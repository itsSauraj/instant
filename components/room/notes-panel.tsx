"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { StickyNote } from "lucide-react";

import { NoteComposer } from "@/components/room/note-composer";
import { NoteMarkdown } from "@/components/room/note-markdown";
import type { Note } from "@/lib/peer-session";
import { pulse } from "@/lib/animation";
import { cn, formatTime } from "@/lib/utils";

export function NotesPanel({
  notes,
  peerTyping,
  disabled,
  onSend,
  onTyping,
}: {
  notes: Note[];
  peerTyping: boolean;
  disabled: boolean;
  onSend: (text: string) => void;
  onTyping: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(notes.length);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;

    if (notes.length > lastCount.current) {
      pulse(list.lastElementChild);
    }
    lastCount.current = notes.length;
    list.scrollTop = list.scrollHeight;
  }, [notes.length]);

  useEffect(() => {
    // Keep the typing indicator in view as it appears.
    if (peerTyping && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [peerTyping]);

  return (
    <div className="panel flex h-full flex-col overflow-hidden">
      <div
        ref={listRef}
        className="scroll-slim flex-1 space-y-3 overflow-y-auto p-4 sm:p-5"
        aria-live="polite"
      >
        {notes.length === 0 ? (
          <EmptyNotes />
        ) : (
          notes.map((note) => <NoteBubble key={note.id} note={note} />)
        )}

        {peerTyping ? (
          <div className="text-muted-foreground flex items-center gap-1.5 pl-1 text-xs">
            <Dot delay="0ms" />
            <Dot delay="150ms" />
            <Dot delay="300ms" />
            <span className="ml-1">typing…</span>
          </div>
        ) : null}
      </div>

      <div className="border-t p-3 sm:p-4">
        {/* Rich text in, markdown out: the composer renders formatting as it is
            typed and hands over markdown on send, so the bubbles below and the
            wire protocol are untouched. */}
        <NoteComposer disabled={disabled} onSend={onSend} onTyping={onTyping} />
      </div>
    </div>
  );
}

function NoteBubble({ note }: { note: Note }) {
  return (
    <div className={cn("flex", note.mine ? "justify-end" : "justify-start")}>
      <div
        // A stable hook for the whole bubble. Without one, anything walking up
        // from the message text lands on the markdown paragraph itself and never
        // sees the author label beside it.
        data-slot="note"
        data-author={note.authorName || undefined}
        className={cn(
          "max-w-[min(34rem,85%)] rounded-2xl px-3.5 py-2 text-sm shadow-xs",
          note.mine
            ? "bg-primary text-primary-foreground rounded-br-md"
            : "bg-secondary text-secondary-foreground rounded-bl-md",
        )}
      >
        {/* Name the author on incoming notes. Left/right alignment was enough
            for a pair, but a room now holds up to seven people and alignment
            alone cannot say which of six others wrote this. Own notes stay
            unlabelled -- the right-hand side already means "you". */}
        {!note.mine && note.authorName ? (
          <p className="text-muted-foreground mb-0.5 text-[0.7rem] font-semibold">
            {note.authorName}
          </p>
        ) : null}
        <NoteMarkdown text={note.text} />
        <time
          dateTime={new Date(note.at).toISOString()}
          className={cn(
            "mt-1 block text-[0.65rem] tabular-nums",
            note.mine ? "text-primary-foreground/70" : "text-muted-foreground",
          )}
        >
          {formatTime(note.at)}
        </time>
      </div>
    </div>
  );
}

function EmptyNotes() {
  return (
    <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 text-center">
      <StickyNote className="size-8 opacity-40" />
      <p className="text-sm">No notes yet.</p>
      <p className="max-w-xs text-xs">
        Notes stay in this session and disappear when it ends.
      </p>
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="bg-muted-foreground/70 size-1.5 animate-bounce rounded-full"
      style={{ animationDelay: delay, animationDuration: "1s" }}
    />
  );
}
