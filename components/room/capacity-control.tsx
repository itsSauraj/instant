"use client";

import { Minus, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ROOM_CAPACITY } from "@/lib/signal-protocol";
import { cn } from "@/lib/utils";

/**
 * Host-only stepper for the participant limit (ROOM_CAPACITY.min..max).
 *
 * A stepper rather than a slider or free input: the range is seven discrete
 * values and each change is a deliberate act the server must ratify. Lowering
 * the limit below the current headcount is allowed — it ejects nobody, it
 * only stops further joins — and the copy says so the moment that happens.
 */
export function CapacityControl({
  capacity,
  headcount,
  onChange,
  disabled = false,
  className,
}: {
  capacity: number;
  /** How many people are currently seated, to explain a lowered limit. */
  headcount: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  className?: string;
}) {
  const overCapacity = headcount > capacity;

  return (
    <div role="group" aria-label="Participant limit" className={cn("space-y-1", className)}>
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-sm">Participant limit</p>

        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Lower the participant limit"
            disabled={disabled || capacity <= ROOM_CAPACITY.min}
            onClick={() => onChange(capacity - 1)}
            className="size-7"
          >
            <Minus className="size-3.5" />
          </Button>

          {/* Live so a screen-reader host hears the new value on each step. */}
          <span aria-live="polite" className="w-14 text-center text-sm tabular-nums">
            <span className="font-semibold">{capacity}</span>
            <span className="text-muted-foreground"> of {ROOM_CAPACITY.max}</span>
          </span>

          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Raise the participant limit"
            disabled={disabled || capacity >= ROOM_CAPACITY.max}
            onClick={() => onChange(capacity + 1)}
            className="size-7"
          >
            <Plus className="size-3.5" />
          </Button>
        </div>
      </div>

      <p className={cn("text-xs", overCapacity ? "text-warning" : "text-muted-foreground")}>
        {overCapacity
          ? `${headcount} people are already here. Nobody is removed, but no one new can join.`
          : "Lowering the limit never removes anyone; it only blocks new joins."}
      </p>
    </div>
  );
}
