import {
  ACCEPT_TIMEOUT_MS,
  BUFFER_HIGH_WATER,
  BUFFER_LOW_WATER,
  CHUNK_SIZE,
  MAX_PENDING_SINK_BYTES,
  MAX_RESUME_REQUESTS_PER_LINK,
  MAX_TRANSFER_UID_LENGTH,
  frameChunk,
  readChunk,
  type FileFrame,
} from "@/lib/peer-protocol";
import type { PeerId } from "@/lib/signal-protocol";
import {
  TRANSFER_LIMITS,
  type DownloadSink,
  type SinkProvider,
  type SinkTier,
} from "@/lib/transfer-contract";
import type { PartialStore, StoredPartial } from "@/lib/transfer-store";
import { formatBytes } from "@/lib/utils";

export type TransferDirection = "outgoing" | "incoming";
export type TransferStatus = "pending" | "active" | "complete" | "cancelled" | "failed";

export type Transfer = {
  /** Per-link, per-direction session counter; rides every chunk header. */
  id: number;
  key: string;
  /** Sender-minted durable identity; survives reloads (see peer-protocol). */
  uid: string;
  direction: TransferDirection;
  name: string;
  size: number;
  mime: string;
  transferred: number;
  status: TransferStatus;
  error?: string;
  /** Object URL for a completed memory-tier incoming file; revoked on reset. */
  url?: string;
  /** Set for images so the UI can show a thumbnail without extra work. */
  isImage: boolean;
  startedAt: number;
  completedAt?: number;
  // --- TransferExtras (lib/transfer-contract.ts) ---------------------------
  peerId: PeerId;
  peerName: string;
  sinkTier?: SinkTier;
  savedTo?: string;
  resumable?: boolean;
  confirmedBytes?: number;
  resumedFrom?: number;
};

type Callbacks = {
  onChange: () => void;
  onError: (message: string) => void;
};

/**
 * Session-level wiring a FileTransferManager needs beyond its channel. All of
 * it is optional (a context-less manager behaves like the Phase 1 engine with
 * an in-memory sink and no resume), so legacy constructors keep compiling.
 */
export type FileTransferContext = {
  peerId: PeerId;
  peerName: string;
  roomId: string;
  /** Resolves once the provider/store have finished loading (they are async). */
  ready?: Promise<unknown>;
  /** Late-bound: the provider may swap from fallback to real after load. */
  provider: () => SinkProvider;
  store: () => PartialStore | null;
  /** The session's registry of files it has offered, by uid. */
  lookupOutgoing: (uid: string) => File | undefined;
  registerOutgoing?: (uid: string, file: File) => void;
  /** Sender side: a peer holds a partial we no longer have the File for. */
  onResumeMissing?: (info: { uid: string; name: string; received: number; size: number }) => void;
  /** Receiver side: the sender refused/failed to honour our resume request. */
  onResumeNack?: (uid: string, reason?: string) => void;
  /** The set of persisted partial records changed. */
  onPartialsChanged?: () => void;
};

const isImageMime = (mime: string) => mime.startsWith("image/");

const MAX_SAFE_TRANSFER_ID = 0xffffffff; // must fit the 4-byte chunk header

/**
 * Last-resort sink provider: the Phase 1 behaviour (accumulate in memory,
 * finish as an object URL), expressed through the contract so the engine has
 * exactly one receive path. Used until the real provider module loads - and
 * forever in environments where it cannot.
 */
export function createMemorySinkProvider(): SinkProvider {
  return {
    capability: () => ({
      tier: "memory",
      streaming: false,
      maxBytes: TRANSFER_LIMITS.maxMemoryBytes,
      hasDestination: false,
      destinationLabel: null,
    }),
    canChooseFolder: () => false,
    chooseFolder: async () => false,
    clearFolder: () => {},
    open: async ({ mime }) => {
      let chunks: Uint8Array[] = [];
      let written = 0;
      let dead = false;
      const sink: DownloadSink = {
        tier: "memory",
        get written() {
          return written;
        },
        async write(chunk: Uint8Array) {
          if (dead) throw new Error("Sink is closed");
          chunks.push(chunk);
          written += chunk.byteLength;
        },
        async close() {
          dead = true;
          const blob = new Blob(chunks as BlobPart[], { type: mime });
          chunks = [];
          return { url: URL.createObjectURL(blob) };
        },
        async abort() {
          dead = true;
          chunks = [];
        },
      };
      return sink;
    },
  };
}

const FALLBACK_PROVIDER = createMemorySinkProvider();

const DEFAULT_CONTEXT: FileTransferContext = {
  peerId: "",
  peerName: "Peer",
  roomId: "",
  provider: () => FALLBACK_PROVIDER,
  store: () => null,
  lookupOutgoing: () => undefined,
};

/** Everything the engine tracks about one in-flight incoming transfer. */
type Inbound = {
  id: number;
  uid: string;
  transfer: Transfer;
  sink: DownloadSink | null;
  /** Serialises sink writes; chunks arrive faster than a sink may accept. */
  queue: Promise<void>;
  /** Bytes received but not yet accepted by the sink (RAM exposure). */
  pendingSinkBytes: number;
  /** Bytes durably resumable-from: persisted windows (memory tier) or
   *  sink.written (tiers whose destination itself survives). */
  durable: number;
  lastAcked: number;
  /** Mirror windows into IndexedDB (memory tier only - its bytes die with
   *  the page; streaming tiers keep their own bytes). */
  persistBytes: boolean;
  nextSeq: number;
  window: Uint8Array[];
  windowBytes: number;
  record: StoredPartial | null;
  /** Set when the transfer stops accepting work (any terminal path). */
  closed: boolean;
};

