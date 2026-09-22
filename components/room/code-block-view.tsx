"use client";

import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { all } from "lowlight";

/** Every grammar the bubbles can highlight, so the picker and the renderer agree. */
const LANGUAGES = Object.keys(all).sort();

/**
 * How a code block looks while it is being written: the same dark surface as
 * a sent bubble, with a language picker in the corner where the bubble shows
 * its language label. Changing the language re-highlights the block and
 * becomes the fence's info string when the note is sent, so the others see the
 * same colours.
 */
export function CodeBlockView({ node, updateAttributes, editor }: NodeViewProps) {
  const language = typeof node.attrs.language === "string" ? node.attrs.language : "";

  return (
    <NodeViewWrapper className="relative" data-slot="composer-code-block">
      <pre>
        <NodeViewContent<"code"> as="code" />
      </pre>
      {/* contentEditable={false} keeps ProseMirror's hands off the picker, and
          swallowing mousedown keeps a click on it from moving the caret. */}
      <select
        contentEditable={false}
        aria-label="Code language"
        value={language}
        disabled={!editor.isEditable}
        onMouseDown={(event) => event.stopPropagation()}
        onChange={(event) => updateAttributes({ language: event.target.value || null })}
        className="absolute top-1.5 right-1.5 max-w-32 cursor-pointer rounded bg-white/10 px-1.5 py-0.5 text-xs tracking-wide text-zinc-300 outline-none hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default"
      >
        <option value="">auto</option>
        {LANGUAGES.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </NodeViewWrapper>
  );
}
