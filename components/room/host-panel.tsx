"use client";

import { Crown, Power } from "lucide-react";

import { CapacityControl } from "@/components/room/capacity-control";
import { VISIBILITY_COPY, VisibilityToggle } from "@/components/room/visibility-toggle";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type { Participant, RoomVisibility } from "@/lib/signal-protocol";
import { cn } from "@/lib/utils";

/**
 * Host-only room controls: who may join, the participant limit, and the one
 * irreversible act - closing the session for everyone. Only the host may close a room
 * (delegating that right no longer exists), so the close button lives here and
 * nowhere else, behind an explicit confirmation.
 *
 * Laid out as a single column: this renders inside the right-hand Settings
 * drawer, which is 20rem wide, so every row is its explanation on top and its
 * control underneath rather than the two fighting for one line.
 *
 * Pinning is deliberately NOT here. A pin is a property of a person's video, so
 * it belongs on their tile in the Audio & video grid where you can see who you
 * are pinning - putting it in a dropdown here divorced it from the thing it
 * acts on.
 *
 * The server enforces every one of these; this panel merely issues the
 * requests and reflects the authoritative state it is handed.
 */
export function HostPanel({
  capacity,
  visibility,
  participants,
  onCapacityChange,
  onVisibilityChange,
  onTransferHost,
  onClose,
  className,
}: {
  capacity: number;
  visibility: RoomVisibility;
  participants: Participant[];
  onCapacityChange: (value: number) => void;
  /** Opens the room to anyone with the link, or makes arrivals knock again. */
  onVisibilityChange: (value: RoomVisibility) => void;
  /** Opens the successor picker in transfer-only mode: the host role moves,
   *  this participant STAYS in the session. Distinct from the leave flow. */
  onTransferHost: () => void;
  /** Ends the session for everyone. Called only after the confirmation. */
  onClose: () => void;
  className?: string;
}) {
  return (
    <section aria-label="Host controls" className={cn("space-y-4", className)}>
      {/* Admission first: it is the setting most likely to be changed
          mid-session ("just let everyone in") and the one with the widest
          consequence, so it should not hide below the stepper. */}
      <div role="group" aria-label="Who can join" className="space-y-2">
        <p className="text-sm font-medium">Who can join</p>
        <VisibilityToggle value={visibility} onChange={onVisibilityChange} size="sm" />
        <p className="text-muted-foreground text-xs">
          {VISIBILITY_COPY[visibility].summary}
          {visibility === "public"
            ? " Anyone already waiting at the door was let in when you opened it."
            : " Switching to private never removes anyone already here."}
        </p>
      </div>

      <Separator />

      <CapacityControl
        capacity={capacity}
        headcount={participants.length}
        onChange={onCapacityChange}
      />

      <Separator />

      {/* Transfer WITHOUT leaving. The other handover (transfer, then leave)
          lives behind the rail's End session control; this one exists for the
          host who wants to stay on the call but stop holding the keys. */}
      <div className="space-y-2">
        <p className="text-sm font-medium">Transfer hosting</p>
        <p className="text-muted-foreground text-xs">
          Hand the host role to someone else and stay in the session as a regular participant.
          Nothing changes until the room confirms the handover.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-slot="transfer-hosting"
          onClick={onTransferHost}
          className="gap-1.5"
        >
          <Crown className="size-3.5" />
          Transfer hosting
        </Button>
      </div>

      <Separator />

      <div className="space-y-2">
        <p className="text-sm font-medium">Close the session</p>
        <p className="text-muted-foreground text-xs">
          Ending the session disconnects everyone at once. To leave while the session continues
          for the others, use the End session control in the left rail - it lets you hand hosting
          to someone first.
        </p>

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button type="button" variant="destructive" size="sm" className="gap-1.5">
              <Power className="size-3.5" />
              Close session for everyone
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Close this session for everyone?</AlertDialogTitle>
              <AlertDialogDescription>
                All {participants.length} participants are disconnected immediately, and every
                note and file shared here is cleared. This cannot be undone, and the session
                cannot be resumed.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep it open</AlertDialogCancel>
              <AlertDialogAction onClick={onClose}>Close for everyone</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </section>
  );
}
