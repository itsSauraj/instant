import { describe, expect, it } from "vitest";
import {
  ROOM_CAPACITY,
  clampCapacity,
  isEnforced,
  isInitiator,
  isPolite,
  sanitizeName,
  sanitizeUid,
  sanitizeVisibility,
  videoBudget,
  type Participant,
} from "@/lib/signal-protocol";

describe("sanitizeVisibility", () => {
  it("accepts only the literal public, and falls back to private for anything else", () => {
    expect(sanitizeVisibility("public")).toBe("public");
    expect(sanitizeVisibility("private")).toBe("private");
    expect(sanitizeVisibility("PUBLIC")).toBe("private");
    expect(sanitizeVisibility("open")).toBe("private");
    expect(sanitizeVisibility(null)).toBe("private");
    expect(sanitizeVisibility(undefined)).toBe("private");
    expect(sanitizeVisibility(1)).toBe("private");
  });
});

const participant = (id: string, joinedAt: number): Participant => ({
  id,
  name: id,
  isHost: false,
  joinedAt,
  away: false,
  avatarSeed: "",
});

describe("isPolite", () => {
  it("assigns exactly one polite peer per pair", () => {
    expect(isPolite("aaa", "bbb")).toBe(false);
    expect(isPolite("bbb", "aaa")).toBe(true);
  });

  it("is antisymmetric for every distinct pair", () => {
    const ids = ["a", "z", "0", "9", "abcd1234", "abcd1235"];
    for (const self of ids) {
      for (const remote of ids) {
        if (self === remote) continue;
        expect(isPolite(self, remote)).toBe(!isPolite(remote, self));
      }
    }
  });
});

describe("isInitiator", () => {
  it("lets the longer-seated peer initiate to the newcomer", () => {
    const older = participant("b", 1000);
    const newer = participant("a", 2000);
    expect(isInitiator(older, newer)).toBe(true);
    expect(isInitiator(newer, older)).toBe(false);
  });

  it("breaks same-millisecond ties by id, still yielding one initiator", () => {
    const a = participant("aaa", 1000);
    const b = participant("bbb", 1000);
    expect(isInitiator(a, b)).toBe(true);
    expect(isInitiator(b, a)).toBe(false);
  });
});

describe("isEnforced", () => {
  it("enforces only the mute actions", () => {
    expect(isEnforced("mute-audio")).toBe(true);
    expect(isEnforced("mute-video")).toBe(true);
    expect(isEnforced("ask-audio")).toBe(false);
    expect(isEnforced("ask-video")).toBe(false);
  });
});

describe("sanitizeUid", () => {
  it("passes a browser-minted UUID through unchanged", () => {
    const uid = "550e8400-e29b-41d4-a716-446655440000";
    expect(sanitizeUid(uid)).toBe(uid);
  });

  it("treats non-strings as absent", () => {
    expect(sanitizeUid(undefined)).toBe("");
    expect(sanitizeUid(null)).toBe("");
    expect(sanitizeUid(42)).toBe("");
    expect(sanitizeUid({})).toBe("");
  });

  it("rejects strings outside the 8..64 hex-and-dash shape", () => {
    expect(sanitizeUid("abc")).toBe(""); // too short
    expect(sanitizeUid("a".repeat(65))).toBe(""); // too long
    expect(sanitizeUid("zzzzzzzz")).toBe(""); // not hex
    expect(sanitizeUid("<script>alert(1)</script>")).toBe("");
    expect(sanitizeUid("deadbeef")).toBe("deadbeef"); // minimal valid
    expect(sanitizeUid("a".repeat(64))).toBe("a".repeat(64)); // maximal valid
  });
});

describe("sanitizeName", () => {
  // Spelled via fromCharCode so no invisible characters live in this source.
  const BEL = String.fromCharCode(0x07); // Cc
  const ZWSP = String.fromCharCode(0x200b); // Cf
  const ZWJ = String.fromCharCode(0x200d); // Cf
  const RLM = String.fromCharCode(0x200f); // Cf

  it("treats non-strings as absent", () => {
    expect(sanitizeName(undefined)).toBe("");
    expect(sanitizeName(12)).toBe("");
  });

  it("collapses whitespace and trims", () => {
    expect(sanitizeName("  Ada   Lovelace  ")).toBe("Ada Lovelace");
    expect(sanitizeName("line\none")).toBe("line one");
    expect(sanitizeName("tab\there")).toBe("tab here");
  });

  it("strips control and format characters", () => {
    expect(sanitizeName(`a${BEL}b`)).toBe("a b");
    expect(sanitizeName(`a${ZWJ}b`)).toBe("a b");
    expect(sanitizeName(BEL + ZWSP + RLM)).toBe("");
  });

  it("caps the length at the wire limit", () => {
    expect(sanitizeName("x".repeat(100))).toHaveLength(32);
  });
});

describe("clampCapacity", () => {
  it("defaults anything non-numeric to the pair default", () => {
    expect(clampCapacity(undefined)).toBe(ROOM_CAPACITY.default);
    expect(clampCapacity("5")).toBe(ROOM_CAPACITY.default);
    expect(clampCapacity(NaN)).toBe(ROOM_CAPACITY.default);
    expect(clampCapacity(Infinity)).toBe(ROOM_CAPACITY.default);
  });

  it("clamps to the 2..7 room range", () => {
    expect(clampCapacity(0)).toBe(ROOM_CAPACITY.min);
    expect(clampCapacity(-3)).toBe(ROOM_CAPACITY.min);
    expect(clampCapacity(1)).toBe(2);
    expect(clampCapacity(100)).toBe(ROOM_CAPACITY.max);
  });

  it("floors fractional values before clamping", () => {
    expect(clampCapacity(3.9)).toBe(3);
    expect(clampCapacity(7.5)).toBe(7);
  });

  it("passes in-range integers through", () => {
    for (let n = ROOM_CAPACITY.min; n <= ROOM_CAPACITY.max; n++) {
      expect(clampCapacity(n)).toBe(n);
    }
  });
});

describe("videoBudget", () => {
  it("gives a pair the full budget", () => {
    expect(videoBudget(2)).toEqual({ height: 720, maxBitrateKbps: 1500, frameRate: 30 });
  });

  it("never increases any budget dimension as the room grows", () => {
    let previous = videoBudget(2);
    for (let n = 3; n <= ROOM_CAPACITY.max; n++) {
      const budget = videoBudget(n);
      expect(budget.height).toBeLessThanOrEqual(previous.height);
      expect(budget.maxBitrateKbps).toBeLessThanOrEqual(previous.maxBitrateKbps);
      expect(budget.frameRate).toBeLessThanOrEqual(previous.frameRate);
      previous = budget;
    }
  });

  it("bottoms out at the 6+ tier", () => {
    expect(videoBudget(6)).toEqual(videoBudget(7));
    expect(videoBudget(7)).toEqual({ height: 270, maxBitrateKbps: 300, frameRate: 15 });
  });
});
