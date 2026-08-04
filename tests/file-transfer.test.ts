import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FileTransferManager,
  createMemorySinkProvider,
  type FileTransferContext,
  type Transfer,
} from "@/lib/file-transfer";
import { ACCEPT_TIMEOUT_MS, MAX_RESUME_REQUESTS_PER_LINK, frameChunk, type FileFrame } from "@/lib/peer-protocol";
import { TRANSFER_LIMITS } from "@/lib/transfer-contract";
import type { PartialStore, StoredPartial } from "@/lib/transfer-store";

// Node exposes URL.createObjectURL for Blob, but guard for leaner runtimes.
if (typeof URL.createObjectURL !== "function") {
  URL.createObjectURL = (() => "blob:fake") as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
}

/**
 * Stand-in for an open RTCDataChannel. `send` records outbound traffic and,
 * when linked to a peer channel, delivers it there on the microtask queue -
 * which is exactly the "async but ordered" behaviour of the real thing.
 */
class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = "open";
  binaryType = "";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent: (string | ArrayBuffer)[] = [];
  peer: FakeDataChannel | null = null;

  send(data: string | ArrayBuffer) {
    if (this.readyState !== "open") throw new Error("Channel is not open");
    this.sent.push(data);
    const peer = this.peer;
    if (peer && peer.readyState === "open") {
      queueMicrotask(() => peer.dispatchEvent(new MessageEvent("message", { data })));
    }
  }

  /** Injects a frame as if the remote peer had sent it. */
  receive(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  frames(): FileFrame[] {
    return this.sent
      .filter((item): item is string => typeof item === "string")
      .map((item) => JSON.parse(item) as FileFrame);
  }

  framesOf<T extends FileFrame["k"]>(k: T) {
    return this.frames().filter((frame): frame is Extract<FileFrame, { k: T }> => frame.k === k);
  }

  asRtc(): RTCDataChannel {
    return this as unknown as RTCDataChannel;
  }
}

function linkChannels(a: FakeDataChannel, b: FakeDataChannel) {
  a.peer = b;
  b.peer = a;
}

const disposables: FileTransferManager[] = [];

function makeManager(channel: FakeDataChannel, context?: Partial<FileTransferContext>) {
  const errors: string[] = [];
  let changes = 0;
  // Each manager gets its own memory provider unless the test overrides it.
  const provider = createMemorySinkProvider();
  const full: FileTransferContext = {
    peerId: "peer-remote",
    peerName: "Remote",
    roomId: "room-1",
    provider: () => provider,
    store: () => null,
    lookupOutgoing: () => undefined,
    ...context,
  };
  const manager = new FileTransferManager(
    channel.asRtc(),
    { onChange: () => changes++, onError: (message) => errors.push(message) },
    full,
  );
  disposables.push(manager);
  return { manager, errors, changed: () => changes };
}

afterEach(() => {
  for (const manager of disposables.splice(0)) manager.dispose();
  vi.useRealTimers();
});

/** Lets queued microtasks and zero-timers run down. */
async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

type OfferFrame = Extract<FileFrame, { k: "offer" }>;

function offerFrame(over: Partial<OfferFrame> = {}): string {
  return JSON.stringify({
    k: "offer",
    id: 1,
    uid: "uid-1",
    name: "file.bin",
    size: 8,
    mime: "application/octet-stream",
    lastModified: 0,
    ...over,
  });
}

function firstTransfer(manager: FileTransferManager): Transfer {
  const list = manager.list();
  expect(list.length).toBeGreaterThan(0);
  return list[0];
}

