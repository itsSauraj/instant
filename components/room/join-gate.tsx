"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useGSAP } from "@gsap/react";
import { DoorOpen, Lock } from "lucide-react";

import { NameField } from "@/components/home/name-field";
import { Button } from "@/components/ui/button";
import { revealIn } from "@/lib/animation";
import { getStoredName, sanitizeName, setStoredName } from "@/lib/identity";
import { prettyRoomId } from "@/lib/ids";

/**
 * Shown to anyone arriving at a room URL before anything is sent.
 *
 * Nothing goes out until they submit: the signalling stream is not opened, so
 * the host is never asked to approve an anonymous request. That is the point of
 * gating here rather than prompting afterwards -- the host decides based on a
 * name, so the name has to exist before the knock does.
 *
 * The page cannot know yet which of three rooms lies behind the code: a private
 * one (they will knock), a public one (they walk in) or none at all (a custom
 * code typed into the address bar founds a fresh room with them as host). The
 * copy says so rather than promising any one outcome.
 *
 * The creator of the room skips this (they named themselves on the home page),
 * and so does a reload that is reclaiming an existing seat.
 */
export function JoinGate({
  roomId,
  onSubmit,
}: {
  roomId: string;
  /** Called with the sanitized name once the visitor commits to joining. */
  onSubmit: (name: string) => void;
}) {
  const scope = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [nudge, setNudge] = useState(false);

  useGSAP(() => revealIn(scope.current, { stagger: 0.05, y: 12 }), { scope });

  // Prefill after mount: localStorage does not exist on the server, and reading
  // it during hydration would mismatch the markup.
  useEffect(() => {
    setName(getStoredName());
    inputRef.current?.focus();
  }, []);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const clean = sanitizeName(name);
    // Unlike the home page, an empty name is refused outright here. The host
    // may be about to decide whether to admit a stranger and "Guest 3" tells
    // them nothing, so this is the one place a name is genuinely required.
    if (!clean) {
      setNudge(true);
      inputRef.current?.focus();
      return;
    }
    setStoredName(clean);
    onSubmit(clean);
  };

  return (
    <div
      ref={scope}
      className="mx-auto grid min-h-dvh w-full max-w-md place-items-center p-5"
    >
      <form onSubmit={submit} className="panel w-full p-6 text-center sm:p-7">
        <span className="bg-primary/15 ring-primary/30 mx-auto grid size-14 place-items-center rounded-full ring-1">
          <DoorOpen className="text-primary size-6" />
        </span>

        <h1 data-anim="in" className="mt-5 text-lg font-semibold">
          Join this session
        </h1>
        <p data-anim="in" className="text-muted-foreground mt-1.5 text-sm">
          You are about to join session{" "}
          <span className="font-mono">{prettyRoomId(roomId)}</span>. If it is private, the host
          will see your name and decide whether to let you in; if it is public, you walk straight
          in. If nobody is using this code yet, you start the session and become its host.
        </p>

        <div data-anim="in" className="mt-5 text-left">
          <NameField
            ref={inputRef}
            value={name}
            onChange={(next) => {
              setName(next);
              if (next.trim()) setNudge(false);
            }}
            nudge={nudge}
          />
        </div>

        <Button data-anim="in" type="submit" size="lg" className="mt-4 w-full">
          Ask to join
        </Button>

        <p
          data-anim="in"
          className="text-muted-foreground mt-4 flex items-start justify-center gap-2 text-xs"
        >
          <Lock className="mt-0.5 size-3.5 shrink-0" />
          <span className="text-left">
            Nothing is sent until you press the button. Once you are in, everything you share goes
            straight to the other people, not through a server.
          </span>
        </p>

        <Button data-anim="in" asChild variant="ghost" size="sm" className="mt-3">
          <Link href="/">Cancel</Link>
        </Button>
      </form>
    </div>
  );
}
