import { afterEach, describe, expect, it, vi } from "vitest";
import {
  answerKnock,
  closeRoom,
  leaveRoom,
  moderate,
  openStream,
  relaySignal,
  removePeer,
  setCapacity,
  setPin,
  setVisibility,
  streamAborted,
  transferHost,
  type Connection,
} from "@/lib/server/rooms";
import {
  SIGNAL_LIMITS,
  type ModerationAction,
  type RoomVisibility,
  type ServerEvent,
  type SignalPayload,
} from "@/lib/signal-protocol";

/**
 * The registry is process-global (it survives dev-server reloads by design),
 * so every test uses a fresh room id instead of trying to reset shared state.
 */
let roomCounter = 0;
const freshRoomId = () => `testroom${++roomCounter}`;

type TestStream = {
  events: ServerEvent[];
  disconnected: boolean;
  handlers: { emit: (event: ServerEvent) => void; disconnect: () => void };
};

function makeStream(): TestStream {
  const stream: TestStream = {
    events: [],
    disconnected: false,
    handlers: {
      emit: (event) => stream.events.push(event),
      disconnect: () => {
        stream.disconnected = true;
      },
    },
  };
  return stream;
}

function eventsOf<T extends ServerEvent["t"]>(stream: TestStream, t: T) {
  return stream.events.filter((event): event is Extract<ServerEvent, { t: T }> => event.t === t);
}

function lastWelcome(stream: TestStream) {
  const welcomes = eventsOf(stream, "welcome");
  expect(welcomes.length).toBeGreaterThan(0);
  return welcomes[welcomes.length - 1];
}

type Seat = {
  stream: TestStream;
  conn: Connection;
  id: string;
  secret: string;
  resumeToken: string;
};

function seatFrom(stream: TestStream, conn: Connection): Seat {
  const welcome = lastWelcome(stream);
  return {
    stream,
    conn,
    id: welcome.self.id,
    secret: welcome.secret,
    resumeToken: welcome.resumeToken,
  };
}

/** First arrival founds the room and is seated as host. */
function found(
  roomId: string,
  name = "Host",
  uid = "",
  visibility: RoomVisibility = "private",
): Seat {
  const stream = makeStream();
  const conn = openStream(roomId, { name, resumeToken: null, uid, visibility }, stream.handlers);
  return seatFrom(stream, conn);
}

/** A later arrival. Knocks on a private room; walks into a public one. */
function knock(roomId: string, name = "Guest", uid = "") {
  const stream = makeStream();
  const conn = openStream(roomId, { name, resumeToken: null, uid }, stream.handlers);
  return { stream, conn };
}

/** Knocks and has the host admit; returns the seated guest. */
function join(roomId: string, host: Seat, name = "Guest", uid = ""): Seat {
  const joiner = knock(roomId, name, uid);
  const knocks = eventsOf(host.stream, "knock");
  const knockId = knocks[knocks.length - 1].knockId;
  const result = answerKnock(roomId, host.id, host.secret, knockId, true);
  expect(result).toEqual({ ok: true });
  return seatFrom(joiner.stream, joiner.conn);
}

const payload: SignalPayload = { kind: "candidate", candidate: null };

afterEach(() => {
  vi.useRealTimers();
});

