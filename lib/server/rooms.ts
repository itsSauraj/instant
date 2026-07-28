import { createToken } from "@/lib/ids";
import {
  SIGNAL_LIMITS,
  type EndReason,
  type PeerRole,
  type ServerEvent,
} from "@/lib/signal-protocol";

/**
 * In-memory signalling registry.
 *
 * Two invariants drive every method here:
 *
 *  1. **Strictly two peers.** A room accepts at most two occupants, and once
 *     the second one arrives the room is *sealed* — a vacated slot is never
 *     refilled. That closes the window where a third party could grab a seat
 *     after someone drops.
 *
 *  2. **Symmetric teardown.** When either peer leaves for any reason the whole
 *     room is destroyed and both streams are closed. There is no state a
 *     surviving peer could reuse, which is what makes the client-side reset
 *     unconditional rather than best-effort.
 *
 * Nothing is persisted: rooms exist only for the duration of the negotiation.
 */

type Occupant = {
  peerId: string;
  secret: string;
  role: PeerRole;
  emit: (event: ServerEvent) => void;
  disconnect: () => void;
};

type Room = {
  id: string;
  occupants: Map<string, Occupant>;
  sealed: boolean;
  relayCount: number;
  createdAt: number;
  /** The first occupant. Only the host may end the session or delegate that right. */
  hostPeerId: string | null;
  /** Host-granted permission for the guest to end the session. Off by default. */
  guestMayEnd: boolean;
  lobbyTimer?: ReturnType<typeof setTimeout>;
  hardTimer?: ReturnType<typeof setTimeout>;
};

export type JoinResult =
  | {
      ok: true;
      peerId: string;
      secret: string;
      role: PeerRole;
      peerPresent: boolean;
      isHost: boolean;
      guestMayEnd: boolean;
    }
  | { ok: false; error: "room-full" | "spent" };

// Survive Next.js dev-server module reloads; otherwise a peer's slot would be
// orphaned every time the route file is recompiled.
const registry: Map<string, Room> = ((globalThis as Record<string, unknown>)
  .__instantSignalRooms as Map<string, Room>) ?? new Map<string, Room>();
(globalThis as Record<string, unknown>).__instantSignalRooms = registry;

/**
 * Ids of rooms that were sealed and then torn down, with their expiry time.
 *
 * Without this, reloading the page mid-session would silently re-open a fresh
 * lobby on the same invite link — reviving a code that both peers had already
 * been told was dead. A room that never sealed is *not* tombstoned, so simply
 * refreshing while waiting in the lobby still works.
 */
const spent: Map<string, number> = ((globalThis as Record<string, unknown>).__instantSpentRooms as Map<
  string,
  number
>) ?? new Map<string, number>();
(globalThis as Record<string, unknown>).__instantSpentRooms = spent;

/** Keeps the tombstone map bounded; called on every join. */
function sweepSpent(now: number) {
  for (const [id, expiry] of spent) {
    if (expiry <= now) spent.delete(id);
  }
}

function clearTimers(room: Room) {
  if (room.lobbyTimer) clearTimeout(room.lobbyTimer);
  if (room.hardTimer) clearTimeout(room.hardTimer);
  room.lobbyTimer = undefined;
  room.hardTimer = undefined;
}

function armLobbyTimer(room: Room) {
  if (room.lobbyTimer) clearTimeout(room.lobbyTimer);
  room.lobbyTimer = setTimeout(() => {
    destroyRoom(room.id, "expired");
  }, SIGNAL_LIMITS.lobbyTtlMs);
  room.lobbyTimer.unref?.();
}

/**
 * Closes a room and every stream attached to it. Safe to call repeatedly and
 * from inside a stream's own cancel handler.
 *
 * @param exceptPeerId a peer that is already gone and must not be notified.
 */
export function destroyRoom(roomId: string, reason: EndReason, exceptPeerId?: string) {
  const room = registry.get(roomId);
  if (!room) return;

  // Delete first so re-entrant calls from disconnect() handlers are no-ops.
  registry.delete(roomId);
  clearTimers(room);

  // Burn the code, but only if two people actually met here.
  if (room.sealed) {
    spent.set(roomId, Date.now() + SIGNAL_LIMITS.spentTtlMs);
  }

  for (const occupant of room.occupants.values()) {
    if (occupant.peerId !== exceptPeerId) {
      try {
        occupant.emit({ t: "peer-left", reason });
      } catch {
        // Stream already torn down by the client; nothing to salvage.
      }
    }
    try {
      occupant.disconnect();
    } catch {
      // Same.
    }
  }
  room.occupants.clear();
}

