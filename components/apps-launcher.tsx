"use client";

import { useEffect, useRef, useState } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import {
  BarChart3,
  Code,
  FileText,
  Files,
  Globe,
  Image as ImageIcon,
  LayoutGrid,
  MessageSquare,
  Music,
  Sparkles,
  Terminal,
  Video,
  type LucideIcon,
} from "lucide-react";

import { useAppsList } from "@/hooks/use-apps-list";
import type { AppAccent, AppEntry, AppIconName } from "@/lib/apps-registry";
import { cn } from "@/lib/utils";

/**
 * The apps grid: one trigger, one panel, listing links served by a remote
 * registry you deploy centrally.
 *
 * Markup lives here rather than being fetched, so no remote code runs in a page
 * that holds a session credential in its URL. The remote still shapes the
 * result - order, grouping, accent, badge - but only by choosing from the
 * palettes below, so it can never inject CSS or script.
 *
 * Placement and size are the call-site's business: every visual axis is a
 * variant, and `className` merges last so a consumer always wins.
 */

/** Remote icon NAMES map to local components. Nothing remote is ever rendered. */
const ICONS: Record<AppIconName, LucideIcon> = {
  grid: LayoutGrid,
  video: Video,
  notes: FileText,
  files: Files,
  chat: MessageSquare,
  code: Code,
  globe: Globe,
  sparkles: Sparkles,
  terminal: Terminal,
  image: ImageIcon,
  music: Music,
  chart: BarChart3,
};

const ACCENT_CLASS: Record<AppAccent, string> = {
  primary: "text-primary",
  success: "text-success",
  warning: "text-warning",
  neutral: "text-muted-foreground",
};

const BADGE_LABEL = { new: "New", beta: "Beta", soon: "Soon" } as const;

const triggerVariants = cva(
  // Pill language, matching components/ui/button.tsx rather than the panel radius.
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-full font-medium whitespace-nowrap transition-all outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none",
  {
    variants: {
      variant: {
        icon: "hover:bg-accent hover:text-accent-foreground text-muted-foreground",
        pill: "border bg-background/60 shadow-xs hover:bg-accent hover:text-accent-foreground",
        ghost: "hover:bg-accent hover:text-accent-foreground text-muted-foreground",
        inline: "text-muted-foreground hover:text-foreground underline-offset-4 hover:underline",
      },
      size: {
        sm: "text-xs",
        default: "text-sm",
        lg: "text-base",
      },
    },
    compoundVariants: [
      // Icon-only triggers are square; the rest get horizontal padding.
      { variant: "icon", size: "sm", class: "size-8 [&_svg]:size-4" },
      { variant: "icon", size: "default", class: "size-9 [&_svg]:size-4" },
      { variant: "icon", size: "lg", class: "size-11 [&_svg]:size-5" },
      { variant: "ghost", size: "sm", class: "size-8 [&_svg]:size-4" },
      { variant: "ghost", size: "default", class: "size-9 [&_svg]:size-4" },
      { variant: "ghost", size: "lg", class: "size-11 [&_svg]:size-5" },
      { variant: "pill", size: "sm", class: "h-8 px-3 [&_svg]:size-4" },
      { variant: "pill", size: "default", class: "h-9 px-4 [&_svg]:size-4" },
      { variant: "pill", size: "lg", class: "h-11 px-6 [&_svg]:size-5" },
      { variant: "inline", size: "sm", class: "[&_svg]:size-3.5" },
      { variant: "inline", size: "default", class: "[&_svg]:size-4" },
      { variant: "inline", size: "lg", class: "[&_svg]:size-4" },
    ],
    defaultVariants: { variant: "icon", size: "default" },
  },
);

const panelVariants = cva(
  // `panel` is the app's glass surface, so the launcher matches every dialog.
  "panel absolute z-50 overflow-hidden p-2 shadow-lg",
  {
    variants: {
      placement: {
        bottom: "top-[calc(100%+0.5rem)]",
        top: "bottom-[calc(100%+0.5rem)]",
        left: "right-[calc(100%+0.5rem)] top-0",
        right: "left-[calc(100%+0.5rem)] top-0",
      },
      align: {
        start: "left-0",
        center: "left-1/2 -translate-x-1/2",
        end: "right-0",
      },
      layout: {
        list: "w-64",
        grid: "w-72",
      },
    },
    compoundVariants: [
      // Side placements are already horizontally positioned; the align axis
      // would fight them, so it is neutralised there.
      { placement: "left", align: ["start", "center", "end"], class: "left-auto translate-x-0" },
      { placement: "right", align: ["start", "center", "end"], class: "right-auto translate-x-0" },
    ],
    defaultVariants: { placement: "bottom", align: "end", layout: "grid" },
  },
);

