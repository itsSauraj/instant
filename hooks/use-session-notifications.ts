"use client";

import { useEffect, useRef, useState } from "react";

import { pushToast } from "@/hooks/use-toasts";

/**
 * Turns session transitions into visible notifications, and reports a running
 * activity count so the tab title can flag what happened while you were away.
 *
 * Kept separate from `useSessionSounds` on purpose: muting the audio must not
 * also silence the visual notifications, and vice versa. Both edge-detect the
 * same snapshot independently.
 *
 * Like the sound hook, it takes the values the caller already rendered rather
 * than subscribing to the session store, so it stays decoupled from the
 * store's internals.
 */
export type SessionNotificationsInput = {
  phase: string;
  notes: ReadonlyArray<{ mine: boolean }>;
  transfers: ReadonlyArray<{
    key: string;
    name: string;
    direction: string;
    status: string;
    error?: string;
  }>;
  media: { remoteAudioLive: boolean; remoteVideoLive: boolean };
};

type Remembered = {
  phase: string;
  noteCount: number;
  transfers: Map<string, string>;
  remoteAudioLive: boolean;
  remoteVideoLive: boolean;
};

function remember(input: SessionNotificationsInput): Remembered {
  const transfers = new Map<string, string>();
  for (const transfer of input.transfers) transfers.set(transfer.key, transfer.status);
  return {
    phase: input.phase,
    noteCount: input.notes.length,
    transfers,
    remoteAudioLive: input.media.remoteAudioLive,
    remoteVideoLive: input.media.remoteVideoLive,
  };
}

/** @returns a monotonically increasing count of notable events this session. */
export function useSessionNotifications(input: SessionNotificationsInput): number {
  const previous = useRef<Remembered | null>(null);
  const [activity, setActivity] = useState(0);

  useEffect(() => {
    const current = remember(input);
    const prev = previous.current;
    previous.current = current;

    // First render only establishes the baseline. Without this, opening a room
    // that already has state would fire a burst of toasts for old events.
    if (!prev) return;

    let events = 0;

    // A note the peer sent. Our own notes are already visible in the composer.
    const incomingNotes = current.noteCount - prev.noteCount;
    if (incomingNotes > 0) {
      const mine = input.notes.slice(-incomingNotes).every((note) => note.mine);
      if (!mine) {
        events += incomingNotes;
        pushToast({
          title: incomingNotes > 1 ? `${incomingNotes} new notes` : "New note",
          description: "Open the Notes tab to read it.",
        });
      }
    }

    for (const transfer of input.transfers) {
      const before = prev.transfers.get(transfer.key);
      if (before === transfer.status) continue;

      const incoming = transfer.direction === "incoming";

      if (transfer.status === "active" && before === undefined && incoming) {
        pushToast({ title: "Incoming file", description: transfer.name });
        continue;
      }
      if (transfer.status === "complete") {
        events += 1;
        pushToast({
          title: incoming ? "File received" : "File sent",
          description: transfer.name,
          variant: "success",
        });
        continue;
      }
      if (transfer.status === "failed") {
        events += 1;
        pushToast({
          title: incoming ? "Incoming transfer failed" : "Could not send file",
          description: transfer.error ? `${transfer.name} - ${transfer.error}` : transfer.name,
          variant: "error",
        });
      }
      // Cancellations are deliberately silent: whoever cancelled already knows,
      // and the row in the Files tab records it.
    }

    if (current.remoteVideoLive && !prev.remoteVideoLive) {
      events += 1;
      pushToast({ title: "Video started", description: "The other side turned on a camera." });
    } else if (!current.remoteVideoLive && prev.remoteVideoLive) {
      pushToast({ title: "Video stopped" });
    }

    if (current.remoteAudioLive && !prev.remoteAudioLive) {
      events += 1;
      pushToast({ title: "Audio started", description: "You can now hear the other side." });
    }

    if (current.phase !== prev.phase) {
      if (current.phase === "connected") {
        events += 1;
        pushToast({ title: "Peer connected", description: "The session is now private to you two.", variant: "success" });
      } else if (current.phase === "ended") {
        events += 1;
        pushToast({ title: "Session ended", variant: "warning" });
      }
    }

    if (events > 0) setActivity((count) => count + events);
  });

  return activity;
}
