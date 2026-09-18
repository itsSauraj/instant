"use client";

import { useEffect } from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The room's one right-hand drawer. Participants, Invite and Settings all
 * render inside it, so there is a single place things "slide in from" and a
 * single idiom for closing them (the X, Escape, or the scrim).
 *
 * It overlays the room rather than pushing it: the video strip and the tabs
 * keep their geometry, which matters mid-call. On a phone it becomes a
 * full-height sheet from the right edge.
 *
 * `modal` decides whether a scrim dims and blocks the room behind it. The
 * drawer sits over the video strip's per-tile controls, and without a scrim a
 * click there lands on the drawer and the buttons underneath merely appear
 * dead; the scrim makes that visible and gives a click-anywhere-to-close.
 * Callers pass `modal={false}` only when the drawer opened on its own (a
 * knock), because dimming someone's whole UI on another person's action is
 * worse than either problem.
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
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
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
          className="fixed inset-0 z-30 bg-black/20 backdrop-blur-[1px]"
        />
      ) : null}
      <aside
        role="dialog"
        aria-modal={modal || undefined}
        aria-label={title}
        data-slot="side-panel"
        className={cn(
          "panel fixed inset-y-0 right-0 z-40 flex w-80 max-w-[85vw] flex-col rounded-none border-l shadow-xl",
          "sm:inset-y-3 sm:right-3 sm:rounded-xl sm:border",
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

/** Scrolling body for drawer content that is just a column of controls. */
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
