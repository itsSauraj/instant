/**
 * Selection-aware markdown edits for the note composer, Slack-style: each
 * action toggles - applying it to already-formatted text removes the markers.
 * Pure functions over (value, selection) so the behavior is easy to test.
 */

export type FormatAction =
  | "bold"
  | "italic"
  | "strike"
  | "code"
  | "codeblock"
  | "link"
  | "bullet"
  | "ordered"
  | "quote";

export type FormatPatch = {
  /** Range of the current value to replace. */
  start: number;
  end: number;
  insert: string;
  /** Selection to restore after the edit. */
  selStart: number;
  selEnd: number;
};

const INLINE_MARKERS: Partial<Record<FormatAction, string>> = {
  bold: "**",
  italic: "_",
  strike: "~~",
  code: "`",
};

export function formatPatch(
  value: string,
  selStart: number,
  selEnd: number,
  action: FormatAction,
): FormatPatch {
  switch (action) {
    case "bold":
    case "italic":
    case "strike":
    case "code":
      return inlinePatch(value, selStart, selEnd, INLINE_MARKERS[action]!);
    case "codeblock":
      return codeBlockPatch(value, selStart, selEnd);
    case "link":
      return linkPatch(value, selStart, selEnd);
    case "bullet":
      return linePrefixPatch(value, selStart, selEnd, "- ");
    case "quote":
      return linePrefixPatch(value, selStart, selEnd, "> ");
    case "ordered":
      return orderedPatch(value, selStart, selEnd);
  }
}

function inlinePatch(value: string, start: number, end: number, marker: string): FormatPatch {
  const sel = value.slice(start, end);
  const len = marker.length;

  // Selection includes the markers: **bold** -> bold
  if (sel.length >= len * 2 && sel.startsWith(marker) && sel.endsWith(marker)) {
    const inner = sel.slice(len, sel.length - len);
    return { start, end, insert: inner, selStart: start, selEnd: start + inner.length };
  }

  // Markers sit just outside the selection: **|bold|** -> bold
  if (value.slice(start - len, start) === marker && value.slice(end, end + len) === marker) {
    return {
      start: start - len,
      end: end + len,
      insert: sel,
      selStart: start - len,
      selEnd: end - len,
    };
  }

  // Wrap. With an empty selection this leaves the caret between the markers.
  return {
    start,
    end,
    insert: marker + sel + marker,
    selStart: start + len,
    selEnd: end + len,
  };
}

/** Expand a selection to whole lines. */
function lineRange(value: string, start: number, end: number) {
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const nextBreak = value.indexOf("\n", end);
  return { lineStart, lineEnd: nextBreak === -1 ? value.length : nextBreak };
}

function codeBlockPatch(value: string, start: number, end: number): FormatPatch {
  const { lineStart, lineEnd } = lineRange(value, start, end);
  const block = value.slice(lineStart, lineEnd);
  const lines = block.split("\n");

  // Toggle off when the selected lines are already a fenced block.
  if (lines.length >= 2 && lines[0].startsWith("```") && lines[lines.length - 1] === "```") {
    const inner = lines.slice(1, -1).join("\n");
    return {
      start: lineStart,
      end: lineEnd,
      insert: inner,
      selStart: lineStart,
      selEnd: lineStart + inner.length,
    };
  }

  return {
    start: lineStart,
    end: lineEnd,
    insert: "```\n" + block + "\n```",
    selStart: lineStart + 4,
    selEnd: lineStart + 4 + block.length,
  };
}

function linkPatch(value: string, start: number, end: number): FormatPatch {
  const sel = value.slice(start, end);

  // A selected URL becomes the destination; otherwise it becomes the label.
  if (/^https?:\/\/\S+$/.test(sel)) {
    return {
      start,
      end,
      insert: `[text](${sel})`,
      selStart: start + 1,
      selEnd: start + 5,
    };
  }

  const label = sel || "text";
  const insert = `[${label}](url)`;
  return {
    start,
    end,
    insert,
    selStart: start + label.length + 3,
    selEnd: start + label.length + 6,
  };
}

function linePrefixPatch(value: string, start: number, end: number, prefix: string): FormatPatch {
  const { lineStart, lineEnd } = lineRange(value, start, end);
  const lines = value.slice(lineStart, lineEnd).split("\n");
  const active = lines.every((line) => line.startsWith(prefix));

  const insert = lines
    .map((line) => (active ? line.slice(prefix.length) : prefix + line))
    .join("\n");
  return {
    start: lineStart,
    end: lineEnd,
    insert,
    selStart: lineStart,
    selEnd: lineStart + insert.length,
  };
}

function orderedPatch(value: string, start: number, end: number): FormatPatch {
  const { lineStart, lineEnd } = lineRange(value, start, end);
  const lines = value.slice(lineStart, lineEnd).split("\n");
  const active = lines.every((line) => /^\d+\. /.test(line));

  const insert = lines
    .map((line, i) => (active ? line.replace(/^\d+\. /, "") : `${i + 1}. ${line}`))
    .join("\n");
  return {
    start: lineStart,
    end: lineEnd,
    insert,
    selStart: lineStart,
    selEnd: lineStart + insert.length,
  };
}

/**
 * Maps a keydown with Ctrl/Cmd held to its action, mirroring Slack's
 * bindings. Digits use `event.code` so Shift+7 (&) still matches.
 */
export function shortcutAction(event: {
  key: string;
  code: string;
  shiftKey: boolean;
  altKey: boolean;
}): FormatAction | null {
  const key = event.key.toLowerCase();
  if (!event.shiftKey && !event.altKey) {
    if (key === "b") return "bold";
    if (key === "i") return "italic";
    return null;
  }
  if (!event.shiftKey) return null;
  switch (event.code) {
    case "KeyX":
      return event.altKey ? null : "strike";
    case "KeyC":
      return event.altKey ? "codeblock" : "code";
    case "KeyU":
      return event.altKey ? null : "link";
    case "Digit7":
      return event.altKey ? null : "ordered";
    case "Digit8":
      return event.altKey ? null : "bullet";
    case "Digit9":
      return event.altKey ? null : "quote";
    default:
      return null;
  }
}
