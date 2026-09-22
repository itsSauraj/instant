import { describe, expect, it } from "vitest";
import {
  NO_CHOICE,
  groupDevices,
  inputConstraint,
  isMissingDeviceError,
  loadDeviceChoice,
  reconcileChoice,
  supportsOutputSelection,
} from "@/lib/media-devices";

const device = (kind: string, deviceId: string, label = "") =>
  ({ kind, deviceId, label }) as Pick<MediaDeviceInfo, "kind" | "deviceId" | "label">;

describe("groupDevices", () => {
  it("sorts devices into the three kinds and keeps their labels", () => {
    const groups = groupDevices([
      device("audioinput", "mic-1", "Headset Microphone"),
      device("videoinput", "cam-1", "FaceTime HD Camera"),
      device("audiooutput", "out-1", "Headset Earphone"),
    ]);
    expect(groups.audioinput).toEqual([
      { deviceId: "mic-1", label: "Headset Microphone", generic: false },
    ]);
    expect(groups.videoinput[0].label).toBe("FaceTime HD Camera");
    expect(groups.audiooutput[0].label).toBe("Headset Earphone");
  });

  it("numbers unlabeled devices per kind and marks them generic", () => {
    const groups = groupDevices([
      device("audioinput", "a"),
      device("audioinput", "b"),
      device("videoinput", "c"),
    ]);
    expect(groups.audioinput.map((o) => o.label)).toEqual(["Microphone 1", "Microphone 2"]);
    expect(groups.videoinput[0]).toMatchObject({ label: "Camera 1", generic: true });
  });

  it("drops id-less entries and duplicate ids, and ignores unknown kinds", () => {
    const groups = groupDevices([
      device("audioinput", "", "Ghost"),
      device("audioinput", "a", "Real"),
      device("audioinput", "a", "Real again"),
      device("somethingelse", "z", "Odd"),
    ]);
    expect(groups.audioinput).toHaveLength(1);
    expect(groups.audioinput[0].label).toBe("Real");
    expect(groups.videoinput).toEqual([]);
    expect(groups.audiooutput).toEqual([]);
  });
});

describe("reconcileChoice", () => {
  const options = groupDevices([device("audioinput", "a", "A"), device("audioinput", "b", "B")])
    .audioinput;

  it("keeps a choice that is still present", () => {
    expect(reconcileChoice("b", options)).toBe("b");
  });

  it("falls back to the default when the chosen device is gone", () => {
    expect(reconcileChoice("unplugged", options)).toBeNull();
  });

  it("keeps the choice while the list is still unknown", () => {
    expect(reconcileChoice("unplugged", [])).toBe("unplugged");
    expect(reconcileChoice(null, options)).toBeNull();
  });
});

describe("inputConstraint", () => {
  it("asks for the chosen device exactly, and for nothing in particular by default", () => {
    // `ideal` is only a hint browsers are free to ignore; they do, and hand
    // back the default microphone. The missing-device retry lives elsewhere.
    expect(inputConstraint("mic-1")).toEqual({ deviceId: { exact: "mic-1" } });
    expect(inputConstraint(null)).toEqual({});
  });
});

describe("isMissingDeviceError", () => {
  it("recognises only the errors that mean the device is not there", () => {
    expect(isMissingDeviceError({ name: "OverconstrainedError" })).toBe(true);
    expect(isMissingDeviceError({ name: "NotFoundError" })).toBe(true);
    expect(isMissingDeviceError({ name: "NotAllowedError" })).toBe(false);
    expect(isMissingDeviceError({ name: "NotReadableError" })).toBe(false);
    expect(isMissingDeviceError(new Error("boom"))).toBe(false);
    expect(isMissingDeviceError(null)).toBe(false);
  });
});

describe("storage and support probes outside a browser", () => {
  it("reports no choice and no output selection under Node", () => {
    expect(loadDeviceChoice()).toEqual(NO_CHOICE);
    expect(supportsOutputSelection()).toBe(false);
  });
});
