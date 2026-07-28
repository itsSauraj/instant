import {
  BUFFER_HIGH_WATER,
  BUFFER_LOW_WATER,
  CHUNK_SIZE,
  MAX_RECEIVE_BYTES,
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
  private readonly cancelledOutgoing = new Set<number>();
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
        if (this.cancelledOutgoing.has(id)) {
          this.finish(transfer, "cancelled", "Cancelled by receiver");
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
      this.cancelledOutgoing.add(transfer.id);
      this.send({ k: "cancel", id: transfer.id, by: "sender", reason: "Cancelled by sender" });
      this.finish(transfer, "cancelled", "Cancelled");
    } else {
      this.inbound.delete(transfer.id);
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

      if (frame.size > MAX_RECEIVE_BYTES) {
        this.send({
          k: "cancel",
          id: frame.id,
          by: "receiver",
          reason: `Larger than the ${formatBytes(MAX_RECEIVE_BYTES)} limit`,
        });
        this.callbacks.onError(
          `Declined "${frame.name}" — ${formatBytes(frame.size)} exceeds the ${formatBytes(
            MAX_RECEIVE_BYTES,
          )} receive limit.`,
        );
        return;
      }

      const key = this.key("incoming", frame.id);
      this.transfers.set(key, {
        id: frame.id,
        key,
        direction: "incoming",
        // Never trust a peer-supplied path; keep the basename only.
        name: sanitizeName(frame.name),
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
        this.cancelledOutgoing.add(frame.id);
      } else {
        this.inbound.delete(frame.id);
      }
      const transfer = this.transfers.get(this.key(direction, frame.id));
      if (transfer && transfer.status !== "complete") {
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
      this.inbound.delete(parsed.transferId);
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
    this.callbacks.onChange();
  }

  private completeIncoming(id: number) {
    const chunks = this.inbound.get(id);
    const transfer = this.transfers.get(this.key("incoming", id));
    if (!chunks || !transfer) return;
    this.inbound.delete(id);

    if (transfer.transferred !== transfer.size) {
      this.finish(
        transfer,
        "failed",
        `Incomplete — got ${formatBytes(transfer.transferred)} of ${formatBytes(transfer.size)}`,
      );
      return;
    }

    const blob = new Blob(chunks as BlobPart[], { type: transfer.mime });
    transfer.url = URL.createObjectURL(blob);
    this.finish(transfer, "complete");
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
  }
}

function sanitizeName(name: unknown) {
  if (typeof name !== "string" || !name.trim()) return "untitled";
  return name.replace(/^.*[\\/]/, "").slice(0, 180) || "untitled";
}
