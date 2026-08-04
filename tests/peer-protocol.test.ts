import { describe, expect, it } from "vitest";
import { CHUNK_HEADER_BYTES, frameChunk, readChunk } from "@/lib/peer-protocol";

describe("frameChunk / readChunk", () => {
  it("round-trips a payload with its transfer id", () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const framed = frameChunk(7, payload);

    expect(framed.byteLength).toBe(CHUNK_HEADER_BYTES + payload.byteLength);
    const parsed = readChunk(framed);
    expect(parsed).not.toBeNull();
    expect(parsed!.transferId).toBe(7);
    expect([...parsed!.data]).toEqual([1, 2, 3, 4, 5]);
  });

  it("accepts a plain ArrayBuffer as the chunk", () => {
    const buffer = new Uint8Array([9, 8, 7]).buffer;
    const parsed = readChunk(frameChunk(1, buffer));
    expect([...parsed!.data]).toEqual([9, 8, 7]);
  });

  it("frames a subarray view without dragging in its backing buffer", () => {
    const backing = new Uint8Array([0, 0, 42, 43, 0, 0]);
    const view = backing.subarray(2, 4);
    const parsed = readChunk(frameChunk(3, view));
    expect([...parsed!.data]).toEqual([42, 43]);
    expect(parsed!.data.byteLength).toBe(2);
  });

  it("writes the id little-endian so both sides agree byte for byte", () => {
    const framed = frameChunk(0x01020304, new Uint8Array(0));
    expect([...new Uint8Array(framed)]).toEqual([0x04, 0x03, 0x02, 0x01]);
  });

  it("survives the full uint32 id range the 4-byte header allows", () => {
    const parsed = readChunk(frameChunk(0xffffffff, new Uint8Array([1])));
    expect(parsed!.transferId).toBe(0xffffffff);
  });

  it("handles an empty payload", () => {
    const parsed = readChunk(frameChunk(5, new Uint8Array(0)));
    expect(parsed!.transferId).toBe(5);
    expect(parsed!.data.byteLength).toBe(0);
  });

  it("rejects buffers shorter than the header instead of misreading them", () => {
    expect(readChunk(new ArrayBuffer(0))).toBeNull();
    expect(readChunk(new ArrayBuffer(CHUNK_HEADER_BYTES - 1))).toBeNull();
  });
});
