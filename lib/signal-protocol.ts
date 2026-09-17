/**
 * Wire contract shared by the signalling route and the browser transport.
 *
 * This is the boundary between `lib/server/rooms.ts` (authority) and
 * `lib/mesh-session.ts` (transport). Change it deliberately: both sides and the
 * verification scripts are written against exactly these shapes.
 *
 * The model is a **host-owned room holding 2 to 7 participants in a full mesh**.
 * The server introduces peers and relays their negotiation; it never carries
 * media or file data.
 */

export type PeerId = string;

/**
 * Who may be seated without the host's word.
 *
 *  - `private`: an arrival is queued as a knock and the host answers it.
 *  - `public`: an arrival is seated on the spot while a seat is free.
 *
 * Chosen when the room is founded and changeable by the host at any time. It
 * governs *admission only*: every host-only action stays host-only, capacity
 * still applies, and a public room is still destroyed when the host closes it.
 */
export type RoomVisibility = "private" | "public";

/** Anything that is not literally `public` is private: the safe default. */
export function sanitizeVisibility(raw: unknown): RoomVisibility {
  return raw === "public" ? "public" : "private";
}

export const ROOM_CAPACITY = {
  min: 2,
  max: 7,
  /** A room starts as a pair; the host raises it deliberately. */
  default: 2,
} as const;

export type Participant = {
  id: PeerId;
  name: string;
  isHost: boolean;
  /** Server clock at first join. Stable ordering for the video grid. */
  joinedAt: number;
  /** Seat held open while the peer is reloading or briefly offline. */
  away: boolean;
  /**
   * Seed for this person's generated robot avatar, taken from the browser uid
   * they presented on joining (`JOIN_PARAM.uid`). It must reach the other
   * participants, because otherwise each browser would invent a different robot
   * for the same person.
   *
   * Note this is a stable per-browser value, so the people in a room can tell
   * it is the same person across sessions. That is the point -- a recognisable
   * avatar needs a durable seed -- but it is a real (if mild) correlation
   * vector, so it is shared only with seated participants and never leaves the
   * mesh. Empty when the joiner presented no uid; the UI falls back to initials.
   */
  avatarSeed: string;
};

/** Why one participant is no longer in the room. */
export type LeaveReason =
  | "left" // chose to leave
  | "disconnected" // stream dropped and the seat grace expired
  | "removed"; // the host removed them

/** Why *this* client's session is over. Terminal. */
export type EndReason =
  | "host-closed" // the host ended it for everyone
  | "self-left" // you left
  | "removed" // the host removed you
  | "room-full" // capacity reached
  | "rejected" // the host declined your request to join
  | "expired" // nobody admitted you, or the empty room timed out
  | "room-closed" // the server released the room
  | "transport-error"; // signalling stream failed

/**
 * Host moderation of someone else's devices.
 *
 * The asymmetry here is a browser constraint, not a design choice: a remote
 * party can never switch on your microphone or camera, so only turning things
 * OFF is enforceable. Turning them on is a request the owner must accept, which
 * is exactly how every conferencing product behaves.
 */
export type ModerationAction =
  | "mute-audio" // enforced: the target stops sending audio
  | "mute-video" // enforced: the target stops sending video
  | "ask-audio" // request only: prompts the target to unmute
  | "ask-video"; // request only: prompts the target to turn the camera on

/** True for the actions a client applies without asking its user. */
export function isEnforced(action: ModerationAction) {
  return action === "mute-audio" || action === "mute-video";
}

/** Peer-to-peer negotiation, relayed verbatim between exactly two members. */
export type SignalPayload =
  | { kind: "description"; description: RTCSessionDescriptionInit }
  | { kind: "candidate"; candidate: RTCIceCandidateInit | null };