describe("incoming offer validation", () => {
  it("ignores structurally hostile offers outright", async () => {
    const channel = new FakeDataChannel();
    const { manager } = makeManager(channel);

    channel.receive(offerFrame({ id: -1 }));
    channel.receive(offerFrame({ id: 1.5 }));
    channel.receive(offerFrame({ id: 0x1_0000_0000 })); // beyond the 4-byte header
    channel.receive(offerFrame({ size: -4 }));
    channel.receive(offerFrame({ size: 4.5 }));
    channel.receive(offerFrame({ uid: "" }));
    channel.receive(offerFrame({ uid: "x".repeat(65) }));
    await settle();

    expect(manager.list()).toHaveLength(0);
    expect(channel.sent).toHaveLength(0);
  });

  it("keeps only the basename of a peer-supplied path", async () => {
    const channel = new FakeDataChannel();
    const { manager } = makeManager(channel);

    channel.receive(offerFrame({ name: "..\\..\\windows\\system32\\evil.exe" }));
    await settle();
    expect(firstTransfer(manager).name).toBe("evil.exe");
  });

  it("substitutes untitled for unusable names and caps length", async () => {
    const channel = new FakeDataChannel();
    const { manager } = makeManager(channel);

    channel.receive(offerFrame({ id: 1, uid: "uid-a", name: 42 as unknown as string }));
    channel.receive(offerFrame({ id: 2, uid: "uid-b", name: "x".repeat(300) }));
    await settle();

    const [first, second] = manager.list();
    expect(first.name).toBe("untitled");
    expect(second.name).toHaveLength(180);
  });

  it("declines a duplicate id while the original transfer is live", async () => {
    const channel = new FakeDataChannel();
    const { manager, errors } = makeManager(channel);

    channel.receive(offerFrame());
    await settle();
    channel.receive(offerFrame({ uid: "uid-2", name: "other.bin" }));
    await settle();

    expect(manager.list()).toHaveLength(1);
    expect(errors.some((e) => e.includes("reused transfer id"))).toBe(true);
    // No cancel was sent: while the original lives, a cancel would kill it.
    expect(channel.framesOf("cancel")).toHaveLength(0);
  });
});

describe("admission limits", () => {
  it("declines the offer beyond the concurrent-transfer cap", async () => {
    const channel = new FakeDataChannel();
    const { manager, errors } = makeManager(channel);

    for (let id = 1; id <= TRANSFER_LIMITS.maxActiveIncomingPerPeer + 1; id++) {
      channel.receive(offerFrame({ id, uid: `uid-${id}` }));
    }
    await settle();

    expect(manager.list()).toHaveLength(TRANSFER_LIMITS.maxActiveIncomingPerPeer);
    const cancels = channel.framesOf("cancel");
    expect(cancels).toHaveLength(1);
    expect(cancels[0].id).toBe(TRANSFER_LIMITS.maxActiveIncomingPerPeer + 1);
    expect(errors.some((e) => e.includes("already receiving"))).toBe(true);
  });

  it("declines a single file larger than the memory tier allows", async () => {
    const channel = new FakeDataChannel();
    const { manager, errors } = makeManager(channel);

    channel.receive(offerFrame({ size: TRANSFER_LIMITS.maxMemoryBytes + 1 }));
    await settle();

    expect(manager.list()).toHaveLength(0);
    expect(channel.framesOf("cancel")).toHaveLength(1);
    expect(errors.some((e) => e.includes("exceeds"))).toBe(true);
  });

  it("declines when the aggregate session memory budget would overflow", async () => {
    const channel = new FakeDataChannel();
    const { manager, errors } = makeManager(channel);

    channel.receive(offerFrame({ id: 1, uid: "uid-a", size: TRANSFER_LIMITS.maxMemoryBytes }));
    channel.receive(offerFrame({ id: 2, uid: "uid-b", size: TRANSFER_LIMITS.maxMemoryBytes }));
    channel.receive(offerFrame({ id: 3, uid: "uid-c", size: 1 }));
    await settle();

    expect(manager.list()).toHaveLength(2);
    const cancels = channel.framesOf("cancel");
    expect(cancels).toHaveLength(1);
    expect(cancels[0].id).toBe(3);
    expect(errors.some((e) => e.includes("memory"))).toBe(true);
  });
});

