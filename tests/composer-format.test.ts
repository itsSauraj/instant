import { describe, expect, it } from "vitest";
import { formatPatch, shortcutAction, type FormatAction } from "@/components/room/composer-format";

/** Applies a patch the way the composer would, returning the new value. */
function apply(value: string, patch: ReturnType<typeof formatPatch>) {
  return value.slice(0, patch.start) + patch.insert + value.slice(patch.end);
}

describe("inline formats", () => {
  it("wraps a selection in markers", () => {
    const value = "make this bold";
    const patch = formatPatch(value, 10, 14, "bold");
    const next = apply(value, patch);
    expect(next).toBe("make this **bold**");
    // The restored selection still covers the same word.
    expect(next.slice(patch.selStart, patch.selEnd)).toBe("bold");
  });

  it("leaves the caret between markers for an empty selection", () => {
    const patch = formatPatch("", 0, 0, "bold");
    expect(patch.insert).toBe("****");
    expect(patch.selStart).toBe(2);
    expect(patch.selEnd).toBe(2);
  });

  it("toggles off when the selection includes the markers", () => {
    const value = "**bold**";
    const patch = formatPatch(value, 0, 8, "bold");
    expect(apply(value, patch)).toBe("bold");
    expect(patch.selStart).toBe(0);
    expect(patch.selEnd).toBe(4);
  });

  it("toggles off when the markers sit just outside the selection", () => {
    const value = "say **bold** now";
    const patch = formatPatch(value, 6, 10, "bold"); // "bold" selected, ** outside
    expect(apply(value, patch)).toBe("say bold now");
    expect(patch.selStart).toBe(4);
    expect(patch.selEnd).toBe(8);
  });

  it.each([
    ["italic", "_"],
    ["strike", "~~"],
    ["code", "`"],
  ] as [FormatAction, string][])("uses the right marker for %s", (action, marker) => {
    const value = "word";
    const patch = formatPatch(value, 0, 4, action);
    expect(apply(value, patch)).toBe(`${marker}word${marker}`);
  });
});

describe("code blocks", () => {
  it("fences the selected lines", () => {
    const value = "const a = 1;\nconst b = 2;";
    const patch = formatPatch(value, 0, value.length, "codeblock");
    expect(apply(value, patch)).toBe("```\nconst a = 1;\nconst b = 2;\n```");
  });

  it("expands a mid-line selection to whole lines", () => {
    const value = "before\ncode here\nafter";
    const patch = formatPatch(value, 9, 13, "codeblock"); // inside "code here"
    expect(apply(value, patch)).toBe("before\n```\ncode here\n```\nafter");
  });

  it("removes an existing fence", () => {
    const value = "```\ncode\n```";
    const patch = formatPatch(value, 0, value.length, "codeblock");
    expect(apply(value, patch)).toBe("code");
  });
});

describe("links", () => {
  it("uses a selected URL as the destination and selects the label", () => {
    const value = "https://example.com";
    const patch = formatPatch(value, 0, value.length, "link");
    expect(apply(value, patch)).toBe("[text](https://example.com)");
    expect(patch.insert.slice(patch.selStart - patch.start, patch.selEnd - patch.start)).toBe(
      "text",
    );
  });

  it("uses selected text as the label and selects the url placeholder", () => {
    const value = "click here";
    const patch = formatPatch(value, 0, 10, "link");
    expect(apply(value, patch)).toBe("[click here](url)");
    expect(patch.insert.slice(patch.selStart - patch.start, patch.selEnd - patch.start)).toBe(
      "url",
    );
  });

  it("inserts a full placeholder for an empty selection", () => {
    const patch = formatPatch("", 0, 0, "link");
    expect(patch.insert).toBe("[text](url)");
  });
});

describe("line prefixes", () => {
  it("bullets every selected line", () => {
    const value = "one\ntwo\nthree";
    const patch = formatPatch(value, 0, value.length, "bullet");
    expect(apply(value, patch)).toBe("- one\n- two\n- three");
  });

  it("removes bullets when every line already has one", () => {
    const value = "- one\n- two";
    const patch = formatPatch(value, 0, value.length, "bullet");
    expect(apply(value, patch)).toBe("one\ntwo");
  });

  it("prefixes all lines when only some are bulleted", () => {
    const value = "- one\ntwo";
    const patch = formatPatch(value, 0, value.length, "bullet");
    expect(apply(value, patch)).toBe("- - one\n- two");
  });

  it("quotes lines with > ", () => {
    const value = "a\nb";
    const patch = formatPatch(value, 0, value.length, "quote");
    expect(apply(value, patch)).toBe("> a\n> b");
  });

  it("numbers lines sequentially and toggles back off", () => {
    const value = "first\nsecond\nthird";
    const on = formatPatch(value, 0, value.length, "ordered");
    const numbered = apply(value, on);
    expect(numbered).toBe("1. first\n2. second\n3. third");

    const off = formatPatch(numbered, 0, numbered.length, "ordered");
    expect(apply(numbered, off)).toBe(value);
  });
});

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
});