describe("founding and knocking", () => {
  it("seats the first arrival as host with the default capacity, private by default", () => {
    const host = found(freshRoomId());
    const welcome = lastWelcome(host.stream);
    expect(welcome.self.isHost).toBe(true);
    expect(welcome.resumed).toBe(false);
    expect(welcome.capacity).toBe(2);
    expect(welcome.visibility).toBe("private");
    expect(welcome.roster).toHaveLength(1);
    expect(welcome.secret).not.toBe("");
    expect(welcome.resumeToken).not.toBe("");
  });

  it("accepts any valid code as a room, custom codes included", () => {
    const host = found("my-team-standup");
    expect(lastWelcome(host.stream).self.isHost).toBe(true);
    const joiner = knock("my-team-standup", "Ada");
    expect(eventsOf(joiner.stream, "waiting-approval")).toHaveLength(1);
  });

  it("queues later arrivals as knocks the host hears about", () => {
    const roomId = freshRoomId();
    const host = found(roomId);
    const joiner = knock(roomId, "Ada");

    expect(eventsOf(joiner.stream, "waiting-approval")).toHaveLength(1);
    const knocks = eventsOf(host.stream, "knock");
    expect(knocks).toHaveLength(1);
    expect(knocks[0].name).toBe("Ada");
    expect(joiner.conn.phase).toBe("knocking");
  });

  it("names blank joiners Guest N in arrival order", () => {
    const roomId = freshRoomId();
    const host = found(roomId);
    knock(roomId, "");
    knock(roomId, "");
    const knocks = eventsOf(host.stream, "knock");
    expect(knocks.map((k) => k.name)).toEqual(["Guest 1", "Guest 2"]);
  });

  it("admitting seats the knocker and tells everyone", () => {
    const roomId = freshRoomId();
    const host = found(roomId);
    const guest = join(roomId, host, "Ada");

    const welcome = lastWelcome(guest.stream);
    expect(welcome.self.isHost).toBe(false);
    expect(welcome.roster).toHaveLength(2);
    expect(eventsOf(host.stream, "peer-joined")).toHaveLength(1);
    expect(guest.conn.phase).toBe("seated");
  });

  it("denying ends the knocker with rejected", () => {
    const roomId = freshRoomId();
    const host = found(roomId);
    const joiner = knock(roomId);
    const knockId = eventsOf(host.stream, "knock")[0].knockId;

    expect(answerKnock(roomId, host.id, host.secret, knockId, false)).toEqual({ ok: true });
    expect(eventsOf(joiner.stream, "ended")[0]?.reason).toBe("rejected");
    expect(joiner.stream.disconnected).toBe(true);
  });

  it("rejects answers to knocks that no longer exist", () => {
    const roomId = freshRoomId();
    const host = found(roomId);
    expect(answerKnock(roomId, host.id, host.secret, "nope", true)).toEqual({
      ok: false,
      error: "unknown-knock",
    });
  });

  it("turns a joiner away when the room is at capacity", () => {
    const roomId = freshRoomId();
    const host = found(roomId);
    join(roomId, host);

    const third = knock(roomId);
    expect(eventsOf(third.stream, "ended")[0]?.reason).toBe("room-full");
    expect(third.conn.phase).toBe("done");
    expect(third.stream.disconnected).toBe(true);
  });

  it("still resolves a knock that waited until the room filled", () => {
    const roomId = freshRoomId();
    const host = found(roomId);
    const ada = knock(roomId, "Ada");
    const bob = knock(roomId, "Bob");
    const knocks = eventsOf(host.stream, "knock");

    expect(answerKnock(roomId, host.id, host.secret, knocks[0].knockId, true)).toEqual({
      ok: true,
    });
    // The second admit is answered honestly even though Ada took the last seat.
    expect(answerKnock(roomId, host.id, host.secret, knocks[1].knockId, true)).toEqual({
      ok: true,
    });
    expect(eventsOf(ada.stream, "welcome")).toHaveLength(1);
    expect(eventsOf(bob.stream, "ended")[0]?.reason).toBe("room-full");
  });
});

describe("public rooms", () => {
  it("seats later arrivals immediately, without a knock", () => {
    const roomId = freshRoomId();
    const host = found(roomId, "Host", "", "public");
    expect(lastWelcome(host.stream).visibility).toBe("public");

    const walkIn = knock(roomId, "Ada");
    expect(eventsOf(walkIn.stream, "waiting-approval")).toHaveLength(0);
    expect(eventsOf(host.stream, "knock")).toHaveLength(0);

    const welcome = lastWelcome(walkIn.stream);
    expect(welcome.self.isHost).toBe(false);
    expect(welcome.self.name).toBe("Ada");
    expect(welcome.visibility).toBe("public");
    expect(welcome.roster).toHaveLength(2);
    expect(walkIn.conn.phase).toBe("seated");
    expect(eventsOf(host.stream, "peer-joined")).toHaveLength(1);
  });

  it("still enforces capacity on walk-ins", () => {
    const roomId = freshRoomId();
    found(roomId, "Host", "", "public");
    knock(roomId, "Ada");

    const third = knock(roomId, "Bob");
    expect(eventsOf(third.stream, "ended")[0]?.reason).toBe("room-full");
    expect(third.conn.phase).toBe("done");
  });

  it("ignores a joiner's visibility request on an existing room", () => {
    const roomId = freshRoomId();
    const host = found(roomId); // private
    const stream = makeStream();
    openStream(
      roomId,
      { name: "Sneaky", resumeToken: null, uid: "", visibility: "public" },
      stream.handlers,
    );
    expect(eventsOf(stream, "waiting-approval")).toHaveLength(1);
    expect(eventsOf(stream, "welcome")).toHaveLength(0);
    const rosters = eventsOf(host.stream, "roster");
    expect(rosters.every((event) => event.visibility === "private")).toBe(true);
  });

  it("lets a walk-in leave and reload like any other member", () => {
    const roomId = freshRoomId();
    const host = found(roomId, "Host", "", "public");
    const walkIn = knock(roomId, "Ada");
    const seat = seatFrom(walkIn.stream, walkIn.conn);

    streamAborted(seat.conn);
    expect(eventsOf(host.stream, "peer-away")[0]).toMatchObject({ peerId: seat.id, away: true });

    const back = makeStream();
    openStream(roomId, { name: "Ada", resumeToken: seat.resumeToken, uid: "" }, back.handlers);
    expect(lastWelcome(back).resumed).toBe(true);
    expect(lastWelcome(back).self.id).toBe(seat.id);
  });
});

