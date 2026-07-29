"use client";

import { useEffect, useRef, useState } from "react";
import {
  Mic,
  MicOff,
  MonitorOff,
  MonitorUp,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { MediaState } from "@/lib/peer-session";
import { cn } from "@/lib/utils";

export function MediaPanel({
  media,
  localStream,
  remoteStream,
  disabled,
  onToggleMic,
  onToggleCamera,
  onToggleScreen,
}: {
  media: MediaState;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  disabled: boolean;
  onToggleMic: () => Promise<void>;
  onToggleCamera: () => Promise<void>;
  onToggleScreen: () => Promise<void>;
}) {
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const run = (id: string, action: () => Promise<void>) => async () => {
    setDeviceError(null);
    setBusy(id);
    // Chrome/Safari reject a dismissed permission prompt, so `finally` clears
    // the busy state. Firefox can leave the promise pending forever when the
    // prompt is dismissed without a decision, which would pin every control in
    // the disabled state — the failsafe re-enables them.
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

  const showingLocal = media.cameraOn || media.screenOn;

  return (
    <div className="panel flex h-full flex-col overflow-hidden">
      {/* min-h-0 plus an absolutely positioned surface: the video's intrinsic
          size (a portrait phone camera is very tall) must never inflate this
          flex item, or it pushes the controls out of the clipped panel. */}
      <div className="relative min-h-0 flex-1 bg-black/85">
        <Surface
          stream={remoteStream}
          version={media.version}
          muted={muted}
          label="Live video from the other person"
          className={cn(
            "absolute inset-0 size-full object-contain",
            !media.remoteVideoLive && "invisible",
          )}
        />

        {!media.remoteVideoLive ? (
          <div className="absolute inset-0 grid place-items-center px-6 text-center">
            <div className="flex flex-col items-center gap-2">
              <div className="grid size-14 place-items-center rounded-full bg-white/10 ring-1 ring-white/15">
                {media.remoteAudioLive ? (
                  <Mic className="size-6 text-white/85" />
                ) : (
                  <VideoOff className="size-6 text-white/60" />
                )}
              </div>
              <p className="text-sm font-medium text-white/85">
                {media.remoteAudioLive
                  ? "Audio only — camera is off on the other side"
                  : disabled
                    ? "Waiting for the connection"
                    : "The other side hasn't turned on a camera"}
              </p>
            </div>
          </div>
        ) : null}

        {media.remoteAudioLive ? (
          <Badge variant="success" className="absolute top-3 left-3 bg-success/25">
            <Volume2 />
            Receiving audio
          </Badge>
        ) : null}

        {showingLocal ? (
          <div className="absolute right-3 bottom-3 w-32 overflow-hidden rounded-lg border border-white/15 shadow-lg sm:w-44">
            <Surface
              stream={localStream}
              version={media.version}
              // Always muted: playing your own microphone back is a feedback loop.
              muted
              mirrored={media.cameraOn && !media.screenOn}
              className="aspect-video w-full bg-black object-cover"
            />
            <span className="absolute bottom-1 left-1.5 text-[0.6rem] font-medium text-white/80">
              {media.screenOn ? "Your screen" : "You"}
            </span>
          </div>
        ) : null}
      </div>

      <div className="shrink-0 space-y-2 border-t p-3 sm:p-4">
        <div className="flex items-center justify-center gap-2">
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
          <Control
            active={media.screenOn}
            disabled={disabled || busy !== null}
            onClick={run("screen", onToggleScreen)}
            on={{ icon: MonitorUp, label: "Stop sharing screen" }}
            off={{ icon: MonitorOff, label: "Share your screen" }}
          />
          <div className="mx-1 h-8 w-px bg-border" />
          <Control
            active={!muted}
            disabled={!media.remoteAudioLive}
            onClick={async () => setMuted((value) => !value)}
            on={{ icon: Volume2, label: "Mute incoming audio" }}
            off={{ icon: VolumeX, label: "Unmute incoming audio" }}
          />
        </div>

        <p
          role={deviceError ? "alert" : undefined}
          className={cn(
            "text-center text-xs",
            deviceError ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {deviceError ??
            (media.screenOn && media.cameraOn
              ? "Screen share is being sent; your camera stays in the local preview."
              : "Media flows straight to the other browser and is encrypted by DTLS-SRTP.")}
        </p>
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

/**
 * A `<video>` whose `srcObject` is kept in sync with a MediaStream. Tracks are
 * added and removed on the same stream object, so `version` is what actually
 * signals a change — the stream identity never varies.
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
    // Autoplay can be refused before any user gesture; the controls below are a
    // gesture, so a later toggle recovers it.
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
      // The unlabeled local preview is decorative — its visible caption ("You"
      // / "Your screen") is the accessible text, so don't announce it twice.
      aria-hidden={label ? undefined : true}
      className={cn(className, mirrored && "-scale-x-100")}
    />
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
