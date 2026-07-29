import { createToken } from "@/lib/ids";
import {
  ROOM_CAPACITY,
  SIGNAL_LIMITS,
  clampCapacity,
  type EndReason,
  type LeaveReason,
  type ModerationAction,
  type Participant,
  type PeerId,
  type ServerEvent,
  type SignalPayload,
} from "@/lib/signal-protocol";

/**
 * In-memory signalling registry for host-owned rooms of 2..7 participants.
 *
 * Three invariants drive every method here:
 *
 *  1. **The host owns the room.** Admitting, removing, pinning, resizing and
 *     closing are host-only. Anyone else may only leave, and their departure
 *     never takes the room with it.
 *
 *  2. **A dropped stream is not a departure.** The seat is held (`away: true`)
 *     for `awayTtlMs`; presenting the seat's `resumeToken` reclaims the same
 *     peer id without knocking again. Only when the grace expires is the seat
 *     actually released. This is what makes a page refresh survivable, for the
 *     host included.
 *
 *  3. **Nobody is seated without the host's word.** A GET on an existing room
 *     only queues a knock; the host answers it with `admit`. The one exception
 *     is a valid resume token, which proves the joiner already held a seat.
 *
 * Nothing is persisted: rooms exist only in process memory, and the registry
 * hangs off `globalThis` so a dev-server module reload does not orphan seats.
 */

type StreamHandlers = {
  emit: (event: ServerEvent) => void;
  disconnect: () => void;
};

type Member = {
  id: PeerId;
  name: string;
  /** The browser's persistent anonymous id; empty when the client sent none. */
  uid: string;
  secret: string;
  /** Proof of seat ownership across reconnects. Unguessable, never rotated:
   *  rotating on every resume would lock the client out if the fresh
   *  `welcome` were lost in transit before it could be persisted. */
  resumeToken: string;
  joinedAt: number;
  away: boolean;
  /** Bumps on every (re)attach so a stale stream's abort handler cannot mark
   *  the seat away after a newer stream has already reclaimed it. */
  epoch: number;
  awayTimer?: ReturnType<typeof setTimeout>;
  stream: StreamHandlers;
};

type Knock = {
  id: string;
  name: string;
  uid: string;
  /** The joiner's connection handle; mutated to `seated` on admit. */
  conn: Connection;
  stream: StreamHandlers;
  timer?: ReturnType<typeof setTimeout>;
};

type Room = {
  id: string;
  members: Map<PeerId, Member>;
  knocks: Map<string, Knock>;
  hostId: PeerId;
  /**
   * The founder's browser id: the durable admin identity. Seat-based
   * `hostId` says who holds the role right now (succession may hand it to
   * someone else while the founder is gone); a returning founder with this
   * uid takes the role back.
   */
  hostUid: string;
  capacity: number;
  /**
   * Relay budget baseline: the largest capacity the room has ever had. The
   * budget is `maxMessagesPerParticipant * budgetCapacity` because a 7-way
   * mesh is 21 negotiating pairs and legitimately needs far more relay
   * traffic than a pair. Using the historical maximum means lowering the
   * capacity never retroactively rate-limits an already-established mesh.
   */
  budgetCapacity: number;
  relayCount: number;
  /** Host-forced pin, included in every later `welcome`. */
  pinned: PeerId | null;
  createdAt: number;
  /** Monotonic counter behind "Guest N" placeholder names. */
  guestCounter: number;
  emptyTimer?: ReturnType<typeof setTimeout>;
  lobbyTimer?: ReturnType<typeof setTimeout>;
  hardTimer?: ReturnType<typeof setTimeout>;
};

/**
 * Handle for one SSE stream, owned by this module and held by the route so its
 * abort handler can report the drop regardless of whether the stream was still
 * knocking or already seated by then. `phase: "done"` makes aborts no-ops.
 */
export type Connection = {
  phase: "knocking" | "seated" | "done";
  roomId: string;
  knockId?: string;
  peerId?: PeerId;
  epoch?: number;
};

