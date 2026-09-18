"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown } from "@tiptap/markdown";
import { CharacterCount } from "@tiptap/extensions";
import type { EditorState } from "@tiptap/pm/state";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  Code,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  SendHorizontal,
  SquareCode,
  Strikethrough,
  TextQuote,
  type LucideIcon,
} from "lucide-react";

import { shortcutAction, type FormatAction } from "@/components/room/composer-format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MAX_NOTE_LENGTH } from "@/lib/peer-protocol";
import { cn } from "@/lib/utils";

/**
 * The note composer: a rich-text field that shows formatting as you type, the
 * way chat apps do. Typing `**bold**` turns bold on the spot, `- ` starts a
 * list, a fenced ``` opens a code block, and the toolbar and Slack-style
 * shortcuts toggle the same things.
 *
 * What travels over the wire is still markdown: on send the document is
 * serialised (`editor.getMarkdown()`) and the receiving side renders it with
 * the same `NoteMarkdown` component as before, so nothing about the notes
 * protocol or the bubbles changes. The editor is only a nicer way to write
 * the text.
 *
 * Enter sends, Shift+Enter breaks a line. Inside a list, quote or code block
 * Enter keeps editing (new item, new line) because that is what Enter means
 * there; Ctrl/Cmd+Enter sends from anywhere.
 */

const MOD =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

const TOOLBAR: { action: FormatAction; label: string; shortcut: string; icon: LucideIcon }[][] = [
  [
    { action: "bold", label: "Bold", shortcut: `${MOD}+B`, icon: Bold },
    { action: "italic", label: "Italic", shortcut: `${MOD}+I`, icon: Italic },
    { action: "strike", label: "Strikethrough", shortcut: `${MOD}+Shift+X`, icon: Strikethrough },
  ],
  [
    { action: "code", label: "Code", shortcut: `${MOD}+Shift+C`, icon: Code },
    { action: "codeblock", label: "Code block", shortcut: `${MOD}+Alt+Shift+C`, icon: SquareCode },
  ],
  [{ action: "link", label: "Link", shortcut: `${MOD}+Shift+U`, icon: LinkIcon }],
  [
    { action: "bullet", label: "Bulleted list", shortcut: `${MOD}+Shift+8`, icon: List },
    { action: "ordered", label: "Ordered list", shortcut: `${MOD}+Shift+7`, icon: ListOrdered },
    { action: "quote", label: "Blockquote", shortcut: `${MOD}+Shift+9`, icon: TextQuote },
  ],
];

/** Editor node names each toolbar action toggles, for the pressed state. */
const ACTIVE_NAME: Record<FormatAction, string> = {
  bold: "bold",
  italic: "italic",
  strike: "strike",
  code: "code",
  codeblock: "codeBlock",
  link: "link",
  bullet: "bulletList",
  ordered: "orderedList",
  quote: "blockquote",
};

/** Inside these, Enter edits rather than sends; see the component note. */
const EDITING_CONTEXTS = new Set(["codeBlock", "listItem", "blockquote"]);

function inEditingContext(state: EditorState) {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if (EDITING_CONTEXTS.has($from.node(depth).type.name)) return true;
  }
  return false;
}

