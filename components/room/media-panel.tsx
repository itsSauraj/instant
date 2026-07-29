"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Mic,
  MicOff,
  MonitorOff,
  MonitorUp,
  Shield,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
} from "lucide-react";

import { VideoGrid } from "@/components/room/video-grid";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { MeshMediaState, MeshParticipant } from "@/lib/mesh-session";
import {
  isEnforced,
  videoBudget,
  type ModerationAction,
  type Participant,
  type PeerId,
} from "@/lib/signal-protocol";
import { cn } from "@/lib/utils";

/**
 * The audio/video panel: the stage-plus-strip call layout on top, the device
 * controls (mic, camera, screen share, incoming-audio mute) below, and -- for
 * the host -- the moderation controls.
 *
 * The viewer's LOCAL pin lives here as plain component state: it is a private
 * layout preference, never sent anywhere. The host's forced pin
 * (`pinnedByHost`) comes from the server and always wins (see VideoGrid).
 *
 * Moderation contract (matches `isEnforced` in the frozen wire contract):
 *  - `moderation` is the most recent `moderated` event aimed at THIS client.
 *    Enforced actions (mute-audio/mute-video) are applied by the TRANSPORT,
 *    which turns the device off before this prop updates -- the panel only
 *    attributes the result ("Muted by <host>") so a force-mute never looks
 *    self-inflicted. This panel deliberately does NOT toggle devices for
 *    enforced actions: doing it here too would race the transport and a
 *    double "off" toggle would turn the device back ON.
 *  - ask-* actions are requests: they render a dismissible prompt naming who
 *    asked, and NOTHING changes unless the user accepts. No browser lets a
 *    remote party switch a mic or camera on, and the UI never implies it.
 */