describe("visibility changes", () => {
  it("is host-only and echoed to everyone through the roster", () => {
    const roomId = freshRoomId();
    const host = found(roomId);
    const guest = join(roomId, host);

    expect(setVisibility(roomId, guest.id, guest.secret, "public")).toEqual({
      ok: false,
      error: "forbidden",
    });

    expect(setVisibility(roomId, host.id, host.secret, "public")).toEqual({ ok: true });
    for (const stream of [host.stream, guest.stream]) {
      const rosters = eventsOf(stream, "roster");
      expect(rosters[rosters.length - 1].visibility).toBe("public");
    }
  });

  it("opening the room seats everyone already waiting, in arrival order", () => {
    const roomId = freshRoomId();
    const host = found(roomId);
    setCapacity(roomId, host.id, host.secret, 3);
    const ada = knock(roomId, "Ada");
    const bob = knock(roomId, "Bob");
    expect(eventsOf(host.stream, "knock")).toHaveLength(2);

    expect(setVisibility(roomId, host.id, host.secret, "public")).toEqual({ ok: true });

    expect(lastWelcome(ada.stream).self.name).toBe("Ada");
    expect(lastWelcome(bob.stream).self.name).toBe("Bob");
    expect(ada.conn.phase).toBe("seated");
    expect(bob.conn.phase).toBe("seated");
    expect(lastWelcome(ada.stream).self.joinedAt).toBeLessThanOrEqual(
      lastWelcome(bob.stream).self.joinedAt,
    );

    // Whoever was seated by the flip appears on the host's roster.
    const rosters = eventsOf(host.stream, "roster");
    const latest = rosters[rosters.length - 1];
    expect(latest.roster.map((p) => p.name).sort()).toEqual(["Ada", "Bob", "Host"]);
    expect(latest.visibility).toBe("public");
  });

  it("turns away the waiting knockers that do not fit when the room is opened", () => {
    const roomId = freshRoomId();
    const host = found(roomId); // capacity 2: one free seat
    const ada = knock(roomId, "Ada");
    const bob = knock(roomId, "Bob");

    setVisibility(roomId, host.id, host.secret, "public");

    expect(eventsOf(ada.stream, "welcome")).toHaveLength(1);
    expect(eventsOf(bob.stream, "ended")[0]?.reason).toBe("room-full");
    expect(bob.stream.disconnected).toBe(true);
    // The knock is resolved either way; nothing lingers for the host.
    const knocks = eventsOf(host.stream, "knock");
    expect(
      answerKnock(roomId, host.id, host.secret, knocks[1].knockId, true),
    ).toEqual({ ok: false, error: "unknown-knock" });
  });

  it("closing the room back down makes new arrivals knock and removes nobody", () => {
    const roomId = freshRoomId();
    const host = found(roomId, "Host", "", "public");
    setCapacity(roomId, host.id, host.secret, 3);
    const walkIn = knock(roomId, "Ada");
    expect(eventsOf(walkIn.stream, "welcome")).toHaveLength(1);

    expect(setVisibility(roomId, host.id, host.secret, "private")).toEqual({ ok: true });
    expect(eventsOf(walkIn.stream, "ended")).toHaveLength(0);

    const late = knock(roomId, "Bob");
    expect(eventsOf(late.stream, "waiting-approval")).toHaveLength(1);
    expect(eventsOf(host.stream, "knock")[0]?.name).toBe("Bob");
  });

  it("survives a host handover: the new host holds the toggle", () => {
    const roomId = freshRoomId();
    const host = found(roomId);
    const guest = join(roomId, host);

    transferHost(roomId, host.id, host.secret, guest.id);
    expect(setVisibility(roomId, host.id, host.secret, "public")).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(setVisibility(roomId, guest.id, guest.secret, "public")).toEqual({ ok: true });
  });
});