describe("receiving", () => {
  it("accepts, ingests chunks and completes on done", async () => {
    const channel = new FakeDataChannel();
    const { manager } = makeManager(channel);
    const payload = new TextEncoder().encode("hello world");

    channel.receive(offerFrame({ size: payload.byteLength, name: "hello.txt" }));
    await settle();

    const accepts = channel.framesOf("accept");
    expect(accepts).toEqual([{ k: "accept", id: 1, from: 0 }]);
    expect(firstTransfer(manager).status).toBe("active");

    channel.receive(frameChunk(1, payload));
    channel.receive(JSON.stringify({ k: "done", id: 1 }));
    await settle();

    const transfer = firstTransfer(manager);
    expect(transfer.status).toBe("complete");
    expect(transfer.transferred).toBe(payload.byteLength);
    expect(transfer.url).toBeTruthy();
    const acks = channel.framesOf("ack");
    expect(acks[acks.length - 1]).toMatchObject({ id: 1, received: payload.byteLength });
  });

  it("fails a sender that overruns its declared size", async () => {
    const channel = new FakeDataChannel();
    const { manager } = makeManager(channel);

    channel.receive(offerFrame({ size: 4 }));
    await settle();
    channel.receive(frameChunk(1, new Uint8Array(8)));
    await settle();

    const transfer = firstTransfer(manager);
    expect(transfer.status).toBe("failed");
    expect(transfer.error).toContain("declared");
    expect(channel.framesOf("cancel")).toHaveLength(1);
  });

  it("fails an early done honestly instead of finishing short", async () => {
    const channel = new FakeDataChannel();
    const { manager } = makeManager(channel);

    channel.receive(offerFrame({ size: 8 }));
    await settle();
    channel.receive(frameChunk(1, new Uint8Array(4)));
    channel.receive(JSON.stringify({ k: "done", id: 1 }));
    await settle();

    const transfer = firstTransfer(manager);
    expect(transfer.status).toBe("failed");
    expect(transfer.error).toContain("Incomplete");
  });

  it("drops chunks for ids it never accepted", async () => {
    const channel = new FakeDataChannel();
    const { manager } = makeManager(channel);
    channel.receive(frameChunk(99, new Uint8Array(8)));
    await settle();
    expect(manager.list()).toHaveLength(0);
    expect(channel.sent).toHaveLength(0);
  });
});

describe("sending", () => {
  it("fails the transfer when no accept arrives in time", async () => {
    vi.useFakeTimers();
    const channel = new FakeDataChannel();
    const { manager } = makeManager(channel);

    const pending = manager.beginOutgoing(new File([new Uint8Array(4)], "a.bin"), "uid-out");
    await vi.advanceTimersByTimeAsync(ACCEPT_TIMEOUT_MS + 1);

    expect(await pending).toBeNull();
    const transfer = firstTransfer(manager);
    expect(transfer.status).toBe("failed");
    expect(transfer.error).toBe("Receiver did not respond");
    expect(channel.framesOf("cancel")).toHaveLength(1);
  });

  it("refuses an accept offset beyond the file", async () => {
    const channel = new FakeDataChannel();
    const { manager } = makeManager(channel);

    const pending = manager.beginOutgoing(new File([new Uint8Array(4)], "a.bin"), "uid-out");
    await settle();
    channel.receive(JSON.stringify({ k: "accept", id: 1, from: 999 }));

    expect(await pending).toBeNull();
    const transfer = firstTransfer(manager);
    expect(transfer.status).toBe("failed");
    expect(transfer.error).toContain("resume offset");
    expect(channel.framesOf("cancel")[0]).toMatchObject({ reason: "Invalid resume offset" });
  });

  it("applies acks monotonically and never beyond what was sent", async () => {
    const channel = new FakeDataChannel();
    const { manager } = makeManager(channel);

    const pending = manager.beginOutgoing(new File([new Uint8Array(8)], "a.bin"), "uid-out");
    await settle();
    channel.receive(JSON.stringify({ k: "accept", id: 1, from: 0 }));
    const handle = await pending;
    expect(handle).not.toBeNull();

    expect(await handle!.deliver(new Uint8Array(4))).toBe(true);
    const transfer = firstTransfer(manager);
    expect(transfer.transferred).toBe(4);

    channel.receive(JSON.stringify({ k: "ack", id: 1, received: 3 }));
    expect(transfer.confirmedBytes).toBe(3);
    channel.receive(JSON.stringify({ k: "ack", id: 1, received: 2 })); // regression
    expect(transfer.confirmedBytes).toBe(3);
    channel.receive(JSON.stringify({ k: "ack", id: 1, received: 999 })); // beyond sent
    expect(transfer.confirmedBytes).toBe(3);
  });

  it("stops delivering once the receiver cancels", async () => {
    const channel = new FakeDataChannel();
    const { manager } = makeManager(channel);

    const pending = manager.beginOutgoing(new File([new Uint8Array(64)], "a.bin"), "uid-out");
    await settle();
    channel.receive(JSON.stringify({ k: "accept", id: 1, from: 0 }));
    const handle = await pending;

    channel.receive(
      JSON.stringify({ k: "cancel", id: 1, by: "receiver", reason: "Cancelled by receiver" }),
    );
    expect(await handle!.deliver(new Uint8Array(16))).toBe(false);
    expect(firstTransfer(manager).status).toBe("cancelled");
  });
});