export type AppsLauncherProps = {
  /** Trigger label. Omitted for icon-only; the aria-label is always set. */
  label?: string;
  /** Hide entries a given page should not offer. */
  filter?: (app: AppEntry) => boolean;
  className?: string;
  panelClassName?: string;
} & VariantProps<typeof triggerVariants> &
  VariantProps<typeof panelVariants>;

export function AppsLauncher({
  variant,
  size,
  placement,
  align,
  layout,
  label,
  filter,
  className,
  panelClassName,
}: AppsLauncherProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Fetch only once opened: a visitor who never touches the launcher - most of
  // them, and everyone mid-call - causes no request at all.
  const { apps } = useAppsList(open);
  const visible = filter ? apps.filter(filter) : apps;

  useEffect(() => {
    if (!open) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    // `pointerdown` rather than `click`: closing on mousedown feels immediate
    // and avoids swallowing the click that follows.
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  const grouped = new Map<string, AppEntry[]>();
  for (const app of visible) {
    const key = app.group ?? "";
    grouped.set(key, [...(grouped.get(key) ?? []), app]);
  }

  return (
    <div ref={rootRef} data-slot="apps-launcher" className="relative inline-flex">
      <button
        type="button"
        aria-label="Apps"
        aria-expanded={open}
        aria-haspopup="menu"
        data-slot="apps-launcher-trigger"
        onClick={() => setOpen((value) => !value)}
        className={cn(triggerVariants({ variant, size }), className)}
      >
        <LayoutGrid />
        {label ? <span>{label}</span> : null}
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Apps"
          data-slot="apps-launcher-panel"
          className={cn(panelVariants({ placement, align, layout }), panelClassName)}
        >
          {visible.length === 0 ? (
            <p className="text-muted-foreground px-2 py-3 text-center text-xs">
              No apps to show yet.
            </p>
          ) : (
            [...grouped.entries()].map(([group, entries]) => (
              <div key={group || "ungrouped"}>
                {group ? (
                  <p className="text-muted-foreground px-2 pt-1.5 pb-1 text-[0.7rem] font-medium">
                    {group}
                  </p>
                ) : null}
                <div className={cn(layout === "list" ? "space-y-0.5" : "grid grid-cols-3 gap-1")}>
                  {entries.map((app) => (
                    <AppLink key={app.id} app={app} layout={layout ?? "grid"} />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function AppLink({ app, layout }: { app: AppEntry; layout: "list" | "grid" }) {
  const Icon = ICONS[app.icon];

  return (
    <a
      role="menuitem"
      href={app.url}
      target="_blank"
      // noreferrer keeps the room URL out of the destination's logs even if the
      // global Referrer-Policy is ever relaxed; noopener denies it a handle back
      // into a tab that may be holding a live session.
      rel="noopener noreferrer"
      data-slot="apps-launcher-item"
      title={app.description ?? app.name}
      className={cn(
        "hover:bg-accent focus-visible:ring-ring/50 group flex rounded-lg outline-none focus-visible:ring-[3px]",
        layout === "list"
          ? "items-center gap-2.5 px-2 py-1.5"
          : "flex-col items-center gap-1 px-1 py-2 text-center",
      )}
    >
      <Icon className={cn("shrink-0", ACCENT_CLASS[app.accent], layout === "grid" && "size-5")} />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate font-medium",
            layout === "list" ? "text-sm" : "text-[0.7rem]",
          )}
        >
          {app.name}
        </span>
        {layout === "list" && app.description ? (
          <span className="text-muted-foreground block truncate text-xs">{app.description}</span>
        ) : null}
      </span>
      {app.badge ? (
        <span className="bg-primary/15 text-primary shrink-0 rounded-full px-1.5 py-0.5 text-[0.6rem] font-semibold">
          {BADGE_LABEL[app.badge]}
        </span>
      ) : null}
    </a>
  );
}
