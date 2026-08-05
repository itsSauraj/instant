import type { LucideIcon } from "lucide-react";

import { Reveal } from "@/components/guide/reveal";

/**
 * One numbered, anchor-addressable section of the guide. Server-rendered;
 * only the entrance animation crosses into the client (via Reveal).
 *
 * `scroll-mt-24` keeps the heading clear of the floating island nav when a
 * table-of-contents link jumps here.
 */
export function GuideSection({
  id,
  step,
  icon: Icon,
  title,
  lead,
  children,
}: {
  /** The anchor the table of contents points at. */
  id: string;
  /** 1-based position, rendered as the step number. */
  step: number;
  icon: LucideIcon;
  title: string;
  /** One-line summary under the heading. */
  lead?: string;
  children: React.ReactNode;
}) {
  return (
    <Reveal as="section" id={id} className="panel scroll-mt-24 p-5 sm:p-6">
      <header data-anim="in" className="flex items-start gap-3">
        <span
          aria-hidden
          className="bg-primary/15 ring-primary/30 text-primary grid size-9 shrink-0 place-items-center rounded-lg ring-1"
        >
          <Icon className="size-4.5" />
        </span>
        <div className="min-w-0">
          <p className="text-primary font-mono text-[0.7rem] font-medium tracking-widest uppercase">
            {String(step).padStart(2, "0")}
          </p>
          <h2 className="text-base font-semibold sm:text-lg">{title}</h2>
          {lead ? <p className="text-muted-foreground mt-0.5 text-sm">{lead}</p> : null}
        </div>
      </header>

      <div
        data-anim="in"
        className="text-muted-foreground mt-4 space-y-3 text-sm leading-relaxed [&_li]:ml-4 [&_li]:list-disc [&_strong]:text-foreground"
      >
        {children}
      </div>
    </Reveal>
  );
}

/** Ordered steps inside a section: number bubbles instead of list dots. */
export function StepList({ items }: { items: React.ReactNode[] }) {
  return (
    <ol className="space-y-2">
      {items.map((item, index) => (
        <li key={index} className="flex items-start gap-2.5 !list-none !ml-0">
          <span
            aria-hidden
            className="bg-secondary text-secondary-foreground mt-0.5 grid size-5 shrink-0 place-items-center rounded-full font-mono text-[0.65rem] font-semibold"
          >
            {index + 1}
          </span>
          <span className="min-w-0">{item}</span>
        </li>
      ))}
    </ol>
  );
}

/** A labelled fact row, for tier tables and control lists. */
export function FactRow({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="bg-background/50 flex items-start gap-2.5 rounded-lg border p-3 !list-none !ml-0">
      <Icon aria-hidden className="text-primary mt-0.5 size-4 shrink-0" />
      <span className="min-w-0">
        <strong className="block text-sm font-medium">{title}</strong>
        <span className="text-muted-foreground mt-0.5 block text-sm">{children}</span>
      </span>
    </li>
  );
}
