"use client";

import { useRef } from "react";
import { useGSAP } from "@gsap/react";
import { Link2, Loader2, Lock } from "lucide-react";

import { CopyField } from "@/components/copy-field";
import { Badge } from "@/components/ui/badge";
import { EASE, gsap, prefersReducedMotion, revealIn } from "@/lib/animation";
import { prettyRoomId } from "@/lib/ids";

/** Shown while the first participant is alone in the room. */
export function LobbyOverlay({ roomId, inviteUrl }: { roomId: string; inviteUrl: string }) {
  const scope = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLSpanElement>(null);

  useGSAP(
    () => {
      revealIn(scope.current, { stagger: 0.05, y: 12 });
      if (ringRef.current && !prefersReducedMotion()) {
        gsap.to(ringRef.current, {
          scale: 1.6,
          opacity: 0,
          duration: 1.9,
          ease: EASE.out,
          repeat: -1,
        });
      }
    },
    { scope },
  );

  return (
    <div
      ref={scope}
      className="bg-background/80 absolute inset-0 z-20 grid place-items-center p-5 backdrop-blur-md"
    >
      <div className="panel w-full max-w-md p-6 text-center sm:p-7">
        <div className="relative mx-auto grid size-14 place-items-center">
          <span
            ref={ringRef}
            aria-hidden
            className="absolute inset-0 rounded-full border border-primary/50"
          />
          <span className="bg-primary/15 ring-primary/30 grid size-14 place-items-center rounded-full ring-1">
            <Loader2 className="text-primary size-6 animate-spin" />
          </span>
        </div>

        <h2 data-anim="in" className="mt-5 text-lg font-semibold">
          Waiting for one other person
        </h2>
        <p data-anim="in" className="text-muted-foreground mt-1.5 text-sm">
          Send them this link. The session seals as soon as they arrive.
        </p>

        <div data-anim="in" className="mt-5 space-y-3 text-left">
          <div>
            <p className="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-xs font-medium">
              <Link2 className="size-3.5" />
              Invite link
            </p>
            <CopyField value={inviteUrl} label="Copy invite link" />
          </div>
          <div>
            <p className="text-muted-foreground mb-1.5 text-xs font-medium">Or share the code</p>
            <CopyField value={prettyRoomId(roomId)} label="Copy session code" />
          </div>
        </div>

        <Badge data-anim="in" variant="muted" className="mt-5 gap-1.5 py-1">
          <Lock />
          Only the next person to open this link can join
        </Badge>
      </div>
    </div>
  );
}