describe("authentication", () => {
  it("distinguishes unknown room, non-member and bad secret", () => {
    const roomId = freshRoomId();
    const host = found(roomId);

    expect(relaySignal("no-such-room", host.id, host.secret, "x", payload)).toEqual({
      ok: false,
      error: "unknown-room",
    });
    expect(relaySignal(roomId, "stranger", host.secret, "x", payload)).toEqual({
      ok: false,
      error: "not-member",
    });
    expect(relaySignal(roomId, host.id, "wrong-secret", "x", payload)).toEqual({
      ok: false,
      error: "unauthorized",
    });
  });

  it("refuses every host-only action for a guest", () => {
    const roomId = freshRoomId();
    const host = found(roomId);
    const guest = join(roomId, host);
    const forbidden = { ok: false, error: "forbidden" };

    expect(closeRoom(roomId, guest.id, guest.secret)).toEqual(forbidden);
    expect(answerKnock(roomId, guest.id, guest.secret, "k", true)).toEqual(forbidden);
    expect(setCapacity(roomId, guest.id, guest.secret, 3)).toEqual(forbidden);
    expect(setVisibility(roomId, guest.id, guest.secret, "public")).toEqual(forbidden);
    expect(removePeer(roomId, guest.id, guest.secret, host.id)).toEqual(forbidden);
    expect(transferHost(roomId, guest.id, guest.secret, host.id)).toEqual(forbidden);
    expect(setPin(roomId, guest.id, guest.secret, host.id)).toEqual(forbidden);
    expect(moderate(roomId, guest.id, guest.secret, host.id, "mute-audio")).toEqual(forbidden);
  });
});

describe("signalling relay", () => {
  it("delivers to exactly the addressed member", () => {
    const roomId = freshRoomId();
    const host = found(roomId);
    setCapacity(roomId, host.id, host.secret, 3);
    const a = join(roomId, host, "A");
    const b = join(roomId, host, "B");

    expect(relaySignal(roomId, host.id, host.secret, a.id, payload)).toEqual({ ok: true });

    const delivered = eventsOf(a.stream, "signal");
    expect(delivered).toHaveLength(1);
    expect(delivered[0].from).toBe(host.id);
    expect(delivered[0].data).toEqual(payload);
    expect(eventsOf(b.stream, "signal")).toHaveLength(0);
    expect(eventsOf(host.stream, "signal")).toHaveLength(0);
  });

  it("rejects self-addressed and unknown targets", () => {
    const roomId = freshRoomId();
    const host = found(roomId);
    expect(relaySignal(roomId, host.id, host.secret, host.id, payload)).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(relaySignal(roomId, host.id, host.secret, "ghost", payload)).toEqual({
      ok: false,
      error: "unknown-peer",
    });
  });

  it("rate-limits after the capacity-scaled relay budget", () => {
    const roomId = freshRoomId();
    const host = found(roomId);
    const guest = join(roomId, host);

    const budget = SIGNAL_LIMITS.maxMessagesPerParticipant * 2; // budgetCapacity is 2
    for (let i = 0; i < budget; i++) {
      expect(relaySignal(roomId, host.id, host.secret, guest.id, payload).ok).toBe(true);
    }
    expect(relaySignal(roomId, host.id, host.secret, guest.id, payload)).toEqual({
      ok: false,
      error: "rate-limited",
    });
  });
});

