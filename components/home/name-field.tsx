"use client";

import { UserRound } from "lucide-react";

import { Input } from "@/components/ui/input";
import { setStoredName } from "@/lib/identity";
import { SIGNAL_LIMITS } from "@/lib/signal-protocol";
import { cn } from "@/lib/utils";

/**
 * The "what should people call you" field, shared by the create and join
 * flows. It persists on every keystroke so that *any* way of leaving the home
 * page - the create button, the join form, or a successful QR scan - carries
 * the latest name into the room without the caller having to remember to
 * flush it.
 */
export function NameField({
  value,
  onChange,
  nudge = false,
  id = "display-name",
  className,
  ref,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Shows the "please add a name" hint. Never blocks: the field stays optional. */
  nudge?: boolean;
  id?: string;
  className?: string;
  ref?: React.Ref<HTMLInputElement>;
}) {
  const showNudge = nudge && value.trim() === "";

  return (
    <div className={cn("space-y-1.5", className)}>
      <label
        htmlFor={id}
        className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium"
      >
        <UserRound className="size-3.5" aria-hidden />
        Your name
      </label>
      <Input
        ref={ref}
        id={id}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          // Raw value into storage; the setter sanitizes. Persisting here means
          // a scan-initiated join sees the name without an explicit submit.
          setStoredName(event.target.value);
        }}
        placeholder="Shown to everyone in the session"
        maxLength={SIGNAL_LIMITS.maxNameLength}
        autoComplete="name"
        spellCheck={false}
        aria-describedby={showNudge ? `${id}-nudge` : undefined}
      />
      {showNudge ? (
        // A nudge, not an error: joining nameless is allowed (the server
        // substitutes a placeholder), so this must not read as invalid.
        <p id={`${id}-nudge`} role="status" className="text-warning text-xs">
          Add a name so the others know who's asking to join.
        </p>
      ) : null}
    </div>
  );
}