/** Bare domains become https links; anything with a scheme is left alone. */
function normaliseHref(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function NoteComposer({
  disabled,
  onSend,
  onTyping,
  className,
}: {
  disabled: boolean;
  /** Receives the note as markdown, already trimmed and non-empty. */
  onSend: (markdown: string) => void;
  onTyping: () => void;
  className?: string;
}) {
  // The editor's key handler is created once; refs keep it on the latest props.
  const onSendRef = useRef(onSend);
  const onTypingRef = useRef(onTyping);
  const disabledRef = useRef(disabled);
  useEffect(() => {
    onSendRef.current = onSend;
    onTypingRef.current = onTyping;
    disabledRef.current = disabled;
  });

  const editorRef = useRef<Editor | null>(null);
  const submitRef = useRef<() => void>(() => {});
  const runRef = useRef<(action: FormatAction) => void>(() => {});

  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const linkInputRef = useRef<HTMLInputElement>(null);

  const editor = useEditor({
    // Created after mount: the room page is server-rendered and a ProseMirror
    // view has no DOM to attach to there.
    immediatelyRender: false,
    // Re-render only through the selector below, not on every keystroke.
    shouldRerenderOnTransaction: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        // Markdown has no underline, and a chat box needs no trailing paragraph.
        underline: false,
        trailingNode: false,
        link: {
          openOnClick: false,
          autolink: true,
          linkOnPaste: true,
          defaultProtocol: "https",
        },
      }),
      Markdown,
      // Counts characters of the visible text; the serialised markdown is a
      // little longer, and the transport clips it to the same cap anyway.
      CharacterCount.configure({ limit: MAX_NOTE_LENGTH }),
    ],
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": "Note",
        "aria-multiline": "true",
        // `note-md` gives the live text the same typography as a sent bubble,
        // so what you see while typing is what the others will see.
        class: "note-md min-h-6 outline-none",
      },
      handleKeyDown: (view, event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
          if (event.ctrlKey || event.metaKey || !inEditingContext(view.state)) {
            event.preventDefault();
            submitRef.current();
            return true;
          }
          return false;
        }
        if (event.ctrlKey || event.metaKey) {
          const action = shortcutAction(event);
          if (action) {
            event.preventDefault();
            runRef.current(action);
            return true;
          }
        }
        return false;
      },
    },
    onUpdate: () => onTypingRef.current(),
  });

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  useEffect(() => {
    if (linkOpen) linkInputRef.current?.focus();
  }, [linkOpen]);

  // One subscription for everything the chrome needs; re-renders only when
  // one of these values actually changes.
  const view = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      if (!current) return null;
      const active = {} as Record<FormatAction, boolean>;
      for (const action of Object.keys(ACTIVE_NAME) as FormatAction[]) {
        active[action] = current.isActive(ACTIVE_NAME[action]);
      }
      return {
        isEmpty: current.isEmpty,
        chars: (current.storage.characterCount as { characters: () => number }).characters(),
        active,
      };
    },
  });

  const submit = useCallback(() => {
    const current = editorRef.current;
    if (!current || disabledRef.current) return;
    const markdown = current.getMarkdown().trim();
    if (!markdown) return;
    onSendRef.current(markdown.slice(0, MAX_NOTE_LENGTH));
    current.commands.clearContent(true);
    setLinkOpen(false);
  }, []);
  submitRef.current = submit;

  const run = useCallback((action: FormatAction) => {
    const current = editorRef.current;
    if (!current || disabledRef.current) return;
    const chain = current.chain().focus();
    switch (action) {
      case "bold":
        chain.toggleBold().run();
        break;
      case "italic":
        chain.toggleItalic().run();
        break;
      case "strike":
        chain.toggleStrike().run();
        break;
      case "code":
        chain.toggleCode().run();
        break;
      case "codeblock":
        chain.toggleCodeBlock().run();
        break;
      case "bullet":
        chain.toggleBulletList().run();
        break;
      case "ordered":
        chain.toggleOrderedList().run();
        break;
      case "quote":
        chain.toggleBlockquote().run();
        break;
      case "link":
        if (current.isActive("link")) {
          chain.extendMarkRange("link").unsetLink().run();
        } else {
          // Asked inline rather than via window.prompt, which some browsers
          // block and which would drop the editor's selection.
          setLinkUrl("");
          setLinkOpen(true);
        }
        break;
    }
    onTypingRef.current();
  }, []);
  runRef.current = run;

  const applyLink = () => {
    const current = editorRef.current;
    const href = normaliseHref(linkUrl);
    setLinkOpen(false);
    setLinkUrl("");
    if (!current) return;
    if (!href) {
      current.commands.focus();
      return;
    }
    if (current.state.selection.empty) {
      // Nothing selected: the URL itself becomes the linked text.
      current
        .chain()
        .focus()
        .insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] })
        .run();
    } else {
      current.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }
  };

  const isEmpty = view?.isEmpty ?? true;
  const remaining = view ? MAX_NOTE_LENGTH - view.chars : MAX_NOTE_LENGTH;
  const placeholder = disabled ? "Waiting for the connection…" : "Write a note…  (Enter to send)";

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-center gap-0.5">
        {TOOLBAR.map((group, i) => (
          <div key={group[0].action} className="flex items-center gap-0.5">
            {i > 0 ? <span className="bg-border mx-1 h-4 w-px" aria-hidden /> : null}
            {group.map(({ action, label, shortcut, icon: Icon }) => {
              const pressed = view?.active[action] ?? false;
              return (
                <Tooltip key={action}>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn(
                        "text-muted-foreground hover:text-foreground size-7",
                        pressed && "bg-accent text-foreground",
                      )}
                      disabled={disabled || !editor}
                      aria-label={label}
                      aria-pressed={pressed}
                      // Keep the editor's selection: a focus change here would
                      // collapse it before the command could use it.
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => run(action)}
                    >
                      <Icon className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {label}
                    <span className="text-muted-foreground ml-1.5 tabular-nums">{shortcut}</span>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        ))}
      </div>

      {linkOpen ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            applyLink();
          }}
          className="flex items-center gap-2"
        >
          <Input
            ref={linkInputRef}
            value={linkUrl}
            onChange={(event) => setLinkUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setLinkOpen(false);
                editor?.commands.focus();
              }
            }}
            placeholder="Paste a link…"
            aria-label="Link URL"
            autoComplete="off"
            spellCheck={false}
            className="h-8 text-xs"
          />
          <Button type="submit" size="sm" variant="secondary">
            Add link
          </Button>
        </form>
      ) : null}

      <div className="flex items-end gap-2">
        <div
          data-slot="note-composer"
          aria-disabled={disabled || undefined}
          onClick={() => editor?.commands.focus()}
          className={cn(
            "border-input bg-background/50 scroll-slim relative max-h-40 min-h-10 flex-1 cursor-text overflow-y-auto rounded-lg border px-3 py-2 text-sm shadow-xs transition-[color,box-shadow]",
            "focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]",
            disabled && "cursor-not-allowed opacity-50",
          )}
        >
          {isEmpty ? (
            <span
              aria-hidden
              className="text-muted-foreground pointer-events-none absolute top-2 right-3 left-3 truncate"
            >
              {placeholder}
            </span>
          ) : null}
          <EditorContent editor={editor} />
        </div>
        <Button
          size="icon"
          onClick={submit}
          disabled={disabled || isEmpty}
          aria-label="Send note"
        >
          <SendHorizontal />
        </Button>
      </div>

      {remaining < 200 ? (
        <p className="text-muted-foreground text-right text-xs">{remaining} characters left</p>
      ) : null}
    </div>
  );
}
