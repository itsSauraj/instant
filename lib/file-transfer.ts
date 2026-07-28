import {
  BUFFER_HIGH_WATER,
  BUFFER_LOW_WATER,
  CHUNK_SIZE,
  MAX_ACTIVE_INCOMING_TRANSFERS,
  MAX_RECEIVE_BYTES,
  MAX_SESSION_RECEIVE_BYTES,
  frameChunk,
  readChunk,
  type FileFrame,
} from "@/lib/peer-protocol";
import { formatBytes } from "@/lib/utils";

export type TransferDirection = "outgoing" | "incoming";
export type TransferStatus = "pending" | "active" | "complete" | "cancelled" | "failed";

export type Transfer = {
  id: number;
  key: string;
  direction: TransferDirection;
  name: string;
  size: number;
  mime: string;
  transferred: number;
  status: TransferStatus;
  error?: string;
  /** Object URL for a completed incoming file; revoked on reset. */
  url?: string;
  /** Set for images so the UI can show a thumbnail without extra work. */
  isImage: boolean;
  startedAt: number;
  completedAt?: number;
};

type Callbacks = {
  onChange: () => void;
  onError: (message: string) => void;
};

const isImageMime = (mime: string) => mime.startsWith("image/");

/**
 * Owns the `files` data channel: chunking, backpressure, reassembly and
 * cancellation in both directions.
 *
 * Transfer ids are namespaced by direction (`out:1`, `in:1`) because both peers
 * number their own sends from 1 and the two sequences are independent.
 */
export class FileTransferManager {
  private readonly transfers = new Map<string, Transfer>();
  /** Chunk buffers for in-flight incoming transfers, keyed by remote id. */
  private readonly inbound = new Map<number, Uint8Array[]>();
  /** Outgoing ids the send loop must abandon, and who asked for it. */
  private readonly cancelledOutgoing = new Map<number, "local" | "remote">();
  /**
   * Bytes currently held from incoming transfers: buffered chunks of active
   * ones plus the Blobs of completed ones (those stay resident until
   * `dispose()` revokes their object URLs).
   */
  private inboundHeldBytes = 0;
  private nextId = 1;
  private disposed = false;

