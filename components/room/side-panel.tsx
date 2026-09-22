"use client";

import { useEffect } from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The room's one right-hand pane. Participants, Invite and Settings all
 * render inside it, so there is a single place things open and a single idiom
 * for closing them (the X, or the button that opened them).
 *
 * On a wide screen it is a docked column in the tab row, a window beside the
 * notes/files/video content rather than something floating over it: nothing
 * is dimmed or blurred, the room stays fully usable, and the pane simply stays
 * open until it is closed. Below the `lg` breakpoint there is no width to dock
 * into, so it becomes a full-height sheet from the right edge; only there does
 * `modal` add a plain (unblurred) scrim with click-to-close and Escape.
 * Callers pass `modal={false}` when the pane opened on its own (a knock), so
 * another person's action never blocks the phone's whole UI.
 */
export function SidePanel({
  open,
  modal = true,
  title,
  subtitle,
  onClose,
  children,
  className,
}: {
  open: boolean;
  modal?: boolean;
  /** Also the accessible name, so scripts and screen readers can find it. */
  title: string;
  subtitle?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  // Escape closes the sheet, never the docked window: a window that vanished
  // because you pressed Escape in the composer would be a bug, not a feature.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (window.matchMedia(DOCKED_QUERY).matches) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      {modal ? (
        <div
          aria-hidden
          onClick={onClose}
          data-slot="side-panel-scrim"
          className="fixed inset-0 z-30 bg-black/30 lg:hidden"
        />
      ) : null}
      <aside
        role="dialog"
        aria-label={title}
        data-slot="side-panel"
        className={cn(
          // Sheet (narrow): fixed to the right edge, full height.
          "panel fixed inset-y-0 right-0 z-40 flex w-80 max-w-[85vw] flex-col rounded-none border-l shadow-xl",
          "sm:inset-y-3 sm:right-3 sm:rounded-xl sm:border",
          // Docked (wide): an ordinary column in the tab row.
          "lg:static lg:inset-auto lg:z-auto lg:h-full lg:max-w-none lg:shrink-0 lg:rounded-xl lg:border lg:shadow-none",
          className,
        )}
      >
        <header className="flex shrink-0 items-center gap-2 border-b p-3 sm:px-4">
          <h2 className="text-sm font-semibold">{title}</h2>
          {subtitle ? (
            <span className="text-muted-foreground min-w-0 truncate text-xs">{subtitle}</span>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label={`Close ${title.toLowerCase()}`}
            data-slot="side-panel-close"
            className="ml-auto size-7 shrink-0"
          >
            <X className="size-4" />
          </Button>
        </header>
        {children}
      </aside>
    </>
  );
}

/** Tailwind's `lg` breakpoint; at and above it the pane docks. */
const DOCKED_QUERY = "(min-width: 64rem)";

/** Scrolling body for pane content that is just a column of controls. */
export function SidePanelBody({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("scroll-slim min-h-0 flex-1 overflow-y-auto p-3 sm:p-4", className)}>
      {children}
    </div>
  );
}
