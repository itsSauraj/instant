"use client";

import { useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { SessionPhase } from "@/lib/peer-session";
import { cn } from "@/lib/utils";

type Status = "connected" | "connecting" | "disconnected";

type Participant = {
  seed: string;
  label: string;
  status: Status;
};

const DOT: Record<Status, string> = {
  connected: "bg-success",
  connecting: "bg-warning",
  disconnected: "bg-destructive",
};

const STATUS_LABEL: Record<Status, string> = {
  connected: "connected",
  connecting: "connecting…",
  disconnected: "disconnected",
};

/** At most this many chips render inline; the rest collapse into "+N". */
const MAX_VISIBLE = 3;

/**
 * Figma/Google-Docs-style participant chips: one avatar per peer with a
 * status dot. Avatars are generated from role-based seeds so both browsers
 * render the same face for the same person without exchanging anything.
 * Beyond MAX_VISIBLE participants the overflow becomes a "+N" chip that
 * opens the full participant list.
 */
export function Presence({
  roomId,
  isHost,
  phase,
}: {
  roomId: string;
  isHost: boolean;
  phase: SessionPhase;
}) {
  const ended = phase === "ended";
  const peerStatus: Status =
    phase === "connected" ? "connected" : ended ? "disconnected" : "connecting";

  const myRole = isHost ? "host" : "guest";
  const peerRole = isHost ? "guest" : "host";

  // Today a session holds exactly two people; the list shape (and the +N
  // overflow below) is what a bigger room would flow through unchanged.
  const participants: Participant[] = [
    {
      seed: `${roomId}-${myRole}`,
      label: `You (${myRole}) — ${STATUS_LABEL[ended ? "disconnected" : "connected"]}`,
      status: ended ? "disconnected" : "connected",
    },
    {
      seed: `${roomId}-${peerRole}`,
      label: `${peerRole === "host" ? "Host" : "Guest"} — ${STATUS_LABEL[peerStatus]}`,
      status: peerStatus,
    },
  ];

  // When everyone fits, show everyone. When not, the last slot becomes +N,
  // so the pill never renders more than MAX_VISIBLE elements.
  const collapsed = participants.length > MAX_VISIBLE;
  const visible = collapsed ? participants.slice(0, MAX_VISIBLE - 1) : participants;
  const overflow = participants.length - visible.length;

  return (
    <div className="flex items-center -space-x-1.5" role="group" aria-label="Participants">
      {visible.map((participant) => (
        <Avatar key={participant.seed} {...participant} />
      ))}

      {overflow > 0 ? (
        <Dialog>
          <DialogTrigger asChild>
            <button
              type="button"
              aria-label={`Show all ${participants.length} participants`}
              className={cn(
                "bg-secondary text-secondary-foreground ring-background relative z-10 grid size-7",
                "place-items-center rounded-full text-[0.65rem] font-semibold ring-2",
                "hover:bg-accent focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px]",
              )}
            >
              +{overflow}
            </button>
          </DialogTrigger>
          <DialogContent className="max-w-xs gap-3 p-5">
            <DialogHeader className="gap-1">
              <DialogTitle>Participants</DialogTitle>
              <DialogDescription>
                {participants.length} people in this session
              </DialogDescription>
            </DialogHeader>
            <ul className="space-y-1.5">
              {participants.map((participant) => (
                <li key={participant.seed} className="flex items-center gap-2.5 text-sm">
                  <Avatar {...participant} plain />
                  <span className="min-w-0 truncate">{participant.label}</span>
                </li>
              ))}
            </ul>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

function Avatar({
  seed,
  status,
  label,
  plain,
}: Participant & {
  /** List rendering: no tooltip, no dimming — the row text carries the info. */
  plain?: boolean;
}) {
  const [failed, setFailed] = useState(false);

  const chip = (
    <span
      className={cn("relative inline-flex", !plain && status !== "connected" && "opacity-60")}
      aria-label={plain ? undefined : label}
    >
      <span className="bg-secondary ring-background grid size-7 place-items-center overflow-hidden rounded-full ring-2">
        {failed ? (
          <span className="text-muted-foreground text-[0.6rem] font-semibold uppercase">
            {seed.endsWith("host") ? "H" : "G"}
          </span>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- remote
          // generator with a dynamic seed; next/image adds nothing here.
          <img
            src={`https://robohash.org/${encodeURIComponent(seed)}.png?set=set1&size=56x56`}
            alt=""
            width={28}
            height={28}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
            className="size-full object-cover"
          />
        )}
      </span>
      <span
        aria-hidden
        className={cn(
          "ring-background absolute right-0 bottom-0 size-2.5 rounded-full ring-2",
          DOT[status],
          status === "connecting" && "animate-pulse",
        )}
      />
    </span>
  );

  if (plain) return chip;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
