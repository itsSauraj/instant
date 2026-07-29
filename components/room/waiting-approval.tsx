"use client";

import { useRef } from "react";
import { useGSAP } from "@gsap/react";
import { DoorClosed, LogOut } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EASE, gsap, prefersReducedMotion, revealIn } from "@/lib/animation";

/**
 * Full-cover screen for a joiner whose knock is pending. Structure and motion
 * mirror LobbyOverlay so waiting reads as one idiom throughout the app: a
 * blurred cover, a centred panel, one breathing ring as the only loop.
 */
export function WaitingApproval({
  hostName,
  onLeave,
}: {
  /** Whose room it is, when the invite carried it. Null when unknown. */
  hostName?: string | null;
  /** Gives up: withdraws the knock and leaves for the home page. */
  onLeave: () => void;
}) {
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
      className="bg-background/80 absolute inset-0 z-20 grid place-items-center overflow-y-auto p-5 backdrop-blur-md"
    >
      <div
        role="status"
        aria-live="polite"
        className="panel relative my-auto w-full max-w-md p-6 text-center sm:p-7"
      >
        <div className="relative mx-auto grid size-14 place-items-center">
          <span
            ref={ringRef}
            aria-hidden
            className="absolute inset-0 rounded-full border border-primary/50"
          />
          <span className="bg-primary/15 ring-primary/30 grid size-14 place-items-center rounded-full ring-1">
            <DoorClosed className="text-primary size-6" aria-hidden />
          </span>
        </div>

        <h2 data-anim="in" className="mt-5 text-lg font-semibold">
          Asking to be let in
        </h2>
        <p data-anim="in" className="text-muted-foreground mt-1.5 text-sm">
          {hostName
            ? `This is ${hostName}'s session. They've been asked to let you in.`
            : "The host has been asked to let you in."}
        </p>

        <Badge data-anim="in" variant="muted" className="mt-5 py-1">
          Nobody joins without the host's say-so
        </Badge>

        <div data-anim="in" className="mt-5">
          <Button
            type="button"
            variant="outline"
            onClick={onLeave}
            aria-label="Stop waiting and leave"
            className="gap-1.5"
          >
            <LogOut className="size-4" />
            Stop waiting
          </Button>
        </div>
      </div>
    </div>
  );
}
