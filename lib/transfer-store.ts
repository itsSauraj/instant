import { TRANSFER_LIMITS, type PartialTransfer } from "@/lib/transfer-contract";

/**
 * IndexedDB persistence for partial incoming transfers, so a reload can offer
 * to CONTINUE a transfer instead of restarting it at zero.
 *
 * Two object stores:
 *
 *  - "partials": one metadata record per interrupted transfer, keyed by the
 *    sender-minted stable uid (`PartialTransfer.id`), scoped by room via an
 *    index. This is the contract's `PartialTransfer` plus the fields the
 *    engine needs that the UI does not: the sender's peerId (identity match
 *    must be scoped to the peer that sent the bytes) and the file's
 *    lastModified (part of the same-file identity check).
 *
 *  - "chunks": the partial BYTES, but only for sink tiers that cannot restore
 *    them themselves (the memory tier: its bytes die with the page). Written
 *    as append-only windows of ~ackIntervalBytes, keyed [uid, seq], committed
 *    in the SAME transaction as the metadata update so `received` can never
 *    claim bytes that were not durably stored - the receiver's ack (and
 *    therefore the sender's resume rewind point) is only honest because of
 *    this atomicity. Deleted the moment the transfer completes or is
 *    discarded.
 *
 * Everything degrades: private browsing modes where IndexedDB is missing or
 * throws yield a `null` store, and every method swallows storage failures.
 * Transfers still work without it - they just restart from zero after a
 * reload, which is exactly the pre-resume behaviour.
 */

const DB_NAME = "instant-transfers";
const DB_VERSION = 1;
const PARTIALS = "partials";
const CHUNKS = "chunks";

/**
 * Hard cap on partial records kept per room. Admission caps already bound how
 * many *live* transfers a peer can open, but records outlive sessions; without
 * this, repeated interrupted sessions could accumulate stale rows (and, for
 * the memory tier, their persisted bytes) until the TTL fires.
 */
const MAX_PARTIALS_PER_ROOM = 32;

/** The engine-facing record: the UI contract plus resume-critical identity. */
export type StoredPartial = PartialTransfer & {
  /** Who sent it. Identity matching is scoped to this peer. */
  peerId: string;
  /** Third leg of the same-file identity (name + size + lastModified). */
  lastModified: number;
  /** True when the partial's bytes are persisted in the "chunks" store. */
  hasBytes: boolean;
};

type ChunkRow = {
  key: [string, number];
  id: string;
  seq: number;
  bytes: ArrayBuffer;
};

/** Narrow interface the transfer engine codes against (mockable in tests). */
export type PartialStore = {
  /** All partial records for this room, TTL-pruned, newest first. */
  list(): Promise<StoredPartial[]>;
  get(id: string): Promise<StoredPartial | null>;
  /** Metadata-only upsert (streaming tiers; the sink holds the bytes). */
  put(record: StoredPartial): Promise<boolean>;
  /**
   * Atomically appends one window of bytes AND updates the metadata record.
   * `record.received` must equal the total contiguous bytes INCLUDING this
   * window. Returns false when storage failed (caller must not ack).
   */
  appendBytes(record: StoredPartial, seq: number, bytes: Uint8Array): Promise<boolean>;
  /**
   * The persisted windows for `id`, in order, or null when they are missing
   * or do not add up to `expectedBytes` (torn/stale data must never be
   * replayed into a sink - a corrupt resume is worse than a restart).
   */
  readBytes(id: string, expectedBytes: number): Promise<Uint8Array[] | null>;
  /** Removes the record and any persisted bytes. Safe on unknown ids. */
  discard(id: string): Promise<void>;
};

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
}

function isRecord(value: unknown): value is StoredPartial {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<StoredPartial>;
  return (
    typeof r.id === "string" &&
    typeof r.roomId === "string" &&
    typeof r.name === "string" &&
    typeof r.size === "number" &&
    typeof r.received === "number" &&
    typeof r.updatedAt === "number" &&
    typeof r.peerId === "string" &&
    typeof r.lastModified === "number"
  );
}

class IdbPartialStore implements PartialStore {
  constructor(
    private readonly db: IDBDatabase,
    private readonly roomId: string,
  ) {}

  private fresh(record: StoredPartial): boolean {
    return Date.now() - record.updatedAt <= TRANSFER_LIMITS.partialTtlMs;
  }

