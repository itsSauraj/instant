import { describe, expect, it } from "vitest";
import { shortcutAction } from "@/components/room/composer-format";

describe("shortcutAction", () => {
  const event = (over: Partial<Parameters<typeof shortcutAction>[0]>) => ({
    key: "",
    code: "",
    shiftKey: false,
    altKey: false,
    ...over,
  });

  it("maps the plain modifier shortcuts", () => {
    expect(shortcutAction(event({ key: "b" }))).toBe("bold");
    expect(shortcutAction(event({ key: "B" }))).toBe("bold");
    expect(shortcutAction(event({ key: "i" }))).toBe("italic");
    expect(shortcutAction(event({ key: "x" }))).toBeNull();
  });

  it("maps the shifted shortcuts by physical key", () => {
    expect(shortcutAction(event({ shiftKey: true, code: "KeyX" }))).toBe("strike");
    expect(shortcutAction(event({ shiftKey: true, code: "KeyC" }))).toBe("code");
    expect(shortcutAction(event({ shiftKey: true, code: "KeyU" }))).toBe("link");
    expect(shortcutAction(event({ shiftKey: true, code: "Digit7" }))).toBe("ordered");
    expect(shortcutAction(event({ shiftKey: true, code: "Digit8" }))).toBe("bullet");
    expect(shortcutAction(event({ shiftKey: true, code: "Digit9" }))).toBe("quote");
    expect(shortcutAction(event({ shiftKey: true, code: "KeyZ" }))).toBeNull();
  });

  it("reserves shift+alt for the code block", () => {
    expect(shortcutAction(event({ shiftKey: true, altKey: true, code: "KeyC" }))).toBe(
      "codeblock",
    );
    expect(shortcutAction(event({ shiftKey: true, altKey: true, code: "KeyX" }))).toBeNull();
    expect(shortcutAction(event({ shiftKey: true, altKey: true, code: "Digit7" }))).toBeNull();
  });

  it("returns null for alt without shift", () => {
    expect(shortcutAction(event({ altKey: true, key: "b" }))).toBeNull();
  });

  it("does not fire on Enter, which the composer reserves for sending", () => {
    expect(shortcutAction(event({ key: "Enter", code: "Enter" }))).toBeNull();
    expect(shortcutAction(event({ key: "Enter", code: "Enter", shiftKey: true }))).toBeNull();
  });
});
