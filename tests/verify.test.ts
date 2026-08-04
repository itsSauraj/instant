import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VERIFY_EMOJI,
  VERIFY_EMOJI_COUNT,
  isDigestVerified,
  markDigestVerified,
  pairFingerprint,
  unmarkDigestVerified,
} from "@/lib/verify";

const FP_A = "sha-256 4A:5B:6C:7D";
const FP_B = "sha-256 FF:EE:DD:CC";

describe("pairFingerprint", () => {
  it("is symmetric: both peers derive the identical fingerprint", async () => {
    const ours = await pairFingerprint(FP_A, FP_B);
    const theirs = await pairFingerprint(FP_B, FP_A);
    expect(ours.digest).toBe(theirs.digest);
    expect(ours.emojis).toEqual(theirs.emojis);
  });

  it("is deterministic across calls", async () => {
    const first = await pairFingerprint(FP_A, FP_B);
    const second = await pairFingerprint(FP_A, FP_B);
    expect(first).toEqual(second);
  });

  it("renders a 64-hex-char digest and 10 emojis from the alphabet", async () => {
    const { digest, emojis } = await pairFingerprint(FP_A, FP_B);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(emojis).toHaveLength(VERIFY_EMOJI_COUNT);
    for (const emoji of emojis) {
      expect(VERIFY_EMOJI).toContain(emoji);
    }
  });

  it("changes when either fingerprint changes", async () => {
    const base = await pairFingerprint(FP_A, FP_B);
    const differentRemote = await pairFingerprint(FP_A, "sha-256 00:11:22:33");
    expect(differentRemote.digest).not.toBe(base.digest);
  });

  it("keeps the emoji alphabet at exactly 64 entries so byte-indexing stays unbiased", () => {
    expect(VERIFY_EMOJI).toHaveLength(64);
    expect(new Set(VERIFY_EMOJI).size).toBe(64);
  });
});

describe("verified-digest store", () => {
  it("reports nothing verified when there is no window at all", () => {
    expect(isDigestVerified("abc")).toBe(false);
    expect(() => markDigestVerified("abc")).not.toThrow();
    expect(() => unmarkDigestVerified("abc")).not.toThrow();
  });

  describe("with browser storage present", () => {
    let backing: Map<string, string>;

    beforeEach(() => {
      backing = new Map();
      vi.stubGlobal("window", {
        localStorage: {
          getItem: (key: string) => backing.get(key) ?? null,
          setItem: (key: string, value: string) => void backing.set(key, value),
        },
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("round-trips mark / check / unmark", () => {
      expect(isDigestVerified("d1")).toBe(false);
      markDigestVerified("d1");
      expect(isDigestVerified("d1")).toBe(true);
      unmarkDigestVerified("d1");
      expect(isDigestVerified("d1")).toBe(false);
    });

    it("keeps digests independent", () => {
      markDigestVerified("d1");
      markDigestVerified("d2");
      unmarkDigestVerified("d1");
      expect(isDigestVerified("d1")).toBe(false);
      expect(isDigestVerified("d2")).toBe(true);
    });

    it("survives corrupted storage contents", () => {
      backing.set("instant-verified-digests", "{not json");
      expect(isDigestVerified("d1")).toBe(false);
      markDigestVerified("d1");
      expect(isDigestVerified("d1")).toBe(true);
    });

    it("ignores non-string entries smuggled into storage", () => {
      backing.set("instant-verified-digests", JSON.stringify(["d1", 42, null, { x: 1 }]));
      expect(isDigestVerified("d1")).toBe(true);
      expect(isDigestVerified("42")).toBe(false);
    });

    it("evicts the oldest digests beyond the 200-entry cap", () => {
      for (let i = 0; i < 205; i++) markDigestVerified(`digest-${i}`);
      expect(isDigestVerified("digest-0")).toBe(false);
      expect(isDigestVerified("digest-4")).toBe(false);
      expect(isDigestVerified("digest-5")).toBe(true);
      expect(isDigestVerified("digest-204")).toBe(true);
    });

    it("re-marking an existing digest refreshes it instead of duplicating", () => {
      markDigestVerified("keep");
      for (let i = 0; i < 199; i++) markDigestVerified(`filler-${i}`);
      markDigestVerified("keep"); // moves to the newest slot
      markDigestVerified("one-more"); // evicts filler-0, not "keep"
      expect(isDigestVerified("keep")).toBe(true);
      expect(isDigestVerified("filler-0")).toBe(false);
    });
  });
});