describe("capacity", () => {
  it("clamps host requests to the 2..7 range", () => {
    const roomId = freshRoomId();
    const host = found(roomId);

    setCapacity(roomId, host.id, host.secret, 100);
    let rosters = eventsOf(host.stream, "roster");
    expect(rosters[rosters.length - 1].capacity).toBe(7);

    setCapacity(roomId, host.id, host.secret, 0);
    rosters = eventsOf(host.stream, "roster");
    expect(rosters[rosters.length - 1].capacity).toBe(2);
  });

  it("lowering below headcount ejects nobody but blocks new joins", () => {
    const roomId = freshRoomId();
    const host = found(roomId);
    setCapacity(roomId, host.id, host.secret, 3);
    const a = join(roomId, host, "A");
    const b = join(roomId, host, "B");

    setCapacity(roomId, host.id, host.secret, 2);
    expect(eventsOf(a.stream, "ended")).toHaveLength(0);
    expect(eventsOf(b.stream, "ended")).toHaveLength(0);

    const late = knock(roomId);
    expect(eventsOf(late.stream, "ended")[0]?.reason).toBe("room-full");
  });
});

describe("leaving and succession", () => {
  it("lets a guest leave without taking the room down", () => {
    const roomId = freshRoomId();
    const host = found(roomId);
    const guest = join(roomId, host);

    expect(leaveRoom(roomId, guest.id, guest.secret)).toEqual({ ok: true });
    expect(eventsOf(guest.stream, "ended")[0]?.reason).toBe("self-left");

    const left = eventsOf(host.stream, "peer-left");
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ peerId: guest.id, reason: "left" });

    // Host is untouched and the room still answers.
    expect(eventsOf(host.stream, "ended")).toHaveLength(0);
    expect(setCapacity(roomId, host.id, host.secret, 3)).toEqual({ ok: true });
  });

  it("promotes the longest-seated member when the host leaves", () => {
    vi.useFakeTimers();
    const roomId = freshRoomId();
    const host = found(roomId);
    setCapacity(roomId, host.id, host.secret, 3);
    vi.advanceTimersByTime(10);
    const first = join(roomId, host, "First");
    vi.advanceTimersByTime(10);
    const second = join(roomId, host, "Second");

    leaveRoom(roomId, host.id, host.secret);

    const toFirst = eventsOf(first.stream, "host-changed");
    expect(toFirst).toHaveLength(1);
    expect(toFirst[0]).toMatchObject({ peerId: first.id, becameHost: true, byChoice: false });
    const toSecond = eventsOf(second.stream, "host-changed");
    expect(toSecond[0]).toMatchObject({ peerId: first.id, becameHost: false });

    // The promoted peer actually holds the keys now.
    expect(setCapacity(roomId, first.id, first.secret, 4)).toEqual({ ok: true });
    expect(setCapacity(roomId, second.id, second.secret, 4)).toEqual({
      ok: false,
      error: "forbidden",
    });
  });

  it("replays waiting knocks to the successor", () => {
    vi.useFakeTimers();
    const roomId = freshRoomId();
    const host = found(roomId);
    setCapacity(roomId, host.id, host.secret, 3);
    vi.advanceTimersByTime(10);
    const guest = join(roomId, host, "Guest");
    knock(roomId, "Waiting");

    leaveRoom(roomId, host.id, host.secret);

    const replayed = eventsOf(guest.stream, "knock");
    expect(replayed).toHaveLength(1);
    expect(replayed[0].name).toBe("Waiting");
  });

  it("turns waiting knockers away when the last member leaves", () => {
    const roomId = freshRoomId();
    const host = found(roomId);
    setCapacity(roomId, host.id, host.secret, 3);
    const waiting = knock(roomId, "Waiting");

    leaveRoom(roomId, host.id, host.secret);
    expect(eventsOf(waiting.stream, "ended")[0]?.reason).toBe("expired");
  });

  it("lets the next arrival refound an emptied room as host", () => {
    const roomId = freshRoomId();
    const host = found(roomId);
    leaveRoom(roomId, host.id, host.secret);

    const refounder = found(roomId, "New Host");
    expect(lastWelcome(refounder.stream).self.isHost).toBe(true);
  });
});

