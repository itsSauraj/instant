"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { MeshSession, type LinkQuality, type MeshSnapshot } from "@/lib/mesh-session";
import {
  ROOM_CAPACITY,
  type ModerationAction,
  type PeerId,
  type RoomVisibility,
} from "@/lib/signal-protocol";
import { TRANSFER_LIMITS, type SendTargets } from "@/lib/transfer-contract";

/** Rendered while the session object is being constructed on mount. */
const INITIAL: MeshSnapshot = {
  phase: "joining",
  self: null,
  participants: [],
  capacity: ROOM_CAPACITY.default,
  visibility: "private",
  isHost: false,
  pinnedByHost: null,
  knocks: [],
  notes: [],
  typingPeers: [],
  peerTyping: false,
  transfers: [],
  sink: {
    tier: "memory",
    streaming: false,
    maxBytes: TRANSFER_LIMITS.maxMemoryBytes,
    hasDestination: false,
    destinationLabel: null,
  },
  canChooseFolder: false,
  media: {
    micOn: false,
    cameraOn: false,
    screenOn: false,
    screenAudioOn: false,
    screenAudioSupport: "unknown",
    remoteAudioLive: false,
    remoteVideoLive: false,
    byPeer: {},
    version: 0,
  },
  doc: { text: "", rev: 0, at: 0, mine: false },
  moderation: null,
  hostChange: null,
  error: null,
  endReason: null,
};

const NO_SUBSCRIBE = () => () => {};
const getInitial = () => INITIAL;

const TYPING_IDLE_MS = 1500;

/**
 * Binds one `MeshSession` to React. Returns a flat object: the snapshot
 * spread open, plus streams and stable action callbacks.
 *
 * `useSessionSounds` and `useSessionNotifications` consume this object
 * structurally - `phase`, `endReason`, `error`, `notes[].mine`,
 * `transfers[]{key,name,direction,status,error}`, `media.{micOn,cameraOn,
 * screenOn,remoteAudioLive,remoteVideoLive}` - so those fields keep their
 * names and shapes across the mesh rewrite.
 */