export function MediaPanel({
  media,
  self,
  participants,
  localStream,
  getRemoteStream,
  pinnedByHost,
  isHost,
  disabled,
  onPinPeer,
  onModerate,
  moderation,
  onToggleMic,
  onToggleCamera,
  onToggleScreen,
}: {
  media: MeshMediaState;
  /** The local participant; null while joining. */
  self: Participant | null;
  /** Everyone else (the snapshot keeps self separate). */
  participants: MeshParticipant[];
  localStream: MediaStream | null;
  getRemoteStream: (peerId: PeerId) => MediaStream | null;
  /** The host's forced pin, if any. */
  pinnedByHost: PeerId | null;
  isHost: boolean;
  disabled: boolean;
  /** Host only: force a pin for everyone (null clears). No-op for guests. */
  onPinPeer: (peerId: PeerId | null) => void;
  /** Host only: moderate one participant (`peerId`) or everyone else
   *  (`peerId` null). When absent the moderation UI does not render. */
  onModerate?: (peerId: PeerId | null, action: ModerationAction) => void;
  /** The most recent `moderated` event aimed at this client. `seq` must
   *  increase per event so an identical repeat still re-fires the prompt. */
  moderation?: { seq: number; action: ModerationAction; byName: string } | null;
  onToggleMic: () => Promise<void>;
  onToggleCamera: () => Promise<void>;
  onToggleScreen: () => Promise<void>;
}) {
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  /** Private to this browser: which tile THIS viewer put on the stage. */
  const [localPin, setLocalPin] = useState<PeerId | null>(null);
  /** The host's room-wide moderation cluster, behind a "more" toggle in the
   *  floating pill (each action still confirms via its own AlertDialog). */
  const [hostMenuOpen, setHostMenuOpen] = useState(false);

  /** A pending ask-* request from the host, awaiting this user's decision. */
  const [ask, setAsk] = useState<{ action: "ask-audio" | "ask-video"; byName: string } | null>(
    null,
  );
  /** Who force-muted us; shown on the self tile while the device stays off. */
  const [forcedAudioBy, setForcedAudioBy] = useState<string | null>(null);
  const [forcedVideoBy, setForcedVideoBy] = useState<string | null>(null);

  // Screen capture is missing from every iOS browser and most Android ones.
  // Detected after mount (not during render) so server and client HTML agree.
  const [canShareScreen, setCanShareScreen] = useState(false);
  useEffect(() => {
    setCanShareScreen(typeof navigator.mediaDevices?.getDisplayMedia === "function");
  }, []);

  const applyModeration = useCallback((action: ModerationAction, byName: string) => {
    if (isEnforced(action)) {
      // The transport already turned the device off; we only attribute it.
      if (action === "mute-audio") setForcedAudioBy(byName);
      else setForcedVideoBy(byName);
      return;
    }
    // A request. It must never auto-accept; the user decides below.
    setAsk({ action, byName });
  }, []);

  const lastModerationSeq = useRef(0);
  useEffect(() => {
    if (!moderation || moderation.seq === lastModerationSeq.current) return;
    lastModerationSeq.current = moderation.seq;
    applyModeration(moderation.action, moderation.byName);
  }, [moderation, applyModeration]);

  // Attribution ends the moment the user turns the device back on; likewise a
  // pending ask is moot once the asked-for device is already live.
  useEffect(() => {
    if (media.micOn) {
      setForcedAudioBy(null);
      setAsk((current) => (current?.action === "ask-audio" ? null : current));
    }
  }, [media.micOn]);
  useEffect(() => {
    if (media.cameraOn || media.screenOn) {
      setForcedVideoBy(null);
      setAsk((current) => (current?.action === "ask-video" ? null : current));
    }
  }, [media.cameraOn, media.screenOn]);

  // Dev-only test hooks, following the repo's `__instantPeerConnections`
  // convention. They let the Playwright suite drive this panel's moderation
  // behaviour before the transport lane lands the `moderated` event wiring:
  //  - __instantModerationTest(action, byName): inject an incoming event.
  //  - When `onModerate` is not wired yet, outgoing host actions are recorded
  //    on __instantModerationOutbox so intent is still assertable. The real
  //    prop replaces the fallback automatically once the manager wires it.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const holder = window as unknown as Record<string, unknown>;
    holder.__instantModerationTest = (action: ModerationAction, byName: string) =>
      applyModeration(action, byName);
    return () => {
      delete holder.__instantModerationTest;
    };
  }, [applyModeration]);

  const moderate =
    onModerate ??
    (process.env.NODE_ENV !== "production"
      ? (peerId: PeerId | null, action: ModerationAction) => {
          const holder = window as unknown as {
            __instantModerationOutbox?: { peerId: PeerId | null; action: ModerationAction }[];
          };
          (holder.__instantModerationOutbox ??= []).push({ peerId, action });
        }
      : undefined);
  const canModerate = isHost && Boolean(moderate);

  const run = (id: string, action: () => Promise<void>) => async () => {
    setDeviceError(null);
    setBusy(id);
    // Chrome/Safari reject a dismissed permission prompt, so `finally` clears
    // the busy state. Firefox can leave the promise pending forever when the
    // prompt is dismissed without a decision, which would pin every control in
    // the disabled state -- the failsafe re-enables them.
    const failsafe = window.setTimeout(
      () => setBusy((current) => (current === id ? null : current)),
      15_000,
    );
    try {
      await action();
    } catch (error) {
      setDeviceError(describeDeviceError(error));
    } finally {
      window.clearTimeout(failsafe);
      setBusy((current) => (current === id ? null : current));
    }
  };

  // Same accounting as the transport's budget: self plus every non-away peer
  // (away seats cost no uplink, so they do not depress anyone's quality).
  const meshCount = (self ? 1 : 0) + participants.filter((peer) => !peer.away).length;
  // The honest quality note: in a full mesh each person uploads one copy of
  // their camera per other participant, so the frozen contract's videoBudget()
  // steps resolution down as headcount rises (720p at 2 people, 270p at 6-7).
  // Without saying so, users read the softer video as the app being broken.
  const qualityNote =
    meshCount >= 4
      ? `With ${meshCount} people, cameras are sent at ${videoBudget(meshCount).height}p -- every` +
        " participant uploads a separate copy to each of the others. Screen share stays full quality."
      : null;

  return (
    <div className="panel relative flex h-full flex-col overflow-hidden">
      {/* min-h-0 flex-1 layout: each tile positions its <video> absolutely,
          so no video's intrinsic size (a portrait phone camera is very tall)
          can inflate this flex item and push the controls out of the panel. */}
      <VideoGrid
        self={self}
        participants={participants}
        media={media}
        localStream={localStream}
        getRemoteStream={getRemoteStream}
        localPin={localPin}
        pinnedByHost={pinnedByHost}
        isHost={isHost}
        incomingAudioMuted={muted}
        onLocalPin={setLocalPin}
        onHostPin={onPinPeer}
        canModerate={canModerate}
        onModerate={moderate ? (peerId, action) => moderate(peerId, action) : undefined}
        forcedAudioBy={forcedAudioBy}
        forcedVideoBy={forcedVideoBy}
      />

      {/* The call controls FLOAT over the video as a translucent pill,
          centred near the bottom -- this is what makes the panel read as a
          call, not a dashboard. It is ALWAYS visible (no hover-to-appear:
          keyboard and touch users must always be able to reach it), padded
          above any safe-area inset for thumbs, and the stage tile raises its
          name bar so the pill never covers the person's name. The wrapper is
          pointer-events-none so the tiles behind the empty areas stay
          clickable. From `sm` up the overlay is inset from the right by the
          strip column's width, so everything floats over the STAGE only and
          can never sit on top of a strip card's pin/moderation controls. */}
      <div className="pointer-events-none absolute bottom-0 left-0 right-0 z-10 flex flex-col items-center gap-2 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:right-44 lg:right-52">
        {ask ? (
          <div
            role="status"
            data-slot="moderation-ask"
            className="bg-background/80 pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-2 rounded-2xl border px-3 py-2 text-sm shadow-lg backdrop-blur-md"
          >
            <span>
              {/* The host ASKED; nothing changes unless you accept. */}
              <span className="font-medium">{ask.byName}</span>
              {ask.action === "ask-audio"
                ? " asked you to unmute."
                : " asked you to turn your camera on."}
            </span>
            <span className="flex gap-2">
              <Button
                size="sm"
                disabled={disabled || busy !== null}
                onClick={run(
                  ask.action === "ask-audio" ? "mic" : "camera",
                  ask.action === "ask-audio" ? onToggleMic : onToggleCamera,
                )}
              >
                {ask.action === "ask-audio" ? "Unmute" : "Turn camera on"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAsk(null)}>
                Not now
              </Button>
            </span>
          </div>
        ) : null}

        {deviceError || (media.screenOn && media.cameraOn) ? (
          <p
            // role="alert" ONLY when there is an actual error; the screen-share
            // hint is informational and must not interrupt a screen reader.
            role={deviceError ? "alert" : undefined}
            className={cn(
              "bg-background/80 pointer-events-auto max-w-xl rounded-2xl border px-3 py-1 text-center text-xs shadow backdrop-blur-md",
              deviceError ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {deviceError ?? "Screen share is being sent; your camera stays in your own tile."}
          </p>
        ) : null}

        {qualityNote ? (
          <p className="bg-background/80 text-muted-foreground pointer-events-auto max-w-xl rounded-2xl border px-3 py-1 text-center text-xs shadow backdrop-blur-md">
            {qualityNote}
          </p>
        ) : null}

        {hostMenuOpen && canModerate && participants.length > 0 ? (
          <div
            data-slot="host-controls"
            className="bg-background/80 pointer-events-auto flex flex-wrap items-center justify-center gap-2 rounded-2xl border px-3 py-2 shadow-lg backdrop-blur-md"
          >
            {/* Blunt instruments, so both sit behind a confirmation that
                names the consequence. Enforced OFF only: there is, by browser
                design, no "unmute everyone". */}
            <RoomWideModeration
              triggerLabel="Mute everyone"
              triggerIcon={MicOff}
              title="Mute everyone?"
              description="Everyone except you immediately stops sending audio. They stay muted until they unmute themselves -- you can only ask them to."
              confirmLabel="Mute everyone"
              onConfirm={() => moderate?.(null, "mute-audio")}
            />
            <RoomWideModeration
              triggerLabel="Turn off all cameras"
              triggerIcon={VideoOff}
              title="Turn off all cameras?"
              description="Everyone except you immediately stops sending video. Their cameras stay off until they turn them back on themselves -- you can only ask them to."
              confirmLabel="Turn off all cameras"
              onConfirm={() => moderate?.(null, "mute-video")}
            />
          </div>
        ) : null}

        <div
          data-slot="call-controls"
          className="bg-background/70 pointer-events-auto flex items-center gap-1.5 rounded-full border p-1.5 shadow-lg backdrop-blur-md"
        >
          <Control
            active={media.micOn}
            disabled={disabled || busy !== null}
            onClick={run("mic", onToggleMic)}
            on={{ icon: Mic, label: "Turn off microphone" }}
            off={{ icon: MicOff, label: "Turn on microphone" }}
          />
          <Control
            active={media.cameraOn}
            disabled={disabled || busy !== null}
            onClick={run("camera", onToggleCamera)}
            on={{ icon: Video, label: "Turn off camera" }}
            off={{ icon: VideoOff, label: "Turn on camera" }}
          />
          {canShareScreen ? (
            <Control
              active={media.screenOn}
              disabled={disabled || busy !== null}
              onClick={run("screen", onToggleScreen)}
              on={{ icon: MonitorUp, label: "Stop sharing screen" }}
              off={{ icon: MonitorOff, label: "Share your screen" }}
            />
          ) : null}
          <div className="bg-border mx-0.5 h-8 w-px" />
          {/* Incoming-audio mute: a separate control from the microphone.
              "Mute" alone is ambiguous between the two. */}
          <Control
            active={!muted}
            disabled={!media.remoteAudioLive}
            onClick={async () => setMuted((value) => !value)}
            on={{ icon: Volume2, label: "Mute incoming audio" }}
            off={{ icon: VolumeX, label: "Unmute incoming audio" }}
          />
          {canModerate && participants.length > 0 ? (
            <>
              <div className="bg-border mx-0.5 h-8 w-px" />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={hostMenuOpen ? "default" : "secondary"}
                    size="icon-lg"
                    aria-expanded={hostMenuOpen}
                    aria-label={hostMenuOpen ? "Hide host controls" : "Show host controls"}
                    onClick={() => setHostMenuOpen((open) => !open)}
                  >
                    <Shield />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {hostMenuOpen ? "Hide host controls" : "Host controls"}
                </TooltipContent>
              </Tooltip>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Control({
  active,
  disabled,
  onClick,
  on,
  off,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void | Promise<void>;
  on: { icon: typeof Mic; label: string };
  off: { icon: typeof Mic; label: string };
}) {
  // Labels name the NEXT action ("Turn off camera" while it is on).
  const { icon: Icon, label } = active ? on : off;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={active ? "default" : "secondary"}
          size="icon-lg"
          disabled={disabled}
          onClick={() => void onClick()}
          aria-pressed={active}
          aria-label={label}
        >
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** One confirmed room-wide moderation action (host only). */
function RoomWideModeration({
  triggerLabel,
  triggerIcon: TriggerIcon,
  title,
  description,
  confirmLabel,
  onConfirm,
}: {
  triggerLabel: string;
  triggerIcon: typeof Mic;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm">
          <TriggerIcon />
          {triggerLabel}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{confirmLabel}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function describeDeviceError(error: unknown) {
  if (!(error instanceof Error)) return "Could not start that device.";

  switch (error.name) {
    case "NotAllowedError":
      return "Permission denied. Allow access in your browser's site settings, then try again.";
    case "NotFoundError":
      return "No matching device found on this computer.";
    case "NotReadableError":
    case "TrackStartError":
      return "The device is in use by another application.";
    case "AbortError":
      return "The request was cancelled.";
    default:
      return error.message || "Could not start that device.";
  }
}
