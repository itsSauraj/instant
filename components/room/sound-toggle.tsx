"use client";

import { useSyncExternalStore } from "react";
import { Volume2, VolumeX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isMuted, subscribeMuted, toggleMuted } from "@/lib/sound";

// Server render always shows "sound on": the real preference lives in
// localStorage, which useSyncExternalStore re-reads right after hydration.
const getServerMuted = () => false;

/** Mute toggle for the synthesized UI sounds; sits next to ThemeToggle. */
export function SoundToggle() {
  const muted = useSyncExternalStore(subscribeMuted, isMuted, getServerMuted);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => toggleMuted()}
          aria-pressed={muted}
          aria-label={muted ? "Unmute sound effects" : "Mute sound effects"}
        >
          {muted ? <VolumeX /> : <Volume2 />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{muted ? "Unmute sounds" : "Mute sounds"}</TooltipContent>
    </Tooltip>
  );
}
