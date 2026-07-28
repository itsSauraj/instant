"use client";

import { Loader2, ShieldCheck, ShieldX, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { SessionPhase } from "@/lib/peer-session";

const PRESENTATION: Record<
  SessionPhase,
  { label: string; variant: "success" | "warning" | "muted" | "destructive"; spin?: boolean }
> = {
  idle: { label: "Starting", variant: "muted", spin: true },
  joining: { label: "Joining", variant: "muted", spin: true },
  waiting: { label: "Waiting for peer", variant: "warning" },
  connecting: { label: "Connecting", variant: "warning", spin: true },
  connected: { label: "Peer connected", variant: "success" },
  ended: { label: "Session ended", variant: "destructive" },
};

export function ConnectionStatus({ phase }: { phase: SessionPhase }) {
  const { label, variant, spin } = PRESENTATION[phase];

  const Icon =
    phase === "connected"
      ? ShieldCheck
      : phase === "ended"
        ? ShieldX
        : phase === "waiting"
          ? Users
          : Loader2;

  return (
    <Badge variant={variant} className="gap-1.5 py-1" aria-live="polite">
      <Icon className={spin ? "animate-spin" : undefined} />
      {label}
    </Badge>
  );
}
