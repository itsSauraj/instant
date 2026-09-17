"use client";

import { useRef } from "react";
import { useGSAP } from "@gsap/react";
import { AlertTriangle, Globe, Link2, Loader2, Lock, QrCode, X } from "lucide-react";

import { CopyField } from "@/components/copy-field";
import { QrInvite } from "@/components/room/qr-invite";
import { VisibilityToggle } from "@/components/room/visibility-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EASE, gsap, prefersReducedMotion, revealIn } from "@/lib/animation";
import { isGeneratedRoomId, prettyRoomId } from "@/lib/ids";
import type { RoomVisibility } from "@/lib/signal-protocol";

/** Shown while the first participant is alone in the room. */
export function LobbyOverlay({
  roomId,
  inviteUrl,
  visibility,
  onVisibilityChange,
  onDismiss,
}: {
  roomId: string;
  inviteUrl: string;
  visibility: RoomVisibility;
  /** Host only: flips the room between private and public while waiting. */
  onVisibilityChange?: (value: RoomVisibility) => void;
  /** Lets the creator close the overlay and use the room while alone. */
  onDismiss?: () => void;
}) {
  const scope = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLSpanElement>(null);
  const isPublic = visibility === "public";
  // A code somebody chose is a code somebody else can guess. In a private room
  // the host still stands between the guess and a seat; in a public one the
  // guess IS the seat, so say so right where the code is being shared.
  const guessable = isPublic && !isGeneratedRoomId(roomId);

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
      {/* my-auto rather than centring alone: the panel is tall enough with the
          QR that it must be able to scroll on a short viewport. */}
      <div className="panel relative my-auto w-full max-w-md p-6 text-center sm:p-7">
        {onDismiss ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={onDismiss}
            aria-label="Close and wait in the room"
            className="text-muted-foreground absolute top-2.5 right-2.5 size-8"
          >
            <X className="size-4" />
          </Button>
        ) : null}
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
          Waiting for others to join
        </h2>
        <p data-anim="in" className="text-muted-foreground mt-1.5 text-sm">
          {isPublic
            ? "Share this link. Anyone who opens it joins straight away."
            : "Share this link. You will be asked to let each person in as they arrive."}
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
          <div>
            <p className="text-muted-foreground mb-2 flex items-center gap-1.5 text-xs font-medium">
              <QrCode className="size-3.5" />
              Or scan it with a phone
            </p>
            {/* The invite link is already printed above, so don't repeat it. */}
            <QrInvite url={inviteUrl} showUrl={false} />
          </div>
        </div>

        {onVisibilityChange ? (
          <div data-anim="in" className="mt-5 space-y-1.5 text-left">
            <p className="text-muted-foreground text-xs font-medium">Who can join</p>
            <VisibilityToggle value={visibility} onChange={onVisibilityChange} size="sm" />
          </div>
        ) : null}

        <Badge
          data-anim="in"
          variant={isPublic ? "warning" : "muted"}
          data-visibility={visibility}
          className="mt-4 gap-1.5 py-1"
        >
          {isPublic ? <Globe /> : <Lock />}
          {isPublic ? "Open to anyone with the link" : "Nobody joins until you approve them"}
        </Badge>

        {guessable ? (
          <p
            role="note"
            data-slot="guessable-warning"
            className="text-warning mt-3 flex items-start justify-center gap-1.5 text-left text-xs"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              This is a custom code, so it is easy to guess. Anyone who types it in joins without
              asking. Switch to private if that matters.
            </span>
          </p>
        ) : null}
      </div>
    </div>
  );
}
