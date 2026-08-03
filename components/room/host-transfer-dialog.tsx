"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Participant, PeerId } from "@/lib/signal-protocol";
import { cn } from "@/lib/utils";

/**
 * "Who takes over?" - the step between a host choosing Leave and actually
 * leaving. A room without a host strands everyone (nobody can admit or close),
 * so the host may not slip out without answering this.
 *
 * Three honest shapes, depending on who is available:
 *  - Somebody eligible: a dropdown of seated, present participants. The host
 *    themself and `away` participants are not candidates - a held seat cannot
 *    act as host, and the server refuses both anyway. The confirm button is
 *    the affordance: disabled until a choice is made.
 *  - Everyone else away: no valid recipient, said plainly instead of an empty
 *    dropdown. Leaving is still possible but presented as the destructive act
 *    it is (the room runs unmanaged until someone returns).
 *  - Alone: leaving ends the room; the button says exactly that.
 *
 * The ACT (transfer first, leave only once the server ratifies it) lives in
 * room-client; `pendingName` reflects that in-flight state here. Initial
 * focus is always Cancel - never the destructive or consequential action.
 */
export function HostTransferDialog({
  open,
  onOpenChange,
  participants,
  pendingName,
  onTransferAndLeave,
  onLeaveWithoutTransfer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Everyone else currently seated, `away` participants included. */
  participants: Participant[];
  /** Set while a transfer awaits the server's ratification; disables the form. */
  pendingName: string | null;
  /** Transfer host to `peerId`, then leave once the server confirms it. */
  onTransferAndLeave: (peerId: PeerId) => void;
  /** Leave with no successor - only offered when there is nobody eligible. */
  onLeaveWithoutTransfer: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const selectId = useId();
  const [selected, setSelected] = useState<PeerId | "">("");

  // A stale selection must not survive a close/reopen: the person may be gone.
  useEffect(() => {
    if (!open) setSelected("");
  }, [open]);

  const eligible = participants.filter((peer) => !peer.away);
  const awayCount = participants.length - eligible.length;
  const busy = pendingName !== null;

  // Re-validated against the current roster: the chosen peer may have left
  // between selecting and confirming.
  const chosen = eligible.find((peer) => peer.id === selected) ?? null;
  const alone = participants.length === 0;
  const nobodyPresent = !alone && eligible.length === 0;

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent
        // Cancel is the safe option; it must hold focus, not the action.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus();
        }}
      >
        {alone ? (
          <>
            <DialogHeader>
              <DialogTitle>Leave and end the session?</DialogTitle>
              <DialogDescription>
                You are the only one here, so leaving ends the session. It cannot be
                resumed.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <DialogClose asChild>
                <Button ref={cancelRef} data-slot="transfer-cancel" variant="outline">
                  Stay in the session
                </Button>
              </DialogClose>
              <Button
                variant="destructive"
                data-slot="transfer-leave-end"
                onClick={onLeaveWithoutTransfer}
              >
                Leave and end the session
              </Button>
            </div>
          </>
        ) : nobodyPresent ? (
          <>
            <DialogHeader>
              <DialogTitle>No one can take over right now</DialogTitle>
              <DialogDescription>
                Everyone else is reconnecting, and a held seat cannot let people in or
                close the room. If you leave, the session runs unmanaged until someone
                returns.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <DialogClose asChild>
                <Button ref={cancelRef} data-slot="transfer-cancel" variant="outline">
                  Stay in the session
                </Button>
              </DialogClose>
              <Button
                variant="destructive"
                data-slot="transfer-leave-anyway"
                onClick={onLeaveWithoutTransfer}
              >
                Leave anyway
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Who takes over as host?</DialogTitle>
              <DialogDescription>
                Only the host can let people in or close the room.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-1.5">
              <label htmlFor={selectId} className="text-sm font-medium">
                New host
              </label>
              {/* Radix select rather than a native one: the browser's own
                  dropdown renders with OS chrome that ignores the app's theme,
                  which looked broken inside a dark dialog. Nothing is selected
                  initially, so confirm stays disabled until a real person is
                  picked -- the placeholder is not a choice. */}
              <Select
                value={selected || undefined}
                disabled={busy}
                onValueChange={(value) => setSelected(value)}
              >
                <SelectTrigger id={selectId} aria-label="New host">
                  <SelectValue placeholder="Choose who takes over" />
                </SelectTrigger>
                <SelectContent>
                  {eligible.map((peer) => (
                    <SelectItem key={peer.id} value={peer.id}>
                      {peer.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {awayCount > 0 ? (
                <p className="text-muted-foreground text-xs">
                  Reconnecting participants cannot take over and are not listed.
                </p>
              ) : null}
            </div>

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <DialogClose asChild>
                <Button
                  ref={cancelRef}
                  data-slot="transfer-cancel"
                  variant="outline"
                  disabled={busy}
                >
                  Cancel
                </Button>
              </DialogClose>
              <Button
                data-slot="transfer-confirm"
                disabled={busy || !chosen}
                aria-busy={busy || undefined}
                onClick={() => chosen && onTransferAndLeave(chosen.id)}
              >
                {busy ? (
                  <>
                    <Loader2 aria-hidden className="animate-spin" />
                    Handing the session to {pendingName}…
                  </>
                ) : chosen ? (
                  `Make ${chosen.name} host and leave`
                ) : (
                  "Make host and leave"
                )}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
