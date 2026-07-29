"use client";

import { Shield } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * The room's verification meter: a shield that fills bottom-to-top with the
 * share of connected peers whose encryption this user has emoji-verified.
 * Clicking it opens the participants panel, where verification happens.
 */
export function VerifiedShield({
  percent,
  connectedPeers,
  onClick,
  className,
}: {
  /** 0-100: verified / connected peers. */
  percent: number;
  connectedPeers: number;
  onClick?: () => void;
  className?: string;
}) {
  const full = percent >= 100 && connectedPeers > 0;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={`Encryption verification: ${percent}% of connected peers verified`}
          className={cn(
            "focus-visible:ring-ring/50 relative grid size-8 place-items-center rounded-lg",
            "hover:bg-accent outline-none focus-visible:ring-[3px]",
            className,
          )}
        >
          <span className="relative inline-flex size-4.5">
            <Shield className="text-muted-foreground/50 absolute inset-0 size-full" />
            {/* The fill: a second, solid shield clipped from the bottom up. */}
            <span
              aria-hidden
              className="absolute inset-x-0 bottom-0 overflow-hidden"
              style={{ height: `${Math.max(0, Math.min(100, percent))}%` }}
            >
              <Shield
                className={cn(
                  "absolute bottom-0 left-0 size-4.5",
                  full ? "fill-success text-success" : "fill-warning text-warning",
                )}
              />
            </span>
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {connectedPeers === 0
          ? "Nobody connected yet · verification lives in the participants list"
          : `${percent}% verified · click to verify people`}
      </TooltipContent>
    </Tooltip>
  );
}