describe("closing and removing", () => {
  it("host close ends the session for members and knockers alike", () => {
    const roomId = freshRoomId();
    const host = found(roomId);
    setCapacity(roomId, host.id, host.secret, 3);
    const guest = join(roomId, host);
    const waiting = knock(roomId);

    expect(closeRoom(roomId, host.id, host.secret)).toEqual({ ok: true });
    for (const stream of [host.stream, guest.stream, waiting.stream]) {
      expect(eventsOf(stream, "ended")[0]?.reason).toBe("host-closed");
      expect(stream.disconnected).toBe(true);
    }

    // The code is reusable immediately afterwards.
    const refounder = found(roomId);
    expect(lastWelcome(refounder.stream).self.isHost).toBe(true);
  });

  it("host removes a guest, who is told and disconnected", () => {
    const roomId = freshRoomId();
    const host = found(roomId);
    const guest = join(roomId, host);

    expect(removePeer(roomId, host.id, host.secret, guest.id)).toEqual({ ok: true });
    expect(eventsOf(guest.stream, "ended")[0]?.reason).toBe("removed");
    expect(guest.stream.disconnected).toBe(true);
    expect(eventsOf(host.stream, "peer-left")[0]).toMatchObject({
      peerId: guest.id,
      reason: "removed",
    });
  });

  it("rejects self-removal and unknown targets", () => {
    const roomId = freshRoomId();
    const host = found(roomId);
    expect(removePeer(roomId, host.id, host.secret, host.id)).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(removePeer(roomId, host.id, host.secret, "ghost")).toEqual({
      ok: false,
      error: "unknown-peer",
    });
  });
});

describe("host transfer", () => {
  it("hands the role over by choice and announces it", () => {
    const roomId = freshRoomId();
    const host = found(roomId);
    const guest = join(roomId, host);

    expect(transferHost(roomId, host.id, host.secret, guest.id)).toEqual({ ok: true });

    const toGuest = eventsOf(guest.stream, "host-changed");
    expect(toGuest[0]).toMatchObject({ peerId: guest.id, becameHost: true, byChoice: true });
    const toHost = eventsOf(host.stream, "host-changed");
    expect(toHost[0]).toMatchObject({ peerId: guest.id, becameHost: false, byChoice: true });

    // Keys actually moved.
    expect(setCapacity(roomId, guest.id, guest.secret, 3)).toEqual({ ok: true });
    expect(setCapacity(roomId, host.id, host.secret, 3)).toEqual({
      ok: false,
      error: "forbidden",
    });
  });

  it("rejects transfers to yourself, strangers and away members", () => {
    const roomId = freshRoomId();
    const host = found(roomId);
    const guest = join(roomId, host);

    expect(transferHost(roomId, host.id, host.secret, host.id)).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(transferHost(roomId, host.id, host.secret, "ghost")).toEqual({
      ok: false,
      error: "unknown-peer",
    });

    streamAborted(guest.conn); // guest is now away
    expect(transferHost(roomId, host.id, host.secret, guest.id)).toEqual({
      ok: false,
      error: "invalid",
    });
  });

  it("moves the admin identity with an explicit transfer", () => {
    const roomId = freshRoomId();
    const founderUid = "aaaa1111";
    const host = found(roomId, "Founder", founderUid);
    const guest = join(roomId, host, "Guest", "bbbb2222");

    transferHost(roomId, host.id, host.secret, guest.id);
    leaveRoom(roomId, host.id, host.secret);

    // The founder returning tokenless must now knock like anyone else.
    const back = knock(roomId, "Founder", founderUid);
    expect(eventsOf(back.stream, "waiting-approval")).toHaveLength(1);
    expect(eventsOf(back.stream, "welcome")).toHaveLength(0);
  });

  it("keeps the admin identity through automatic succession", () => {
    const roomId = freshRoomId();
    const founderUid = "aaaa1111";
    const host = found(roomId, "Founder", founderUid);
    const guest = join(roomId, host, "Guest", "bbbb2222");

    leaveRoom(roomId, host.id, host.secret); // guest inherits by succession

    // The founder returning tokenless is recognised and takes the role back.
    const backStream = makeStream();
    openStream(roomId, { name: "Founder", resumeToken: null, uid: founderUid }, backStream.handlers);
    const welcome = lastWelcome(backStream);
    expect(welcome.self.isHost).toBe(true);

    const rosters = eventsOf(guest.stream, "roster");
    const latest = rosters[rosters.length - 1].roster;
    expect(latest.find((p) => p.id === welcome.self.id)?.isHost).toBe(true);
    expect(latest.find((p) => p.id === guest.id)?.isHost).toBe(false);
  });
});