export function usePeerSession(
  roomId: string,
  displayName = "",
  /** The visibility to found the room with, should this join create it.
   *  Ignored by the server for a room that already exists. */
  foundAs: RoomVisibility = "private",
) {
  const [session, setSession] = useState<MeshSession | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingActive = useRef(false);

  useEffect(() => {
    const instance = new MeshSession(roomId, displayName, { visibility: foundAs });
    setSession(instance);
    // Deferred a tick so StrictMode's dev-only mount/unmount/mount cycle never
    // opens a first signalling stream: it would claim a seat, then abort and
    // leave the surviving instance looking like a second participant.
    const startTimer = setTimeout(() => instance.start(), 0);

    // A real unload (reload or tab close) must NOT send `leave`: the server
    // holds the seat and the sessionStorage resume token reclaims it after a
    // reload. handlePageHide only releases page-local resources.
    const onPageHide = () => instance.handlePageHide();
    window.addEventListener("pagehide", onPageHide);

    return () => {
      // Effect cleanup, by contrast, is an in-app departure (route change, or
      // the StrictMode probe before start() ever ran): leave deliberately so
      // the room is told immediately instead of after the away grace.
      clearTimeout(startTimer);
      if (typingTimer.current) {
        clearTimeout(typingTimer.current);
        typingTimer.current = null;
      }
      typingActive.current = false;
      window.removeEventListener("pagehide", onPageHide);
      instance.leave();
      setSession(null);
    };
  }, [roomId, displayName, foundAs]);

  const snapshot = useSyncExternalStore(
    session ? session.subscribe : NO_SUBSCRIBE,
    session ? session.getSnapshot : getInitial,
    getInitial,
  );

  const sendNote = useCallback(
    (text: string) => {
      if (typingTimer.current) {
        clearTimeout(typingTimer.current);
        typingTimer.current = null;
      }
      if (typingActive.current) {
        typingActive.current = false;
        session?.setTyping(false);
      }
      session?.sendNote(text);
    },
    [session],
  );

  /** Call on every keystroke; the off-signal is sent automatically when idle. */
  const notifyTyping = useCallback(() => {
    if (!session) return;
    if (!typingActive.current) {
      typingActive.current = true;
      session.setTyping(true);
    }
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      typingActive.current = false;
      session.setTyping(false);
    }, TYPING_IDLE_MS);
  }, [session]);

  /**
   * Send to everyone (no second argument), to an explicit `SendTargets` list
   * of peer ids, or - legacy convenience - to a single peer id string.
   */
  const sendFiles = useCallback(
    (files: File[], to?: SendTargets | PeerId | null) => {
      void session?.sendFiles(files, to);
    },
    [session],
  );

  const updateDoc = useCallback((text: string) => session?.updateDoc(text), [session]);
  const cancelTransfer = useCallback((key: string) => session?.cancelTransfer(key), [session]);

  /** Continue a persisted partial transfer (a `partial:<uid>` snapshot key).
   *  Works while the original sender is connected; honest error otherwise. */
  const resumeTransfer = useCallback((key: string) => session?.resumeTransfer(key), [session]);
  /** Forget a persisted partial transfer: its record and its stored bytes. */
  const discardPartial = useCallback((key: string) => session?.discardPartial(key), [session]);

  /** Prompt for a destination folder. Call from a user gesture; resolves
   *  false when unsupported or cancelled. Capability updates in `sink`. */
  const chooseSaveFolder = useCallback(
    () => session?.chooseSaveFolder() ?? Promise.resolve(false),
    [session],
  );
  /** Forget the chosen folder and fall back to the next sink tier. */
  const clearSaveFolder = useCallback(() => session?.clearSaveFolder(), [session]);

  /** Leave the room yourself; the others keep going. */
  const leaveSession = useCallback(() => session?.leave(), [session]);
  /** Host only: end the session for everyone (no-op for guests). */
  const closeSession = useCallback(() => session?.close(), [session]);
  /** Legacy alias for the old single "End session" button: the host closes
   *  the room, anyone else just leaves. Prefer the two explicit actions. */
  const endSession = useCallback(() => {
    if (!session) return;
    if (session.getSnapshot().isHost) session.close();
    else session.leave();
  }, [session]);

  const toggleMic = useCallback(() => session?.toggleMic() ?? Promise.resolve(), [session]);
  const toggleCamera = useCallback(() => session?.toggleCamera() ?? Promise.resolve(), [session]);
  /** Starts or stops the screen share. Desktop/tab audio is requested with it
   *  and included when the platform and the user grant it; `media.screenAudioOn`
   *  reports whether any actually flowed. Rejects when the picker is dismissed. */
  const toggleScreenShare = useCallback(
    () => session?.toggleScreenShare() ?? Promise.resolve(),
    [session],
  );
  /** Drop shared desktop audio while the picture keeps flowing. One-way: only a
   *  fresh screen share can grant display audio again, so do not present this as
   *  a toggle. */
  const stopScreenAudio = useCallback(() => session?.stopScreenAudio(), [session]);

  // Host controls (the server rejects them from anyone else).
  const admit = useCallback(
    (knockId: string, allow: boolean) => session?.admit(knockId, allow),
    [session],
  );
  const setCapacity = useCallback((value: number) => session?.setCapacity(value), [session]);
  /** Host only: open the room to anyone with the link (`public`) or make
   *  arrivals knock (`private`). `visibility` on the snapshot reflects it. */
  const setVisibility = useCallback(
    (value: RoomVisibility) => session?.setVisibility(value),
    [session],
  );
  const removePeer = useCallback((peerId: PeerId) => session?.removePeer(peerId), [session]);
  const pinPeer = useCallback((peerId: PeerId | null) => session?.pin(peerId), [session]);
  /** Host only: moderate one peer's devices (null = everyone else's). The
   *  server enforces host-ness; the resulting `moderated` event lands in
   *  `moderation` on the snapshot with a monotonically increasing `seq`. */
  const moderate = useCallback(
    (peerId: PeerId | null, action: ModerationAction) => session?.moderate(peerId, action),
    [session],
  );
  /** Host only: hand the room to another participant and stay as a guest.
   *  Confirmation arrives as the `hostChange` notification on the snapshot
   *  (react to it once per `seq`), while `isHost` flips via the authoritative
   *  roster - the roster, not the notification, is the truth. */
  const transferHost = useCallback((peerId: PeerId) => session?.transferHost(peerId), [session]);

  // An ended session has no streams. The MediaStream objects themselves live
  // for the whole session (tracks are added and removed on them), so without
  // this a <video> stays bound to an emptied stream after teardown.
  const live = snapshot.phase !== "ended";

  /** Per-peer remote stream lookup; identity is stable, re-read on
   *  `media.version` changes. Null when that link is not live. */
  const getRemoteStream = useCallback(
    (peerId: PeerId) => session?.getRemoteStream(peerId) ?? null,
    [session],
  );

  /** Polled by the participants panel while it is open; never in snapshots. */
  const getLinkQuality = useCallback(
    (peerId: PeerId): Promise<LinkQuality> =>
      session?.getLinkQuality(peerId) ?? Promise.resolve({ state: "closed", rttMs: null }),
    [session],
  );

  /** DTLS emoji fingerprint for one peer; null until directly connected. */
  const getPairFingerprint = useCallback(
    (peerId: PeerId) => session?.getPairFingerprint(peerId) ?? Promise.resolve(null),
    [session],
  );

  // Convenience map for grid rendering. Rebuilt per snapshot render - with a
  // 7-person cap this is at most six lookups.
  const remoteStreams = new Map<PeerId, MediaStream>();
  if (live && session) {
    for (const participant of snapshot.participants) {
      const stream = session.getRemoteStream(participant.id);
      if (stream) remoteStreams.set(participant.id, stream);
    }
  }

  return {
    ...snapshot,
    localStream: live ? (session?.getLocalStream() ?? null) : null,
    remoteStreams,
    getRemoteStream,
    getLinkQuality,
    getPairFingerprint,
    sendNote,
    notifyTyping,
    updateDoc,
    sendFiles,
    cancelTransfer,
    resumeTransfer,
    discardPartial,
    chooseSaveFolder,
    clearSaveFolder,
    // The engine's own provider, so the destination picker steers the sink that
    // actually receives files rather than a second, inert instance.
    sinkProvider: session?.getSinkProvider() ?? null,
    leaveSession,
    closeSession,
    endSession,
    toggleMic,
    toggleCamera,
    toggleScreenShare,
    stopScreenAudio,
    admit,
    setCapacity,
    setVisibility,
    removePeer,
    pinPeer,
    moderate,
    transferHost,
  };
}

export type PeerSessionApi = ReturnType<typeof usePeerSession>;
