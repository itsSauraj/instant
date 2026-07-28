import Link from "next/link";

import { cn } from "@/lib/utils";

export function Brand({ className, href = "/" }: { className?: string; href?: string }) {
  return (
    <Link
      href={href}
      className={cn(
        "group inline-flex items-center gap-2.5 rounded-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        className,
      )}
    >
      <span className="relative grid size-8 place-items-center rounded-lg bg-primary/15 ring-1 ring-primary/30">
        <span className="size-2 rounded-full bg-primary shadow-[0_0_12px_2px_var(--primary)]" />
        <span className="absolute inset-0 rounded-lg ring-1 ring-inset ring-primary/20 transition-transform group-hover:scale-105" />
      </span>
      <span className="text-[0.95rem] font-semibold tracking-tight">Instant</span>
    </Link>
  );
}
