import { describe, expect, it } from "vitest";
import { extractRoomId } from "@/lib/scan";

describe("extractRoomId", () => {
  it("takes the room segment out of an invite link from any origin", () => {
    expect(extractRoomId("https://instant.example.com/room/k3f9mq2t")).toBe("k3f9mq2t");
    expect(extractRoomId("http://localhost:3000/room/K3F9-MQ2T?x=1#y")).toBe("k3f9mq2t");
    expect(extractRoomId("https://elsewhere.test/room/my-team/")).toBe("myteam");
  });

  it("accepts a bare code, grouped or not", () => {
    expect(extractRoomId("k3f9-mq2t")).toBe("k3f9mq2t");
    expect(extractRoomId("  K3F9 MQ2T ")).toBe("k3f9mq2t");
    expect(extractRoomId("standup")).toBe("standup");
  });

  it("refuses payloads that are not a code, even when they contain code-like letters", () => {
    // Would normalise to `httpsevilexamplephish`, a plausible custom code, if
    // the bare-code path were not restricted to pure letter/digit runs.
    expect(extractRoomId("https://evil.example/phish")).toBeNull();
    expect(extractRoomId("mailto:someone@example.com")).toBeNull();
    expect(extractRoomId("WIFI:S:Cafe;T:WPA;P:secret;;")).toBeNull();
  });

  it("refuses codes outside the length bounds and empty input", () => {
    expect(extractRoomId("")).toBeNull();
    expect(extractRoomId("abc")).toBeNull();
    expect(extractRoomId("a".repeat(33))).toBeNull();
    expect(extractRoomId("https://x.dev/room/abc")).toBeNull();
  });

  it("never returns anything navigable", () => {
    const out = extractRoomId("https://evil.example/room/k3f9mq2t");
    expect(out).toBe("k3f9mq2t");
    expect(out).not.toContain("/");
    expect(out).not.toContain(":");
  });
});
