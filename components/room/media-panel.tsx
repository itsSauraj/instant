"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Headphones,
  Mic,
  MicOff,
  MonitorOff,
  MonitorUp,
  Shield,
  Video,
  VideoOff,
  Volume2,
  VolumeOff,
  VolumeX,
} from "lucide-react";

import { DeviceMenu } from "@/components/room/device-menu";
import { VideoGrid } from "@/components/room/video-grid";
import { ScreenAudioPeersProvider } from "@/components/room/video-tile";
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
import type { MediaDevices } from "@/hooks/use-media-devices";
import type { DeviceKind } from "@/lib/media-devices";
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
 *
 * Screen AUDIO follows the same "never imply what we cannot do" rule. Only the
 * browser's own picker can add audio to a display capture, so there is no
 * toggle for it here: the share button's tooltip points at the picker before a
 * share, and while sharing a status line says whether audio actually arrived -
 * a silent share that looks fine is this feature's whole failure mode. Where
 * the platform has no display audio at all (Firefox, Safari, and system audio
 * on macOS) the UI says so instead of dangling a dead affordance.
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
  devices,
  onChooseDevice,
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
  /** The device lists and remembered choice; with `onChooseDevice`, each call
   *  control grows a Meet-style arrow that opens them. Omit both to hide. */
  devices?: MediaDevices;
  /** Applies a choice; rejects when a live capture cannot switch over, and
   *  the rejection is reported beside the controls like any device error. */
  onChooseDevice?: (kind: DeviceKind, deviceId: string | null) => Promise<void>;
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
  // How much audio this browser can put INSIDE a display capture, on the same
  // after-mount rule. "unknown" is the pre-mount value AND the answer when the
  // browser will not say, so every message it drives stays platform-neutral.
  const [displayAudio, setDisplayAudio] = useState<DisplayAudioSupport>("unknown");
  useEffect(() => {
    setCanShareScreen(typeof navigator.mediaDevices?.getDisplayMedia === "function");
    setDisplayAudio(detectDisplayAudio());
  }, []);

  /*
   * Desktop-audio state, from the transport. Both fields are read OPTIONALLY on
   * purpose: they land in a separate change, and an absent field must mean "no
   * audio" rather than an unknown that hides the status line.
   *  - screenAudioOn: this client's share is currently carrying device audio.
   *  - screenAudioAvailable: the platform offered audio at all; undefined until
   *    a share has actually been attempted, so it only ever refines the guess.
   */
  const { screenAudioOn = false, screenAudioAvailable } = media as MeshMediaState & {
    screenAudioOn?: boolean;
    screenAudioAvailable?: boolean;
  };
  const screenAudioImpossible = audioOutOfReach(screenAudioOn, screenAudioAvailable, displayAudio);

  /** The feedback-loop warning, dismissed for the rest of this share. */
  const [loopWarningOff, setLoopWarningOff] = useState(false);
  useEffect(() => {
    if (!screenAudioOn) setLoopWarningOff(false);
  }, [screenAudioOn]);

  /* Who is sharing screen audio, for the tiles. Self comes from our own state;
   * peers come from the snapshot's per-peer media once the transport publishes
   * it, read optionally so this behaves correctly before it does. */
  const screenAudioPeers = useMemo(() => {
    const ids = new Set<PeerId>();
    if (self && screenAudioOn) ids.add(self.id);
    for (const [peerId, peer] of Object.entries(media.byPeer)) {
      if ((peer as { screenAudioLive?: boolean }).screenAudioLive) ids.add(peerId);
    }
    return ids;
  }, [self, screenAudioOn, media.byPeer]);

  /*
   * The feedback loop, warned about only when it can actually happen: sharing
   * this device's audio re-captures every other participant coming out of the
   * speakers, so they hear themselves back. All four conditions matter -
   * audio really is being shared, the call really is audible (so the speakers
   * really are playing the others), the capture really can be device-wide (a
   * different tab's audio never contains the call, so tab-only platforms are
   * excluded), and the user has not already acknowledged it.
   */
  const feedbackRisk =
    screenAudioOn && !muted && media.remoteAudioLive && displayAudio !== "tab" && !loopWarningOff;

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
      {/* Renders no element of its own, so the grid stays this panel's flex
          child; it only tells each tile whose share carries audio. */}
      <ScreenAudioPeersProvider peerIds={screenAudioPeers}>
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
          sinkId={devices ? (devices.choice.audiooutput ?? null) : undefined}
        />
      </ScreenAudioPeersProvider>

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

        {deviceError ? (
          // role="alert" ONLY here: this is the one message that reports a
          // failure. Everything else below is a status and stays polite.
          <p
            role="alert"
            className="bg-background/80 text-destructive pointer-events-auto max-w-xl rounded-2xl border px-3 py-1 text-center text-xs shadow backdrop-blur-md"
          >
            {deviceError}
          </p>
        ) : null}

        {media.screenOn ? (
          <p
            // The share is running: say whether its audio came with it. The
            // user cannot tell otherwise - a silent share looks identical to a
            // working one - so this is announced politely as it changes.
            role="status"
            data-slot="screen-audio-status"
            className={cn(
              "bg-background/80 pointer-events-auto flex max-w-xl items-center gap-1.5 rounded-2xl border px-3 py-1 text-left text-xs shadow backdrop-blur-md",
              screenAudioOn ? "text-success" : "text-muted-foreground",
            )}
          >
            {screenAudioOn ? (
              <Volume2 aria-hidden className="size-3.5 shrink-0" />
            ) : (
              <VolumeOff aria-hidden className="size-3.5 shrink-0" />
            )}
            <span>
              {screenAudioOn
                ? "Your screen share includes its audio."
                : screenAudioImpossible
                  ? "Your screen share is video only. This browser cannot capture screen audio."
                  : `Your screen share is video only. Stop and restart it, ticking ${audioBoxLabel(displayAudio)} in the browser's picker, to include the sound.`}
              {media.cameraOn ? " Your camera stays in your own tile." : null}
            </span>
          </p>
        ) : null}

        {feedbackRisk ? (
          <div
            role="status"
            data-slot="screen-audio-feedback"
            className="bg-background/80 text-warning pointer-events-auto flex max-w-xl flex-wrap items-center justify-center gap-2 rounded-2xl border px-3 py-2 text-xs shadow-lg backdrop-blur-md"
          >
            <Headphones aria-hidden className="size-4 shrink-0" />
            <span className="text-left">
              You are sharing this computer's audio while the call is playing out of its speakers,
              so everyone will hear themselves echo. Put on headphones, or mute the call while you
              present.
            </span>
            <span className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => setMuted(true)}>
                Mute incoming audio
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setLoopWarningOff(true)}>
                Dismiss
              </Button>
            </span>
          </div>
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
          {/* Each device control is a pair, as in Meet: the big button toggles,
              the small arrow beside it picks WHICH device. Choosing runs
              through `run` so a device that will not open reports its error
              in the same place a failed toggle does. */}
          <div className="flex items-center gap-0.5" data-slot="mic-control">
            <Control
              active={media.micOn}
              disabled={disabled || busy !== null}
              onClick={run("mic", onToggleMic)}
              on={{ icon: Mic, label: "Turn off microphone" }}
              off={{ icon: MicOff, label: "Turn on microphone" }}
            />
            {devices && onChooseDevice ? (
              <DeviceMenu
                devices={devices}
                kinds={["audioinput", "audiooutput"]}
                label="Microphone and speaker options"
                disabled={disabled || busy !== null}
                onChoose={(kind, deviceId) =>
                  void run(`device-${kind}`, () => onChooseDevice(kind, deviceId))()
                }
              />
            ) : null}
          </div>
          <div className="flex items-center gap-0.5" data-slot="camera-control">
            <Control
              active={media.cameraOn}
              disabled={disabled || busy !== null}
              onClick={run("camera", onToggleCamera)}
              on={{ icon: Video, label: "Turn off camera" }}
              off={{ icon: VideoOff, label: "Turn on camera" }}
            />
            {devices && onChooseDevice ? (
              <DeviceMenu
                devices={devices}
                kinds={["videoinput"]}
                label="Camera options"
                disabled={disabled || busy !== null}
                onChoose={(kind, deviceId) =>
                  void run(`device-${kind}`, () => onChooseDevice(kind, deviceId))()
                }
              />
            ) : null}
          </div>
          {canShareScreen ? (
            <Control
              active={media.screenOn}
              disabled={disabled || busy !== null}
              onClick={run("screen", onToggleScreen)}
              on={{ icon: MonitorUp, label: "Stop sharing screen" }}
              off={{ icon: MonitorOff, label: "Share your screen" }}
              // Discoverability without pretending to control it: sound is
              // added in the browser's own picker, so before a share the hint
              // points there, and where the browser has no display audio it
              // says that instead. While sharing, the status line above owns
              // the message, so the hint steps aside.
              hint={
                media.screenOn
                  ? undefined
                  : screenAudioImpossible
                    ? "This browser shares video only - it cannot capture screen audio."
                    : `Sound is not automatic: tick ${audioBoxLabel(displayAudio)} in the browser's picker.`
              }
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
  hint,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void | Promise<void>;
  on: { icon: typeof Mic; label: string };
  off: { icon: typeof Mic; label: string };
  /** Extra guidance for the tooltip only; never folded into `aria-label`. */
  hint?: string;
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
      {/* `aria-label` stays exactly the next action, so the button never
          announces a paragraph; the hint rides along as the description. */}
      <TooltipContent className={cn(hint && "max-w-64")}>
        {label}
        {hint ? <span className="text-muted-foreground mt-1 block">{hint}</span> : null}
      </TooltipContent>
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

/** How much audio a browser can put inside a display capture. */
type DisplayAudioSupport = "system" | "tab" | "none" | "unknown";

/**
 * There is no feature test for display audio - getSupportedConstraints()
 * describes devices, not the picker - so the brand list is the only signal
 * available, and it is only ever used to pick WORDING, never to disable screen
 * sharing. It matters because the truth differs per platform: Firefox and
 * Safari have no display audio at all (and can fail the whole capture when it
 * is requested), and a Chromium on macOS or Linux can capture a tab's sound but
 * never the system's. Anything unrecognised stays "unknown" and gets neutral
 * wording rather than a guess.
 */
function detectDisplayAudio(): DisplayAudioSupport {
  const agent = navigator as Navigator & {
    userAgentData?: { brands?: { brand: string }[]; platform?: string };
  };
  const ua = navigator.userAgent;
  const chromium =
    (agent.userAgentData?.brands ?? []).some((entry) => /Chromium/i.test(entry.brand)) ||
    (/Chrom(e|ium)\//.test(ua) && !/(Firefox|FxiOS)/.test(ua));
  if (!chromium) return "none";

  const platform = agent.userAgentData?.platform ?? ua;
  if (/Windows|CrOS/i.test(platform)) return "system";
  if (/Mac|Linux|X11|Android/i.test(platform)) return "tab";
  return "unknown";
}

/** Is screen audio out of reach on this client? The transport's observation (it
 *  asked, and the platform gave nothing) beats the user-agent guess; the guess
 *  is all there is before the first share. */
function audioOutOfReach(
  on: boolean,
  available: boolean | undefined,
  support: DisplayAudioSupport,
) {
  if (on) return false;
  if (available !== undefined) return !available;
  return support === "none";
}

/** What the user has to tick in the browser's OWN picker. The app cannot switch
 *  this on, which is why every message points at the picker instead of offering
 *  a toggle that would only ever be a lie. */
function audioBoxLabel(support: DisplayAudioSupport) {
  switch (support) {
    case "system":
      return '"Also share tab audio" or "Also share system audio"';
    case "tab":
      return '"Also share tab audio" (a tab only - this platform has no system audio)';
    default:
      return "the audio box";
  }
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
