"use client";

import { useEffect, useRef } from "react";
import { Crown, Mic, MicOff, Monitor, Pin, PinOff, Video, VideoOff, Wifi } from "lucide-react";

import { RobotAvatar } from "@/components/room/robot-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ModerationAction, Participant } from "@/lib/signal-protocol";
import { cn } from "@/lib/utils";

/**
 * One participant's tile: their live video when it flows, otherwise a
 * locally-drawn avatar placeholder, plus their name, role and device state,
 * the pin controls, and (for the host) the moderation controls.
 *
 * The pin control lives ON the tile deliberately: a pin is a property of a
 * person's video, so it belongs where you can see whose video you are pinning,
 * not in a dropdown elsewhere. Two distinct controls:
 *  - "Pin for you" (everyone has it): rearranges only THIS viewer's layout.
 *  - "Pin for everyone" (host only): forces the layout for the whole room via
 *    the server. The two are visually and textually separate so a viewer never
 *    mistakes a local pin for a room-wide one.
 *
 * Moderation is asymmetric because browsers make it so: a host can force a
 * device OFF ("Mute", "Turn off camera") but can only ASK for it to come on
 * ("Ask to unmute") -- no remote party can switch on someone's microphone or
 * camera. The labels never pretend otherwise.
 *
 * Avatars are drawn locally: a RobotAvatar generated from the seed the person
 * brought with them, or initials (hue derived from the peer id) when they
 * presented no seed -- matching presence.tsx. Never fetch avatars from a
 * third-party service: that would put session identifiers in someone else's
 * server logs.
 */
