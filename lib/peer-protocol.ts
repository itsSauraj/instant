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

export const MAX_NOTE_LENGTH = 4000;

export type NoteFrame =
  | { k: "note"; id: string; text: string; at: number }
  | { k: "typing"; on: boolean };

export type FileFrame =
  | { k: "offer"; id: number; name: string; size: number; mime: string }
  | { k: "done"; id: number }
  | { k: "cancel"; id: number; by: "sender" | "receiver"; reason?: string };

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
