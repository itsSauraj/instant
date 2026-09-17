"use client";

import { Globe, Lock } from "lucide-react";

import type { RoomVisibility } from "@/lib/signal-protocol";
import { cn } from "@/lib/utils";

/** One line each, reused wherever the choice is explained. */
export const VISIBILITY_COPY: Record<RoomVisibility, { label: string; summary: string }> = {
  private: {
    label: "Private",
    summary: "People who open the link ask to join, and the host lets each one in by name.",
  },
  public: {
    label: "Public",
    summary: "Anyone who opens the link or types the code walks straight in while a seat is free.",
  },
};

/**
 * Private / Public as a two-way segmented control.
 *
 * A radio group rather than a switch: "public" is not the "on" state of
 * "private", and a switch with an unlabelled off position would make people
 * guess which way is which. Both options are always visible and named.
 *
 * Presentational only. The home page binds it to local state before a room
 * exists; in the room the host binds it to the session, where the server has
 * the final say and the roster echoes the value that actually took effect.
 */
export function VisibilityToggle({
  value,
  onChange,
  disabled = false,
  size = "default",
  className,
  "aria-label": ariaLabel = "Who can join",
}: {
  value: RoomVisibility;
  onChange: (value: RoomVisibility) => void;
  disabled?: boolean;
  size?: "default" | "sm";
  className?: string;
  "aria-label"?: string;
}) {
  const options: { value: RoomVisibility; icon: typeof Lock }[] = [
    { value: "private", icon: Lock },
    { value: "public", icon: Globe },
  ];

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      data-slot="visibility-toggle"
      className={cn(
        "bg-muted/60 inline-flex w-full items-center gap-1 rounded-xl border p-1 backdrop-blur",
        className,
      )}
    >
      {options.map(({ value: option, icon: Icon }) => {
        const selected = option === value;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={selected}
            data-state={selected ? "on" : "off"}
            data-visibility={option}
            disabled={disabled}
            onClick={() => {
              if (!selected) onChange(option);
            }}
            className={cn(
              "inline-flex flex-1 items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition-all outline-none",
              "focus-visible:ring-ring/50 focus-visible:ring-[3px]",
              "disabled:pointer-events-none disabled:opacity-50",
              size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm",
              selected
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className={size === "sm" ? "size-3.5" : "size-4"} aria-hidden />
            {VISIBILITY_COPY[option].label}
          </button>
        );
      })}
    </div>
  );
}

/** The compact chip shown beside the session code in the room header. */
export function VisibilityBadge({
  visibility,
  className,
}: {
  visibility: RoomVisibility;
  className?: string;
}) {
  const Icon = visibility === "public" ? Globe : Lock;
  return (
    <span
      data-slot="visibility-badge"
      data-visibility={visibility}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        visibility === "public"
          ? "border-warning/40 bg-warning/10 text-warning"
          : "border-border bg-muted/60 text-muted-foreground",
        className,
      )}
    >
      <Icon className="size-3" aria-hidden />
      {VISIBILITY_COPY[visibility].label}
    </span>
  );
}
