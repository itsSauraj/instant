"use client";

import { VideoTile } from "@/components/room/video-tile";
import type { MeshMediaState, MeshParticipant } from "@/lib/mesh-session";
import type { ModerationAction, Participant, PeerId } from "@/lib/signal-protocol";
import { cn } from "@/lib/utils";

/**
 * Meeting-call layout for 1..7 participants: ONE LARGE STAGE tile plus
 * everyone else as small cards in a strip. This is the only layout -- an
 * equal grid was built first and deliberately removed, so there is exactly
 * one arrangement to reason about (and even 2 people render as stage + one
 * card, per the product spec).
 *
 * From the `sm` breakpoint (640px) up, the strip is a vertical column pinned
 * to the RIGHT edge -- the stage fills the remaining space to its left -- and
 * the column scrolls internally when its cards overflow (six cards at 7
 * people will not fit a laptop's height). Below `sm` it is a horizontally
 * scrollable row under the stage, so the layout works at 390px wide.
 *
 * STAGE PRECEDENCE (highest wins):
 *   1. The host's forced pin (`pinnedByHost`, server-authoritative).
 *   2. This viewer's local pin (`localPin`, private to this browser).
 *   3. Automatic: our own active screen share first -- a share is usually the
 *      point of the call, and it is the ONLY share we can identify (a remote
 *      video track does not say whether it is a camera or a screen) -- then
 *      the first OTHER participant by joinedAt (id tie-break), then self when
 *      alone. "Most recent speaker" was considered and skipped: detecting it
 *      needs a WebAudio analyser per remote stream, which is not cheap.
 * A pin naming someone no longer on the roster is ignored entirely; tiles are
 * reconciled purely from the roster (no roster entry, no tile).
 *
 * Except for its stage occupant, the strip keeps everyone -- self included --
 * in joinedAt order (id tie-break), the same total order every member
 * computes, so tiles never jump around as state changes; the stage itself
 * only moves when a pin or a screen share actually changes.
 */
