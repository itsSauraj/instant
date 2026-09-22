"use client";

import { useRef } from "react";
import Link from "next/link";
import { useGSAP } from "@gsap/react";
import {
  ArrowRight,
  BookOpen,
  Crown,
  FileDown,
  FileText,
  HardDriveDownload,
  MonitorUp,
  QrCode,
  RefreshCw,
  ShieldCheck,
  UserCheck,
  type LucideIcon,
} from "lucide-react";

import { BetaBadge } from "@/components/beta-badge";
import { revealIn } from "@/lib/animation";
import { cn } from "@/lib/utils";

/**
 * The real feature set, one line each. The hero shows what a session looks
 * like; this section answers "but what can it actually do" without sending
 * anyone to the docs - though the guide link at the end is there for whoever
 * wants the long version.
 */
type Feature = {
  icon: LucideIcon;
  title: string;
  description: string;
  /** Works end to end but is still being tuned; shown with a Beta pill. */
  beta?: boolean;
};

const FEATURES: Feature[] = [
  {
    icon: UserCheck,
    title: "Private by default, public on demand",
    description: "In a private session nobody enters without being let in by name. Flip it to public and anyone with the link walks in.",
  },
  {
    icon: ShieldCheck,
    title: "Emoji-verified encryption",
    description: "Compare ten emojis out loud to confirm the end-to-end encryption. If they match, nobody is in the middle.",
  },
  {
    icon: MonitorUp,
    title: "Up to 7 in a mesh call",
    description: "Camera, microphone and screen share, with every browser connected directly to every other. Still being tuned.",
    beta: true,
  },
  {
    icon: RefreshCw,
    title: "Survives a refresh",
    description: "A reload reclaims your seat automatically - no re-approval, no interruption for anyone else.",
  },
  {
    icon: FileDown,
    title: "Resumable transfers",
    description: "An interrupted file transfer continues from the last confirmed byte instead of starting over.",
  },
  {
    icon: QrCode,
    title: "Short codes, QR invite and scan",
    description: "An eight-character code, or one you choose by typing it after /room/. QR codes are generated and decoded in the browser.",
  },
  {
    icon: FileText,
    title: "Markdown notes and a shared doc",
    description: "Chat in Markdown, and write in one live document everybody edits together.",
  },
  {
    icon: Crown,
    title: "Host controls",
    description: "Mute and camera moderation, pinning, and handing the room to a new host mid-session.",
  },
];

export function FeatureGrid({ className }: { className?: string }) {
  const scope = useRef<HTMLElement>(null);

  // Same entrance idiom as the hero: children marked data-anim="in" start
  // hidden via CSS and are revealed in DOM order (or shown immediately under
  // reduced motion - revealIn handles that).
  useGSAP(
    () => {
      revealIn(scope.current, { stagger: 0.05, y: 16 });
    },
    { scope },
  );

  return (
    <section
      ref={scope}
      data-feature-grid
      aria-labelledby="feature-grid-heading"
      className={cn("mt-16", className)}
    >
      <div data-anim="in" className="mx-auto max-w-xl text-center">
        <h2 id="feature-grid-heading" className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Everything a session can do
        </h2>
        <p className="text-muted-foreground mt-2 text-sm sm:text-base">
          All of it happens between browsers. The server introduces people, then steps out.
        </p>
      </div>

      <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {/* The direct-save card gets double width and an accent border: it is
            the feature desktop users care about most and the easiest to miss. */}
        <div
          data-anim="in"
          data-feature-save
          className="panel border-primary/40 p-5 sm:col-span-2"
        >
          <div className="flex items-center justify-between gap-3">
            <HardDriveDownload className="text-primary size-5" />
            <span className="border-primary/25 bg-primary/10 text-primary rounded-full border px-2.5 py-0.5 text-[11px] font-medium">
              Desktop Chrome and Edge
            </span>
          </div>
          <h3 className="mt-3 text-sm font-semibold">Saves straight to your device</h3>
          <p className="text-muted-foreground mt-1 text-sm">
            Pick a folder once and received files stream directly into it as the bytes
            arrive - nothing is buffered in browser memory, so size stops mattering.
            Everywhere else, files simply land in your normal downloads.
          </p>
        </div>

        {FEATURES.map(({ icon: Icon, title, description, beta }) => (
          <div key={title} data-anim="in" className="panel p-5">
            <div className="flex items-center justify-between gap-3">
              <Icon className="text-primary size-5" />
              {beta ? <BetaBadge /> : null}
            </div>
            <h3 className="mt-3 text-sm font-semibold">{title}</h3>
            <p className="text-muted-foreground mt-1 text-sm">{description}</p>
          </div>
        ))}

        {/* Sized to complete the grid row; styled as the section's one action. */}
        <Link
          href="/guide"
          data-anim="in"
          className="panel hover:border-primary/40 group flex items-center gap-4 p-5 transition-colors sm:col-span-2"
        >
          <BookOpen className="text-primary size-5 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">Read the guide</span>
            <span className="text-muted-foreground mt-1 block text-sm">
              How sessions, approval, encryption and transfers actually work.
            </span>
          </span>
          <ArrowRight className="text-muted-foreground group-hover:text-primary size-4 shrink-0 transition-colors" />
        </Link>
      </div>
    </section>
  );
}
