"use client";

import { useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useGSAP } from "@gsap/react";
import { Home, PlugZap, RotateCcw, ShieldX, UserX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { revealIn } from "@/lib/animation";
import { createRoomId } from "@/lib/ids";
import type { EndReason } from "@/lib/signal-protocol";

const EXPLANATION: Record<EndReason, { title: string; body: string; icon: typeof ShieldX }> = {
  "peer-ended": {
    title: "The other person ended the session",
    body: "Everything shared here has been cleared from both sides. Start a new session to continue.",
    icon: UserX,
  },
  "peer-left": {
    title: "The other person disconnected",
    body: "Their connection dropped, so the session was closed for both of you. Nothing can be resumed — start a new one.",
    icon: UserX,
  },
  "self-ended": {
    title: "You ended the session",
    body: "The connection was closed and all notes and files were cleared on both sides.",
    icon: ShieldX,
  },
  "room-full": {
    title: "This session is already full",
    body: "A session links exactly two people, and both places are taken. Ask for a fresh invite link.",
    icon: ShieldX,
  },
  "session-over": {
    title: "This session has already ended",
    body: "Once two people have met on a code it is retired for good, so the link cannot be re-opened. Start a new session and share the new link.",
    icon: ShieldX,
  },
  "room-closed": {
    title: "The session was closed",
    body: "The signalling server released this session. Start a new one to reconnect.",
    icon: PlugZap,
  },
  expired: {
    title: "The invite expired",
    body: "Nobody joined in time, so the session was released. Create a new one to try again.",
    icon: PlugZap,
  },
  "transport-error": {
    title: "The connection was lost",
    body: "The session could not be kept alive. Start a new one — this session cannot be reused.",
    icon: PlugZap,
  },
};

/**
 * Terminal screen. Reaching it means the session object has already been torn
 * down, so there is deliberately no "reconnect" affordance: the only way
 * forward is a brand-new room.
 */
export function EndedOverlay({ reason, error }: { reason: EndReason | null; error: string | null }) {
  const router = useRouter();
  const scope = useRef<HTMLDivElement>(null);

  useGSAP(() => revealIn(scope.current, { stagger: 0.05, y: 12 }), { scope });

  const { title, body, icon: Icon } = EXPLANATION[reason ?? "room-closed"];
  const isRefusal = reason === "room-full";

  return (
    <div
      ref={scope}
      role="alertdialog"
      aria-labelledby="ended-title"
      className="bg-background/85 absolute inset-0 z-30 grid place-items-center p-5 backdrop-blur-md"
    >
      <div className="panel w-full max-w-md p-6 text-center sm:p-7">
        <span className="bg-destructive/12 ring-destructive/25 mx-auto grid size-14 place-items-center rounded-full ring-1">
          <Icon className="text-destructive size-6" />
        </span>

        <h2 id="ended-title" data-anim="in" className="mt-5 text-lg font-semibold">
          {title}
        </h2>
        <p data-anim="in" className="text-muted-foreground mt-1.5 text-sm text-pretty">
          {body}
        </p>

        {error ? (
          <p
            data-anim="in"
            className="bg-muted/60 text-muted-foreground mt-4 rounded-lg border px-3 py-2 text-left font-mono text-xs"
          >
            {error}
          </p>
        ) : null}

        <div data-anim="in" className="mt-6 flex flex-col gap-2 sm:flex-row">
          {isRefusal ? null : (
            <Button className="flex-1 gap-2" onClick={() => router.replace(`/room/${createRoomId()}`)}>
              <RotateCcw className="size-4" />
              New session
            </Button>
          )}
          <Button asChild variant={isRefusal ? "default" : "outline"} className="flex-1 gap-2">
            <Link href="/">
              <Home className="size-4" />
              Back home
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
