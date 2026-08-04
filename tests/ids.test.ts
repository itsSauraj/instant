import { describe, expect, it } from "vitest";
import { createRoomId, createToken, isValidRoomId, normalizeRoomId, prettyRoomId } from "@/lib/ids";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

describe("createRoomId", () => {
  it("emits 16 characters drawn from the Crockford-style alphabet", () => {
    const id = createRoomId();
    expect(id).toHaveLength(16);
    expect([...id].every((c) => ALPHABET.includes(c))).toBe(true);
    expect(isValidRoomId(id)).toBe(true);
  });

  it("does not repeat", () => {
    const ids = new Set(Array.from({ length: 50 }, () => createRoomId()));
    expect(ids.size).toBe(50);
  });
});

describe("normalizeRoomId", () => {
  it("extracts the id from a pasted room link", () => {
    expect(normalizeRoomId("https://example.com/room/k3f9mq2t8xbv7rn0")).toBe(
      "k3f9mq2t8xbv7rn0",
    );
  });

  it("drops query strings and fragments", () => {
    expect(normalizeRoomId("https://x.dev/room/k3f9mq2t8xbv7rn0?utm=1#join")).toBe(
      "k3f9mq2t8xbv7rn0",
    );
  });

  it("strips display grouping, whitespace and casing", () => {
    expect(normalizeRoomId("  K3F9-MQ2T-8XBV-7RN0  ")).toBe("k3f9mq2t8xbv7rn0");
  });
});

describe("isValidRoomId", () => {
  it("accepts the pretty (dashed) form", () => {
    const id = createRoomId();
    expect(isValidRoomId(prettyRoomId(id))).toBe(true);
  });

  it("rejects wrong lengths", () => {
    expect(isValidRoomId("")).toBe(false);
    expect(isValidRoomId("abc")).toBe(false);
    expect(isValidRoomId("a".repeat(17))).toBe(false);
  });

  it("rejects characters outside the alphabet even when they normalise", () => {
    // i, l, o, u are lowercase alphanumerics, so they survive normalisation
    // and must be caught by the alphabet check itself.
    expect(isValidRoomId("iiiiiiiiiiiiiiii")).toBe(false);
    expect(isValidRoomId("looooooooooooool")).toBe(false);
    expect(isValidRoomId("uuuuuuuuuuuuuuuu")).toBe(false);
  });
});

describe("prettyRoomId", () => {
  it("groups the id in fours for reading aloud", () => {
    expect(prettyRoomId("k3f9mq2t8xbv7rn0")).toBe("k3f9-mq2t-8xbv-7rn0");
  });

  it("normalises before grouping", () => {
    expect(prettyRoomId("https://x.dev/room/K3F9MQ2T8XBV7RN0")).toBe("k3f9-mq2t-8xbv-7rn0");
  });
});

describe("createToken", () => {
  it("derives length from the requested byte count", () => {
    expect(createToken()).toHaveLength(32);
    expect(createToken(8)).toHaveLength(16);
    expect(createToken(24)).toHaveLength(48);
  });

  it("does not repeat", () => {
    expect(createToken()).not.toBe(createToken());
  });
});
