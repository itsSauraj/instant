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

/** What the host is trying to do with the handover. The two acts share the
 *  successor picker but end differently, and the copy must say which. */
export type TransferIntent = "leave" | "stay";

/**
 * "Who takes over?" - the successor picker for BOTH host handovers:
 *
 *  - `intent="leave"`: the step between a host choosing Leave and actually
 *    leaving. A room without a host strands everyone (nobody can admit or
 *    close), so the host may not slip out without answering this.
 *  - `intent="stay"`: hand the role over and REMAIN in the session as a
 *    regular participant (reached from the host panel's "Transfer hosting").
 *
 * Three honest shapes, depending on who is available:
 *  - Somebody eligible: a dropdown of seated, present participants. The host
 *    themself and `away` participants are not candidates - a held seat cannot
 *    act as host, and the server refuses both anyway. The confirm button is
 *    the affordance: disabled until a choice is made.
 *  - Everyone else away: no valid recipient, said plainly instead of an empty
 *    dropdown. When leaving, that is still possible but presented as the
 *    destructive act it is; when staying, there is simply nothing to do yet.
 *  - Alone: leaving ends the room (said exactly so); a transfer-only has no
 *    possible recipient, so the dialog says to invite someone first.
 *
 * The ACT (transfer first, act only once the server ratifies it) lives in
 * room-client; `pendingName` reflects that in-flight state here. Initial
 * focus is always Cancel - never the destructive or consequential action.
 */
export function HostTransferDialog({
  open,
  onOpenChange,
  intent,
  participants,
  pendingName,
  onTransfer,
  onLeaveWithoutTransfer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "leave": transfer, then leave once ratified. "stay": transfer only. */
  intent: TransferIntent;
  /** Everyone else currently seated, `away` participants included. */
  participants: Participant[];
  /** Set while a transfer awaits the server's ratification; disables the form. */
  pendingName: string | null;
  /** Transfer host to `peerId`; the follow-through (leave or stay) happens
   *  in the caller, and only once the server confirms the handover. */
  onTransfer: (peerId: PeerId) => void;
  /** Leave with no successor - only offered (and only meaningful) when
   *  `intent` is "leave" and there is nobody eligible. */
  onLeaveWithoutTransfer: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const selectId = useId();
  const [selected, setSelected] = useState<PeerId | "">("");

  // A stale selection must not survive a close/reopen: the person may be gone.
  useEffect(() => {
    if (!open) setSelected("");
  }, [open]);

  const leaving = intent === "leave";
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
          leaving ? (
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
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>No one else is here yet</DialogTitle>
                <DialogDescription>
                  Hosting can only be handed to another seated participant. Invite
                  someone first, then transfer from here.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <DialogClose asChild>
                  <Button ref={cancelRef} data-slot="transfer-cancel" variant="outline">
                    Close
                  </Button>
                </DialogClose>
              </div>
            </>
          )
        ) : nobodyPresent ? (
          <>
            <DialogHeader>
              <DialogTitle>No one can take over right now</DialogTitle>
              <DialogDescription>
                {leaving
                  ? "Everyone else is reconnecting, and a held seat cannot let people in or close the room. If you leave, the session runs unmanaged until someone returns."
                  : "Everyone else is reconnecting, and a held seat cannot let people in or close the room. Try again when someone is back."}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <DialogClose asChild>
                <Button ref={cancelRef} data-slot="transfer-cancel" variant="outline">
                  {leaving ? "Stay in the session" : "Close"}
                </Button>
              </DialogClose>
              {leaving ? (
                <Button
                  variant="destructive"
                  data-slot="transfer-leave-anyway"
                  onClick={onLeaveWithoutTransfer}
                >
                  Leave anyway
                </Button>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Who takes over as host?</DialogTitle>
              <DialogDescription>
                {leaving
                  ? "Only the host can let people in or close the room."
                  : "You stay in the session as a regular participant; only the host role moves."}
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
                onClick={() => chosen && onTransfer(chosen.id)}
              >
                {busy ? (
                  <>
                    <Loader2 aria-hidden className="animate-spin" />
                    {leaving
                      ? `Handing the session to ${pendingName}…`
                      : `Making ${pendingName} the host…`}
                  </>
                ) : chosen ? (
                  leaving ? (
                    `Make ${chosen.name} host and leave`
                  ) : (
                    `Make ${chosen.name} host`
                  )
                ) : leaving ? (
                  "Make host and leave"
                ) : (
                  "Make host"
                )}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