export function VideoTile({
  participant,
  isSelf,
  stream,
  mediaVersion,
  videoLive,
  audioLive,
  mirror,
  screenSharing,
  audioMuted,
  localPinned,
  hostPinned,
  hostPinActive,
  canPinForEveryone,
  onToggleLocalPin,
  onToggleHostPin,
  canModerate,
  onModerate,
  forcedAudioBy,
  forcedVideoBy,
  labelClearance = false,
  className,
}: {
  participant: Participant;
  isSelf: boolean;
  /** This participant's MediaStream (local capture for self). Null when no
   *  link is live -- e.g. the peer is away/reconnecting. */
  stream: MediaStream | null;
  /** `media.version` from the snapshot. Tracks arrive and leave on the SAME
   *  stream object, so this counter -- not stream identity -- signals change. */
  mediaVersion: number;
  /** Whether this participant is currently sending live video. */
  videoLive: boolean;
  /** Whether their microphone is live (self: whether ours is on). */
  audioLive: boolean;
  /** Mirror the image. Callers pass camera-not-screen for the self tile;
   *  mirrored text on a screen share reads backwards. */
  mirror: boolean;
  /** Self only: the outgoing video is a screen share. */
  screenSharing: boolean;
  /** Mute playback (the viewer's incoming-audio mute). The self tile is
   *  ALWAYS muted regardless -- hearing your own mic is a feedback loop. */
  audioMuted: boolean;
  /** This tile is the viewer's own local pin. */
  localPinned: boolean;
  /** This tile is the host's forced, room-wide pin. */
  hostPinned: boolean;
  /** A host-forced pin exists somewhere, which overrides any local pin. */
  hostPinActive: boolean;
  /** The viewer is the host and may pin for everyone. */
  canPinForEveryone: boolean;
  onToggleLocalPin: () => void;
  /** Host only; omitted for guests. */
  onToggleHostPin?: () => void;
  /** The viewer is the host, this is someone else's tile, and moderation is
   *  wired: show the mute / turn-off-camera / ask-* controls. */
  canModerate?: boolean;
  /** Moderate THIS participant. The grid curries the peer id in. */
  onModerate?: (action: ModerationAction) => void;
  /** Self tile only: the host who force-muted the microphone. Shown while the
   *  mic is still off, so it never looks like the user muted themselves. */
  forcedAudioBy?: string | null;
  /** Self tile only: the host who force-stopped the camera. */
  forcedVideoBy?: string | null;
  /** Stage tile only: raise the name bar (from `sm` up) so the floating
   *  control pill at the panel's bottom never covers the person's name. */
  labelClearance?: boolean;
  className?: string;
}) {
  const name = participant.name;
  const hue = hueFor(participant.id);

  // Labels name the NEXT action, and say which scope they affect.
  const localPinLabel = localPinned
    ? `Unpin ${name} (your layout only)`
    : `Pin ${name} (your layout only)`;
  const hostPinLabel = hostPinned ? `Unpin ${name} for everyone` : `Pin ${name} for everyone`;

  // Moderation: exactly one audio and one video control, matched to the
  // participant's current state -- never "Mute" someone already muted. The
  // enforced actions are verbs the host does; the requests are phrased as
  // asking, because that is all a browser allows.
  const audioModeration = audioLive
    ? { action: "mute-audio" as const, label: `Mute ${name}`, icon: MicOff }
    : { action: "ask-audio" as const, label: `Ask ${name} to unmute`, icon: Mic };
  const videoModeration = videoLive
    ? { action: "mute-video" as const, label: `Turn off ${name}'s camera`, icon: VideoOff }
    : { action: "ask-video" as const, label: `Ask ${name} to turn their camera on`, icon: Video };
  // An away peer has no live devices and no open stream to receive an ask.
  const showModeration = Boolean(canModerate && onModerate && !isSelf && !participant.away);

  return (
    <div
      data-slot="video-tile"
      data-peer-id={participant.id}
      data-self={isSelf || undefined}
      data-video-live={videoLive || undefined}
      data-pinned={hostPinned ? "host" : localPinned ? "local" : undefined}
      className={cn(
        "group relative overflow-hidden rounded-lg bg-black/85 ring-1 ring-white/10",
        className,
      )}
    >
      <Surface
        stream={stream}
        version={mediaVersion}
        // The self preview is ALWAYS muted -- an unmuted local preview plays
        // your own microphone back at you (feedback loop). Remote tiles obey
        // the viewer's incoming-audio mute. Audio-only peers keep an audible
        // (but invisible) surface, so hiding is done with `invisible`, never
        // by unmounting.
        muted={isSelf || audioMuted}
        mirrored={mirror && !screenSharing}
        label={isSelf ? undefined : `Live video from ${name}`}
        className={cn(
          "absolute inset-0 size-full object-contain",
          !videoLive && "invisible",
        )}
      />

      {!videoLive ? (
        <div className="absolute inset-0 grid place-items-center p-3 text-center">
          <div
            className={cn("flex flex-col items-center gap-1.5", participant.away && "opacity-75")}
          >
            {/* Locally drawn avatar, matching presence.tsx: the robot needs
                the seed the person brought with them; without one (older
                client, or storage unavailable) initials still identify them
                rather than an identical default robot for everyone. Nothing
                leaves the device for this. */}
            {participant.avatarSeed ? (
              <span
                aria-hidden
                data-avatar="robot"
                data-avatar-seed={participant.avatarSeed}
                className="size-14"
              >
                <RobotAvatar seed={participant.avatarSeed} />
              </span>
            ) : (
              <span
                aria-hidden
                data-avatar="initials"
                className="grid size-12 place-items-center rounded-full text-sm font-semibold"
                style={{
                  backgroundColor: `oklch(0.72 0.13 ${hue})`,
                  color: `oklch(0.24 0.06 ${hue})`,
                }}
              >
                {initials(name)}
              </span>
            )}
            {participant.away ? (
              // Their seat is held while they reload: reconnecting, not gone.
              <Badge variant="warning" className="gap-1">
                <Wifi aria-hidden />
                Reconnecting…
              </Badge>
            ) : audioLive && !isSelf ? (
              <span className="text-xs font-medium text-white/75">Audio only</span>
            ) : (
              <span className="text-xs text-white/55">Camera off</span>
            )}
          </div>
        </div>
      ) : null}

      {/* State badges, written out -- never carried by an icon alone. The
          wording keeps the two kinds of pin apart: "for you" is this viewer's
          private layout; a host pin is room-wide and, for a guest, clearly
          host-enforced. Forced-device badges name the host so a force-mute
          never looks like the user muted themselves. */}
      <div className="absolute top-1.5 left-1.5 flex max-w-[85%] flex-wrap gap-1">
        {hostPinned ? (
          <Badge className="bg-primary/90 gap-1">
            <Pin aria-hidden />
            {canPinForEveryone ? "Pinned for everyone" : "Pinned by host for everyone"}
          </Badge>
        ) : localPinned ? (
          hostPinActive ? (
            <Badge variant="muted" className="gap-1">
              <Pin aria-hidden />
              Your pin (overridden by the host's pin)
            </Badge>
          ) : (
            <Badge variant="secondary" className="gap-1">
              <Pin aria-hidden />
              Pinned for you
            </Badge>
          )
        ) : null}
        {isSelf && !audioLive && forcedAudioBy ? (
          <Badge variant="destructive" className="gap-1 bg-black/60">
            <MicOff aria-hidden />
            Muted by {forcedAudioBy}
          </Badge>
        ) : null}
        {isSelf && !videoLive && forcedVideoBy ? (
          <Badge variant="destructive" className="gap-1 bg-black/60">
            <VideoOff aria-hidden />
            Camera turned off by {forcedVideoBy}
          </Badge>
        ) : null}
      </div>

      {/* Tile controls. Real <button>s, so keyboard access is native; visually
          quiet until the tile is hovered or a control inside it has focus. */}
      <div
        className={cn(
          "absolute top-1.5 right-1.5 flex max-w-[70%] flex-wrap justify-end gap-1 transition-opacity",
          "opacity-0 group-hover:opacity-100 focus-within:opacity-100",
          (localPinned || hostPinned) && "opacity-100",
        )}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant={localPinned ? "default" : "secondary"}
              aria-pressed={localPinned}
              aria-label={localPinLabel}
              onClick={onToggleLocalPin}
              className={cn(
                "size-7",
                !localPinned && "bg-black/55 text-white ring-1 ring-white/25 hover:bg-black/75 hover:text-white",
              )}
            >
              {localPinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{localPinLabel}</TooltipContent>
        </Tooltip>

        {canPinForEveryone && onToggleHostPin ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant={hostPinned ? "default" : "secondary"}
                aria-pressed={hostPinned}
                aria-label={hostPinLabel}
                onClick={onToggleHostPin}
                className={cn(
                  "h-7 gap-1 px-2 text-[0.65rem]",
                  !hostPinned && "bg-black/55 text-white ring-1 ring-white/25 hover:bg-black/75 hover:text-white",
                )}
              >
                {hostPinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                All
              </Button>
            </TooltipTrigger>
            <TooltipContent>{hostPinLabel}</TooltipContent>
          </Tooltip>
        ) : null}

        {showModeration
          ? [audioModeration, videoModeration].map(({ action, label, icon: Icon }) => (
              <Tooltip key={action}>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="secondary"
                    aria-label={label}
                    onClick={() => onModerate?.(action)}
                    className="size-7 bg-black/55 text-white ring-1 ring-white/25 hover:bg-black/75 hover:text-white"
                  >
                    <Icon className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{label}</TooltipContent>
              </Tooltip>
            ))
          : null}
      </div>

      {/* Name bar. Always present, so a live video is never anonymous. On the
          stage tile the row is raised (from `sm` up, where the floating pill
          overlaps the stage) so the pill never covers the name. */}
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-linear-to-t from-black/80 via-black/40 to-transparent px-2 pt-5 pb-1.5 text-xs text-white",
          labelClearance && "sm:from-black/60 sm:via-black/30 sm:pb-18",
        )}
      >
        <span className="min-w-0 truncate font-medium">
          {name}
          {isSelf ? <span className="text-white/70"> (You)</span> : null}
        </span>
        {participant.isHost ? (
          <span title="Host" className="shrink-0">
            <Crown aria-hidden className="text-warning size-3" />
            <span className="sr-only">Host</span>
          </span>
        ) : null}
        {screenSharing ? (
          <span title="Sharing screen" className="shrink-0">
            <Monitor aria-hidden className="size-3 text-white/85" />
            <span className="sr-only">Sharing screen</span>
          </span>
        ) : null}
        {!audioLive ? (
          <span title="Microphone off" className="ml-auto shrink-0">
            <MicOff aria-hidden className="size-3 text-white/75" />
            <span className="sr-only">Microphone off</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A `<video>` whose `srcObject` is kept in sync with a MediaStream. Tracks are
 * added and removed on the same stream object, so `version` is what actually
 * signals a change -- the stream identity never varies for a link's life.
 * (Carried over verbatim from the pre-grid media panel; the fixes in here are
 * load-bearing.)
 */
function Surface({
  stream,
  version,
  muted,
  mirrored,
  className,
  label,
}: {
  stream: MediaStream | null;
  version: number;
  muted: boolean;
  mirrored?: boolean;
  className?: string;
  /** Accessible name. Omit for decorative surfaces (the local self-preview). */
  label?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    if (element.srcObject !== stream) {
      element.srcObject = stream;
    }
    if (!stream) {
      // Releasing the binding matters: a <video> left holding a stream keeps
      // the decoder attached after the session is gone.
      element.pause();
      return;
    }
    // Autoplay can be refused before any user gesture; the controls below the
    // grid are a gesture, so a later toggle recovers it.
    void element.play().catch(() => {});

    return () => {
      element.srcObject = null;
    };
  }, [stream, version]);

  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      aria-label={label}
      // The unlabeled self preview is decorative -- its visible caption
      // ("You") is the accessible text, so don't announce it twice.
      aria-hidden={label ? undefined : true}
      className={cn(className, mirrored && "-scale-x-100")}
    />
  );
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Stable, well-spread hue from an id. Same function as presence.tsx, so the
 *  tile placeholder and the header chip agree on a person's colour. */
function hueFor(id: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (((hash >>> 0) % 360) * 0.618) % 360;
}