  constructor(
    private channel: RTCDataChannel,
    private readonly callbacks: Callbacks,
  ) {
    this.channel.binaryType = "arraybuffer";
    this.channel.bufferedAmountLowThreshold = BUFFER_LOW_WATER;
    this.channel.addEventListener("message", this.handleMessage);
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

  async sendFiles(files: File[]) {
    // Sequential on purpose: one file saturates the channel, and serialising
    // keeps per-file progress honest instead of showing three stalled bars.
    for (const file of files) {
      if (this.disposed) return;
      await this.sendFile(file);
    }
  }

  private async sendFile(file: File) {
    const id = this.nextId++;
    const key = this.key("outgoing", id);
    const transfer: Transfer = {
      id,
      key,
      direction: "outgoing",
      name: file.name,
      size: file.size,
      mime: file.type || "application/octet-stream",
      transferred: 0,
      status: "pending",
      isImage: isImageMime(file.type),
      startedAt: Date.now(),
    };
    this.transfers.set(key, transfer);
    this.callbacks.onChange();

    this.send({ k: "offer", id, name: transfer.name, size: file.size, mime: transfer.mime });

    transfer.status = "active";
    this.callbacks.onChange();

    try {
      let offset = 0;
      // Zero-byte files still need to complete, hence the do/while shape.
      while (offset < file.size || (file.size === 0 && offset === 0)) {
        if (this.disposed) return;
        const cancelledBy = this.cancelledOutgoing.get(id);
        if (cancelledBy !== undefined) {
          // `cancel()` / the remote cancel frame already finished the record
          // with the right attribution; never overwrite that. Label a
          // straggler correctly if it somehow was not finished yet.
          // (Widen: TS narrows `status` to "active" after the assignment
          // above, but cancel paths mutate it behind our back.)
          const status = transfer.status as TransferStatus;
          if (status === "pending" || status === "active") {
            this.finish(
              transfer,
              "cancelled",
              cancelledBy === "local" ? "Cancelled" : "Cancelled by receiver",
            );
          }
          return;
        }
        if (this.channel.readyState !== "open") {
          throw new Error("Channel closed mid-transfer");
        }

        await this.drain();
        if (this.disposed || this.cancelledOutgoing.has(id)) continue;

        const slice = file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size));
        const buffer = await slice.arrayBuffer();
        this.channel.send(frameChunk(id, buffer));

        offset += buffer.byteLength;
        transfer.transferred = offset;
        this.callbacks.onChange();

        if (file.size === 0) break;
      }

      this.send({ k: "done", id });
      this.finish(transfer, "complete");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Transfer failed";
      this.send({ k: "cancel", id, by: "sender", reason: message });
      this.finish(transfer, "failed", message);
      this.callbacks.onError(`Could not send ${transfer.name}: ${message}`);
    } finally {
      this.cancelledOutgoing.delete(id);
    }
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
      this.finish(transfer, "cancelled", "Cancelled");
    } else {
      this.releaseInbound(transfer.id);
      this.send({ k: "cancel", id: transfer.id, by: "receiver", reason: "Cancelled by receiver" });
      this.finish(transfer, "cancelled", "Cancelled");
    }
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
    if (frame.k === "offer") {
      if (typeof frame.id !== "number" || typeof frame.size !== "number" || frame.size < 0) return;

      // Never trust a peer-supplied path; keep the basename only.
      const name = sanitizeName(frame.name);
      const key = this.key("incoming", frame.id);

      const existing = this.transfers.get(key);
      if (existing) {
        // A well-behaved sender never reuses an id; accepting would orphan
        // the previous record and leak its object URL. Only answer with a
        // cancel frame when the original is finished — while it is still
        // live, a cancel for this id would abort the original transfer.
        if (existing.status !== "active" && existing.status !== "pending") {
          this.send({
            k: "cancel",
            id: frame.id,
            by: "receiver",
            reason: "Transfer id already used",
          });
        }
        this.callbacks.onError(`Declined "${name}" — the peer reused transfer id ${frame.id}.`);
        return;
      }

      if (frame.size > MAX_RECEIVE_BYTES) {
        this.send({
          k: "cancel",
          id: frame.id,
          by: "receiver",
          reason: `Larger than the ${formatBytes(MAX_RECEIVE_BYTES)} limit`,
        });
        this.callbacks.onError(
          `Declined "${name}" — ${formatBytes(frame.size)} exceeds the ${formatBytes(
            MAX_RECEIVE_BYTES,
          )} receive limit.`,
        );
        return;
      }

      if (this.inbound.size >= MAX_ACTIVE_INCOMING_TRANSFERS) {
        this.send({
          k: "cancel",
          id: frame.id,
          by: "receiver",
          reason: `More than ${MAX_ACTIVE_INCOMING_TRANSFERS} simultaneous transfers`,
        });
        this.callbacks.onError(
          `Declined "${name}" — already receiving ${MAX_ACTIVE_INCOMING_TRANSFERS} files. ` +
            `Ask the sender to retry once the current transfers finish.`,
        );
        return;
      }

      // Memory this session is already committed to: bytes held right now
      // (buffered chunks plus completed Blobs awaiting dispose) plus the
      // still-unreceived remainder of every active incoming transfer.
      let committed = this.inboundHeldBytes;
      for (const t of this.transfers.values()) {
        if (t.direction === "incoming" && t.status === "active") {
          committed += t.size - t.transferred;
        }
      }
      if (committed + frame.size > MAX_SESSION_RECEIVE_BYTES) {
        this.send({
          k: "cancel",
          id: frame.id,
          by: "receiver",
          reason: `Receive memory budget of ${formatBytes(MAX_SESSION_RECEIVE_BYTES)} exhausted`,
        });
        this.callbacks.onError(
          `Declined "${name}" — accepting ${formatBytes(frame.size)} would exceed the ` +
            `${formatBytes(MAX_SESSION_RECEIVE_BYTES)} this session can hold in memory. ` +
            `Save your received files and start a new session, then retry.`,
        );
        return;
      }

      this.transfers.set(key, {
        id: frame.id,
        key,
        direction: "incoming",
        name,
        size: frame.size,
        mime: frame.mime || "application/octet-stream",
        transferred: 0,
        status: "active",
        isImage: isImageMime(frame.mime ?? ""),
        startedAt: Date.now(),
      });
      this.inbound.set(frame.id, []);
      this.callbacks.onChange();
      return;
    }

    if (frame.k === "done") {
      this.completeIncoming(frame.id);
      return;
    }

    if (frame.k === "cancel") {
      // `by` describes who initiated it, so the *other* side's record is ours.
      const direction: TransferDirection = frame.by === "sender" ? "incoming" : "outgoing";
      if (direction === "outgoing") {
        this.cancelledOutgoing.set(frame.id, "remote");
      } else {
        this.releaseInbound(frame.id);
      }
      const transfer = this.transfers.get(this.key(direction, frame.id));
      // Only records still running: a record we already finished locally
      // (e.g. the user's own cancel) keeps its original attribution.
      if (transfer && (transfer.status === "pending" || transfer.status === "active")) {
        this.finish(transfer, "cancelled", frame.reason ?? "Cancelled by peer");
      }
    }
  }

  private handleChunk(buffer: ArrayBuffer) {
    const parsed = readChunk(buffer);
    if (!parsed) return;

    const chunks = this.inbound.get(parsed.transferId);
    const transfer = this.transfers.get(this.key("incoming", parsed.transferId));
    // Unknown or already-cancelled transfer: drop the bytes on the floor.
    if (!chunks || !transfer || transfer.status !== "active") return;

    if (transfer.transferred + parsed.data.byteLength > transfer.size) {
      this.releaseInbound(parsed.transferId);
      this.send({
        k: "cancel",
        id: parsed.transferId,
        by: "receiver",
        reason: "Sent more data than declared",
      });
      this.finish(transfer, "failed", "Sender exceeded the declared file size");
      return;
    }

    // Copy: the received buffer is only ours until the next message.
    chunks.push(new Uint8Array(parsed.data));
    transfer.transferred += parsed.data.byteLength;
    this.inboundHeldBytes += parsed.data.byteLength;
    this.callbacks.onChange();
  }

  private completeIncoming(id: number) {
    const chunks = this.inbound.get(id);
    const transfer = this.transfers.get(this.key("incoming", id));
    if (!chunks || !transfer) return;

    if (transfer.transferred !== transfer.size) {
      this.releaseInbound(id);
      this.finish(
        transfer,
        "failed",
        `Incomplete — got ${formatBytes(transfer.transferred)} of ${formatBytes(transfer.size)}`,
      );
      return;
    }

    // The chunk buffers become the Blob, which occupies the same bytes, so
    // `inboundHeldBytes` keeps counting them until dispose() releases it.
    this.inbound.delete(id);
    const blob = new Blob(chunks as BlobPart[], { type: transfer.mime });
    transfer.url = URL.createObjectURL(blob);
    this.finish(transfer, "complete");
  }

  /**
   * Drops an in-flight incoming transfer's chunk buffers and returns their
   * bytes to the receive budget. Safe to call for ids that hold no buffers.
   */
  private releaseInbound(id: number) {
    const chunks = this.inbound.get(id);
    if (!chunks) return;
    this.inbound.delete(id);
    for (const chunk of chunks) this.inboundHeldBytes -= chunk.byteLength;
  }

  private finish(transfer: Transfer, status: TransferStatus, error?: string) {
    transfer.status = status;
    transfer.error = error;
    transfer.completedAt = Date.now();
    if (status === "complete") transfer.transferred = transfer.size;
    this.callbacks.onChange();
  }

  // ------------------------------------------------------------- lifecycle

  /** Marks everything still running as failed — used when the channel drops. */
  failAll(reason: string) {
    for (const transfer of this.transfers.values()) {
      if (transfer.status === "pending" || transfer.status === "active") {
        if (transfer.direction === "incoming") this.releaseInbound(transfer.id);
        this.finish(transfer, "failed", reason);
      }
    }
  }

  /** Releases every object URL. Without this a session leaks its whole inbox. */
  dispose() {
    this.disposed = true;
    this.channel.removeEventListener("message", this.handleMessage);
    for (const transfer of this.transfers.values()) {
      if (transfer.url) URL.revokeObjectURL(transfer.url);
    }
    this.transfers.clear();
    this.inbound.clear();
    this.cancelledOutgoing.clear();
    this.inboundHeldBytes = 0;
  }
}

function sanitizeName(name: unknown) {
  if (typeof name !== "string" || !name.trim()) return "untitled";
  return name.replace(/^.*[\\/]/, "").slice(0, 180) || "untitled";
}
