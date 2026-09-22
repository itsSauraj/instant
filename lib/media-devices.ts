/**
 * Device choice for the call: which microphone and camera to capture from,
 * and which speaker to play the others through.
 *
 * The choice is remembered per browser in localStorage and applied as an
 * `exact` constraint. Exact, because browsers treat an `ideal` device id as a
 * mere hint and happily hand back the default instead; the transport pairs it
 * with a retry on the default for the one failure that means "that device is
 * gone", so a remembered headset that is unplugged today still does not fail
 * the capture. Nothing here touches a device; the transport captures, the
 * tiles play, and this module only says which one they should use.
 */

export type DeviceKind = "audioinput" | "videoinput" | "audiooutput";

export type DeviceChoice = Record<DeviceKind, string | null>;

export type DeviceOption = {
  deviceId: string;
  label: string;
  /** The browser gave no label (no permission yet), so `label` is made up. */
  generic: boolean;
};

export const DEVICE_KINDS: readonly DeviceKind[] = ["audioinput", "videoinput", "audiooutput"];

export const NO_CHOICE: DeviceChoice = { audioinput: null, videoinput: null, audiooutput: null };

export const DEVICE_NOUN: Record<DeviceKind, string> = {
  audioinput: "Microphone",
  videoinput: "Camera",
  audiooutput: "Speaker",
};

const STORAGE_KEY: Record<DeviceKind, string> = {
  audioinput: "instant-device-microphone",
  videoinput: "instant-device-camera",
  audiooutput: "instant-device-speaker",
};

/** The remembered choice, or none where storage is unavailable (SSR, private mode). */
export function loadDeviceChoice(): DeviceChoice {
  const choice: DeviceChoice = { ...NO_CHOICE };
  if (typeof window === "undefined") return choice;
  for (const kind of DEVICE_KINDS) {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY[kind]);
      if (raw) choice[kind] = raw;
    } catch {
      // Storage disabled: the choice lives for this page only.
    }
  }
  return choice;
}

/** Null forgets the choice, so the system default applies again. */
export function saveDeviceChoice(kind: DeviceKind, deviceId: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (deviceId) window.localStorage.setItem(STORAGE_KEY[kind], deviceId);
    else window.localStorage.removeItem(STORAGE_KEY[kind]);
  } catch {
    // Same: applies for this page's lifetime only.
  }
}

/**
 * Sorts an `enumerateDevices()` result into the three kinds, one option per
 * device. Before any permission is granted browsers return devices with empty
 * labels (and Chromium with empty ids too); those get a numbered stand-in
 * label so the list is still usable, and id-less entries are dropped because
 * nothing could be selected by them.
 */
export function groupDevices(
  list: ReadonlyArray<Pick<MediaDeviceInfo, "kind" | "deviceId" | "label">>,
): Record<DeviceKind, DeviceOption[]> {
  const groups: Record<DeviceKind, DeviceOption[]> = {
    audioinput: [],
    videoinput: [],
    audiooutput: [],
  };
  for (const device of list) {
    const kind = device.kind as DeviceKind;
    if (!(kind in groups) || !device.deviceId) continue;
    const bucket = groups[kind];
    if (bucket.some((option) => option.deviceId === device.deviceId)) continue;
    const label = device.label.trim();
    bucket.push({
      deviceId: device.deviceId,
      label: label || `${DEVICE_NOUN[kind]} ${bucket.length + 1}`,
      generic: !label,
    });
  }
  return groups;
}

/**
 * The remembered id, if the device is still present. When the list is known
 * and the device is gone, null: the picker then shows the system default
 * rather than a checkmark beside nothing. An empty list (no permission yet)
 * keeps the choice, since the device may well be there.
 */
export function reconcileChoice(choice: string | null, options: DeviceOption[]): string | null {
  if (!choice || options.length === 0) return choice;
  return options.some((option) => option.deviceId === choice) ? choice : null;
}

/** getUserMedia constraint for a chosen input device; empty for the default. */
export function inputConstraint(choice: string | null): MediaTrackConstraints {
  return choice ? { deviceId: { exact: choice } } : {};
}

/**
 * True for the getUserMedia failures that mean the requested device is not
 * there (unplugged, or an id from another session), as opposed to a refused
 * permission or a device that is busy. Only these justify quietly retrying
 * on the default.
 */
export function isMissingDeviceError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "OverconstrainedError" || name === "NotFoundError";
}

/** Whether this browser lets a page choose the output device (Chromium does). */
export function supportsOutputSelection(): boolean {
  return (
    typeof HTMLMediaElement !== "undefined" &&
    typeof (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId === "function"
  );
}
