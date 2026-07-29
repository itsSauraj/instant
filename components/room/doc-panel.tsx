"use client";

import { useEffect, useRef, useState } from "react";
import { Download, FileText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MAX_DOC_LENGTH } from "@/lib/peer-protocol";
import type { DocState } from "@/lib/peer-session";
import { cn } from "@/lib/utils";

export function DocPanel({
  doc,
  roomId,
  connected,
  onUpdate,
}: {
  doc: DocState;
  roomId: string;
  connected: boolean;
  onUpdate: (text: string) => void;
}) {
  const [text, setText] = useState(doc.text);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  // Adopt session-side changes: the peer's live edits, and the copy restored
  // from localStorage on mount. Our own in-flight typing is left alone.
  useEffect(() => {
    const el = editorRef.current;
    if (!el || doc.text === el.value) return;

    const focused = document.activeElement === el;
    if (doc.mine && focused) return; // echo of a local keystroke mid-render

    const selStart = el.selectionStart;
    const selEnd = el.selectionEnd;
    setText(doc.text);
    if (focused) {
      // A peer edit landed while we were typing; keep the caret in place
      // rather than letting the replacement fling it to the end.
      requestAnimationFrame(() => {
        el.setSelectionRange(
          Math.min(selStart, doc.text.length),
          Math.min(selEnd, doc.text.length),
        );
      });
    }
  }, [doc.text, doc.mine]);

  const download = (ext: "txt" | "md") => {
    const blob = new Blob([editorRef.current?.value ?? text], {
      type: ext === "md" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `instant-doc-${roomId}.${ext}`;
    anchor.click();
    // Give the click a tick to start the download before releasing the blob.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="panel flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b p-3 sm:px-4">
        <FileText className="text-muted-foreground size-4" />
        <span className="text-sm font-medium">Shared doc</span>
        <span
          className={cn(
            "size-1.5 rounded-full",
            connected ? "bg-success" : "bg-warning",
          )}
          aria-hidden
        />
        <span className="text-muted-foreground text-xs">
          {connected ? "Live — both of you can edit" : "Offline — edits sync when the peer joins"}
        </span>

        <div className="ml-auto flex items-center gap-1.5">
          {(["md", "txt"] as const).map((ext) => (
            <Tooltip key={ext}>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => download(ext)}
                  disabled={!text}
                  className="gap-1.5"
                >
                  <Download className="size-3.5" />.{ext}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Download as .{ext}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      </div>

      <textarea
        ref={editorRef}
        value={text}
        maxLength={MAX_DOC_LENGTH}
        onChange={(event) => {
          setText(event.target.value);
          onUpdate(event.target.value);
        }}
        placeholder="Write together. Everything here is synced live, kept on this device, and downloadable as .md or .txt."
        aria-label="Shared document"
        spellCheck={false}
        className={cn(
          "scroll-slim min-h-0 flex-1 resize-none bg-transparent p-4 font-mono text-sm leading-relaxed",
          "placeholder:text-muted-foreground/70 outline-none sm:p-5",
        )}
      />

      <div className="text-muted-foreground flex shrink-0 items-center justify-between border-t px-3 py-2 text-xs sm:px-4">
        <span>Saved on this device — ending the session does not delete it.</span>
        <span className="tabular-nums">
          {text.length.toLocaleString()} / {MAX_DOC_LENGTH.toLocaleString()}
        </span>
      </div>
    </div>
  );
}