export function VideoGrid({
  self,
  participants,
  media,
  localStream,
  getRemoteStream,
  localPin,
  pinnedByHost,
  isHost,
  incomingAudioMuted,
  onLocalPin,
  onHostPin,
  canModerate = false,
  onModerate,
  forcedAudioBy,
  forcedVideoBy,
  sinkId,
  className,
}: {
  /** The local participant; null while still joining. */
  self: Participant | null;
  /** Everyone else, from the snapshot (self is kept separate there). */
  participants: MeshParticipant[];
  media: MeshMediaState;
  localStream: MediaStream | null;
  getRemoteStream: (peerId: PeerId) => MediaStream | null;
  /** This viewer's private pin. Affects only this browser's layout. */
  localPin: PeerId | null;
  /** The host's forced pin, authoritative for the whole room. */
  pinnedByHost: PeerId | null;
  isHost: boolean;
  /** The viewer's incoming-audio mute (self tiles are always muted anyway). */
  incomingAudioMuted: boolean;
  onLocalPin: (peerId: PeerId | null) => void;
  /** Forwarded to `pinPeer`; only ever called when `isHost`. */
  onHostPin: (peerId: PeerId | null) => void;
  /** Host moderation is available (viewer is host AND the wiring exists). */
  canModerate?: boolean;
  onModerate?: (peerId: PeerId, action: ModerationAction) => void;
  /** Passed through to the self tile: who force-muted us, if anyone. */
  forcedAudioBy?: string | null;
  forcedVideoBy?: string | null;
  /** The chosen speaker for every remote tile; null is the system default. */
  sinkId?: string | null;
  className?: string;
}) {
  // One list, self included, in the shared joinedAt/id total order.
  const entries: { participant: Participant; isSelf: boolean }[] = [
    ...(self ? [{ participant: self, isSelf: true }] : []),
    ...participants.map((p) => ({ participant: p as Participant, isSelf: false })),
  ].sort(
    (a, b) =>
      a.participant.joinedAt - b.participant.joinedAt ||
      (a.participant.id < b.participant.id ? -1 : 1),
  );

  const present = new Set(entries.map((entry) => entry.participant.id));

  // Stage precedence, exactly as documented above.
  const hostPin = pinnedByHost && present.has(pinnedByHost) ? pinnedByHost : null;
  const viewerPin = localPin && present.has(localPin) ? localPin : null;
  const firstOther = entries.find((entry) => !entry.isSelf)?.participant.id ?? null;
  const automatic = self && media.screenOn ? self.id : (firstOther ?? self?.id ?? null);
  const stageId = hostPin ?? viewerPin ?? automatic;

  const renderTile = (
    entry: { participant: Participant; isSelf: boolean },
    tileClassName: string,
    isStage = false,
  ) => {
    const { participant, isSelf } = entry;
    const id = participant.id;
    const peerMedia = isSelf ? undefined : media.byPeer[id];
    return (
      <VideoTile
        key={id}
        participant={participant}
        isSelf={isSelf}
        stream={isSelf ? localStream : getRemoteStream(id)}
        mediaVersion={media.version}
        videoLive={isSelf ? media.cameraOn || media.screenOn : (peerMedia?.videoLive ?? false)}
        audioLive={isSelf ? media.micOn : (peerMedia?.audioLive ?? false)}
        // Mirror only the self camera; a mirrored screen share reads backwards,
        // and mirroring someone ELSE defeats "they point left, you look left".
        mirror={isSelf && media.cameraOn && !media.screenOn}
        screenSharing={isSelf && media.screenOn}
        audioMuted={incomingAudioMuted}
        localPinned={localPin === id}
        hostPinned={hostPin === id}
        hostPinActive={hostPin !== null}
        canPinForEveryone={isHost}
        onToggleLocalPin={() => onLocalPin(localPin === id ? null : id)}
        onToggleHostPin={isHost ? () => onHostPin(hostPin === id ? null : id) : undefined}
        canModerate={canModerate && !isSelf}
        onModerate={onModerate ? (action) => onModerate(id, action) : undefined}
        forcedAudioBy={isSelf ? forcedAudioBy : undefined}
        forcedVideoBy={isSelf ? forcedVideoBy : undefined}
        sinkId={sinkId}
        labelClearance={isStage}
        className={tileClassName}
      />
    );
  };

  if (entries.length === 0 || stageId === null) {
    return (
      <div
        data-slot="video-grid"
        data-layout="empty"
        className={cn(
          "text-muted-foreground grid min-h-0 flex-1 place-items-center text-sm",
          className,
        )}
      >
        Waiting for the connection
      </div>
    );
  }

  const stage = entries.find((entry) => entry.participant.id === stageId)!;
  const strip = entries.filter((entry) => entry.participant.id !== stageId);

  return (
    <div
      data-slot="video-grid"
      data-layout="stage"
      data-stage-id={stageId}
      className={cn(
        // Column below `sm`, row (stage left, strip right) from `sm` up. The
        // extra bottom padding below `sm` keeps the strip clear of the
        // floating control pill, which overlaps the stage only on wide
        // screens (the stage tile's raised name bar handles that side).
        "flex min-h-0 flex-1 flex-col gap-2 p-2 pb-24 sm:flex-row sm:pb-2",
        className,
      )}
    >
      {/* min-h-0/min-w-0 + the tile's absolutely positioned surface: the stage
          video's intrinsic size can never inflate the layout and push the
          device controls out of the panel. */}
      {renderTile(stage, "min-h-0 min-w-0 flex-1", true)}

      {strip.length > 0 ? (
        <div
          data-slot="video-strip"
          className={cn(
            // Phone: a horizontally scrollable row under the stage.
            "flex shrink-0 gap-2 overflow-x-auto pb-1",
            // Wide: a column beside the stage that scrolls vertically.
            "sm:w-40 sm:flex-col sm:overflow-x-hidden sm:overflow-y-auto sm:pb-0 lg:w-48",
          )}
        >
          {strip.map((entry) => renderTile(entry, "aspect-video w-32 shrink-0 sm:w-full"))}
        </div>
      ) : null}
    </div>
  );
}