type OutgoingWaiter = {
  resolve: (from: number | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** What the fan-out orchestrator drives per recipient. */
export type OutgoingHandle = {
  readonly from: number;
  readonly size: number;
  /** Sends one chunk (already positioned); false means drop this recipient. */
  deliver(bytes: Uint8Array): Promise<boolean>;
  finish(): void;
  fail(message: string): void;
};

/**
 * Bytes pulled from the disk per read. Slicing a large File 16 KiB at a time
 * is pathologically slow (each `slice().arrayBuffer()` round-trips to the
 * browser's file backend with cost that grows with the FILE, not the slice),
 * so the send loop reads big spans and frames wire-sized chunks from memory.
 */
export const READ_SPAN_BYTES = 8 * 1024 * 1024;

/**
 * Owns the `files` data channel: chunking, backpressure, sinks, resume and
 * cancellation in both directions.
 *
 * Transfer ids are namespaced by direction (`out:1`, `in:1`) because both
 * peers number their own sends from 1 and the two sequences are independent.
 */
export class FileTransferManager {
  private readonly transfers = new Map<string, Transfer>();
  private readonly inbound = new Map<number, Inbound>();
  /** Outgoing ids the send loop must abandon, and who asked for it. */
  private readonly cancelledOutgoing = new Map<number, "local" | "remote">();
  private readonly pendingAccepts = new Map<number, OutgoingWaiter>();
  private readonly context: FileTransferContext;
  private resumeRequestsHandled = 0;
  private announcedResumables = false;
  private nextId = 1;
  private disposed = false;

  constructor(
    private channel: RTCDataChannel,
    private readonly callbacks: Callbacks,
    context?: FileTransferContext,
  ) {
    this.context = context ?? DEFAULT_CONTEXT;
    this.channel.binaryType = "arraybuffer";
    this.channel.bufferedAmountLowThreshold = BUFFER_LOW_WATER;
    this.channel.addEventListener("message", this.handleMessage);
    // Advertise resumable partials the moment the channel can carry them.
    if (this.channel.readyState === "open") {
      void this.announceResumables();
    } else {
      this.channel.addEventListener("open", () => void this.announceResumables(), { once: true });
    }
  }

  list(): Transfer[] {
    return [...this.transfers.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  private key(direction: TransferDirection, id: number) {
    return `${direction === "outgoing" ? "out" : "in"}:${id}`;
  }

  private send(frame: FileFrame) {
    if (this.channel.readyState !== "open") return;
    this.channel.send(JSON.stringify(frame));
  }

  // ---------------------------------------------------------------- sending

  /** Sends to this manager's peer only. Session-level fan-out lives in
   *  `sendFileToManagers`; this is the single-recipient convenience. */
  async sendFiles(files: File[]) {
    for (const file of files) {
      if (this.disposed) return;
      const uid = crypto.randomUUID();
      this.context.registerOutgoing?.(uid, file);
      await sendFileToManagers(file, uid, [this]);
    }
  }

  /**
   * Opens one outgoing transfer: creates the record, sends the offer and
   * waits for the receiver's `accept` (which carries the start offset - the
   * receiver may resume a partial it already holds durably). Resolves null
   * when this recipient cannot take the file (declined, timed out, cancelled,
   * channel gone); the record is already finished with the right status.
   */
  async beginOutgoing(file: File, uid: string, fresh?: boolean): Promise<OutgoingHandle | null> {
    if (this.disposed || this.channel.readyState !== "open") return null;

    const id = this.nextId++;
    const key = this.key("outgoing", id);
    const transfer: Transfer = {
      id,
      key,
      uid,
      direction: "outgoing",
      name: file.name,
      size: file.size,
      mime: file.type || "application/octet-stream",
      transferred: 0,
      status: "pending",
      isImage: isImageMime(file.type),
      startedAt: Date.now(),
      peerId: this.context.peerId,
      peerName: this.context.peerName,
      confirmedBytes: 0,
    };
    this.transfers.set(key, transfer);
    this.callbacks.onChange();

    this.send({
      k: "offer",
      id,
      uid,
      name: transfer.name,
      size: file.size,
      mime: transfer.mime,
      lastModified: Number.isFinite(file.lastModified) ? file.lastModified : 0,
      ...(fresh ? { fresh: true } : null),
    });

    const from = await this.waitForAccept(id, transfer);
    if (from === null) return null; // record already finished by whoever ended it

    transfer.status = "active";
    transfer.transferred = from;
    transfer.confirmedBytes = from;
    if (from > 0) transfer.resumedFrom = from;
    this.callbacks.onChange();

    const finishRunning = (status: TransferStatus, error?: string) => {
      const current = transfer.status as TransferStatus;
      if (current === "pending" || current === "active") this.finish(transfer, status, error);
    };

    return {
      from,
      size: file.size,
      deliver: async (bytes: Uint8Array): Promise<boolean> => {
        if (this.disposed) return false;
        const cancelledBy = this.cancelledOutgoing.get(id);
        if (cancelledBy !== undefined) {
          // The cancel paths already finished the record with the right
          // attribution; never overwrite it. Label a straggler correctly.
          finishRunning("cancelled", cancelledBy === "local" ? "Cancelled" : "Cancelled by receiver");
          this.cancelledOutgoing.delete(id);
          return false;
        }
        if (this.channel.readyState !== "open") {
          finishRunning("failed", "Channel closed mid-transfer");
          return false;
        }
        await this.drain();
        if (this.disposed) return false;
        if (this.cancelledOutgoing.has(id)) {
          // The cancel path already finished the record with attribution.
          this.cancelledOutgoing.delete(id);
          return false;
        }
        if (this.channel.readyState !== "open") {
          finishRunning("failed", "Channel closed mid-transfer");
          return false;
        }
        try {
          this.channel.send(frameChunk(id, bytes));
        } catch {
          finishRunning("failed", "Channel closed mid-transfer");
          return false;
        }
        transfer.transferred += bytes.byteLength;
        this.callbacks.onChange();
        return true;
      },
      finish: () => {
        this.cancelledOutgoing.delete(id);
        if (this.disposed) return;
        this.send({ k: "done", id });
        finishRunning("complete");
      },
      fail: (message: string) => {
        this.cancelledOutgoing.delete(id);
        this.send({ k: "cancel", id, by: "sender", reason: message });
        finishRunning("failed", message);
        this.callbacks.onError(`Could not send ${transfer.name}: ${message}`);
      },
    };
  }

  /** Resolves with the accepted start offset, or null when the transfer died
   *  first (declined / timed out / cancelled / disposed). */
  private waitForAccept(id: number, transfer: Transfer): Promise<number | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAccepts.delete(id);
        const status = transfer.status as TransferStatus;
        if (status === "pending") {
          this.send({ k: "cancel", id, by: "sender", reason: "Receiver did not respond" });
          this.finish(transfer, "failed", "Receiver did not respond");
        }
        resolve(null);
      }, ACCEPT_TIMEOUT_MS);
      this.pendingAccepts.set(id, { resolve, timer });
    });
  }

  private settleAccept(id: number, from: number | null) {
    const waiter = this.pendingAccepts.get(id);
    if (!waiter) return;
    this.pendingAccepts.delete(id);
    clearTimeout(waiter.timer);
    waiter.resolve(from);
  }

  /** Resolves once the channel has room again. */
  private drain(): Promise<void> {
    if (this.channel.bufferedAmount < BUFFER_HIGH_WATER) return Promise.resolve();

    return new Promise((resolve) => {
      const done = () => {
        this.channel.removeEventListener("bufferedamountlow", done);
        clearInterval(poll);
        resolve();
      };
      // The event is the fast path; the poll covers channel closure and the
      // occasional browser that fires `bufferedamountlow` unreliably.
      const poll = setInterval(() => {
        if (
          this.disposed ||
          this.channel.readyState !== "open" ||
          this.channel.bufferedAmount < BUFFER_HIGH_WATER
        ) {
          done();
        }
      }, 100);
      this.channel.addEventListener("bufferedamountlow", done);
    });
  }

  cancel(key: string) {
    const transfer = this.transfers.get(key);
    if (!transfer || transfer.status === "complete") return;

    if (transfer.direction === "outgoing") {
      this.cancelledOutgoing.set(transfer.id, "local");
      this.send({ k: "cancel", id: transfer.id, by: "sender", reason: "Cancelled by sender" });
      this.settleAccept(transfer.id, null);
      this.finish(transfer, "cancelled", "Cancelled");
    } else {
      // A local cancel is deliberate: the partial is discarded, not kept.
      const inbound = this.inbound.get(transfer.id);
      if (inbound) this.abortIncoming(inbound, { discardRecord: true });
      this.send({ k: "cancel", id: transfer.id, by: "receiver", reason: "Cancelled by receiver" });
      this.finish(transfer, "cancelled", "Cancelled");
    }
  }

  // ---------------------------------------------------------------- resume

  /**
   * Receiver -> sender: advertise every durable partial we hold from this
   * peer, so an interrupted transfer continues without anyone re-clicking.
   */
  private async announceResumables() {
    if (this.disposed || this.announcedResumables) return;
    this.announcedResumables = true;
    try {
      await this.context.ready;
      const store = this.context.store();
      if (!store) return;
      const partials = await store.list();
      for (const partial of partials) {
        if (this.disposed) return;
        if (partial.peerId !== this.context.peerId) continue;
        if (partial.received <= 0 || partial.received > partial.size) continue;
        this.requestResume(partial);
      }
    } catch {
      // Resume is best-effort; transfers still work without it.
    }
  }

  /** Sends one resume request. Also used by the explicit UI action. */
  requestResume(partial: StoredPartial) {
    this.send({
      k: "resume-req",
      uid: partial.id,
      name: partial.name,
      size: partial.size,
      mime: partial.mime,
      lastModified: partial.lastModified,
      received: partial.received,
    });
  }

  /** Sender side: a peer says it durably holds `received` bytes of `uid`. */
  private handleResumeRequest(frame: Extract<FileFrame, { k: "resume-req" }>) {
    if (
      typeof frame.uid !== "string" ||
      frame.uid.length === 0 ||
      frame.uid.length > MAX_TRANSFER_UID_LENGTH ||
      typeof frame.name !== "string" ||
      typeof frame.size !== "number" ||
      !Number.isInteger(frame.size) ||
      frame.size < 0 ||
      typeof frame.received !== "number" ||
      !Number.isInteger(frame.received) ||
      frame.received < 0 ||
      frame.received > frame.size ||
      typeof frame.lastModified !== "number" ||
      !Number.isFinite(frame.lastModified)
    ) {
      return;
    }
    // A well-behaved peer sends a handful of these per session; a flood is an
    // attempt to make us spam re-offers and file reads.
    this.resumeRequestsHandled += 1;
    if (this.resumeRequestsHandled > MAX_RESUME_REQUESTS_PER_LINK) return;

    // Already re-sending this uid? Do not start a second copy.
    for (const t of this.transfers.values()) {
      if (
        t.direction === "outgoing" &&
        t.uid === frame.uid &&
        (t.status === "pending" || t.status === "active")
      ) {
        return;
      }
    }

    const file = this.context.lookupOutgoing(frame.uid);
    if (!file) {
      // The File object died with a reload; only the user re-selecting it can
      // revive the bytes. Say so honestly on both sides instead of stalling.
      this.send({ k: "resume-nack", uid: frame.uid, reason: "The sender must re-select this file" });
      this.context.onResumeMissing?.({
        uid: frame.uid,
        name: sanitizeName(frame.name),
        received: frame.received,
        size: frame.size,
      });
      return;
    }

    // The file must still BE the file the partial came from. If it is not,
    // restart cleanly (`fresh` orders the receiver to drop its partial) -
    // splicing two files together is the one unforgivable outcome.
    const matches =
      file.name === frame.name &&
      file.size === frame.size &&
      file.lastModified === frame.lastModified;
    void sendFileToManagers(file, frame.uid, [this], { fresh: !matches });
  }

  // -------------------------------------------------------------- receiving

  private handleMessage = (event: MessageEvent) => {
    if (this.disposed) return;

    if (typeof event.data === "string") {
      let frame: FileFrame;
      try {
        frame = JSON.parse(event.data) as FileFrame;
      } catch {
        return;
      }
      this.handleControlFrame(frame);
      return;
    }

    if (event.data instanceof ArrayBuffer) {
      this.handleChunk(event.data);
    }
  };

  private handleControlFrame(frame: FileFrame) {
    if (!frame || typeof frame !== "object" || typeof frame.k !== "string") return;

    if (frame.k === "offer") {
      this.handleOffer(frame);
      return;
    }

    if (frame.k === "accept") {
      if (
        typeof frame.id !== "number" ||
        typeof frame.from !== "number" ||
        !Number.isInteger(frame.from) ||
        frame.from < 0
      ) {
        return;
      }
      const transfer = this.transfers.get(this.key("outgoing", frame.id));
      if (!transfer || transfer.status !== "pending") return;
      if (frame.from > transfer.size) {
        // A receiver claiming more bytes than the file holds is broken or
        // hostile; refuse rather than "resume" into negative territory.
        this.settleAccept(frame.id, null);
        this.send({ k: "cancel", id: frame.id, by: "sender", reason: "Invalid resume offset" });
        this.finish(transfer, "failed", "Receiver requested an invalid resume offset");
        return;
      }
      this.settleAccept(frame.id, frame.from);
      return;
    }

    if (frame.k === "ack") {
      if (
        typeof frame.id !== "number" ||
        typeof frame.received !== "number" ||
        !Number.isFinite(frame.received)
      ) {
        return;
      }
      const transfer = this.transfers.get(this.key("outgoing", frame.id));
      if (!transfer) return;
      // Monotonic, and never beyond what we actually sent: a crafted ack must
      // not move progress (nothing here allocates, so acks cannot exhaust us).
      const confirmed = Math.floor(frame.received);
      if (confirmed < (transfer.confirmedBytes ?? 0) || confirmed > transfer.transferred) return;
      transfer.confirmedBytes = confirmed;
      this.callbacks.onChange();
      return;
    }

    if (frame.k === "done") {
      if (typeof frame.id !== "number") return;
      this.completeIncoming(frame.id);
      return;
    }

    if (frame.k === "resume-req") {
      this.handleResumeRequest(frame);
      return;
    }

    if (frame.k === "resume-nack") {
      if (typeof frame.uid !== "string" || frame.uid.length > MAX_TRANSFER_UID_LENGTH) return;
      this.context.onResumeNack?.(frame.uid, typeof frame.reason === "string" ? frame.reason : undefined);
      return;
    }

    if (frame.k === "cancel") {
      // `by` describes who initiated it, so the *other* side's record is ours.
      const direction: TransferDirection = frame.by === "sender" ? "incoming" : "outgoing";
      if (typeof frame.id !== "number") return;
      if (direction === "outgoing") {
        this.cancelledOutgoing.set(frame.id, "remote");
        this.settleAccept(frame.id, null);
      } else {
        const inbound = this.inbound.get(frame.id);
        // The sender cancelled deliberately; a partial of a transfer the
        // sender killed must not linger and auto-resume later.
        if (inbound) this.abortIncoming(inbound, { discardRecord: true });
      }
      const transfer = this.transfers.get(this.key(direction, frame.id));
      // Only records still running: a record we already finished locally
      // (e.g. the user's own cancel) keeps its original attribution.
      if (transfer && (transfer.status === "pending" || transfer.status === "active")) {
        this.finish(transfer, "cancelled", frame.reason ?? "Cancelled by peer");
      }
    }
  }

  // ------------------------------------------------------ receiving: offers

  private handleOffer(frame: Extract<FileFrame, { k: "offer" }>) {
    if (
      typeof frame.id !== "number" ||
      !Number.isInteger(frame.id) ||
      frame.id < 0 ||
      frame.id > MAX_SAFE_TRANSFER_ID ||
      typeof frame.size !== "number" ||
      !Number.isInteger(frame.size) ||
      frame.size < 0 ||
      frame.size > Number.MAX_SAFE_INTEGER ||
      typeof frame.uid !== "string" ||
      frame.uid.length === 0 ||
      frame.uid.length > MAX_TRANSFER_UID_LENGTH
    ) {
      return;
    }

    // Never trust a peer-supplied path; keep the basename only.
    const name = sanitizeName(frame.name);
    const key = this.key("incoming", frame.id);

    const existing = this.transfers.get(key);
    if (existing) {
      // A well-behaved sender never reuses an id; accepting would orphan the
      // previous record and leak its sink. Only answer with a cancel frame
      // when the original is finished - while it is still live, a cancel for
      // this id would abort the original transfer.
      if (existing.status !== "active" && existing.status !== "pending") {
        this.send({ k: "cancel", id: frame.id, by: "receiver", reason: "Transfer id already used" });
      }
      this.callbacks.onError(`Declined "${name}" - the peer reused transfer id ${frame.id}.`);
      return;
    }

    const decline = (reason: string, toast: string) => {
      this.send({ k: "cancel", id: frame.id, by: "receiver", reason });
      this.callbacks.onError(toast);
    };

    if (this.inbound.size >= TRANSFER_LIMITS.maxActiveIncomingPerPeer) {
      decline(
        `More than ${TRANSFER_LIMITS.maxActiveIncomingPerPeer} simultaneous transfers`,
        `Declined "${name}" - already receiving ${TRANSFER_LIMITS.maxActiveIncomingPerPeer} files ` +
          `from this peer. Ask the sender to retry once the current transfers finish.`,
      );
      return;
    }

    const capability = this.context.provider().capability();

    // Per-file ceiling comes from the tier itself: the memory tier caps at
    // TRANSFER_LIMITS.maxMemoryBytes, streaming tiers are typically unbounded.
    if (capability.maxBytes !== null && frame.size > capability.maxBytes) {
      decline(
        `Larger than the ${formatBytes(capability.maxBytes)} limit`,
        `Declined "${name}" - ${formatBytes(frame.size)} exceeds the ` +
          `${formatBytes(capability.maxBytes)} limit of the current save destination.`,
      );
      return;
    }

    // The aggregate memory budget applies to the MEMORY tier only. Streaming
    // tiers never hold the file in memory, so charging them here would refuse
    // perfectly safe transfers - the whole point of those tiers.
    if (capability.tier === "memory") {
      const committed = this.committedMemoryBytes();
      if (committed + frame.size > TRANSFER_LIMITS.maxSessionMemoryBytes) {
        decline(
          `Receive memory budget of ${formatBytes(TRANSFER_LIMITS.maxSessionMemoryBytes)} exhausted`,
          `Declined "${name}" - accepting ${formatBytes(frame.size)} would exceed the ` +
            `${formatBytes(TRANSFER_LIMITS.maxSessionMemoryBytes)} this session can hold in memory. ` +
            `Save your received files and start a new session, then retry.`,
        );
        return;
      }
    }

    const transfer: Transfer = {
      id: frame.id,
      key,
      uid: frame.uid,
      direction: "incoming",
      name,
      size: frame.size,
      mime: typeof frame.mime === "string" && frame.mime ? frame.mime : "application/octet-stream",
      transferred: 0,
      status: "pending",
      isImage: isImageMime(typeof frame.mime === "string" ? frame.mime : ""),
      startedAt: Date.now(),
      peerId: this.context.peerId,
      peerName: this.context.peerName,
      // Predicted tier so concurrent admissions count this one; corrected to
      // the actual sink tier once the sink opens.
      sinkTier: capability.tier,
      confirmedBytes: 0,
    };
    const inbound: Inbound = {
      id: frame.id,
      uid: frame.uid,
      transfer,
      sink: null,
      queue: Promise.resolve(),
      pendingSinkBytes: 0,
      durable: 0,
      lastAcked: 0,
      persistBytes: false,
      nextSeq: 0,
      window: [],
      windowBytes: 0,
      record: null,
      closed: false,
    };
    this.transfers.set(key, transfer);
    this.inbound.set(frame.id, inbound);
    this.callbacks.onChange();

    const lastModified =
      typeof frame.lastModified === "number" && Number.isFinite(frame.lastModified)
        ? frame.lastModified
        : 0;
    void this.openIncoming(inbound, lastModified, frame.fresh === true);
  }

  /**
   * Async half of accepting an offer: resolve any resumable partial, open the
   * sink (resuming when the sink can, replaying persisted bytes when it
   * cannot), then tell the sender which byte to start from.
   */
  private async openIncoming(inbound: Inbound, lastModified: number, fresh: boolean) {
    const { transfer } = inbound;
    const fail = (reason: string, toast?: string) => {
      if (inbound.closed) return;
      this.abortIncoming(inbound, { discardRecord: false });
      this.send({ k: "cancel", id: inbound.id, by: "receiver", reason });
      if (transfer.status === "pending" || transfer.status === "active") {
        this.finish(transfer, "failed", reason);
      }
      if (toast) this.callbacks.onError(toast);
    };

    try {
      await this.context.ready;
      if (inbound.closed || this.disposed) return;

      const store = this.context.store();
      let resume: StoredPartial | null = null;

      if (fresh) {
        // The sender explicitly said the file changed: any partial we hold
        // for this uid belongs to different bytes. Drop it, start at zero.
        if (store) {
          await store.discard(inbound.uid);
          this.context.onPartialsChanged?.();
        }
      } else if (store) {
        // Same-file identity: the uid is authoritative, and a re-selected
        // file (new uid) may still match by (peer, name, size, lastModified).
        let record = await store.get(inbound.uid);
        if (!record) {
          const partials = await store.list();
          record =
            partials.find(
              (p) =>
                p.peerId === this.context.peerId &&
                p.name === transfer.name &&
                p.size === transfer.size &&
                p.lastModified === lastModified,
            ) ?? null;
        }
        if (
          record &&
          record.peerId === this.context.peerId &&
          record.name === transfer.name &&
          record.size === transfer.size &&
          record.lastModified === lastModified &&
          Number.isInteger(record.received) &&
          record.received > 0 &&
          record.received <= transfer.size
        ) {
          resume = record;
        }
      }

      const provider = this.context.provider();
      let sink: DownloadSink | null = null;
      let from = 0;
      /** Persisted windows replayed into a fresh sink (memory tier resume). */
      let replayedWindows: Uint8Array[] | null = null;

      if (resume) {
        // First choice: the sink itself resumes (the filesystem tier reopens
        // the partial file and seeks). Trust it only if it lands EXACTLY on
        // the recorded offset. Providers whose current tier cannot seek are
        // allowed to throw here; that is not fatal to the resume yet.
        let candidate: DownloadSink | null = null;
        try {
          candidate = await provider.open({
            name: transfer.name,
            mime: transfer.mime,
            expectedBytes: transfer.size,
            transferId: inbound.uid,
            resumeFrom: resume.received,
          });
        } catch {
          candidate = null;
        }
        if (candidate && candidate.written === resume.received) {
          sink = candidate;
          from = resume.received;
        } else {
          if (candidate && candidate.written !== 0) {
            await candidate.abort(); // some other length: unusable, never trust it
            candidate = null;
          }
          // Second choice: a fresh sink plus the bytes WE persisted (memory
          // tier). Works into any tier - the windows are just writes.
          if (resume.hasBytes) {
            let fresh = candidate; // a candidate with written === 0 is fresh
            if (!fresh) {
              try {
                fresh = await provider.open({
                  name: transfer.name,
                  mime: transfer.mime,
                  expectedBytes: transfer.size,
                  transferId: inbound.uid,
                });
              } catch {
                fresh = null;
              }
            }
            if (fresh) {
              replayedWindows = await this.replayPersisted(fresh, resume);
              if (replayedWindows) {
                sink = fresh;
                from = resume.received;
              } else {
                sink = fresh; // keep the sink; the transfer restarts at zero
              }
            }
          } else if (candidate) {
            sink = candidate; // fresh sink, nothing to replay: restart at zero
          }
        }
        if (from === 0 && store) {
          // Resume did not happen; the stale record must not shadow this
          // transfer's own fresh persistence.
          await store.discard(resume.id);
          this.context.onPartialsChanged?.();
        }
      }

      if (!sink) {
        sink = await provider.open({
          name: transfer.name,
          mime: transfer.mime,
          expectedBytes: transfer.size,
          transferId: inbound.uid,
        });
        if (from !== 0) from = 0;
      }

      if (inbound.closed || this.disposed) {
        await sink.abort();
        return;
      }

      // The provider may have fallen back to a different tier than predicted
      // at admission. If we ended up holding bytes in memory after all,
      // re-check the budget with the true tier before committing.
      transfer.sinkTier = sink.tier;
      if (sink.tier === "memory") {
        const committed = this.committedMemoryBytes() - transfer.size; // exclude self
        if (
          transfer.size > TRANSFER_LIMITS.maxMemoryBytes ||
          committed + transfer.size > TRANSFER_LIMITS.maxSessionMemoryBytes
        ) {
          await sink.abort();
          fail(
            `Receive memory budget exhausted`,
            `Declined "${transfer.name}" - the save destination fell back to memory ` +
              `and the memory budget cannot hold it.`,
          );
          return;
        }
      }

      const capability = provider.capability();
      inbound.sink = sink;
      inbound.durable = from;
      inbound.lastAcked = from;
      // Memory-tier bytes die with the page, so WE persist them (that is the
      // only honest basis for the acks resume rewinds to). Filesystem keeps
      // its own bytes; the download tier cannot resume at all, so persisting
      // a record for it would advertise a resume that can never happen.
      inbound.persistBytes = sink.tier === "memory" && store !== null;
      if (store !== null && sink.tier !== "download") {
        inbound.record = {
          id: inbound.uid,
          roomId: this.context.roomId,
          peerId: this.context.peerId,
          peerName: this.context.peerName,
          name: transfer.name,
          mime: transfer.mime,
          size: transfer.size,
          received: from,
          tier: sink.tier,
          updatedAt: Date.now(),
          lastModified,
          hasBytes: false,
        };
        if (replayedWindows && store) {
          // Re-persist the replayed prefix under THIS transfer's uid with a
          // clean window sequence (the old rows may belong to another uid and
          // their seq numbering must restart at 0 for the next resume).
          await store.discard(resume ? resume.id : inbound.uid);
          if (resume && resume.id !== inbound.uid) await store.discard(inbound.uid);
          let persisted = 0;
          let ok = true;
          for (const [seq, window] of replayedWindows.entries()) {
            persisted += window.byteLength;
            inbound.record = {
              ...inbound.record,
              received: persisted,
              updatedAt: Date.now(),
              hasBytes: true,
            };
            if (!(await store.appendBytes(inbound.record, seq, window))) {
              ok = false;
              break;
            }
          }
          if (ok) {
            inbound.nextSeq = replayedWindows.length;
          } else {
            // Storage failed mid-rewrite: the transfer continues (its bytes
            // are already in the sink) but it is no longer resumable.
            inbound.persistBytes = false;
            inbound.record = null;
            void store.discard(inbound.uid);
          }
        } else {
          if (resume && resume.id !== inbound.uid) {
            // Sink-native resume under a new uid: retire the old record.
            void store.discard(resume.id);
          }
          void store.put(inbound.record);
        }
      }
      if (from > 0) transfer.resumedFrom = from;

      transfer.status = "active";
      transfer.transferred = from;
      transfer.confirmedBytes = from;
      // The filesystem sink knows the exact on-disk name it de-duplicated to
      // (an extra beyond the contract); prefer it over the bare folder label.
      const savedAs = (sink as { savedAs?: unknown }).savedAs;
      transfer.savedTo =
        typeof savedAs === "string" && savedAs.length > 0
          ? capability.destinationLabel
            ? `${capability.destinationLabel}/${savedAs}`
            : savedAs
          : (capability.destinationLabel ?? undefined);
      this.callbacks.onChange();
      this.send({ k: "accept", id: inbound.id, from });
      if (from > 0) this.context.onPartialsChanged?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not open a destination";
      fail(
        "Could not open a save destination",
        `Declined "${transfer.name}" - ${message}`,
      );
    }
  }

  /** Replays persisted partial bytes into a fresh sink. Returns the replayed
   *  windows so they can be re-persisted, or null on any doubt at all. */
  private async replayPersisted(
    sink: DownloadSink,
    record: StoredPartial,
  ): Promise<Uint8Array[] | null> {
    if (!record.hasBytes) return null;
    const store = this.context.store();
    if (!store) return null;
    const windows = await store.readBytes(record.id, record.received);
    if (!windows) return null; // torn or missing: never replay doubtful bytes
    try {
      for (const window of windows) {
        await sink.write(window);
      }
    } catch {
      return null;
    }
    return sink.written === record.received ? windows : null;
  }

  // ------------------------------------------------------ receiving: chunks

  private handleChunk(buffer: ArrayBuffer) {
    const parsed = readChunk(buffer);
    if (!parsed) return;

    const inbound = this.inbound.get(parsed.transferId);
    const transfer = inbound?.transfer;
    // Unknown, not-yet-accepted or already-finished transfer: drop the bytes.
    if (!inbound || !transfer || inbound.closed || transfer.status !== "active" || !inbound.sink) {
      return;
    }

    if (transfer.transferred + parsed.data.byteLength > transfer.size) {
      this.abortIncoming(inbound, { discardRecord: true });
      this.send({ k: "cancel", id: parsed.transferId, by: "receiver", reason: "Sent more data than declared" });
      this.finish(transfer, "failed", "Sender exceeded the declared file size");
      return;
    }

    // Copy: the received buffer is only ours until the next message, and this
    // view starts past the 4-byte header (non-zero byteOffset).
    const bytes = new Uint8Array(parsed.data);
    transfer.transferred += bytes.byteLength;
    inbound.pendingSinkBytes += bytes.byteLength;

    // If the sink cannot keep up with the wire, the write queue IS memory
    // growth, whatever the tier. Failing is better than an OOM'd tab.
    if (inbound.pendingSinkBytes > MAX_PENDING_SINK_BYTES) {
      this.abortIncoming(inbound, { discardRecord: false });
      this.send({ k: "cancel", id: parsed.transferId, by: "receiver", reason: "Destination too slow" });
      this.finish(transfer, "failed", "The save destination could not keep up");
      return;
    }

    inbound.queue = inbound.queue.then(async () => {
      if (inbound.closed || !inbound.sink) return;
      try {
        await inbound.sink.write(bytes);
        inbound.pendingSinkBytes -= bytes.byteLength;
        if (inbound.persistBytes) {
          inbound.window.push(bytes);
          inbound.windowBytes += bytes.byteLength;
          if (inbound.windowBytes >= TRANSFER_LIMITS.ackIntervalBytes) {
            await this.flushWindow(inbound);
          }
        } else {
          inbound.durable = inbound.sink.written;
        }
        this.maybeAck(inbound);
      } catch (error) {
        if (inbound.closed) return;
        const message = error instanceof Error ? error.message : "Could not write to the destination";
        this.abortIncoming(inbound, { discardRecord: true });
        this.send({ k: "cancel", id: inbound.id, by: "receiver", reason: "Destination failed" });
        this.finish(inbound.transfer, "failed", message);
      }
    });

    this.callbacks.onChange();
  }

  /**
   * Persists the buffered window (memory tier) atomically with the updated
   * `received` offset. On storage failure resume is disabled for this
   * transfer - the bytes in RAM are fine, so the transfer itself continues.
   */
  private async flushWindow(inbound: Inbound): Promise<void> {
    const store = this.context.store();
    if (!inbound.persistBytes || inbound.windowBytes === 0 || !store || !inbound.record) return;

    const merged = new Uint8Array(inbound.windowBytes);
    let offset = 0;
    for (const part of inbound.window) {
      merged.set(part, offset);
      offset += part.byteLength;
    }
    inbound.window = [];
    const windowBytes = inbound.windowBytes;
    inbound.windowBytes = 0;

    const record: StoredPartial = {
      ...inbound.record,
      received: inbound.durable + windowBytes,
      updatedAt: Date.now(),
      hasBytes: true,
    };
    const seq = inbound.nextSeq;
    const ok = await store.appendBytes(record, seq, merged);
    if (ok) {
      inbound.nextSeq = seq + 1;
      inbound.durable = record.received;
      inbound.record = record;
    } else {
      // Private-browsing quota or a mid-transfer eviction: degrade to
      // non-resumable rather than lying about durability in acks. From here
      // "durable" can only mean "accepted by the sink".
      inbound.persistBytes = false;
      inbound.record = null;
      if (inbound.sink) inbound.durable = inbound.sink.written;
      void store.discard(inbound.uid);
      this.context.onPartialsChanged?.();
    }
  }

  private maybeAck(inbound: Inbound) {
    if (inbound.closed) return;
    const durable = inbound.durable;
    inbound.transfer.confirmedBytes = durable;
    if (durable - inbound.lastAcked < TRANSFER_LIMITS.ackIntervalBytes) return;
    inbound.lastAcked = durable;
    this.send({ k: "ack", id: inbound.id, received: durable });
    // Streaming tiers keep their own bytes; refresh the metadata record so
    // its `received` tracks the durable offset the ack just promised.
    if (!inbound.persistBytes && inbound.record) {
      const store = this.context.store();
      inbound.record = { ...inbound.record, received: durable, updatedAt: Date.now() };
      void store?.put(inbound.record);
    }
  }

  private completeIncoming(id: number) {
    const inbound = this.inbound.get(id);
    if (!inbound || inbound.closed) return;
    const { transfer } = inbound;

    if (transfer.transferred !== transfer.size) {
      this.abortIncoming(inbound, { discardRecord: false });
      this.finish(
        transfer,
        "failed",
        `Incomplete - got ${formatBytes(transfer.transferred)} of ${formatBytes(transfer.size)}`,
      );
      return;
    }

    // Finalisation rides the write queue so every chunk is in the sink first.
    inbound.queue = inbound.queue.then(async () => {
      if (inbound.closed || !inbound.sink) return;
      try {
        if (inbound.sink.written !== transfer.size) {
          throw new Error(
            `Destination holds ${formatBytes(inbound.sink.written)} of ${formatBytes(transfer.size)}`,
          );
        }
        const { url } = await inbound.sink.close();
        inbound.closed = true;
        this.inbound.delete(id);
        if (url) transfer.url = url;
        transfer.confirmedBytes = transfer.size;
        // The transfer is whole; its partial record and bytes are done with.
        const store = this.context.store();
        if (store) {
          void store.discard(inbound.uid);
          this.context.onPartialsChanged?.();
        }
        this.send({ k: "ack", id, received: transfer.size });
        this.finish(transfer, "complete");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not finish the file";
        this.abortIncoming(inbound, { discardRecord: true });
        this.finish(transfer, "failed", message);
      }
    });
  }

  /**
   * Stops an in-flight incoming transfer and releases its sink. Deliberate
   * endings (`discardRecord: true`) also destroy the persisted partial;
   * accidental ones keep it so the transfer can resume later.
   */
  private abortIncoming(inbound: Inbound, options: { discardRecord: boolean }) {
    if (inbound.closed) return;
    inbound.closed = true;
    this.inbound.delete(inbound.id);
    inbound.window = [];
    inbound.windowBytes = 0;
    const sink = inbound.sink;
    inbound.sink = null;
    if (sink) {
      // After the queued writes settle; abort() never throws per contract.
      void inbound.queue.then(() => sink.abort()).catch(() => sink.abort());
    }
    if (options.discardRecord) {
      inbound.record = null;
      const store = this.context.store();
      if (store) {
        void store.discard(inbound.uid);
        this.context.onPartialsChanged?.();
      }
    }
  }

  /**
   * An ACCIDENTAL interruption (link death, session teardown): keep the
   * durable partial so the transfer can continue later, flush what the sink
   * already accepted, and release our references WITHOUT aborting - abort()
   * would delete the very bytes resume needs.
   */
  private suspendIncoming(inbound: Inbound) {
    if (inbound.closed) return;
    inbound.closed = true;
    this.inbound.delete(inbound.id);
    const sink = inbound.sink;
    inbound.sink = null;
    const store = this.context.store();

    if (!store || (!inbound.record && !inbound.persistBytes)) {
      // Nothing durable to keep (download tier, or no storage): the partial
      // is unrecoverable, so release the sink for real.
      if (sink) void inbound.queue.then(() => sink.abort()).catch(() => sink.abort());
      return;
    }

    void inbound.queue
      .then(async () => {
        // Persist the tail that was written but not yet windowed (memory
        // tier), then pin the record at the exact durable offset.
        if (inbound.persistBytes && inbound.windowBytes > 0 && inbound.record) {
          await this.flushWindow(inbound);
        } else if (!inbound.persistBytes && sink && inbound.record) {
          inbound.durable = sink.written;
        }
        if (inbound.record) {
          const final: StoredPartial = {
            ...inbound.record,
            received: inbound.durable,
            updatedAt: Date.now(),
          };
          if (final.received > 0) {
            await store.put(final);
          } else {
            await store.discard(final.id);
          }
        }
        this.context.onPartialsChanged?.();
      })
      .catch(() => {
        // Best-effort: losing the tail only rewinds resume to the last ack.
      });
    inbound.transfer.resumable = true;
  }

  /** Memory the session is committed to holding for memory-tier transfers:
   *  active ones will grow to their full size, completed ones hold their Blob
   *  until dispose() revokes it. Streaming tiers never appear here. */
  private committedMemoryBytes(): number {
    let committed = 0;
    for (const t of this.transfers.values()) {
      if (t.direction !== "incoming" || t.sinkTier !== "memory") continue;
      if (t.status === "pending" || t.status === "active" || t.status === "complete") {
        committed += t.size;
      }
    }
    return committed;
  }

  private finish(transfer: Transfer, status: TransferStatus, error?: string) {
    transfer.status = status;
    transfer.error = error;
    transfer.completedAt = Date.now();
    if (status === "complete") transfer.transferred = transfer.size;
    this.callbacks.onChange();
  }

  // ------------------------------------------------------------- lifecycle

  /** Marks everything still running as failed - used when the channel drops.
   *  Incoming partials are SUSPENDED (kept durable for resume), not deleted. */
  failAll(reason: string) {
    for (const waiter of [...this.pendingAccepts.keys()]) this.settleAccept(waiter, null);
    for (const transfer of this.transfers.values()) {
      if (transfer.status === "pending" || transfer.status === "active") {
        if (transfer.direction === "incoming") {
          const inbound = this.inbound.get(transfer.id);
          if (inbound) this.suspendIncoming(inbound);
        }
        this.finish(transfer, "failed", reason);
      }
    }
  }

  /** Releases every sink and object URL. Without this a session leaks its
   *  whole inbox. Partial records survive on purpose - they are the resume. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.channel.removeEventListener("message", this.handleMessage);
    for (const waiter of [...this.pendingAccepts.keys()]) this.settleAccept(waiter, null);
    for (const inbound of [...this.inbound.values()]) {
      // Anything still running at dispose is an accidental ending.
      this.suspendIncoming(inbound);
    }
    for (const transfer of this.transfers.values()) {
      if (transfer.url) URL.revokeObjectURL(transfer.url);
    }
    this.transfers.clear();
    this.inbound.clear();
    this.cancelledOutgoing.clear();
  }
}

/**
 * Fan-out: streams ONE file to several recipients with a single pass over the
 * disk. The file is read in `READ_SPAN_BYTES` spans - each span is ONE
 * `file.slice().arrayBuffer()` - and wire-sized chunks are framed from the
 * in-memory span for every recipient. The only per-recipient work is the
 * 4-byte-id framing copy; the disk is never re-read per recipient.
 * Recipients may start at different offsets (resume), so a chunk is only
 * delivered to recipients it overlaps.
 *
 * The loop advances at the pace of the slowest recipient; each channel's own
 * 4 MiB send buffer absorbs the difference for peers that are merely uneven.
 */