export type ActionError =
  | "invalid" // 400: structurally valid JSON but semantically impossible
  | "unauthorized" // 401: bad peer credentials
  | "forbidden" // 403: authenticated, but the action is host-only
  | "unknown-room" // 410: no such room
  | "not-member" // 410: sender is not seated in this room
  | "unknown-peer" // 410: target peer is not seated in this room
  | "unknown-knock" // 410: knock already answered, withdrawn or expired
  | "rate-limited"; // 429: relay budget exhausted

export type ActionResult = { ok: true } | { ok: false; error: ActionError };

// Survive Next.js dev-server module reloads; otherwise every recompile of the
// route file would orphan every seat in every live room.
const registry: Map<string, Room> = ((globalThis as Record<string, unknown>)
  .__instantSignalRooms as Map<string, Room>) ?? new Map<string, Room>();
(globalThis as Record<string, unknown>).__instantSignalRooms = registry;

function safeEmit(stream: StreamHandlers, event: ServerEvent) {
  try {
    stream.emit(event);
  } catch {
    // Stream already torn down by the client; nothing to salvage.
  }
}

function safeDisconnect(stream: StreamHandlers) {
  try {
    stream.disconnect();
  } catch {
    // Same.
  }
}

function isHost(room: Room, member: Member) {
  return room.hostId === member.id;
}

function participantOf(room: Room, member: Member): Participant {
  return {
    id: member.id,
    name: member.name,
    isHost: isHost(room, member),
    joinedAt: member.joinedAt,
    away: member.away,
    // The joiner's own browser uid (already sanitized by the route), so every
    // peer draws the same robot for the same person, stable across resumes.
    // Deliberately empty when none was presented: a server-invented seed would
    // change on every reload, and one derived from the peer id would change on
    // every rejoin -- both make the avatar flicker. Like `name`, this reaches
    // seated participants only; knock events never carry it.
    avatarSeed: member.uid,
  };
}

/** Stable seating order: longest-seated first, ids breaking millisecond ties. */
function seatingOrder(a: Member, b: Member) {
  if (a.joinedAt !== b.joinedAt) return a.joinedAt - b.joinedAt;
  return a.id < b.id ? -1 : 1;
}

function rosterOf(room: Room): Participant[] {
  return [...room.members.values()]
    .sort(seatingOrder)
    .map((member) => participantOf(room, member));
}

function broadcast(room: Room, event: ServerEvent, exceptPeerId?: PeerId) {
  for (const member of room.members.values()) {
    if (member.id !== exceptPeerId) safeEmit(member.stream, event);
  }
}

function broadcastRoster(room: Room) {
  broadcast(room, { t: "roster", roster: rosterOf(room), capacity: room.capacity });
}

function clearMemberTimer(member: Member) {
  if (member.awayTimer) clearTimeout(member.awayTimer);
  member.awayTimer = undefined;
}

function clearKnockTimer(knock: Knock) {
  if (knock.timer) clearTimeout(knock.timer);
  knock.timer = undefined;
}

function clearRoomTimers(room: Room) {
  if (room.emptyTimer) clearTimeout(room.emptyTimer);
  if (room.lobbyTimer) clearTimeout(room.lobbyTimer);
  if (room.hardTimer) clearTimeout(room.hardTimer);
  room.emptyTimer = undefined;
  room.lobbyTimer = undefined;
  room.hardTimer = undefined;
}

/** Empty display names would render as blank tiles; substitute a stable
 *  placeholder instead of rejecting the join. */
function resolveName(room: Room, raw: string): string {
  if (raw) return raw;
  room.guestCounter += 1;
  return `Guest ${room.guestCounter}`;
}

function createRoom(roomId: string, now: number): Room {
  const room: Room = {
    id: roomId,
    members: new Map(),
    knocks: new Map(),
    hostId: "",
    hostUid: "",
    capacity: ROOM_CAPACITY.default,
    budgetCapacity: ROOM_CAPACITY.default,
    relayCount: 0,
    pinned: null,
    createdAt: now,
    guestCounter: 0,
  };
  registry.set(roomId, room);

  room.hardTimer = setTimeout(() => {
    releaseRoom(roomId, "room-closed");
  }, SIGNAL_LIMITS.roomTtlMs);
  room.hardTimer.unref?.();

  // A room that never attracts a second participant should not sit in memory
  // for the full twelve hours.
  room.lobbyTimer = setTimeout(() => {
    releaseRoom(roomId, "expired");
  }, SIGNAL_LIMITS.lobbyTtlMs);
  room.lobbyTimer.unref?.();

  return room;
}

