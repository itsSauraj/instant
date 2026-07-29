"use client";

import { useState } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { SessionPhase } from "@/lib/peer-session";
import { cn } from "@/lib/utils";

type Status = "connected" | "connecting" | "disconnected";

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

/**
 * Figma/Google-Docs-style participant chips: one avatar per peer with a
 * status dot. Avatars are generated from role-based seeds so both browsers
 * render the same face for the same person without exchanging anything.
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
  const me: Status = ended ? "disconnected" : "connected";
  const peer: Status =
    phase === "connected" ? "connected" : ended ? "disconnected" : "connecting";

  const myRole = isHost ? "host" : "guest";
  const peerRole = isHost ? "guest" : "host";

  return (
    <div className="flex items-center -space-x-1.5" role="group" aria-label="Participants">
      <Avatar seed={`${roomId}-${myRole}`} status={me} label={`You (${myRole}) — ${STATUS_LABEL[me]}`} />
      <Avatar
        seed={`${roomId}-${peerRole}`}
        status={peer}
        label={`${peerRole === "host" ? "Host" : "Guest"} — ${STATUS_LABEL[peer]}`}
        dimmed={peer !== "connected"}
      />
    </div>
  );
}

function Avatar({
  seed,
  status,
  label,
  dimmed,
}: {
  seed: string;
  status: Status;
  label: string;
  dimmed?: boolean;
}) {
  const [failed, setFailed] = useState(false);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("relative inline-flex", dimmed && "opacity-60")} aria-label={label}>
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
              "ring-background absolute -right-0 -bottom-0 size-2.5 rounded-full ring-2",
              DOT[status],
              status === "connecting" && "animate-pulse",
            )}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
