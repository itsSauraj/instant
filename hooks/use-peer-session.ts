"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { PeerSession, type SessionSnapshot } from "@/lib/peer-session";

/** Rendered while the session object is being constructed on mount. */
const INITIAL: SessionSnapshot = {
  phase: "joining",
  role: null,
  endReason: null,
  error: null,
  notes: [],
  peerTyping: false,
  transfers: [],
  media: {
    micOn: false,
    cameraOn: false,
    screenOn: false,
    remoteAudioLive: false,
    remoteVideoLive: false,
    version: 0,
  },
  channelsReady: false,
  isHost: false,
  guestMayEnd: false,
  canEndSession: false,
};

const NO_SUBSCRIBE = () => () => {};
const getInitial = () => INITIAL;

const TYPING_IDLE_MS = 1500;

export function usePeerSession(roomId: string) {
  const [session, setSession] = useState<PeerSession | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingActive = useRef(false);

  useEffect(() => {
    const instance = new PeerSession(roomId);
    setSession(instance);
    // Deferred a tick so StrictMode's dev-only mount/unmount/mount cycle never
    // opens a first signalling stream: it would land as a second peer, seal the
    // room, and tear it down for the surviving instance when it aborts.
    const startTimer = setTimeout(() => instance.start(), 0);

    // Notify the peer eagerly on tab close; the server would notice the dropped
    // stream anyway, but this makes the other side reset within a frame.
    const onPageHide = () => instance.end("self-ended", true);
    window.addEventListener("pagehide", onPageHide);

    return () => {
      clearTimeout(startTimer);
      window.removeEventListener("pagehide", onPageHide);
      instance.end("self-ended", true);
      setSession(null);
    };
  }, [roomId]);

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

  const sendFiles = useCallback(
    (files: File[]) => {
      void session?.sendFiles(files);
    },
    [session],
  );

  const cancelTransfer = useCallback((key: string) => session?.cancelTransfer(key), [session]);
  const endSession = useCallback(() => session?.end("self-ended", true), [session]);

  /** Host only: grant or revoke the guest's right to end the session. */
  const setGuestMayEnd = useCallback(
    (allow: boolean) => session?.setGuestMayEnd(allow),
    [session],
  );

  const toggleMic = useCallback(() => session?.toggleMic() ?? Promise.resolve(), [session]);
  const toggleCamera = useCallback(() => session?.toggleCamera() ?? Promise.resolve(), [session]);
  const toggleScreenShare = useCallback(
    () => session?.toggleScreenShare() ?? Promise.resolve(),
    [session],
  );

  // An ended session has no streams. The MediaStream objects themselves live
  // for the whole session (tracks are added and removed on them), so without
  // this a <video> stays bound to an emptied stream after teardown.
  const live = snapshot.phase !== "ended";

  return {
    ...snapshot,
    localStream: live ? (session?.getLocalStream() ?? null) : null,
    remoteStream: live ? (session?.getRemoteStream() ?? null) : null,
    sendNote,
    notifyTyping,
    sendFiles,
    cancelTransfer,
    endSession,
    setGuestMayEnd,
    toggleMic,
    toggleCamera,
    toggleScreenShare,
  };
}

export type PeerSessionApi = ReturnType<typeof usePeerSession>;