/**
 * Closes a room and every stream attached to it, members and knockers alike.
 * Safe to call repeatedly and from inside a stream's own cancel handler.
 */
function releaseRoom(roomId: string, reason: EndReason) {
  const room = registry.get(roomId);
  if (!room) return;

  // Delete first so re-entrant calls from disconnect() handlers are no-ops.
  registry.delete(roomId);
  clearRoomTimers(room);

  for (const member of room.members.values()) {
    clearMemberTimer(member);
    safeEmit(member.stream, { t: "ended", reason });
    safeDisconnect(member.stream);
  }
  room.members.clear();

  for (const knock of room.knocks.values()) {
    clearKnockTimer(knock);
    knock.conn.phase = "done";
    safeEmit(knock.stream, { t: "ended", reason });
    safeDisconnect(knock.stream);
  }
  room.knocks.clear();
}

/** Detaches a knock from the room without emitting anything. */
function removeKnock(room: Room, knock: Knock) {
  clearKnockTimer(knock);
  room.knocks.delete(knock.id);
  knock.conn.phase = "done";
}

/** Ends a knocker's wait: terminal event to them, withdrawal notice to the host. */
function expireKnock(room: Room, knock: Knock, reason: EndReason) {
  removeKnock(room, knock);
  safeEmit(knock.stream, { t: "ended", reason });
  safeDisconnect(knock.stream);
  const host = room.members.get(room.hostId);
  if (host) safeEmit(host.stream, { t: "knock-withdrawn", knockId: knock.id });
}

function armEmptyTimer(room: Room) {
  if (room.emptyTimer) clearTimeout(room.emptyTimer);
  room.emptyTimer = setTimeout(() => {
    releaseRoom(room.id, "expired");
  }, SIGNAL_LIMITS.emptyTtlMs);
  room.emptyTimer.unref?.();
}

/**
 * Removes one member. Everyone else keeps going: this is the heart of the
 * "a departure never destroys the room" model.
 */
function releaseSeat(room: Room, member: Member, reason: LeaveReason) {
  clearMemberTimer(member);
  room.members.delete(member.id);
  safeDisconnect(member.stream);

  broadcast(room, { t: "peer-left", peerId: member.id, reason });

  // A pin aimed at a departed seat would mislead every later `welcome`.
  if (room.pinned === member.id) {
    room.pinned = null;
    broadcast(room, { t: "pin", peerId: null });
  }

  if (room.hostId === member.id && room.members.size > 0) {
    // Succession rule: the longest-seated remaining participant becomes host,
    // with ids breaking ties -- the same deterministic order everyone can
    // compute, so no two clients disagree about who inherited the room.
    const next = [...room.members.values()].sort(seatingOrder)[0];
    room.hostId = next.id;
    // The new host inherits the knock queue; replay it so nobody waiting at
    // the door is stranded by the succession.
    for (const knock of room.knocks.values()) {
      safeEmit(next.stream, { t: "knock", knockId: knock.id, name: knock.name });
    }
  }

  broadcastRoster(room);

  if (room.members.size === 0) {
    // Nobody is left who could admit anyone, so waiting knockers can only be
    // turned away. The room itself lingers for `emptyTtlMs`, after which the
    // code becomes reusable as a fresh room.
    for (const knock of [...room.knocks.values()]) {
      removeKnock(room, knock);
      safeEmit(knock.stream, { t: "ended", reason: "expired" });
      safeDisconnect(knock.stream);
    }
    armEmptyTimer(room);
  }
}

