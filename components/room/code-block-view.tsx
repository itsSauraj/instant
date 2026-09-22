"use client";

import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * The languages on offer: lowlight's "common" set, which is what a chat needs
 * and short enough to scan. The keys are the grammar names the bubbles' renderer
 * understands, so what is picked here highlights the same way over there.
 */
const LANGUAGES: Record<string, string> = {
  arduino: "Arduino",
  bash: "Bash",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  css: "CSS",
  diff: "Diff",
  go: "Go",
  graphql: "GraphQL",
  ini: "INI / TOML",
  java: "Java",
  javascript: "JavaScript",
  json: "JSON",
  kotlin: "Kotlin",
  less: "Less",
  lua: "Lua",
  makefile: "Makefile",
  markdown: "Markdown",
  objectivec: "Objective-C",
  perl: "Perl",
  php: "PHP",
  plaintext: "Plain text",
  python: "Python",
  r: "R",
  ruby: "Ruby",
  rust: "Rust",
  scss: "SCSS",
  shell: "Shell session",
  sql: "SQL",
  swift: "Swift",
  typescript: "TypeScript",
  vbnet: "VB.NET",
  wasm: "WebAssembly",
  xml: "HTML / XML",
  yaml: "YAML",
};

const SORTED = Object.entries(LANGUAGES).sort(([, a], [, b]) => a.localeCompare(b));

/** Radix Select needs a non-empty value, so "no language" travels as this. */
const AUTO = "auto";

/**
 * How a code block looks while it is being written: the same card as a sent
 * bubble's code block (shared `note-code` classes in globals.css), with the
 * language picker sitting in the header strip where the bubble shows its
 * language label. Choosing a language re-highlights the block and becomes the
 * fence's info string when the note is sent, so the others see the same
 * colours.
 *
 * The picker is the app's own Select, not a native <select>: its list renders
 * in a portal outside the editor, so ProseMirror's mouse handling and the
 * node view's re-renders cannot snap it shut, and it follows the light and
 * dark theme like every other menu here.
 */
export function CodeBlockView({ node, updateAttributes, editor }: NodeViewProps) {
  const language = typeof node.attrs.language === "string" ? node.attrs.language : "";
  // A language the list does not know (set by a fence the markdown parser
  // read, say) still has to be shown and keepable, so it gets a row of its own.
  const extra = language && !LANGUAGES[language] ? language : null;

  return (
    <NodeViewWrapper className="note-code" data-slot="composer-code-block">
      {/* contentEditable={false} keeps the caret and ProseMirror's selection
          logic out of the header entirely. */}
      <div contentEditable={false} className="note-code-bar">
        <Select
          value={language || AUTO}
          disabled={!editor.isEditable}
          onValueChange={(value) => updateAttributes({ language: value === AUTO ? null : value })}
        >
          <SelectTrigger
            size="sm"
            aria-label="Code language"
            // Styled like the bubble's language label, since it sits in the
            // same spot on the same fixed dark surface; the hover reveals it
            // as a control.
            className="h-6! w-auto gap-1 rounded-md border-transparent bg-transparent px-1.5 py-0 font-mono text-[0.65rem] tracking-[0.08em] text-zinc-400 uppercase shadow-none hover:bg-white/10 hover:text-zinc-200 focus-visible:border-white/30 focus-visible:ring-white/20 [&_svg]:size-3 [&_svg]:text-zinc-500"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            align="start"
            className="max-h-72 min-w-44"
            // Radix would hand focus back to the trigger; the caret belongs in
            // the code, where the person was typing.
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              editor.commands.focus();
            }}
          >
            <SelectItem value={AUTO}>Auto-detect</SelectItem>
            {extra ? <SelectItem value={extra}>{extra}</SelectItem> : null}
            {SORTED.map(([key, label]) => (
              <SelectItem key={key} value={key}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-[0.65rem] text-zinc-500 select-none">Shift+Enter to exit</span>
      </div>
      <pre>
        <NodeViewContent<"code"> as="code" />
      </pre>
    </NodeViewWrapper>
  );
}
