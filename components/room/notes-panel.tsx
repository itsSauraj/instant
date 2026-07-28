"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SendHorizontal, StickyNote } from "lucide-react";

import { NoteMarkdown } from "@/components/room/note-markdown";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MAX_NOTE_LENGTH } from "@/lib/peer-protocol";
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
  const [draft, setDraft] = useState("");
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

  const submit = () => {
    const text = draft.trim();
    if (!text || disabled) return;
    onSend(text);
    setDraft("");
  };

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
        <div className="flex items-end gap-2">
          <Textarea
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value.slice(0, MAX_NOTE_LENGTH));
              onTyping();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            disabled={disabled}
            rows={1}
            placeholder={disabled ? "Waiting for the connection…" : "Write a note…  (Enter to send)"}
            aria-label="Note"
            className="max-h-40 min-h-10 resize-none"
          />
          <Button size="icon" onClick={submit} disabled={disabled || !draft.trim()} aria-label="Send note">
            <SendHorizontal />
          </Button>
        </div>
        {draft.length > MAX_NOTE_LENGTH - 200 ? (
          <p className="text-muted-foreground mt-1.5 text-right text-xs">
            {MAX_NOTE_LENGTH - draft.length} characters left
          </p>
        ) : null}
      </div>
    </div>
  );
}

function NoteBubble({ note }: { note: Note }) {
  return (
    <div className={cn("flex", note.mine ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[min(34rem,85%)] rounded-2xl px-3.5 py-2 text-sm shadow-xs",
          note.mine
            ? "bg-primary text-primary-foreground rounded-br-md"
            : "bg-secondary text-secondary-foreground rounded-bl-md",
        )}
      >
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
        Notes exist only in these two browsers for the length of the session.
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
