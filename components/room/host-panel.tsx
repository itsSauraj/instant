"use client";

import { Power } from "lucide-react";

import { CapacityControl } from "@/components/room/capacity-control";
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
import type { Participant } from "@/lib/signal-protocol";
import { cn } from "@/lib/utils";

/**
 * Host-only room controls: the participant limit, and the one irreversible act
 * — closing the session for everyone. Only the host may close a room
 * (delegating that right no longer exists), so the close button lives here and
 * nowhere else, behind an explicit confirmation.
 *
 * Pinning is deliberately NOT here. A pin is a property of a person's video, so
 * it belongs on their tile in the Audio & video grid where you can see who you
 * are pinning — putting it in a dropdown here divorced it from the thing it
 * acts on.
 *
 * The server enforces every one of these; this panel merely issues the
 * requests and reflects the authoritative state it is handed.
 */
export function HostPanel({
  capacity,
  participants,
  onCapacityChange,
  onClose,
  className,
}: {
  capacity: number;
  participants: Participant[];
  onCapacityChange: (value: number) => void;
  /** Ends the session for everyone. Called only after the confirmation. */
  onClose: () => void;
  className?: string;
}) {
  return (
    <section
      aria-label="Host controls"
      className={cn("panel mt-3 space-y-3 px-4 py-3", className)}
    >
      <CapacityControl
        capacity={capacity}
        headcount={participants.length}
        onChange={onCapacityChange}
      />

      <Separator />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="text-muted-foreground min-w-0 flex-1 text-sm">
          Ending the session disconnects everyone at once.
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