/** Server -> client, over the SSE stream. */
export type ServerEvent =
  /** Seated. `resumed` is true when reclaiming a seat after a reload. */
  | {
      t: "welcome";
      self: Participant;
      secret: string;
      /** Persist this to reclaim the same seat after a refresh. */
      resumeToken: string;
      roster: Participant[];
      capacity: number;
      visibility: RoomVisibility;
      resumed: boolean;
      /** Host's forced pin, if one is active. */
      pinned: PeerId | null;
    }
  /** Admitted to the waiting queue; the host has been asked. Private rooms only. */
  | { t: "waiting-approval" }
  /** Authoritative roster. Sent on any membership, capacity or visibility change. */
  | { t: "roster"; roster: Participant[]; capacity: number; visibility: RoomVisibility }
  | { t: "peer-joined"; peer: Participant }
  | { t: "peer-left"; peerId: PeerId; reason: LeaveReason }
  /** A peer's seat is held (reloading) or has been reclaimed. */
  | { t: "peer-away"; peerId: PeerId; away: boolean }
  /** Host only: somebody is asking to join. */
  | { t: "knock"; knockId: string; name: string }
  /** Host only: they gave up waiting. */
  | { t: "knock-withdrawn"; knockId: string }
  | { t: "signal"; from: PeerId; data: SignalPayload }
  /** The host pinned a participant for everyone. Null clears it. */
  | { t: "pin"; peerId: PeerId | null }
  /**
   * The room's host changed. Sent to everyone so each client can update its
   * controls; `isHost` on the roster is the authority, this is the event that
   * lets the new host be *told* rather than having to notice.
   *
   * `becameHost` is true only in the copy sent to the new host.
   */
  | { t: "host-changed"; peerId: PeerId; name: string; becameHost: boolean; byChoice: boolean }
  /**
   * The host moderated this client's devices. `isEnforced(action)` actions are
   * applied immediately; the others are prompts the user may decline.
   */
  | { t: "moderated"; action: ModerationAction; byName: string }
  | { t: "ended"; reason: EndReason }
  | { t: "ping" };

/** Client -> server, as a POST body. */
export type ClientMessage =
  /** Negotiation aimed at one specific member. Never broadcast. */
  | { t: "signal"; to: PeerId; data: SignalPayload }
  /** Leave voluntarily. Any participant may do this; the room survives. */
  | { t: "leave" }
  /** Host only: end the session for everyone. */
  | { t: "close" }
  /** Host only: answer a knock. */
  | { t: "admit"; knockId: string; allow: boolean }
  /** Host only: change the participant limit, within ROOM_CAPACITY. */
  | { t: "capacity"; value: number }
  /**
   * Host only: open the room to anyone with the link, or close it back down so
   * arrivals knock again. Opening it seats whoever is already waiting.
   */
  | { t: "visibility"; value: RoomVisibility }
  /** Host only: eject a participant. */
  | { t: "remove"; peerId: PeerId }
  /**
   * Host only: hand the room to someone else and stay in it.
   *
   * Distinct from leaving: a host who leaves triggers automatic succession, but
   * that gives them no say in who takes over. This lets them choose, which is
   * the point when the host is the only one who can close the room or admit
   * anyone.
   */
  | { t: "transfer-host"; peerId: PeerId }
  /** Host only: force a pin for everyone. Null clears it. */
  | { t: "pin"; peerId: PeerId | null }
  /**
   * Host only: moderate one participant's devices, or everyone else's when
   * `peerId` is null. Never applies to the host's own devices.
   */
  | { t: "moderate"; peerId: PeerId | null; action: ModerationAction };

/**
 * Deterministic negotiation roles for a mesh.
 *
 * Perfect negotiation needs exactly one impolite peer per pair, and both sides
 * must agree without talking about it. Comparing ids gives a total order that
 * both peers compute identically.
 */
export function isPolite(selfId: PeerId, remoteId: PeerId) {
  return selfId > remoteId;
}

