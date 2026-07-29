"use client";

import { useEffect, useRef, useState } from "react";

import { pushToast } from "@/hooks/use-toasts";
import { getUserId } from "@/lib/identity";

/**
 * Shows the in-app toast and, when the tab is hidden, mirrors it as a native
 * browser notification so events still reach someone who switched windows.
 * Tagged per browser identity so a burst collapses into one system banner
 * instead of stacking.
 */
function notify(toast: Parameters<typeof pushToast>[0]) {
  pushToast(toast);

  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted" || !document.hidden) return;
  try {
    new Notification(toast.title, {
      body: toast.description,
      tag: `instant-${getUserId()}`,
    });
  } catch {
    // Some platforms only allow notifications via a service worker; the
    // toast and the title alert still cover those.
  }
}

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

  // Ask for notification permission on the first interaction: Chrome ignores
  // (and penalises) requests that do not come from a user gesture.
  useEffect(() => {
    if (typeof Notification === "undefined" || Notification.permission !== "default") return;
    const ask = () => void Notification.requestPermission();
    window.addEventListener("pointerdown", ask, { once: true });
    return () => window.removeEventListener("pointerdown", ask);
  }, []);

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
        notify({
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
        notify({ title: "Incoming file", description: transfer.name });
        continue;
      }
      if (transfer.status === "complete") {
        events += 1;
        notify({
          title: incoming ? "File received" : "File sent",
          description: transfer.name,
          variant: "success",
        });
        continue;
      }
      if (transfer.status === "failed") {
        events += 1;
        notify({
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
      notify({ title: "Video started", description: "The other side turned on a camera." });
    } else if (!current.remoteVideoLive && prev.remoteVideoLive) {
      notify({ title: "Video stopped" });
    }

    if (current.remoteAudioLive && !prev.remoteAudioLive) {
      events += 1;
      notify({ title: "Audio started", description: "You can now hear the other side." });
    }

    if (current.phase !== prev.phase) {
      if (current.phase === "connected") {
        events += 1;
        notify({ title: "Peer connected", description: "The session is now private to you two.", variant: "success" });
      } else if (current.phase === "ended") {
        events += 1;
        notify({ title: "Session ended", variant: "warning" });
      }
    }

    if (events > 0) setActivity((count) => count + events);
  });

  return activity;
}
