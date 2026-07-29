"use client";

import { Loader2, ShieldCheck, ShieldX, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { MeshPhase } from "@/lib/mesh-session";

const PRESENTATION: Record<
  MeshPhase,
  { label: string; variant: "success" | "warning" | "muted" | "destructive"; spin?: boolean }
> = {
  joining: { label: "Joining", variant: "muted", spin: true },
  "waiting-approval": { label: "Waiting to be let in", variant: "warning", spin: true },
  lobby: { label: "Waiting for others", variant: "warning" },
  connected: { label: "Connected", variant: "success" },
  ended: { label: "Session ended", variant: "destructive" },
};

export function ConnectionStatus({ phase, peers }: { phase: MeshPhase; peers?: number }) {
  const { label, variant, spin } = PRESENTATION[phase];

  const Icon =
    phase === "connected"
      ? ShieldCheck
      : phase === "ended"
        ? ShieldX
        : phase === "lobby"
          ? Users
          : Loader2;

  // With a mesh the headcount is the useful detail, so surface it once there is
  // more than one other person to distinguish from a plain pair.
  const detail = phase === "connected" && typeof peers === "number" && peers > 1 ? ` (${peers})` : "";

  return (
    <Badge variant={variant} className="gap-1.5 py-1" aria-live="polite">
      <Icon className={spin ? "animate-spin" : undefined} />
      {label}
      {detail}
    </Badge>
  );
}
