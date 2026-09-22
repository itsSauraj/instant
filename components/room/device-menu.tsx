"use client";

import { Fragment } from "react";
import { ChevronUp } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { MediaDevices } from "@/hooks/use-media-devices";
import { DEVICE_NOUN, type DeviceKind } from "@/lib/media-devices";

/** Radix radio items need a non-empty value; the system default travels as this. */
const DEFAULT = "__default__";

/**
 * The small arrow beside a call control, the way Meet does it: it opens the
 * device list for that control without toggling it. The microphone's arrow
 * offers the speaker too, since "I cannot hear / they cannot hear me" is one
 * problem to the person having it.
 *
 * The list itself is the app's dropdown menu, rendered in a portal above the
 * floating pill; the choice is applied by the caller (`onChoose`), which is
 * what lets a failed device switch be reported next to the controls.
 */
export function DeviceMenu({
  devices,
  kinds,
  label,
  disabled = false,
  onChoose,
}: {
  devices: MediaDevices;
  /** Which lists to show, in order. */
  kinds: readonly DeviceKind[];
  /** Accessible name for the arrow. */
  label: string;
  disabled?: boolean;
  onChoose: (kind: DeviceKind, deviceId: string | null) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          size="icon"
          aria-label={label}
          disabled={disabled}
          data-slot="device-menu-trigger"
          className="size-7 rounded-full [&_svg]:size-3.5"
        >
          <ChevronUp />
        </Button>
      </DropdownMenuTrigger>
      {/* The pill sits at the bottom of the panel, so the list opens upward. */}
      <DropdownMenuContent side="top" align="start" className="min-w-64" data-slot="device-menu">
        {kinds.map((kind, index) => (
          <Fragment key={kind}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel>{DEVICE_NOUN[kind]}</DropdownMenuLabel>
            {kind === "audiooutput" && !devices.canPickOutput ? (
              // Honest about the platform: Firefox and Safari give pages no say.
              <DropdownMenuItem disabled>
                This browser always plays through the system speaker
              </DropdownMenuItem>
            ) : (
              <DropdownMenuRadioGroup
                value={devices.choice[kind] ?? DEFAULT}
                onValueChange={(value) => onChoose(kind, value === DEFAULT ? null : value)}
              >
                <DropdownMenuRadioItem value={DEFAULT}>System default</DropdownMenuRadioItem>
                {devices.options[kind].map((option) => (
                  <DropdownMenuRadioItem key={option.deviceId} value={option.deviceId}>
                    {option.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            )}
          </Fragment>
        ))}
        {devices.unlabeled ? (
          <>
            <DropdownMenuSeparator />
            <p className="text-muted-foreground px-2 py-1.5 text-xs">
              Device names appear once a microphone or camera has been allowed.
            </p>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