/** Seats a participant. The caller decides host status and emits the welcome. */
function seatMember(room: Room, name: string, stream: StreamHandlers, uid = ""): Member {
  const member: Member = {
    id: createToken(8),
    name,
    uid,
    secret: createToken(24),
    resumeToken: createToken(24),
    joinedAt: Date.now(),
    away: false,
    epoch: 1,
    stream,
  };
  room.members.set(member.id, member);

  // The room found its second participant; the lobby timeout no longer applies.
  if (room.members.size >= 2 && room.lobbyTimer) {
    clearTimeout(room.lobbyTimer);
    room.lobbyTimer = undefined;
  }
  return member;
}

function welcome(room: Room, member: Member, resumed: boolean): ServerEvent {
  return {
    t: "welcome",
    self: participantOf(room, member),
    secret: member.secret,
    resumeToken: member.resumeToken,
    roster: rosterOf(room),
    capacity: room.capacity,
    resumed,
    pinned: room.pinned,
  };
}

function findByResumeToken(room: Room, token: string): Member | undefined {
  for (const member of room.members.values()) {
    if (member.resumeToken.length === token.length && member.resumeToken === token) {
      return member;
    }
  }
  return undefined;
}

/** Reattaches a returning stream to the seat it already owns. */
function reseat(room: Room, member: Member, stream: StreamHandlers): Connection {
  clearMemberTimer(member);

  // A fast reload can reconnect before the old stream's abort fires. Detach
  // the old stream now; its late abort is ignored thanks to the epoch bump.
  const previous = member.stream;
  member.epoch += 1;
  member.stream = stream;
  if (previous !== stream) safeDisconnect(previous);

  const wasAway = member.away;
  member.away = false;

  safeEmit(stream, welcome(room, member, true));
  if (wasAway) {
    broadcast(room, { t: "peer-away", peerId: member.id, away: false }, member.id);
  }

  // A resuming host may have missed knocks while its stream was down; replay
  // the queue so waiting joiners are not silently stuck.
  if (isHost(room, member)) {
    for (const knock of room.knocks.values()) {
      safeEmit(stream, { t: "knock", knockId: knock.id, name: knock.name });
    }
  }

  return { phase: "seated", roomId: room.id, peerId: member.id, epoch: member.epoch };
}

/**
 * Handles a joining GET. Exactly one of four things happens:
 *
 *  - no live room       -> the joiner founds it and is seated as host
 *  - valid resume token -> the joiner reclaims its old seat, no knock needed
 *  - room at capacity   -> `ended room-full`, stream closed
 *  - otherwise          -> queued as a knock; the host decides
 *
 * All events (welcome / waiting-approval / ended) are emitted through the
 * provided handlers before this returns, so the route stays a dumb pipe.
 */