describe("pinning", () => {
  it("broadcasts pins, validates targets and clears on departure", () => {
    const roomId = freshRoomId();
    const host = found(roomId);
    const guest = join(roomId, host);

    expect(setPin(roomId, host.id, host.secret, "ghost")).toEqual({
      ok: false,
      error: "unknown-peer",
    });

    expect(setPin(roomId, host.id, host.secret, guest.id)).toEqual({ ok: true });
    expect(eventsOf(guest.stream, "pin")[0]).toEqual({ t: "pin", peerId: guest.id });

    leaveRoom(roomId, guest.id, guest.secret);
    const pins = eventsOf(host.stream, "pin");
    expect(pins[pins.length - 1]).toEqual({ t: "pin", peerId: null });
  });

  it("carries the active pin to later joiners in their welcome", () => {
    const roomId = freshRoomId();
    const host = found(roomId);
    setCapacity(roomId, host.id, host.secret, 3);
    const a = join(roomId, host, "A");
    setPin(roomId, host.id, host.secret, a.id);

    const b = join(roomId, host, "B");
    expect(lastWelcome(b.stream).pinned).toBe(a.id);
  });
});

describe("moderation", () => {
  function trio() {
    const roomId = freshRoomId();
    const host = found(roomId);
    setCapacity(roomId, host.id, host.secret, 3);
    const a = join(roomId, host, "A");
    const b = join(roomId, host, "B");
    return { roomId, host, a, b };
  }

  it("delivers a targeted action to the target only", () => {
    const { roomId, host, a, b } = trio();
    expect(moderate(roomId, host.id, host.secret, a.id, "mute-audio")).toEqual({ ok: true });

    const toA = eventsOf(a.stream, "moderated");
    expect(toA).toHaveLength(1);
    expect(toA[0]).toMatchObject({ action: "mute-audio", byName: "Host" });
    expect(eventsOf(b.stream, "moderated")).toHaveLength(0);
    expect(eventsOf(host.stream, "moderated")).toHaveLength(0);
  });

  it("moderates everyone but the host on a null target", () => {
    const { roomId, host, a, b } = trio();
    expect(moderate(roomId, host.id, host.secret, null, "mute-video")).toEqual({ ok: true });
    expect(eventsOf(a.stream, "moderated")).toHaveLength(1);
    expect(eventsOf(b.stream, "moderated")).toHaveLength(1);
    expect(eventsOf(host.stream, "moderated")).toHaveLength(0);
  });

  it("rejects unknown actions, self-targets and strangers", () => {
    const { roomId, host } = trio();
    expect(
      moderate(roomId, host.id, host.secret, null, "eject-from-orbit" as ModerationAction),
    ).toEqual({ ok: false, error: "invalid" });
    expect(moderate(roomId, host.id, host.secret, host.id, "mute-audio")).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(moderate(roomId, host.id, host.secret, "ghost", "mute-audio")).toEqual({
      ok: false,
      error: "unknown-peer",
    });
  });
});

