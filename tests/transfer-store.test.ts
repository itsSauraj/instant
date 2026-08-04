import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRANSFER_LIMITS } from "@/lib/transfer-contract";
import { openTransferStore, type PartialStore, type StoredPartial } from "@/lib/transfer-store";

const ROOM = "room-under-test";

const record = (over: Partial<StoredPartial> = {}): StoredPartial => ({
  id: "uid-1",
  roomId: ROOM,
  peerName: "Peer",
  name: "file.bin",
  mime: "application/octet-stream",
  size: 100,
  received: 0,
  tier: "memory",
  updatedAt: Date.now(),
  peerId: "peer-1",
  lastModified: 1234,
  hasBytes: false,
  ...over,
});

describe("openTransferStore", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("degrades to null when IndexedDB is unavailable", async () => {
    vi.stubGlobal("indexedDB", undefined);
    expect(await openTransferStore(ROOM)).toBeNull();
  });

  it("opens a store when IndexedDB exists", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    expect(await openTransferStore(ROOM)).not.toBeNull();
  });
});

describe("PartialStore", () => {
  let store: PartialStore;

  beforeEach(async () => {
    // A fresh factory per test: no cross-test leakage, no cleanup needed.
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    const opened = await openTransferStore(ROOM);
    expect(opened).not.toBeNull();
    store = opened!;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips a metadata record", async () => {
    const row = record({ received: 42 });
    expect(await store.put(row)).toBe(true);
    expect(await store.get("uid-1")).toMatchObject({ id: "uid-1", received: 42 });
  });

  it("returns null for unknown ids", async () => {
    expect(await store.get("nope")).toBeNull();
  });

  it("scopes reads to the store's room", async () => {
    await store.put(record({ id: "other-room", roomId: "some-other-room" }));
    expect(await store.get("other-room")).toBeNull();
  });

  it("treats records past the TTL as gone", async () => {
    await store.put(record({ updatedAt: Date.now() - TRANSFER_LIMITS.partialTtlMs - 1000 }));
    expect(await store.get("uid-1")).toBeNull();
  });

  it("lists this room's fresh records newest first", async () => {
    const now = Date.now();
    await store.put(record({ id: "old", updatedAt: now - 5000 }));
    await store.put(record({ id: "new", updatedAt: now }));
    await store.put(record({ id: "elsewhere", roomId: "other", updatedAt: now }));
    await store.put(
      record({ id: "stale", updatedAt: now - TRANSFER_LIMITS.partialTtlMs - 1000 }),
    );

    const listed = await store.list();
    expect(listed.map((r) => r.id)).toEqual(["new", "old"]);
  });

  it("prunes stale records while listing, not just filters them", async () => {
    const past = Date.now() - TRANSFER_LIMITS.partialTtlMs - 60_000;
    await store.put(record({ id: "stale", updatedAt: past }));
    await store.list();

    // Rewind only the clock (IndexedDB still needs real timers): if the row
    // had merely been filtered it would read as fresh now; deletion is null.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(past + 1000);
    try {
      expect(await store.get("stale")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps records per room, evicting the oldest", async () => {
    const now = Date.now();
    for (let i = 0; i < 35; i++) {
      await store.put(record({ id: `uid-${i}`, updatedAt: now - i * 1000 }));
    }

    const listed = await store.list();
    expect(listed).toHaveLength(32);
    // uid-0 is newest; uid-32..34 are the three oldest and must be evicted.
    expect(listed[0].id).toBe("uid-0");
    expect(await store.get("uid-34")).toBeNull();
    expect(await store.get("uid-31")).not.toBeNull();
  });

  it("appends byte windows atomically with the metadata", async () => {
    const first = new Uint8Array([1, 2, 3]);
    const second = new Uint8Array([4, 5]);

    expect(await store.appendBytes(record({ received: 3, hasBytes: true }), 0, first)).toBe(true);
    expect(await store.appendBytes(record({ received: 5, hasBytes: true }), 1, second)).toBe(
      true,
    );

    expect((await store.get("uid-1"))?.received).toBe(5);
    const windows = await store.readBytes("uid-1", 5);
    expect(windows).not.toBeNull();
    expect(windows!.map((w) => [...w])).toEqual([
      [1, 2, 3],
      [4, 5],
    ]);
  });

  it("copies the window so later mutation cannot corrupt stored bytes", async () => {
    const bytes = new Uint8Array([9, 9, 9]);
    await store.appendBytes(record({ received: 3, hasBytes: true }), 0, bytes);
    bytes.fill(0);
    const windows = await store.readBytes("uid-1", 3);
    expect([...windows![0]]).toEqual([9, 9, 9]);
  });

  it("refuses to return bytes that do not add up", async () => {
    await store.appendBytes(record({ received: 3, hasBytes: true }), 0, new Uint8Array(3));
    expect(await store.readBytes("uid-1", 99)).toBeNull();
  });

  it("refuses torn windows with a gap in the sequence", async () => {
    await store.appendBytes(record({ received: 3, hasBytes: true }), 0, new Uint8Array(3));
    await store.appendBytes(record({ received: 6, hasBytes: true }), 2, new Uint8Array(3));
    expect(await store.readBytes("uid-1", 6)).toBeNull();
  });

  it("discard removes the record and its bytes, and tolerates unknown ids", async () => {
    await store.appendBytes(record({ received: 3, hasBytes: true }), 0, new Uint8Array(3));
    await store.discard("uid-1");

    expect(await store.get("uid-1")).toBeNull();
    expect(await store.readBytes("uid-1", 3)).toBeNull();
    await expect(store.discard("never-existed")).resolves.toBeUndefined();
  });
});