export function openStream(
  roomId: string,
  join: { name: string; resumeToken: string | null; uid: string },
  stream: StreamHandlers,
): Connection {
  const now = Date.now();
  let room = registry.get(roomId);

  // Resume first: a valid token proves prior seat ownership and bypasses both
  // the knock and the capacity check (the seat is already counted).
  if (room && join.resumeToken) {
    const member = findByResumeToken(room, join.resumeToken);
    if (member) return reseat(room, member, stream);
  }

  // A room whose every seat was released is an expired session lingering out
  // its empty grace; the next arrival refounds it rather than knocking on a
  // door nobody can answer.
  if (room && room.members.size === 0) {
    registry.delete(roomId);
    clearRoomTimers(room);
    room = undefined;
  }

  if (!room) {
    room = createRoom(roomId, now);
    const member = seatMember(room, resolveName(room, join.name), stream, join.uid);
    room.hostId = member.id;
    // The founder's browser id is the admin identity for the room's lifetime.
    room.hostUid = join.uid;
    safeEmit(stream, welcome(room, member, false));
    return { phase: "seated", roomId, peerId: member.id, epoch: member.epoch };
  }

  // The admin returning without a resume token (new tab, cleared session
  // storage) is recognised by the founder uid: no knock, and the host role
  // comes back with them even if succession had handed it to someone else.
  if (join.uid && room.hostUid && join.uid === room.hostUid) {
    const holder = [...room.members.values()].find((member) => member.uid === join.uid);
    if (holder?.away) {
      room.hostId = holder.id;
      const conn = reseat(room, holder, stream);
      broadcastRoster(room);
      return conn;
    }
    if (!holder && room.members.size < room.capacity) {
      const member = seatMember(room, resolveName(room, join.name), stream, join.uid);
      room.hostId = member.id;
      safeEmit(stream, welcome(room, member, false));
      broadcast(room, { t: "peer-joined", peer: participantOf(room, member) }, member.id);
      broadcastRoster(room);
      return { phase: "seated", roomId, peerId: member.id, epoch: member.epoch };
    }
    // A live tab already holds the admin uid (or the room is full): fall
    // through to the ordinary knock rather than seizing the seat.
  }

  // Away members still hold their seats, so they count against capacity.
  if (room.members.size >= room.capacity) {
    safeEmit(stream, { t: "ended", reason: "room-full" });
    safeDisconnect(stream);
    return { phase: "done", roomId };
  }

  const conn: Connection = { phase: "knocking", roomId };
  const knock: Knock = {
    id: createToken(8),
    name: resolveName(room, join.name),
    uid: join.uid,
    conn,
    stream,
  };
  conn.knockId = knock.id;
  room.knocks.set(knock.id, knock);

  knock.timer = setTimeout(() => {
    const current = registry.get(roomId);
    if (current?.knocks.get(knock.id) === knock) expireKnock(current, knock, "expired");
  }, SIGNAL_LIMITS.knockTtlMs);
  knock.timer.unref?.();

  safeEmit(stream, { t: "waiting-approval" });
  const host = room.members.get(room.hostId);
  if (host) safeEmit(host.stream, { t: "knock", knockId: knock.id, name: knock.name });

  return conn;
}

/**
 * Called when a stream's underlying request aborts (tab closed, reload,
 * network drop). For a knocker this withdraws the knock; for a member it only
 * marks the seat away -- the seat itself survives for `awayTtlMs`.
 */
export function streamAborted(conn: Connection) {
  if (conn.phase === "done") return;
  const room = registry.get(conn.roomId);
  if (!room) {
    conn.phase = "done";
    return;
  }

  if (conn.phase === "knocking") {
    const knock = conn.knockId ? room.knocks.get(conn.knockId) : undefined;
    conn.phase = "done";
    if (!knock || knock.conn !== conn) return;
    removeKnock(room, knock);
    const host = room.members.get(room.hostId);
    if (host) safeEmit(host.stream, { t: "knock-withdrawn", knockId: knock.id });
    return;
  }

  // Seated. Ignore aborts from a stream that has already been superseded by a
  // resume: the epoch recorded at attach time no longer matches.
  const member = conn.peerId ? room.members.get(conn.peerId) : undefined;
  conn.phase = "done";
  if (!member || member.epoch !== conn.epoch) return;

  member.away = true;
  broadcast(room, { t: "peer-away", peerId: member.id, away: true }, member.id);

  clearMemberTimer(member);
  member.awayTimer = setTimeout(() => {
    const current = registry.get(conn.roomId);
    const held = current?.members.get(member.id);
    // Only release if the very same disconnection is still unresolved.
    if (current && held === member && held.away) {
      releaseSeat(current, held, "disconnected");
    }
  }, SIGNAL_LIMITS.awayTtlMs);
  member.awayTimer.unref?.();
}

type AuthResult =
  | { ok: true; room: Room; self: Member }
  | { ok: false; error: "unknown-room" | "not-member" | "unauthorized" | "forbidden" };

function authenticate(roomId: string, peerId: string, secret: string): AuthResult {
  const room = registry.get(roomId);
  if (!room) return { ok: false, error: "unknown-room" };

  const self = room.members.get(peerId);
  if (!self) return { ok: false, error: "not-member" };

  // Constant-time comparison is overkill for a 240-bit token an attacker
  // cannot oracle, but the length check keeps the compare cheap.
  if (self.secret.length !== secret.length || self.secret !== secret) {
    return { ok: false, error: "unauthorized" };
  }
  return { ok: true, room, self };
}

