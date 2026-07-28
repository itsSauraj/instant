"use client";

import { ShieldCheck, ShieldOff } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Host-only control for delegating the right to end the session. The server
 * enforces the rule; this merely flips the flag and reflects the current
 * state. Rendered only for the host, and only once the pair is connected.
 */
export function HostPanel({
  guestMayEnd,
  onToggle,
}: {
  guestMayEnd: boolean;
  onToggle: (allow: boolean) => void;
}) {
  return (
    <section
      aria-label="Host controls"
      className="panel mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2"
    >
      {guestMayEnd ? (
        <ShieldOff className="text-warning size-4 shrink-0" aria-hidden />
      ) : (
        <ShieldCheck className="text-muted-foreground size-4 shrink-0" aria-hidden />
      )}

      <p className="min-w-0 flex-1 text-sm">
        {guestMayEnd ? "Guest can end session" : "Only you can end this session"}
      </p>

      <Badge variant={guestMayEnd ? "warning" : "muted"}>
        {guestMayEnd ? "Shared" : "Host only"}
      </Badge>

      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-pressed={guestMayEnd}
        aria-label="Allow the guest to end this session"
        onClick={() => onToggle(!guestMayEnd)}
        className="gap-1.5"
      >
        <span
          aria-hidden
          className={cn(
            "size-2 rounded-full transition-colors",
            guestMayEnd ? "bg-success" : "bg-muted-foreground/40",
          )}
        />
        {guestMayEnd ? "Revoke" : "Allow"}
      </Button>
    </section>
  );
}