describe("disconnects and resumes", () => {
  it("marks a dropped member away instead of releasing the seat", () => {
    const roomId = freshRoomId();
    const host = found(roomId);
    const guest = join(roomId, host);

    streamAborted(guest.conn);

    const away = eventsOf(host.stream, "peer-away");
    expect(away[0]).toMatchObject({ peerId: guest.id, away: true });
    expect(eventsOf(host.stream, "peer-left")).toHaveLength(0);
  });

  it("reclaims the same seat with the resume token, skipping the knock", () => {
    const roomId = freshRoomId();
    const host = found(roomId);
    const guest = join(roomId, host);
    streamAborted(guest.conn);

    const back = makeStream();
    openStream(roomId, { name: "x", resumeToken: guest.resumeToken, uid: "" }, back.handlers);

    const welcome = lastWelcome(back);
    expect(welcome.resumed).toBe(true);
    expect(welcome.self.id).toBe(guest.id);

    const away = eventsOf(host.stream, "peer-away");
    expect(away[away.length - 1]).toMatchObject({ peerId: guest.id, away: false });
  });

  it("ignores the stale stream's late abort after a resume", () => {
    const roomId = freshRoomId();
    const host = found(roomId);
    const guest = join(roomId, host);

    const back = makeStream();
    openStream(roomId, { name: "x", resumeToken: guest.resumeToken, uid: "" }, back.handlers);
    expect(guest.stream.disconnected).toBe(true); // old stream detached

    streamAborted(guest.conn); // late abort from the superseded stream
    expect(eventsOf(host.stream, "peer-away")).toHaveLength(0);
  });

  it("replays missed knocks to a resuming host", () => {
    const roomId = freshRoomId();
    const host = found(roomId);
    streamAborted(host.conn);
    const waiting = knock(roomId, "Waiting");

    const back = makeStream();
    openStream(roomId, { name: "Host", resumeToken: host.resumeToken, uid: "" }, back.handlers);

    const replayed = eventsOf(back, "knock");
    expect(replayed).toHaveLength(1);
    expect(replayed[0].name).toBe("Waiting");
    expect(eventsOf(waiting.stream, "waiting-approval")).toHaveLength(1);
  });

  it("lets an away founder reclaim the host seat by uid alone", () => {
    const roomId = freshRoomId();
    const founderUid = "cccc3333";
    const host = found(roomId, "Founder", founderUid);
    const guest = join(roomId, host, "Guest");
    streamAborted(host.conn);

    // New tab: no resume token, same browser uid.
    const back = makeStream();
    openStream(roomId, { name: "Founder", resumeToken: null, uid: founderUid }, back.handlers);

    const welcome = lastWelcome(back);
    expect(welcome.resumed).toBe(true);
    expect(welcome.self.id).toBe(host.id);
    expect(welcome.self.isHost).toBe(true);
    expect(eventsOf(guest.stream, "ended")).toHaveLength(0);
  });

  it("withdraws a knock when the knocker gives up", () => {
    const roomId = freshRoomId();
    const host = found(roomId);
    const joiner = knock(roomId);
    const knockId = eventsOf(host.stream, "knock")[0].knockId;

    streamAborted(joiner.conn);

    expect(eventsOf(host.stream, "knock-withdrawn")[0]).toMatchObject({ knockId });
    expect(answerKnock(roomId, host.id, host.secret, knockId, true)).toEqual({
      ok: false,
      error: "unknown-knock",
    });
  });
});

describe("timeouts", () => {
  it("releases an away seat when the grace expires", () => {
    vi.useFakeTimers();
    const roomId = freshRoomId();
    const host = found(roomId);
    const guest = join(roomId, host);

    streamAborted(guest.conn);
    vi.advanceTimersByTime(SIGNAL_LIMITS.awayTtlMs + 1);

    const left = eventsOf(host.stream, "peer-left");
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ peerId: guest.id, reason: "disconnected" });
  });

  it("expires an unanswered knock", () => {
    vi.useFakeTimers();
    const roomId = freshRoomId();
    const host = found(roomId);
    const joiner = knock(roomId);
    const knockId = eventsOf(host.stream, "knock")[0].knockId;

    vi.advanceTimersByTime(SIGNAL_LIMITS.knockTtlMs + 1);

    expect(eventsOf(joiner.stream, "ended")[0]?.reason).toBe("expired");
    expect(eventsOf(host.stream, "knock-withdrawn")[0]).toMatchObject({ knockId });
  });

  it("expires a lobby that never found a second participant", () => {
    vi.useFakeTimers();
    const roomId = freshRoomId();
    const host = found(roomId);

    vi.advanceTimersByTime(SIGNAL_LIMITS.lobbyTtlMs + 1);
    expect(eventsOf(host.stream, "ended")[0]?.reason).toBe("expired");
  });

  it("disarms the lobby timeout once a second participant is seated", () => {
    vi.useFakeTimers();
    const roomId = freshRoomId();
    const host = found(roomId);
    const guest = join(roomId, host);

    vi.advanceTimersByTime(SIGNAL_LIMITS.lobbyTtlMs + 1);
    expect(eventsOf(host.stream, "ended")).toHaveLength(0);
    expect(eventsOf(guest.stream, "ended")).toHaveLength(0);
  });

  it("releases an empty room after its grace and lets the code be reused", () => {
    vi.useFakeTimers();
    const roomId = freshRoomId();
    const host = found(roomId);
    leaveRoom(roomId, host.id, host.secret);

    vi.advanceTimersByTime(SIGNAL_LIMITS.emptyTtlMs + 1);

    const next = found(roomId, "Next");
    expect(lastWelcome(next.stream).self.isHost).toBe(true);
  });
});
