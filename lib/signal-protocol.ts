/** Wire types shared by the signalling route and the browser transport. */

export type PeerRole = "initiator" | "responder";

/** Why a session ended. Both peers always agree on this before tearing down. */
export type EndReason =
  | "peer-left" // the other side navigated away / closed the tab
  | "peer-ended" // the other side pressed "End session"
  | "room-full" // a third participant was refused
  | "session-over" // this code already hosted a session and is burned
  | "room-closed" // the server destroyed the room
  | "expired" // nobody joined in time
  | "transport-error" // signalling stream died
  | "self-ended"; // this side pressed "End session"

/** Server -> client. */
export type ServerEvent =
  | {
      t: "welcome";
      peerId: string;
      secret: string;
      role: PeerRole;
      peerPresent: boolean;
      /** True for the room's first occupant — the only peer that may always end it. */
      isHost: boolean;
      /** Whether the host has delegated the right to end the session. */
      guestMayEnd: boolean;
    }
  | { t: "peer-joined" }
  | { t: "peer-left"; reason: EndReason }
  | { t: "signal"; data: SignalPayload }
  /** The host toggled whether the guest may end the session. Sent to the guest. */
  | { t: "permission"; guestMayEnd: boolean }
  | { t: "ping" };

/** Client -> client, relayed verbatim by the server. */
export type SignalPayload =
  | { kind: "description"; description: RTCSessionDescriptionInit }
  | { kind: "candidate"; candidate: RTCIceCandidateInit | null };

/** Client -> server request bodies. */
export type ClientMessage =
  | { t: "signal"; data: SignalPayload }
  | { t: "bye" }
  /** Host only: grant or revoke the guest's right to end the session. */
  | { t: "permission"; allow: boolean };

export const SIGNAL_LIMITS = {
  /** SDP for audio+video+2 data channels stays well under this. */
  maxMessageBytes: 96 * 1024,
  /** Per-room relay budget; renegotiation and ICE never come close. */
  maxMessagesPerRoom: 400,
  /** A room with only one occupant is garbage collected after this. */
  lobbyTtlMs: 10 * 60 * 1000,
  /** How long a finished session's code stays unusable. */
  spentTtlMs: 15 * 60 * 1000,
  /** Hard ceiling on any room's lifetime in the signalling registry. */
  roomTtlMs: 60 * 60 * 1000,
  keepAliveMs: 20 * 1000,
} as const;

export const PEER_ID_HEADER = "x-peer-id";
export const PEER_SECRET_HEADER = "x-peer-secret";
