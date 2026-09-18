/**
 * Keyboard bindings for the note composer, Slack-style. The composer itself
 * is a rich-text editor (see note-composer.tsx) that renders formatting as you
 * type; this module only decides which shortcut means which action, as a pure
 * function over the keydown so the mapping is easy to test.
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
