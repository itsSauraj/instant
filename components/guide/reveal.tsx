"use client";

import { useRef } from "react";
import { useGSAP } from "@gsap/react";

import { prefersReducedMotion, revealIn } from "@/lib/animation";

/**
 * The guide's only client boundary: a wrapper that runs `revealIn` over its
 * `[data-anim="in"]` children when the block scrolls into view. The content
 * itself stays server-rendered; this component receives it as children and
 * never re-renders it.
 *
 * Reduced motion is honoured twice over: the global CSS forces the marked
 * elements visible under `prefers-reduced-motion`, and `revealIn` itself
 * degrades to a plain `set` - so the observer is skipped entirely and nothing
 * ever moves.
 */
export function Reveal({
  id,
  as: Tag = "div",
  className,
  children,
}: {
  /** Anchor id when rendering a section the table of contents points at. */
  id?: string;
  as?: "div" | "section";
  className?: string;
  children: React.ReactNode;
}) {
  const scope = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const el = scope.current;
      if (!el) return;

      if (prefersReducedMotion()) {
        revealIn(el);
        return;
      }

      // Already on screen (top of the page, deep-linked anchor): reveal now.
      // Otherwise wait until the reader actually reaches the block.
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            revealIn(el, { y: 12, stagger: 0.06 });
            observer.disconnect();
          }
        },
        { rootMargin: "0px 0px -8% 0px", threshold: 0.05 },
      );
      observer.observe(el);
      return () => observer.disconnect();
    },
    { scope },
  );

  return (
    <Tag ref={scope as React.RefObject<HTMLDivElement>} id={id} className={className}>
      {children}
    </Tag>
  );
}