/** Same as `authenticate`, plus the host check every privileged action needs. */
function authenticateHost(roomId: string, peerId: string, secret: string): AuthResult {
  const auth = authenticate(roomId, peerId, secret);
  if (!auth.ok) return auth;
  if (!isHost(auth.room, auth.self)) {
    return { ok: false, error: "forbidden" };
  }
  return auth;
}

/**
 * Relays one negotiation payload to exactly one seated member. Never
 * broadcast, never echoed to the sender.
 */
export function relaySignal(
  roomId: string,
  peerId: string,
  secret: string,
  to: PeerId,
  data: SignalPayload,
): ActionResult {
  const auth = authenticate(roomId, peerId, secret);
  if (!auth.ok) return auth;

  // Budget scales with capacity: a 7-way mesh is 21 pairs, each with offers,
  // answers, trickled candidates and renegotiations, so a fixed per-room cap
  // sized for a pair would starve a legitimately busy mesh. Exhaustion rejects
  // the message but leaves the room standing -- one flooding client must not
  // end the call for six other people.
  auth.room.relayCount += 1;
  if (auth.room.relayCount > SIGNAL_LIMITS.maxMessagesPerParticipant * auth.room.budgetCapacity) {
    return { ok: false, error: "rate-limited" };
  }

  if (to === peerId) return { ok: false, error: "invalid" };
  const target = auth.room.members.get(to);
  if (!target) return { ok: false, error: "unknown-peer" };

  // An away target has no live stream; the payload is dropped, and WebRTC's
  // renegotiation-on-reconnect recovers the pair once they resume.
  safeEmit(target.stream, { t: "signal", from: peerId, data });
  return { ok: true };
}

/** Voluntary departure. The leaver gets a terminal `ended`; the room survives. */
export function leaveRoom(roomId: string, peerId: string, secret: string): ActionResult {
  const auth = authenticate(roomId, peerId, secret);
  if (!auth.ok) return auth;

  safeEmit(auth.self.stream, { t: "ended", reason: "self-left" });
  releaseSeat(auth.room, auth.self, "left");
  return { ok: true };
}

/** Host only: ends the session for everyone, knockers included. */
export function closeRoom(roomId: string, peerId: string, secret: string): ActionResult {
  const auth = authenticateHost(roomId, peerId, secret);
  if (!auth.ok) return auth;

  releaseRoom(roomId, "host-closed");
  return { ok: true };
}

/**
 * Host only: answers a knock. Allowing seats the joiner (unless the room
 * filled while the knock waited); denying ends their stream with `rejected`.
 * Either way the knock is resolved, so the host's POST succeeds.
 */
export function answerKnock(
  roomId: string,
  peerId: string,
  secret: string,
  knockId: string,
  allow: boolean,
): ActionResult {
  const auth = authenticateHost(roomId, peerId, secret);
  if (!auth.ok) return auth;

  const knock = auth.room.knocks.get(knockId);
  if (!knock) return { ok: false, error: "unknown-knock" };

  removeKnock(auth.room, knock);

  if (!allow) {
    safeEmit(knock.stream, { t: "ended", reason: "rejected" });
    safeDisconnect(knock.stream);
    return { ok: true };
  }

  // The room may have filled (or shrunk) while this knock waited in the queue.
  if (auth.room.members.size >= auth.room.capacity) {
    safeEmit(knock.stream, { t: "ended", reason: "room-full" });
    safeDisconnect(knock.stream);
    return { ok: true };
  }

  const member = seatMember(auth.room, knock.name, knock.stream, knock.uid);
  knock.conn.phase = "seated";
  knock.conn.peerId = member.id;
  knock.conn.epoch = member.epoch;

  safeEmit(member.stream, welcome(auth.room, member, false));
  broadcast(auth.room, { t: "peer-joined", peer: participantOf(auth.room, member) }, member.id);
  broadcastRoster(auth.room);
  return { ok: true };
}

/**
 * Host only: changes the participant limit, clamped to ROOM_CAPACITY. Lowering
 * it below the current headcount ejects nobody -- seated (and away) members
 * keep their seats; the new limit only refuses *further* joins until natural
 * departures bring the headcount back under it.
 */
