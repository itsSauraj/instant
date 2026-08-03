"use client";

import { useRef } from "react";
import { DoorOpen, Power } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * The host's single entry point for ending their participation, offering the
 * two genuinely different acts side by side:
 *
 *  1. Leave — the room CONTINUES for the others. Choosing it hands off to the
 *     successor picker (HostTransferDialog), because a room without a host
 *     strands everyone: only the host can admit people or close it.
 *  2. Close for everyone — destructive and final; the consequence is named on
 *     the option itself, so the click that follows is an informed one.
 *
 * Non-hosts never see this dialog: their Leave affects only themselves, so
 * there is no choice to offer (room-client keeps their plain button).
 *
 * Focus lands on the SAFE option (Leave). Both options are ordinary buttons in
 * a plain dialog — a second confirmation layer would triple-ask for "close"
 * (the rail button, this dialog, then an alert) without adding information the
 * option text does not already carry.
 */
export function EndSessionDialog({
  open,
  onOpenChange,
  othersCount,
  onChooseLeave,
  onCloseForEveryone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Seated participants other than the host (away seats included). */
  othersCount: number;
  /** The host wants to depart but keep the room running; opens the picker. */
  onChooseLeave: () => void;
  /** Ends the session for all participants. Irreversible. */
  onCloseForEveryone: () => void;
}) {
  const leaveRef = useRef<HTMLButtonElement>(null);
  const alone = othersCount === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // The safe way onward gets focus, never the destructive option.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          leaveRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>End session</DialogTitle>
          <DialogDescription>Leaving and closing are different things.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          <button
            ref={leaveRef}
            type="button"
            data-slot="end-leave-option"
            onClick={onChooseLeave}
            className={cn(
              "w-full rounded-xl border p-3 text-left transition-colors outline-none",
              "hover:bg-accent hover:text-accent-foreground",
              "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
            )}
          >
            <span className="flex items-center gap-2 text-sm font-medium">
              <DoorOpen aria-hidden className="size-4 shrink-0" />
              {alone ? "Leave" : "Leave — the session continues"}
            </span>
            {/* Alone there is no continuing room, which is destructive enough
                to warrant the one short line. */}
            {alone ? (
              <span className="text-muted-foreground mt-1 block text-xs">
                You are the only one here, so leaving ends the session.
              </span>
            ) : null}
          </button>

          <button
            type="button"
            data-slot="end-close-option"
            onClick={onCloseForEveryone}
            className={cn(
              "border-destructive/40 w-full rounded-xl border p-3 text-left transition-colors outline-none",
              "hover:bg-destructive/10",
              "focus-visible:border-destructive focus-visible:ring-destructive/40 focus-visible:ring-[3px]",
            )}
          >
            <span className="text-destructive flex items-center gap-2 text-sm font-medium">
              <Power aria-hidden className="size-4 shrink-0" />
              Close for everyone
            </span>
            <span className="text-muted-foreground mt-1 block text-xs">
              Everyone is disconnected immediately. This cannot be undone.
            </span>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