/**
 * Who sends the first offer for a pair. The peer already in the room initiates
 * to the newcomer, so setup never starts with a collision. `joinedAt` ties are
 * broken by id, since two peers can be seated in the same millisecond.
 */
export function isInitiator(self: Participant, remote: Participant) {
  if (self.joinedAt !== remote.joinedAt) return self.joinedAt < remote.joinedAt;
  return self.id < remote.id;
}

export const SIGNAL_LIMITS = {
  /** One SDP for audio+video+data. Mesh SDPs are per-pair, so still small. */
  maxMessageBytes: 96 * 1024,
  /**
   * Relay budget per room. A 7-way mesh is 21 pairs, each needing an offer, an
   * answer and a stream of candidates, plus renegotiation whenever anyone
   * toggles a device -- so this scales with capacity rather than being fixed.
   */
  maxMessagesPerParticipant: 600,
  /** An empty room (nobody seated, nobody knocking) is released after this. */
  emptyTtlMs: 2 * 60 * 1000,
  /** A room that never got a second participant is released after this. */
  lobbyTtlMs: 30 * 60 * 1000,
  /**
   * How long a seat is held after the stream drops. Long enough to cover a
   * page reload and a slow reconnect; short enough that a genuinely departed
   * peer stops occupying a slot.
   */
  awayTtlMs: 45 * 1000,
  /** How long an unanswered knock waits before it is withdrawn. */
  knockTtlMs: 2 * 60 * 1000,
  /** Hard ceiling on a room's lifetime in the registry. */
  roomTtlMs: 12 * 60 * 60 * 1000,
  keepAliveMs: 20 * 1000,
  maxNameLength: 32,
} as const;

export const PEER_ID_HEADER = "x-peer-id";
export const PEER_SECRET_HEADER = "x-peer-secret";

/** Query parameters on the joining GET. */
export const JOIN_PARAM = {
  name: "name",
  /** Presenting a valid token reclaims an away seat and skips the knock. */
  resume: "resume",
  /**
   * The browser's persistent anonymous id (lib/identity.ts). The room
   * remembers the founder's uid as the admin identity, so the host is
   * recognised when they return without a resume token (new tab, cleared
   * session storage) instead of knocking as a stranger.
   */
  uid: "uid",
  /**
   * The visibility a FOUNDER wants for the room. Read only when this GET
   * actually founds the room; a joiner's value is ignored, because who may
   * enter is the host's call and nobody else's.
   */
  visibility: "visibility",
} as const;

/** A uid is a locally-minted UUID; anything else is treated as absent. */
export function sanitizeUid(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return /^[0-9a-fA-F-]{8,64}$/.test(raw) ? raw : "";
}

/** Names are shown to other people, so keep them short and single-line. */
export function sanitizeName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SIGNAL_LIMITS.maxNameLength);
}

export function clampCapacity(value: unknown): number {
  const n = typeof value === "number" ? Math.floor(value) : NaN;
  if (!Number.isFinite(n)) return ROOM_CAPACITY.default;
  return Math.min(ROOM_CAPACITY.max, Math.max(ROOM_CAPACITY.min, n));
}

/**
 * Video budget for a full mesh. Each peer uploads one copy per other peer, so
 * total upstream grows linearly with headcount while a home uplink does not.
 * These are the caps the transport applies to every outgoing video sender.
 *
 * Screen share is exempt: it is usually the point of the call, mostly static,
 * and compresses far better than a camera feed.
 */
export function videoBudget(participants: number) {
  if (participants <= 2) return { height: 720, maxBitrateKbps: 1500, frameRate: 30 };
  if (participants <= 3) return { height: 540, maxBitrateKbps: 900, frameRate: 30 };
  if (participants <= 4) return { height: 360, maxBitrateKbps: 600, frameRate: 25 };
  if (participants <= 5) return { height: 360, maxBitrateKbps: 450, frameRate: 20 };
  return { height: 270, maxBitrateKbps: 300, frameRate: 15 };
}