  async list(): Promise<StoredPartial[]> {
    try {
      const tx = this.db.transaction([PARTIALS, CHUNKS], "readwrite");
      const store = tx.objectStore(PARTIALS);
      const rows = await requestToPromise(store.index("roomId").getAll(this.roomId));
      const alive: StoredPartial[] = [];
      const dead: string[] = [];
      for (const row of rows) {
        if (isRecord(row) && this.fresh(row)) alive.push(row);
        else if (isRecord(row)) dead.push(row.id);
      }
      // TTL prune in passing; also enforce the per-room cap, oldest first.
      alive.sort((a, b) => b.updatedAt - a.updatedAt);
      while (alive.length > MAX_PARTIALS_PER_ROOM) {
        const evicted = alive.pop();
        if (evicted) dead.push(evicted.id);
      }
      for (const id of dead) this.deleteInTx(tx, id);
      await txDone(tx);
      return alive;
    } catch {
      return [];
    }
  }

  async get(id: string): Promise<StoredPartial | null> {
    try {
      const tx = this.db.transaction(PARTIALS, "readonly");
      const row = await requestToPromise(tx.objectStore(PARTIALS).get(id));
      if (!isRecord(row) || row.roomId !== this.roomId || !this.fresh(row)) return null;
      return row;
    } catch {
      return null;
    }
  }

  async put(record: StoredPartial): Promise<boolean> {
    try {
      const tx = this.db.transaction(PARTIALS, "readwrite");
      tx.objectStore(PARTIALS).put(record);
      await txDone(tx);
      return true;
    } catch {
      return false;
    }
  }

  async appendBytes(record: StoredPartial, seq: number, bytes: Uint8Array): Promise<boolean> {
    try {
      // One transaction covers both stores: either the window AND the new
      // `received` land together, or neither does. The caller only acks (and
      // the sender only trusts) offsets this transaction has committed.
      const tx = this.db.transaction([PARTIALS, CHUNKS], "readwrite");
      // Copy into a plain ArrayBuffer: the view may sit inside a larger (or
      // shared) buffer, and IndexedDB structured-clones whatever it is given.
      const copy = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(copy).set(bytes);
      const row: ChunkRow = { key: [record.id, seq], id: record.id, seq, bytes: copy };
      tx.objectStore(CHUNKS).put(row);
      tx.objectStore(PARTIALS).put(record);
      await txDone(tx);
      return true;
    } catch {
      return false;
    }
  }

  async readBytes(id: string, expectedBytes: number): Promise<Uint8Array[] | null> {
    try {
      const tx = this.db.transaction(CHUNKS, "readonly");
      const range = IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
      const rows = (await requestToPromise(tx.objectStore(CHUNKS).getAll(range))) as ChunkRow[];
      rows.sort((a, b) => a.seq - b.seq);
      const windows: Uint8Array[] = [];
      let total = 0;
      for (const [index, row] of rows.entries()) {
        if (row.seq !== index || !(row.bytes instanceof ArrayBuffer)) return null; // torn
        windows.push(new Uint8Array(row.bytes));
        total += row.bytes.byteLength;
      }
      return total === expectedBytes ? windows : null;
    } catch {
      return null;
    }
  }

  async discard(id: string): Promise<void> {
    try {
      const tx = this.db.transaction([PARTIALS, CHUNKS], "readwrite");
      this.deleteInTx(tx, id);
      await txDone(tx);
    } catch {
      // Nothing to release; degrade silently.
    }
  }

  private deleteInTx(tx: IDBTransaction, id: string) {
    tx.objectStore(PARTIALS).delete(id);
    tx.objectStore(CHUNKS).delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
  }
}

/**
 * Opens the room-scoped partial store, or resolves null when IndexedDB is
 * unavailable (private browsing, storage denied, SSR). Never throws: callers
 * treat null as "resume disabled", and transfers proceed non-resumably.
 */
export async function openTransferStore(roomId: string): Promise<PartialStore | null> {
  try {
    if (typeof indexedDB === "undefined" || !indexedDB?.open) return null;
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PARTIALS)) {
        const partials = db.createObjectStore(PARTIALS, { keyPath: "id" });
        partials.createIndex("roomId", "roomId");
      }
      if (!db.objectStoreNames.contains(CHUNKS)) {
        db.createObjectStore(CHUNKS, { keyPath: "key" });
      }
    };
    const db = await requestToPromise(request);
    // Another tab upgrading the schema must not deadlock on us.
    db.onversionchange = () => db.close();
    return new IdbPartialStore(db, roomId);
  } catch {
    return null;
  }
}
