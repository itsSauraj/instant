import gsap from "gsap";

/**
 * Shared GSAP vocabulary. Every screen animates with the same easing and
 * durations so the app reads as one surface rather than a pile of components.
 */
export const EASE = {
  out: "power3.out",
  inOut: "power2.inOut",
  pop: "back.out(1.7)",
} as const;

export const DURATION = {
  fast: 0.28,
  base: 0.5,
  slow: 0.8,
} as const;

/** Honour the OS "reduce motion" setting; GSAP has no opinion of its own. */
export function prefersReducedMotion() {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Reveals elements marked `[data-anim="in"]` inside `scope`, in DOM order.
 * They start at `opacity: 0` from CSS, so nothing flashes before GSAP runs.
 */
export function revealIn(scope: Element | null, options?: { stagger?: number; y?: number }) {
  if (!scope) return;
  const targets = scope.querySelectorAll('[data-anim="in"]');
  if (targets.length === 0) return;

  if (prefersReducedMotion()) {
    gsap.set(targets, { opacity: 1, y: 0, clearProps: "transform" });
    return;
  }

  gsap.fromTo(
    targets,
    { opacity: 0, y: options?.y ?? 14 },
    {
      opacity: 1,
      y: 0,
      duration: DURATION.base,
      ease: EASE.out,
      stagger: options?.stagger ?? 0.07,
      clearProps: "transform",
    },
  );
}

/** A short attention pulse - used when a note or file arrives. */
export function pulse(target: Element | null) {
  if (!target || prefersReducedMotion()) return;
  gsap.fromTo(
    target,
    { scale: 0.96, opacity: 0 },
    { scale: 1, opacity: 1, duration: DURATION.fast, ease: EASE.pop, clearProps: "transform" },
  );
}

export { gsap };
