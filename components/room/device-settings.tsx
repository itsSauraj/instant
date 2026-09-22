"use client";

import { useState } from "react";
import { Camera, Mic, Volume2, type LucideIcon } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { MediaDevices } from "@/hooks/use-media-devices";
import { DEVICE_KINDS, DEVICE_NOUN, type DeviceKind } from "@/lib/media-devices";

/** Radix Select needs a non-empty value; the system default travels as this. */
const DEFAULT = "__default__";

const ICON: Record<DeviceKind, LucideIcon> = {
  audioinput: Mic,
  videoinput: Camera,
  audiooutput: Volume2,
};

/**
 * The Devices section of the Settings pane, for everyone in the room: the same
 * three choices the call controls' arrows offer, laid out as labelled pickers
 * for people who look for such things in settings. Both surfaces read and
 * write the same remembered choice, so they never disagree.
 */
export function DeviceSettings({
  devices,
  onChoose,
}: {
  devices: MediaDevices;
  /** Applies the choice; rejects when a live capture cannot switch over. */
  onChoose: (kind: DeviceKind, deviceId: string | null) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);

  return (
    <section aria-label="Devices" className="space-y-3">
      <div className="space-y-1">
        <p className="text-sm font-medium">Devices</p>
        <p className="text-muted-foreground text-xs">
          Which microphone and camera to send, and which speaker to listen through. The choice is
          remembered on this device
          {devices.unlabeled ? "; names appear once a microphone or camera has been allowed" : ""}
          .
        </p>
      </div>

      {DEVICE_KINDS.map((kind) => {
        const Icon = ICON[kind];
        const unsupported = kind === "audiooutput" && !devices.canPickOutput;
        const id = `device-${kind}`;
        return (
          <div key={kind} className="space-y-1">
            <label
              htmlFor={id}
              className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium"
            >
              <Icon className="size-3.5" aria-hidden />
              {DEVICE_NOUN[kind]}
            </label>
            <Select
              value={devices.choice[kind] ?? DEFAULT}
              disabled={unsupported}
              onValueChange={(value) => {
                setError(null);
                onChoose(kind, value === DEFAULT ? null : value).catch((cause: unknown) => {
                  const detail = cause instanceof Error && cause.message ? ` ${cause.message}` : "";
                  setError(`Could not switch the ${DEVICE_NOUN[kind].toLowerCase()}.${detail}`);
                });
              }}
            >
              <SelectTrigger id={id} size="sm" aria-label={DEVICE_NOUN[kind]}>
                <SelectValue placeholder="System default" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT}>System default</SelectItem>
                {devices.options[kind].map((option) => (
                  <SelectItem key={option.deviceId} value={option.deviceId}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {unsupported ? (
              <p className="text-muted-foreground text-xs">
                This browser always plays through the system speaker.
              </p>
            ) : null}
          </div>
        );
      })}

      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </section>
  );
}
