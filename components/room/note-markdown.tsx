"use client";

import { isValidElement, memo, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { all } from "lowlight";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

/**
 * Renders a note as GitHub-flavored markdown with syntax highlighting for
 * every highlight.js grammar. Raw HTML is never rendered, which keeps notes
 * from the remote peer inert.
 */
export const NoteMarkdown = memo(function NoteMarkdown({ text }: { text: string }) {
  return (
    <div className="note-md wrap-break-word">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[[rehypeHighlight, { languages: all, detect: true }]]}
        components={{
          pre: CodeBlock,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer nofollow">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

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
