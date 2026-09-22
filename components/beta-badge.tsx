import { cn } from "@/lib/utils";

/**
 * The "Beta" pill for a feature that works end to end but is still being
 * tuned. One component so every surface that flags a feature this way looks
 * the same, and so removing the flag later is one search.
 */
export function BetaBadge({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="beta-badge"
      className={cn(
        "border-primary/25 bg-primary/10 text-primary inline-flex items-center rounded-full border px-2 py-0.5 text-[0.65rem] font-semibold tracking-wide uppercase",
        className,
      )}
      {...props}
    >
      Beta
    </span>
  );
}
