"use client";

import { useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useGSAP } from "@gsap/react";
import { DoorOpen, Home, PlugZap, RotateCcw, ShieldX, UserX, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { revealIn } from "@/lib/animation";
import { createRoomId } from "@/lib/ids";
import type { EndReason } from "@/lib/signal-protocol";

const EXPLANATION: Record<EndReason, { title: string; body: string; icon: typeof ShieldX }> = {
  "host-closed": {
    title: "The host ended the session",
    body: "Everyone was disconnected and everything shared here has been cleared. Start a new session to continue.",
    icon: ShieldX,
  },
  "self-left": {
    title: "You left the session",
    body: "The others are still connected. You can rejoin from the invite link if the host lets you back in.",
    icon: DoorOpen,
  },
  removed: {
    title: "The host removed you",
    body: "You are no longer connected to that session, and your copy of everything shared there has been cleared.",
    icon: UserX,
  },
  "room-full": {
    title: "That session is full",
    body: "The host has set a participant limit and every place is taken. Ask them to raise the limit, or to invite you again once someone leaves.",
    icon: Users,
  },
  rejected: {
    title: "The host did not let you in",
    body: "Every person joining has to be approved. Ask the host directly if you think this was a mistake.",
    icon: UserX,
  },
  expired: {
    title: "Nobody let you in",
    body: "Your request to join timed out without an answer. Try again, or ask the host to watch for it.",
    icon: PlugZap,
  },
  "room-closed": {
    title: "The session was closed",
    body: "The signalling server released this session. Start a new one to reconnect.",
    icon: PlugZap,
  },
  "transport-error": {
    title: "The connection was lost",
    body: "The session could not be kept alive. Rejoining from the invite link is worth a try; the room may still be running.",
    icon: PlugZap,
  },
};

/**
 * Reasons where the room itself may still be running, so offering to ask back
 * in is genuinely useful. When the host closed the session or removed you, it
 * is not -- there is nothing to rejoin, and offering it would just invite a
 * pointless knock the host has already answered.
 */
const REJOINABLE = new Set<EndReason>([
  "self-left",
  "transport-error",
  "room-full",
  "expired",
]);

/**
 * Terminal screen for this client's session. The local session object has been
 * torn down either way; where the room may survive we offer to rejoin, which
 * re-enters the host's approval queue rather than reconnecting silently.
 */
export function EndedOverlay({
  reason,
  error,
  roomId,
}: {
  reason: EndReason | null;
  error: string | null;
  /** Enables the rejoin affordance for reasons where the room may still exist. */
  roomId?: string;
}) {
  const router = useRouter();
  const scope = useRef<HTMLDivElement>(null);

  useGSAP(() => revealIn(scope.current, { stagger: 0.05, y: 12 }), { scope });

  const { title, body, icon: Icon } = EXPLANATION[reason ?? "room-closed"];
  const canRejoin = Boolean(roomId) && REJOINABLE.has(reason ?? "room-closed");
  // A fresh room is pointless when you were refused: you wanted *that* session.
  const offerNewRoom = reason !== "room-full" && reason !== "rejected";

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

        {/* The buttons never wrap their labels, so the row must be allowed to
            wrap instead: with all three actions present they overflow a
            28rem card. flex-1 still stretches whatever shares a line. */}
        <div data-anim="in" className="mt-6 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {canRejoin ? (
            // A full reload, deliberately: the client session object is torn
            // down (`ended` is terminal) and router.refresh() only re-renders
            // server components -- it never remounts the session. Reloading
            // re-runs the join from scratch, which means knocking again; the
            // host still decides.
            <Button className="flex-1 gap-2" onClick={() => window.location.reload()}>
              <RotateCcw className="size-4" />
              Ask to rejoin
            </Button>
          ) : null}
          {offerNewRoom ? (
            <Button
              variant={canRejoin ? "outline" : "default"}
              className="flex-1 gap-2"
              onClick={() => router.replace(`/room/${createRoomId()}`)}
            >
              Start a new session
            </Button>
          ) : null}
          <Button
            asChild
            variant={canRejoin || offerNewRoom ? "outline" : "default"}
            className="flex-1 gap-2"
          >
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