describe("resume requests", () => {
  const resumeReq = (uid: string, over: Record<string, unknown> = {}) =>
    JSON.stringify({
      k: "resume-req",
      uid,
      name: "file.bin",
      size: 10,
      mime: "application/octet-stream",
      lastModified: 111,
      received: 5,
      ...over,
    });

  it("nacks resume requests for files it no longer holds", async () => {
    const channel = new FakeDataChannel();
    const missing: string[] = [];
    makeManager(channel, {
      lookupOutgoing: () => undefined,
      onResumeMissing: (info) => void missing.push(info.uid),
    });

    channel.receive(resumeReq("uid-lost"));
    await settle();

    expect(channel.framesOf("resume-nack")).toHaveLength(1);
    expect(missing).toEqual(["uid-lost"]);
  });

  it("caps the resume requests it will act on per link", async () => {
    const channel = new FakeDataChannel();
    makeManager(channel, { lookupOutgoing: () => undefined });

    for (let i = 0; i < MAX_RESUME_REQUESTS_PER_LINK + 5; i++) {
      channel.receive(resumeReq(`uid-${i}`));
    }
    await settle();

    expect(channel.framesOf("resume-nack")).toHaveLength(MAX_RESUME_REQUESTS_PER_LINK);
  });

  it("ignores structurally invalid resume requests without spending budget", async () => {
    const channel = new FakeDataChannel();
    makeManager(channel, { lookupOutgoing: () => undefined });

    channel.receive(resumeReq("bad-1", { received: -1 }));
    channel.receive(resumeReq("bad-2", { received: 11 })); // more than size
    channel.receive(resumeReq("bad-3", { size: 2.5 }));
    channel.receive(resumeReq("", {}));
    await settle();

    expect(channel.framesOf("resume-nack")).toHaveLength(0);
  });

  it("re-offers with the same uid when it still holds the identical file", async () => {
    const channel = new FakeDataChannel();
    const file = new File([new Uint8Array(10)], "file.bin", { lastModified: 111 });
    makeManager(channel, { lookupOutgoing: (uid) => (uid === "uid-keep" ? file : undefined) });

    channel.receive(resumeReq("uid-keep"));
    await settle();

    const offers = channel.framesOf("offer");
    expect(offers).toHaveLength(1);
    expect(offers[0].uid).toBe("uid-keep");
    expect(offers[0].fresh).toBeUndefined();
  });

  it("orders a fresh restart when the file identity no longer matches", async () => {
    const channel = new FakeDataChannel();
    const file = new File([new Uint8Array(10)], "file.bin", { lastModified: 999 });
    makeManager(channel, { lookupOutgoing: () => file });

    channel.receive(resumeReq("uid-changed")); // lastModified 111 vs 999
    await settle();

    const offers = channel.framesOf("offer");
    expect(offers).toHaveLength(1);
    expect(offers[0].fresh).toBe(true);
  });

  it("announces stored partials for this peer when the channel opens", async () => {
    const channel = new FakeDataChannel();
    const partial: StoredPartial = {
      id: "uid-part",
      roomId: "room-1",
      peerName: "Remote",
      name: "big.bin",
      mime: "application/octet-stream",
      size: 100,
      received: 40,
      tier: "memory",
      updatedAt: Date.now(),
      peerId: "peer-remote",
      lastModified: 5,
      hasBytes: true,
    };
    const foreign: StoredPartial = { ...partial, id: "uid-foreign", peerId: "someone-else" };
    const store: PartialStore = {
      list: async () => [partial, foreign],
      get: async () => null,
      put: async () => true,
      appendBytes: async () => true,
      readBytes: async () => null,
      discard: async () => {},
    };
    makeManager(channel, { store: () => store });
    await settle();

    const requests = channel.framesOf("resume-req");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ uid: "uid-part", received: 40 });
  });
});