export function setCapacity(
  roomId: string,
  peerId: string,
  secret: string,
  value: number,
): ActionResult {
  const auth = authenticateHost(roomId, peerId, secret);
  if (!auth.ok) return auth;

  auth.room.capacity = clampCapacity(value);
  // Budget only ever grows; see the `budgetCapacity` note on the Room type.
  auth.room.budgetCapacity = Math.max(auth.room.budgetCapacity, auth.room.capacity);
  broadcastRoster(auth.room);
  return { ok: true };
}

/** Host only: ejects a participant. Self-removal is `leave` or `close`, not this. */
export function removePeer(
  roomId: string,
  peerId: string,
  secret: string,
  targetId: PeerId,
): ActionResult {
  const auth = authenticateHost(roomId, peerId, secret);
  if (!auth.ok) return auth;

  if (targetId === peerId) return { ok: false, error: "invalid" };
  const target = auth.room.members.get(targetId);
  if (!target) return { ok: false, error: "unknown-peer" };

  safeEmit(target.stream, { t: "ended", reason: "removed" });
  releaseSeat(auth.room, target, "removed");
  return { ok: true };
}

/**
 * Host only: forces a pin for everyone (null clears it). Stored on the room so
 * later `welcome` messages carry it to joiners who missed the broadcast.
 */
export function setPin(
  roomId: string,
  peerId: string,
  secret: string,
  target: PeerId | null,
): ActionResult {
  const auth = authenticateHost(roomId, peerId, secret);
  if (!auth.ok) return auth;

  if (target !== null && !auth.room.members.has(target)) {
    return { ok: false, error: "unknown-peer" };
  }

  auth.room.pinned = target;
  broadcast(auth.room, { t: "pin", peerId: target });
  return { ok: true };
}

const MODERATION_ACTIONS = new Set<ModerationAction>([
  "mute-audio",
  "mute-video",
  "ask-audio",
  "ask-video",
]);

/**
 * Host only: moderates one participant's devices, or everyone else's when
 * `target` is null. The event is delivered to the target(s) ONLY -- moderation
 * is between the host and the moderated, never announced to the room.
 *
 * The server deliberately keeps NO mute state. Media flows peer-to-peer, so a
 * mute recorded here would be authority the relay cannot actually enforce.
 * Enforcement is the recipient's client honouring the event (`isEnforced`
 * actions are applied without asking; the `ask-*` ones prompt the user) plus
 * the fact that a muted peer simply stops sending. Do not add mute flags to
 * the Room or to `welcome`.
 *
 * Like `permission` in the two-party predecessor, moderation does not count
 * against the relay budget: it is rare and user-driven, and letting it exhaust
 * the budget would let a host confusingly break their own room.
 */
export function moderate(
  roomId: string,
  peerId: string,
  secret: string,
  target: PeerId | null,
  action: ModerationAction,
): ActionResult {
  // Privacy-sensitive capability: a non-host attempt is refused exactly as
  // seriously as a forged `close`, before anything else is even inspected.
  const auth = authenticateHost(roomId, peerId, secret);
  if (!auth.ok) return auth;

  if (!MODERATION_ACTIONS.has(action)) return { ok: false, error: "invalid" };

  // The host never moderates themselves. An explicit self-target is a client
  // bug, so reject it as invalid rather than silently applying or ignoring it.
  if (target === peerId) return { ok: false, error: "invalid" };

  const byName = auth.self.name;

  if (target !== null) {
    const member = auth.room.members.get(target);
    if (!member) return { ok: false, error: "unknown-peer" };
    safeEmit(member.stream, { t: "moderated", action, byName });
    return { ok: true };
  }

  // Null target: every seated participant except the host. Away members are
  // still seated; their dead stream just drops the event, which is fine
  // because there is no server-side mute state for them to miss.
  for (const member of auth.room.members.values()) {
    if (member.id !== auth.self.id) {
      safeEmit(member.stream, { t: "moderated", action, byName });
    }
  }
  return { ok: true };
}
