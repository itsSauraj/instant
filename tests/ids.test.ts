import { describe, expect, it } from "vitest";
import {
  ROOM_CODE,
  createRoomId,
  createToken,
  isGeneratedRoomId,
  isValidRoomId,
  normalizeRoomId,
  prettyRoomId,
} from "@/lib/ids";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

describe("createRoomId", () => {
  it("emits 8 characters drawn from the Crockford-style alphabet", () => {
    const id = createRoomId();
    expect(id).toHaveLength(ROOM_CODE.generatedLength);
    expect(id).toHaveLength(8);
    expect([...id].every((c) => ALPHABET.includes(c))).toBe(true);
    expect(isValidRoomId(id)).toBe(true);
    expect(isGeneratedRoomId(id)).toBe(true);
  });

  it("does not repeat", () => {
    const ids = new Set(Array.from({ length: 50 }, () => createRoomId()));
    expect(ids.size).toBe(50);
  });
});

describe("normalizeRoomId", () => {
  it("extracts the id from a pasted room link", () => {
    expect(normalizeRoomId("https://example.com/room/k3f9mq2t")).toBe("k3f9mq2t");
  });

  it("drops query strings and fragments", () => {
    expect(normalizeRoomId("https://x.dev/room/k3f9mq2t?utm=1#join")).toBe("k3f9mq2t");
  });

  it("strips display grouping, whitespace and casing", () => {
    expect(normalizeRoomId("  K3F9-MQ2T  ")).toBe("k3f9mq2t");
  });

  it("treats dashes and spaces in a custom code as separators, not content", () => {
    expect(normalizeRoomId("my-team")).toBe("myteam");
    expect(normalizeRoomId("My Team")).toBe("myteam");
    expect(normalizeRoomId("/room/My-Team")).toBe("myteam");
  });
});

describe("isValidRoomId", () => {
  it("accepts the pretty (dashed) form of a generated code", () => {
    const id = createRoomId();
    expect(isValidRoomId(prettyRoomId(id))).toBe(true);
  });

  it("accepts custom codes of any letters and digits within the length bounds", () => {
    expect(isValidRoomId("myteam")).toBe(true);
    expect(isValidRoomId("standup")).toBe(true);
    expect(isValidRoomId("Hello-World")).toBe(true);
    // i, l, o, u are excluded from GENERATED codes only; people type them.
    expect(isValidRoomId("lollipop")).toBe(true);
    expect(isValidRoomId("a".repeat(ROOM_CODE.minLength))).toBe(true);
    expect(isValidRoomId("a".repeat(ROOM_CODE.maxLength))).toBe(true);
  });

  it("rejects codes outside the length bounds", () => {
    expect(isValidRoomId("")).toBe(false);
    expect(isValidRoomId("abc")).toBe(false);
    expect(isValidRoomId("a".repeat(ROOM_CODE.minLength - 1))).toBe(false);
    expect(isValidRoomId("a".repeat(ROOM_CODE.maxLength + 1))).toBe(false);
  });

  it("rejects input that normalises to nothing usable", () => {
    expect(isValidRoomId("---")).toBe(false);
    expect(isValidRoomId("!!!!")).toBe(false);
    expect(isValidRoomId("日本語のコード")).toBe(false);
  });
});

describe("isGeneratedRoomId", () => {
  it("recognises the generated shape and only that shape", () => {
    expect(isGeneratedRoomId("k3f9mq2t")).toBe(true);
    expect(isGeneratedRoomId("K3F9-MQ2T")).toBe(true);
    // Wrong length, or letters a generator never emits.
    expect(isGeneratedRoomId("myteam")).toBe(false);
    expect(isGeneratedRoomId("lollipop")).toBe(false);
    expect(isGeneratedRoomId("k3f9mq2t8xbv7rn0")).toBe(false);
  });
});

describe("prettyRoomId", () => {
  it("groups a generated code in fours for reading aloud", () => {
    expect(prettyRoomId("k3f9mq2t")).toBe("k3f9-mq2t");
  });

  it("normalises before grouping", () => {
    expect(prettyRoomId("https://x.dev/room/K3F9MQ2T")).toBe("k3f9-mq2t");
  });

  it("leaves a custom code exactly as chosen", () => {
    expect(prettyRoomId("myteam")).toBe("myteam");
    expect(prettyRoomId("Daily-Standup")).toBe("dailystandup");
    expect(prettyRoomId("k3f9mq2t8xbv7rn0")).toBe("k3f9mq2t8xbv7rn0");
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
