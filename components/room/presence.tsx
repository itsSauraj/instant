"use client";

import { RobotAvatar } from "@/components/room/robot-avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Participant } from "@/lib/signal-protocol";
import { cn } from "@/lib/utils";

/**
 * Participant chips in the header: one avatar per person, with a status dot.
 *
 * Avatars are drawn locally from initials and a hue derived from the peer id.
 * They were previously fetched from a third-party avatar service with the ROOM
 * ID in the URL, which handed the session credential to someone else's server
 * on every render -- the same leak that ruled out a hosted QR generator. Nothing
 * here touches the network.
 */

/** Inline chips beyond this collapse into a "+N" that opens the full list. */
const MAX_VISIBLE = 4;

export type PresenceEntry = Participant & { isSelf: boolean };
type Entry = PresenceEntry;

export function Presence({
  participants,
  selfId,
  className,
  onOpenList,
  pending = 0,
}: {
  /** The full roster including self, already ordered by arrival. */
  participants: Participant[];
  selfId: string | null;
  className?: string;
  /** Called when the pill is clicked; opens the participants side panel. */
  onOpenList?: () => void;
  /** Join requests awaiting the host: shown as a translucent amber chip. */
  pending?: number;
}) {
  const entries: Entry[] = participants.map((participant) => ({
    ...participant,
    isSelf: participant.id === selfId,
  }));

  if (entries.length === 0) return null;

  // When everyone fits, show everyone; otherwise the last slot becomes "+N" so
  // a full seven-person room never widens the header past MAX_VISIBLE chips.
  const collapsed = entries.length > MAX_VISIBLE;
  const visible = collapsed ? entries.slice(0, MAX_VISIBLE - 1) : entries;
  const overflow = entries.length - visible.length;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onOpenList}
          aria-label={`Show all ${entries.length} participants`}
          className={cn(
            "focus-visible:ring-ring/50 flex items-center -space-x-1.5 rounded-full",
            "outline-none focus-visible:ring-[3px]",
            onOpenList && "cursor-pointer",
            className,
          )}
        >
          {visible.map((entry) => (
            <ParticipantAvatar key={entry.id} entry={entry} />
          ))}

          {overflow > 0 ? (
            <span
              className={cn(
                "bg-secondary text-secondary-foreground ring-background relative z-10 grid size-7",
                "place-items-center rounded-full text-[0.65rem] font-semibold ring-2",
              )}
            >
              +{overflow}
            </span>
          ) : null}

          {pending > 0 ? (
            // Somebody is waiting at the door: a translucent amber placeholder
            // seat, pulsing until the host answers in the participants panel.
            <span
              aria-label={`${pending} waiting to join`}
              className={cn(
                "bg-warning/25 text-warning border-warning/70 ring-background relative z-10",
                "grid size-7 animate-pulse place-items-center rounded-full border border-dashed",
                "text-[0.65rem] font-semibold ring-2",
              )}
            >
              {pending > 1 ? pending : "?"}
            </span>
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {entries.length} in session
        {pending > 0 ? ` · ${pending} waiting to join` : ""} · click for details
      </TooltipContent>
    </Tooltip>
  );
}

/** One line of text covering name, role and state, for tooltip and list alike. */
function describe(entry: Entry) {
  const who = entry.isSelf ? `${entry.name} (you)` : entry.name;
  const role = entry.isHost ? " · host" : "";
  // Away means the seat is held while they reload, not that they have gone.
  const state = entry.away ? " · reconnecting" : "";
  return `${who}${role}${state}`;
}

/**
 * A deterministic local avatar. Both browsers derive the same hue for the same
 * person because the peer id is the same on both sides, so nothing has to be
 * exchanged and nothing is fetched.
 */
export function ParticipantAvatar({ entry }: { entry: Entry }) {
  const hue = hueFor(entry.id);

  return (
    <span
      className={cn("relative inline-flex shrink-0", entry.away && "opacity-60")}
      // The chip is described by its tooltip / row text, so keep it out of the
      // accessibility tree rather than announcing a bare pair of initials.
      aria-hidden
    >
      <span
        className="ring-background grid size-7 place-items-center overflow-hidden rounded-full text-[0.6rem] font-semibold ring-2"
        style={{
          backgroundColor: `oklch(0.72 0.13 ${hue})`,
          color: `oklch(0.24 0.06 ${hue})`,
        }}
      >
        {/* The robot needs the seed the person brought with them; without one
            (older client, or storage unavailable) initials still identify them
            rather than showing an identical default robot for everyone. */}
        {entry.avatarSeed ? <RobotAvatar seed={entry.avatarSeed} /> : initials(entry.name)}
      </span>
      <span
        className={cn(
          "ring-background absolute right-0 bottom-0 size-2.5 rounded-full ring-2",
          entry.away ? "bg-warning animate-pulse" : "bg-success",
        )}
      />
      {entry.isHost ? (
        // A dot rather than a crown glyph: at 28px an icon is unreadable, and
        // the host is also named in the tooltip and the overflow list.
        <span className="bg-primary ring-background absolute top-0 right-0 size-2 rounded-full ring-2" />
      ) : null}
    </span>
  );
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Stable, well-spread hue from an id. FNV-1a: short, and good enough here. */
function hueFor(id: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Golden-angle steps keep neighbouring ids visually far apart.
  return ((hash >>> 0) % 360) * 0.618 % 360;
}
