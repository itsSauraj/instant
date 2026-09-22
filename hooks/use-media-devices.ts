"use client";

import { useCallback, useEffect, useState } from "react";

import {
  NO_CHOICE,
  groupDevices,
  loadDeviceChoice,
  reconcileChoice,
  saveDeviceChoice,
  supportsOutputSelection,
  type DeviceChoice,
  type DeviceKind,
  type DeviceOption,
} from "@/lib/media-devices";

const EMPTY: Record<DeviceKind, DeviceOption[]> = {
  audioinput: [],
  videoinput: [],
  audiooutput: [],
};

export type MediaDevices = {
  /** Every device the browser lists, by kind. Empty until it has been asked. */
  options: Record<DeviceKind, DeviceOption[]>;
  /** The remembered choice per kind; null means the system default. */
  choice: DeviceChoice;
  /** Whether this browser lets a page choose the speaker (Chromium does). */
  canPickOutput: boolean;
  /**
   * True while the browser withholds device names, which it does until a
   * microphone or camera has been allowed once. The UI says so rather than
   * showing "Microphone 1, Microphone 2" as if that were all there is.
   */
  unlabeled: boolean;
  select: (kind: DeviceKind, deviceId: string | null) => void;
  refresh: () => Promise<void>;
};

/**
 * The browser's device list plus this person's remembered choice, kept fresh.
 *
 * `refreshKey` re-reads the list whenever it changes; callers pass the media
 * version so the list picks up real device names the moment a capture is
 * first allowed. Plugging or unplugging hardware re-reads it too. `select`
 * only records the choice; the caller tells the transport to switch a live
 * capture over, so the error from that lands where it can be shown.
 */
export function useMediaDevices(refreshKey: number): MediaDevices {
  const [options, setOptions] = useState(EMPTY);
  const [choice, setChoice] = useState<DeviceChoice>(NO_CHOICE);
  const [canPickOutput, setCanPickOutput] = useState(false);

  // Storage and feature probes run after mount so server and client markup
  // agree; before that the pickers simply show the system default.
  useEffect(() => {
    setChoice(loadDeviceChoice());
    setCanPickOutput(supportsOutputSelection());
  }, []);

  const refresh = useCallback(async () => {
    const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!media?.enumerateDevices) return;
    try {
      setOptions(groupDevices(await media.enumerateDevices()));
    } catch {
      // Enumeration refused (insecure context, or a locked-down browser):
      // keep whatever list was last seen.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!media?.addEventListener) return;
    media.addEventListener("devicechange", refresh);
    return () => media.removeEventListener("devicechange", refresh);
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  const select = useCallback((kind: DeviceKind, deviceId: string | null) => {
    setChoice((current) => ({ ...current, [kind]: deviceId }));
    saveDeviceChoice(kind, deviceId);
  }, []);

  // A remembered device that is no longer plugged in reads as "default", so
  // the checkmark never sits beside a row that is not there.
  const reconciled: DeviceChoice = {
    audioinput: reconcileChoice(choice.audioinput, options.audioinput),
    videoinput: reconcileChoice(choice.videoinput, options.videoinput),
    audiooutput: reconcileChoice(choice.audiooutput, options.audiooutput),
  };

  const listed = [...options.audioinput, ...options.videoinput, ...options.audiooutput];
  const unlabeled = listed.length > 0 && listed.every((option) => option.generic);

  return { options, choice: reconciled, canPickOutput, unlabeled, select, refresh };
}