export async function sendFileToManagers(
  file: File,
  uid: string,
  managers: FileTransferManager[],
  options?: { fresh?: boolean },
): Promise<void> {
  const handles = (
    await Promise.all(managers.map((manager) => manager.beginOutgoing(file, uid, options?.fresh)))
  ).filter((handle): handle is OutgoingHandle => handle !== null);
  if (handles.length === 0) return;

  // A recipient that already durably holds the whole file needs no chunks.
  let active = handles.filter((handle) => handle.from < file.size);
  for (const handle of handles) {
    if (handle.from >= file.size) handle.finish();
  }
  if (file.size === 0 || active.length === 0) {
    return;
  }

  let offset = Math.min(...active.map((handle) => handle.from));
  while (offset < file.size && active.length > 0) {
    const spanEnd = Math.min(offset + READ_SPAN_BYTES, file.size);
    let span: Uint8Array;
    try {
      const buffer = await file.slice(offset, spanEnd).arrayBuffer();
      if (buffer.byteLength !== spanEnd - offset) throw new Error("Short read");
      span = new Uint8Array(buffer);
    } catch {
      // The File object went stale (edited or removed on disk). Nothing sane
      // can be sent from here; fail every remaining copy.
      for (const handle of active) {
        handle.fail("Could not read the file - it may have changed on disk");
      }
      return;
    }

    let chunkStart = offset;
    while (chunkStart < spanEnd && active.length > 0) {
      const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, spanEnd);
      const survivors: OutgoingHandle[] = [];
      for (const handle of active) {
        if (handle.from >= chunkEnd) {
          survivors.push(handle); // resumes beyond this chunk; not started yet
          continue;
        }
        // A resumed recipient may join mid-chunk; give it only its remainder.
        const start = Math.max(handle.from, chunkStart);
        const part = span.subarray(start - offset, chunkEnd - offset);
        if (await handle.deliver(part)) survivors.push(handle);
      }
      active = survivors;
      chunkStart = chunkEnd;
    }
    offset = spanEnd;
  }

  for (const handle of active) handle.finish();
}

function sanitizeName(name: unknown) {
  if (typeof name !== "string" || !name.trim()) return "untitled";
  return name.replace(/^.*[\\/]/, "").slice(0, 180) || "untitled";
}
