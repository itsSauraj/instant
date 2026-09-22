"use client";

import { isValidElement, memo, useRef, useState } from "react";
import { Check, Copy, Link2 } from "lucide-react";
import { all } from "lowlight";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { describeLink } from "@/lib/link-label";
import { cn } from "@/lib/utils";

/**
 * Renders a note (or the shared doc's preview) as GitHub-flavored markdown
 * with syntax highlighting for every highlight.js grammar. Raw HTML is never
 * rendered, which keeps notes from the remote peer inert.
 */
export const NoteMarkdown = memo(function NoteMarkdown({ text }: { text: string }) {
  return (
    <div className="note-md wrap-break-word">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[[rehypeHighlight, { languages: all, detect: true }]]}
        components={{
          pre: CodeBlock,
          a: NoteLink,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

/**
 * Links render as accent-coloured chips, the way a mention would, instead of
 * the raw address: a pasted URL is named after its site with the path as a
 * quieter detail, and a markdown link keeps its own text with the host beside
 * it. The full URL stays in the tooltip and, of course, in the href. Anything
 * that is not an absolute web or mail address falls back to a plain link.
 */
function NoteLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const described = describeLink(href, textOf(children));
  if (!described) {
    return (
      <a href={href} target="_blank" rel="noreferrer nofollow">
        {children}
      </a>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer nofollow" title={href} className="note-link">
      <Link2 className="note-link-icon" aria-hidden />
      <span className="note-link-label">{described.bare ? described.label : children}</span>
      {described.detail ? <span className="note-link-detail">{described.detail}</span> : null}
    </a>
  );
}

/** The plain text inside a rendered markdown node, for comparing with the href. */
function textOf(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: React.ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

function CodeBlock({
  children,
  className,
  // react-markdown hands its syntax-tree node along with the props; spreading
  // it onto the element rendered `node="[object Object]"` into the DOM.
  node: _node,
  ...props
}: React.ComponentProps<"pre"> & { node?: unknown }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const copy = async () => {
    const code = preRef.current?.innerText ?? "";
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access denied: the code stays selectable by hand.
    }
  };

  // rehype-highlight tags the inner <code> with `language-x`; surface it as a label.
  const codeChild = Array.isArray(children) ? children[0] : children;
  const language = isValidElement(codeChild)
    ? (codeChild.props as { className?: string }).className?.match(/language-([\w+-]+)/)?.[1]
    : undefined;

  // A small card: a header strip with the language on the left and the action
  // on the right, the code underneath. Nothing floats over the code any more,
  // so a short first line and a long language name no longer collide. The
  // composer's live code block shares these classes (see globals.css).
  return (
    <div className="note-code" data-slot="note-code">
      <div className="note-code-bar">
        <span className="note-code-lang">{language ?? "code"}</span>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? "Copied" : "Copy code"}
          className={cn(
            "inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-[0.7rem] font-medium text-zinc-300 transition-colors outline-none",
            "hover:bg-white/10 hover:text-zinc-50 focus-visible:ring-2 focus-visible:ring-white/20",
            copied && "text-emerald-300 hover:text-emerald-300",
          )}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre ref={preRef} className={cn("scroll-slim", className)} {...props}>
        {children}
      </pre>
    </div>
  );
}
