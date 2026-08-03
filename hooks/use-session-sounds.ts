"use client";

import { useEffect, useRef } from "react";

import { playCue, primeSoundEngine, type SoundCue } from "@/lib/sound";

/**
 * The slice of the rendered session this hook needs. It deliberately does NOT
 * import or subscribe to the session store: the caller passes the values it
 * already rendered (the object returned by `usePeerSession` satisfies this
 * shape structurally), so this file has no coupling to the store's internals.
 */
export type SessionSoundsInput = {
  phase: string;
  endReason?: string | null;
  error?: string | null;
  notes: ReadonlyArray<{ mine: boolean }>;
  transfers: ReadonlyArray<{ key: string; direction: string; status: string }>;
  media: { micOn: boolean; cameraOn: boolean; screenOn: boolean };
  /** Host only (always empty for guests): pending join requests. */
  knocks?: ReadonlyArray<{ knockId: string }>;
};

/** What we remember between renders - just enough to detect edges. */
type Remembered = {
  phase: string;
  error: string | null;
  noteCount: number;
  knockIds: Set<string>;
  transferStatus: Map<string, { direction: string; status: string }>;
  micOn: boolean;
  cameraOn: boolean;
  screenOn: boolean;
};

function remember(input: SessionSoundsInput): Remembered {
  const transferStatus = new Map<string, { direction: string; status: string }>();
  for (const t of input.transfers) {
    transferStatus.set(t.key, { direction: t.direction, status: t.status });
  }
  return {
    phase: input.phase,
    error: input.error ?? null,
    noteCount: input.notes.length,
    knockIds: new Set((input.knocks ?? []).map((knock) => knock.knockId)),
    transferStatus,
    micOn: input.media.micOn,
    cameraOn: input.media.cameraOn,
    screenOn: input.media.screenOn,
  };
}

/**
 * Fires a sound cue on each session transition. Edges are detected by
 * comparing the current render against the previous one, so cues fire on
 * TRANSITIONS ONLY - never on plain re-renders, and never as a burst on first
 * mount when pre-existing state (old notes, finished transfers) is first seen.
 */
export function useSessionSounds(input: SessionSoundsInput) {
  const prev = useRef<Remembered | null>(null);

  // Register the gesture-unlock listeners as early as possible so the user's
  // first click anywhere is the one that unlocks audio.
  useEffect(() => {
    primeSoundEngine();
  }, []);

  // No dependency array on purpose: the comparison below is cheap and must see
  // every render, since `transfers` items mutate status without changing length.
  useEffect(() => {
    const before = prev.current;
    prev.current = remember(input);
    if (!before) return; // first mount: seed the baseline, play nothing

    const now = prev.current;
    const fired = new Set<SoundCue>();
    const fire = (cue: SoundCue) => {
      // Collapse per render pass; the engine rate-limits across passes too.
      if (fired.has(cue)) return;
      fired.add(cue);
      playCue(cue);
    };

    // --- session end trumps everything else this pass: teardown also drops
    // tracks and clears transfers, and those must not chirp over the cadence.
    if (now.phase === "ended" && before.phase !== "ended") {
      const reason = input.endReason ?? null;
      fire(reason === "peer-left" || reason === "peer-ended" ? "peerLeft" : "sessionEnded");
      return;
    }

    if (now.phase === "connected" && before.phase !== "connected") fire("peerJoined");

    // --- a NEW knock (not merely one remaining answered/expired) taps twice.
    for (const id of now.knockIds) {
      if (!before.knockIds.has(id)) {
        fire("knock");
        break;
      }
    }

    // --- notes: the array only ever appends while a session is live.
    if (now.noteCount > before.noteCount) {
      for (const note of input.notes.slice(before.noteCount)) {
        fire(note.mine ? "noteSent" : "noteReceived");
      }
    }

    // --- transfers: new keys are starts, status flips are outcomes.
    for (const [key, current] of now.transferStatus) {
      const previous = before.transferStatus.get(key);
      if (!previous) {
        if (current.status === "pending" || current.status === "active") fire("fileStarted");
        continue;
      }
      if (previous.status === current.status) continue;
      if (current.status === "complete") {
        fire(current.direction === "outgoing" ? "fileSent" : "fileReceived");
      } else if (current.status === "failed") {
        fire("fileFailed");
      }
      // "cancelled" stays silent: the user did it deliberately, on either side.
    }

    // --- local device toggles.
    if (now.micOn !== before.micOn) fire(now.micOn ? "micOn" : "micOff");
    if (now.cameraOn !== before.cameraOn) fire(now.cameraOn ? "cameraOn" : "cameraOff");
    if (now.screenOn !== before.screenOn) fire(now.screenOn ? "screenShareOn" : "screenShareOff");

    // --- errors: only a NEW message chimes, and not twice when the same
    // failure already sounded as fileFailed.
    if (now.error && now.error !== before.error && !fired.has("fileFailed")) fire("error");
  });
}