export function joinRoom(
  roomId: string,
  handlers: { emit: (event: ServerEvent) => void; disconnect: () => void },
): JoinResult {
  const now = Date.now();
  sweepSpent(now);
  if (spent.has(roomId)) return { ok: false, error: "spent" };

  let room = registry.get(roomId);

  if (!room) {
    room = {
      id: roomId,
      occupants: new Map(),
      sealed: false,
      relayCount: 0,
      createdAt: now,
      hostPeerId: null,
      guestMayEnd: false,
    };
    registry.set(roomId, room);
    room.hardTimer = setTimeout(() => {
      destroyRoom(roomId, "room-closed");
    }, SIGNAL_LIMITS.roomTtlMs);
    room.hardTimer.unref?.();
    armLobbyTimer(room);
  }

  // Sealed rooms reject everyone, including a peer trying to reclaim a slot it
  // just released. Reconnecting means starting a new room.
  if (room.sealed || room.occupants.size >= 2) {
    return { ok: false, error: "room-full" };
  }

  const peerPresent = room.occupants.size === 1;
  const occupant: Occupant = {
    peerId: createToken(8),
    secret: createToken(24),
    // First in creates the offer; second in answers it.
    role: peerPresent ? "responder" : "initiator",
    emit: handlers.emit,
    disconnect: handlers.disconnect,
  };
  room.occupants.set(occupant.peerId, occupant);
  // The first occupant is the host. A room whose sole occupant leaves is always
  // destroyed (never refilled), so this can never point at a departed peer.
  if (room.hostPeerId === null) room.hostPeerId = occupant.peerId;

  if (room.occupants.size === 2) {
    room.sealed = true;
    if (room.lobbyTimer) clearTimeout(room.lobbyTimer);
    room.lobbyTimer = undefined;
    for (const other of room.occupants.values()) {
      if (other.peerId !== occupant.peerId) other.emit({ t: "peer-joined" });
    }
  }

  return {
    ok: true,
    peerId: occupant.peerId,
    secret: occupant.secret,
    role: occupant.role,
    peerPresent,
    isHost: room.hostPeerId === occupant.peerId,
    guestMayEnd: room.guestMayEnd,
  };
}

type AuthResult =
  | { ok: true; room: Room; self: Occupant; other: Occupant | undefined }
  | { ok: false; error: "unknown-room" | "unauthorized" };

function authenticate(roomId: string, peerId: string, secret: string): AuthResult {
  const room = registry.get(roomId);
  if (!room) return { ok: false, error: "unknown-room" };

  const self = room.occupants.get(peerId);
  // Constant-time comparison is overkill for a 120-bit single-use token that
  // an attacker cannot oracle, but a length check keeps the compare cheap.
  if (!self || self.secret.length !== secret.length || self.secret !== secret) {
    return { ok: false, error: "unauthorized" };
  }

  const other = [...room.occupants.values()].find((o) => o.peerId !== peerId);
  return { ok: true, room, self, other };
}

export type RelayResult =
  | { ok: true; delivered: boolean }
  | { ok: false; error: "unknown-room" | "unauthorized" | "rate-limited" };

/** Relays one payload to the *other* occupant. Never echoes, never broadcasts. */
export function relay(
  roomId: string,
  peerId: string,
  secret: string,
  event: ServerEvent,
): RelayResult {
  const auth = authenticate(roomId, peerId, secret);
  if (!auth.ok) return auth;

  auth.room.relayCount += 1;
  if (auth.room.relayCount > SIGNAL_LIMITS.maxMessagesPerRoom) {
    destroyRoom(roomId, "room-closed");
    return { ok: false, error: "rate-limited" };
  }

  if (!auth.other) return { ok: true, delivered: false };
  auth.other.emit(event);
  return { ok: true, delivered: true };
}

/**
 * Called when a peer leaves deliberately or its stream dies. Either way the
 * room goes with it, so the remaining peer is forced through a full reset.
 */
export function leaveRoom(roomId: string, peerId: string, reason: EndReason) {
  const room = registry.get(roomId);
  if (!room?.occupants.has(peerId)) return;
  destroyRoom(roomId, reason, peerId);
}

export function verifyPeer(roomId: string, peerId: string, secret: string) {
  return authenticate(roomId, peerId, secret).ok;
}

export type EndSessionResult =
  | { ok: true }
  | { ok: false; error: "unknown-room" | "unauthorized" | "forbidden" };

/**
 * Deliberate hang-up (`bye`). Authenticated *and* authorised: the host may
 * always end the session; the guest only once the host has granted it. A
 * refused request leaves the room completely untouched.
 */
export function endSession(roomId: string, peerId: string, secret: string): EndSessionResult {
  const auth = authenticate(roomId, peerId, secret);
  if (!auth.ok) return auth;

  if (auth.room.hostPeerId !== peerId && !auth.room.guestMayEnd) {
    return { ok: false, error: "forbidden" };
  }

  destroyRoom(roomId, "peer-ended", peerId);
  return { ok: true };
}

export type PermissionResult =
  | { ok: true }
  | { ok: false; error: "unknown-room" | "unauthorized" | "forbidden" };

/**
 * Host-only: grants or revokes the guest's right to end the session, and tells
 * the guest (if present) so its UI updates live. Anyone else changes nothing.
 */
export function setGuestMayEnd(
  roomId: string,
  peerId: string,
  secret: string,
  allow: boolean,
): PermissionResult {
  const auth = authenticate(roomId, peerId, secret);
  if (!auth.ok) return auth;

  if (auth.room.hostPeerId !== peerId) return { ok: false, error: "forbidden" };

  auth.room.guestMayEnd = allow;
  if (auth.other) {
    try {
      auth.other.emit({ t: "permission", guestMayEnd: allow });
    } catch {
      // Guest stream already torn down; the flag itself is what matters.
    }
  }
  return { ok: true };
}
