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

  return (
    <div className="group/code relative">
      <pre ref={preRef} className={cn("scroll-slim", className)} {...props}>
        {children}
      </pre>
      <div className="absolute top-1.5 right-1.5 flex items-center gap-1.5">
        {language ? (
          <span className="rounded bg-white/10 px-1.5 py-0.5 text-[0.6rem] tracking-wide text-zinc-400 uppercase">
            {language}
          </span>
        ) : null}
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? "Copied" : "Copy code"}
          className={cn(
            "grid size-6 place-items-center rounded-md text-zinc-400 transition-all",
            "hover:bg-white/10 hover:text-zinc-100 focus-visible:ring-[3px] focus-visible:ring-ring/50",
            "opacity-0 outline-none group-hover/code:opacity-100 focus-visible:opacity-100",
            copied && "text-emerald-400 opacity-100 hover:text-emerald-400",
          )}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      </div>
    </div>
  );
}
