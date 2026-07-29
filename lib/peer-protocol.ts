/** Frames exchanged over the two RTCDataChannels once the peers are connected. */

export const CHANNEL = {
  notes: "notes",
  files: "files",
} as const;

/** 16 KiB is the largest chunk every major SCTP stack accepts without fuss. */
export const CHUNK_SIZE = 16 * 1024;

/** Pause sending above this, resume on `bufferedamountlow`. */
export const BUFFER_HIGH_WATER = 4 * 1024 * 1024;
export const BUFFER_LOW_WATER = 512 * 1024;

/** Received files are held in memory, so this is a tab-stability limit. */
export const MAX_RECEIVE_BYTES = 1024 * 1024 * 1024;

/**
 * Aggregate ceiling on everything a session may hold in memory from incoming
 * transfers: in-flight chunk buffers plus completed Blobs that have not yet
 * been released by `dispose()`. `MAX_RECEIVE_BYTES` alone is per-transfer, so
 * without this a peer could open many offers that each pass the per-transfer
 * check and OOM the tab in aggregate. 2 GiB still admits two maximum-size
 * files while staying under the ~3–4 GiB of JS-visible allocations at which
 * browsers routinely kill a tab.
 */
export const MAX_SESSION_RECEIVE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * A well-behaved sender streams files strictly one at a time (see
 * `FileTransferManager.sendFiles`), so it never has more than one incoming
 * transfer open plus a little offer/done race slack. Anything beyond a
 * handful is a misbehaving or hostile peer fanning allocations out across
 * many ids.
 */
export const MAX_ACTIVE_INCOMING_TRANSFERS = 4;

/** Generous enough for real code snippets now that notes render markdown. */
export const MAX_NOTE_LENGTH = 20_000;

/**
 * The shared doc is synced as one frame per (debounced) edit. Kept well under
 * what modern SCTP stacks accept as a single message even if every character
 * is multi-byte.
 */
export const MAX_DOC_LENGTH = 50_000;

export type NoteFrame =
  | { k: "note"; id: string; text: string; at: number }
  | { k: "typing"; on: boolean }
  /**
   * Full-text, last-writer-wins doc sync. `rev` totally orders edits between
   * the two peers (ties broken by `at`); with only two writers this converges
   * without needing OT/CRDT machinery.
   */
  | { k: "doc"; text: string; rev: number; at: number };

/**
 * How long the sender waits for the receiver's `accept` before giving up on
 * that recipient. Generous: the receiver may be opening a filesystem sink or
 * replaying persisted partial bytes before it can answer.
 */
export const ACCEPT_TIMEOUT_MS = 30_000;

/** `uid` values are sender-minted UUIDs; anything longer is hostile garbage. */
export const MAX_TRANSFER_UID_LENGTH = 64;

/**
 * Ceiling on bytes queued between the wire and the sink for one incoming
 * transfer. Sinks are normally faster than the network, so this only trips
 * when a destination stalls (or a hostile peer floods faster than any disk);
 * failing the transfer is better than letting the queue eat the tab's memory.
 */
export const MAX_PENDING_SINK_BYTES = 64 * 1024 * 1024;

/**
 * Resume requests a link will act on for its whole lifetime. A well-behaved
 * peer sends at most a handful (one per partial it holds); a flood of them is
 * an attempt to make us re-read files or spam re-offers.
 */
export const MAX_RESUME_REQUESTS_PER_LINK = 32;

/**
 * The file-transfer control frames (JSON on the `files` channel). Binary
 * chunks travel on the same channel, framed by `frameChunk` below.
 *
 * Identity model: `id` is a per-link, per-direction session counter (cheap,
 * rides every chunk as the 4-byte header) and CANNOT survive a reload. `uid`
 * is a sender-minted token (`crypto.randomUUID()`) that names the (sender,
 * file) pair durably: the receiver keys its persisted partial records by it.
 * Same-file identity across a reload is `name + size + lastModified` — enough
 * to refuse resuming against a different file without hashing gigabytes
 * before the first byte moves.
 *
 *  - offer:  sender proposes a transfer. Carries the durable `uid` and the
 *            full file identity. `fresh: true` orders the receiver to discard
 *            any partial it holds for this uid/identity and start at byte 0
 *            (sent when the sender knows resuming would corrupt: the file it
 *            now holds does not match the partial's identity).
 *  - accept: receiver's answer, after it has opened its sink (and, when
 *            resuming, verified the sink really starts at the claimed byte).
 *            `from` is the byte offset the sender must start at: 0 for a
 *            fresh transfer, the durable partial size when resuming. Chunks
 *            only flow after this frame — the receiver controls the offset.
 *  - ack:    receiver -> sender, every TRANSFER_LIMITS.ackIntervalBytes, and
 *            only for bytes DURABLY in the sink (written + persisted), since
 *            resume rewinds to the last acked offset. Drives the sender's
 *            `confirmedBytes`.
 *  - done:   sender finished writing chunks (unchanged from Phase 1).
 *  - cancel: either side aborts; `by` attributes it (unchanged from Phase 1).
 *  - resume-req:  receiver -> sender after (re)connecting: "I durably hold
 *            `received` bytes of transfer `uid`, which claimed this identity".
 *            The sender validates it still holds a File matching that
 *            identity and, if so, re-offers with the same uid; the normal
 *            offer/accept handshake then lands on `from = received`.
 *  - resume-nack: sender -> receiver: it cannot honour a resume-req (the File
 *            object died with a reload, or the identity no longer matches).
 *            The receiver surfaces this honestly instead of showing 0%.
 */
export type FileFrame =
  | {
      k: "offer";
      id: number;
      uid: string;
      name: string;
      size: number;
      mime: string;
      lastModified: number;
      fresh?: boolean;
    }
  | { k: "accept"; id: number; from: number }
  | { k: "ack"; id: number; received: number }
  | { k: "done"; id: number }
  | { k: "cancel"; id: number; by: "sender" | "receiver"; reason?: string }
  | {
      k: "resume-req";
      uid: string;
      name: string;
      size: number;
      mime: string;
      lastModified: number;
      received: number;
    }
  | { k: "resume-nack"; uid: string; reason?: string };

/**
 * Binary chunks are prefixed with the little-endian uint32 transfer id so
 * several files can stream over one channel without interleaving corruption.
 */
export const CHUNK_HEADER_BYTES = 4;

export function frameChunk(transferId: number, chunk: ArrayBuffer): ArrayBuffer {
  const out = new ArrayBuffer(CHUNK_HEADER_BYTES + chunk.byteLength);
  new DataView(out).setUint32(0, transferId, true);
  new Uint8Array(out, CHUNK_HEADER_BYTES).set(new Uint8Array(chunk));
  return out;
}

export function readChunk(buffer: ArrayBuffer): { transferId: number; data: Uint8Array } | null {
  if (buffer.byteLength < CHUNK_HEADER_BYTES) return null;
  return {
    transferId: new DataView(buffer).getUint32(0, true),
    data: new Uint8Array(buffer, CHUNK_HEADER_BYTES),
  };
}
