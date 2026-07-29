"use client";

import { Crown, UserX, Wifi } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Participant } from "@/lib/signal-protocol";
import { cn } from "@/lib/utils";

/**
 * The room's roster: everyone currently seated, in join order (matching the
 * video grid, which sorts the same way). Compact rows so seven people fit on
 * a phone without scrolling the page — the list scrolls itself if it must.
 */
export function Roster({
  participants,
  selfId,
  isHost,
  onRemove,
  className,
}: {
  participants: Participant[];
  /** The local participant's id; null while joining. */
  selfId: string | null;
  /** Whether the viewer is the host; gates the per-peer remove action. */
  isHost: boolean;
  /** Host only: eject a participant. Ignored when `isHost` is false. */
  onRemove?: (peerId: string) => void;
  className?: string;
}) {
  // joinedAt with an id tie-break: two peers can be seated in the same
  // millisecond, and the order must be stable across renders and clients.
  const ordered = [...participants].sort((a, b) =>
    a.joinedAt !== b.joinedAt ? a.joinedAt - b.joinedAt : a.id < b.id ? -1 : 1,
  );

  return (
    <ul aria-label="Participants" className={cn("space-y-1", className)}>
      {ordered.map((participant) => {
        const isSelf = participant.id === selfId;
        // The host cannot be removed and nobody removes themselves; leaving
        // is its own action.
        const removable = isHost && !isSelf && !participant.isHost && Boolean(onRemove);

        return (
          <li
            key={participant.id}
            className={cn(
              "flex h-9 items-center gap-2 rounded-lg px-2 text-sm",
              participant.away && "opacity-70",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "size-2 shrink-0 rounded-full",
                participant.away ? "bg-warning animate-pulse" : "bg-success",
              )}
            />

            <span className="min-w-0 flex-1 truncate">
              {participant.name}
              {isSelf ? <span className="text-muted-foreground"> (You)</span> : null}
            </span>

            {/* State is written out, never carried by the dot colour alone. */}
            {participant.away ? (
              <Badge variant="warning" className="gap-1">
                <Wifi aria-hidden />
                Reconnecting…
              </Badge>
            ) : null}

            {participant.isHost ? (
              <Badge variant="muted" className="gap-1">
                <Crown aria-hidden />
                Host
              </Badge>
            ) : null}

            {removable ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${participant.name} from the session`}
                    onClick={() => onRemove?.(participant.id)}
                    className="text-muted-foreground hover:text-destructive size-7"
                  >
                    <UserX className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Remove from session</TooltipContent>
              </Tooltip>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