describe("end to end over linked channels", () => {
  it("streams a multi-chunk file sender to receiver", async () => {
    const wireA = new FakeDataChannel();
    const wireB = new FakeDataChannel();
    linkChannels(wireA, wireB);
    const sender = makeManager(wireA, { peerId: "b", peerName: "B" });
    const receiver = makeManager(wireB, { peerId: "a", peerName: "A" });

    const bytes = new Uint8Array(40_000); // three wire chunks
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    await sender.manager.sendFiles([new File([bytes], "big.bin")]);
    await settle(8);

    const sent = firstTransfer(sender.manager);
    expect(sent.status).toBe("complete");
    expect(sent.transferred).toBe(bytes.length);

    const received = firstTransfer(receiver.manager);
    expect(received.status).toBe("complete");
    expect(received.transferred).toBe(bytes.length);
    expect(received.url).toBeTruthy();

    const binaryFrames = wireA.sent.filter((item) => typeof item !== "string");
    expect(binaryFrames).toHaveLength(Math.ceil(bytes.length / (16 * 1024)));
  });

  it("delivers a zero-byte file with no chunks at all", async () => {
    const wireA = new FakeDataChannel();
    const wireB = new FakeDataChannel();
    linkChannels(wireA, wireB);
    const sender = makeManager(wireA, { peerId: "b", peerName: "B" });
    const receiver = makeManager(wireB, { peerId: "a", peerName: "A" });

    await sender.manager.sendFiles([new File([], "empty.bin")]);
    await settle(8);

    expect(firstTransfer(sender.manager).status).toBe("complete");
    expect(firstTransfer(receiver.manager).status).toBe("complete");
    expect(wireA.sent.filter((item) => typeof item !== "string")).toHaveLength(0);
  });
});

describe("lifecycle", () => {
  it("failAll fails running transfers, and does NOT claim resumable with no store", async () => {
    const channel = new FakeDataChannel();
    // makeManager's default context has `store: () => null`, so nothing durable
    // is kept. Claiming `resumable` here would offer a resume that cannot work,
    // which is worse than admitting the bytes are gone.
    const { manager } = makeManager(channel);

    channel.receive(offerFrame({ size: 8 }));
    await settle();
    channel.receive(frameChunk(1, new Uint8Array(4)));
    await settle();

    manager.failAll("Link lost");
    await settle();

    const transfer = firstTransfer(manager);
    expect(transfer.status).toBe("failed");
    expect(transfer.error).toBe("Link lost");
    expect(transfer.resumable).toBeFalsy();
  });

  // The positive case - a store present, so the partial IS resumable - is
  // covered end to end by scripts/verify-transfer-resume.mjs, which reloads
  // mid-transfer against a real IndexedDB and verifies the reassembled file by
  // checksum. Reproducing it here needs a store double that also satisfies the
  // record/persistBytes invariants, and a wrong double would assert nothing.

  it("dispose clears the inbox and revokes object URLs", async () => {
    const channel = new FakeDataChannel();
    const { manager } = makeManager(channel);
    const revoke = vi.spyOn(URL, "revokeObjectURL");

    const payload = new Uint8Array(4);
    channel.receive(offerFrame({ size: 4 }));
    await settle();
    channel.receive(frameChunk(1, payload));
    channel.receive(JSON.stringify({ k: "done", id: 1 }));
    await settle();
    expect(firstTransfer(manager).url).toBeTruthy();

    manager.dispose();
    expect(manager.list()).toHaveLength(0);
    expect(revoke).toHaveBeenCalledTimes(1);
    revoke.mockRestore();
  });
});
