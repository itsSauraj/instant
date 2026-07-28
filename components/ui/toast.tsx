"use client";

import { useRef } from "react";
import { useGSAP } from "@gsap/react";
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { dismissToast, useToasts, type Toast, type ToastVariant } from "@/hooks/use-toasts";
import { DURATION, EASE, gsap, prefersReducedMotion } from "@/lib/animation";
import { cn } from "@/lib/utils";

const VARIANT: Record<
  ToastVariant,
  { icon: typeof Info; role: "status" | "alert"; iconClass: string }
> = {
  info: { icon: Info, role: "status", iconClass: "text-primary" },
  success: { icon: CheckCircle2, role: "status", iconClass: "text-success" },
  warning: { icon: AlertTriangle, role: "status", iconClass: "text-warning" },
  // Errors are announced immediately (role="alert" implies assertive).
  error: { icon: AlertCircle, role: "alert", iconClass: "text-destructive" },
};

/**
 * Fixed stack for in-app notifications. Mount it exactly once, in the room
 * shell.
 *
 * Placement: top-right, below the header. On phones the tab bar spans the
 * full width directly under the header and the composer/media controls own
 * the bottom edge, so the stack drops just below the tab bar; on sm+ the tab
 * bar shrinks to the left, freeing the area right under the header.
 */
export function ToastViewport() {
  const toasts = useToasts();

  return (
    <div
      data-slot="toast-viewport"
      role="region"
      aria-label="Notifications"
      aria-live="polite"
      className={cn(
        "pointer-events-none fixed z-40 flex w-[min(20rem,calc(100vw-1.5rem))] flex-col gap-2",
        "top-[6.75rem] right-3 sm:top-[4.25rem] sm:right-5",
      )}
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  const ref = useRef<HTMLDivElement>(null);
  const { icon: Icon, role, iconClass } = VARIANT[toast.variant];

  // Entrance. data-anim="in" keeps the element at opacity 0 until GSAP runs,
  // so nothing flashes before the tween starts (same trick as the overlays).
  useGSAP(
    () => {
      if (!ref.current) return;
      if (prefersReducedMotion()) return; // the CSS media query pins opacity to 1
      gsap.fromTo(
        ref.current,
        { opacity: 0, y: -10, scale: 0.97 },
        { opacity: 1, y: 0, scale: 1, duration: DURATION.fast, ease: EASE.pop, clearProps: "transform" },
      );
    },
    { scope: ref },
  );

  // Exit: the store flags `leaving` and removes the toast shortly after, so
  // this tween only has to look right — removal never waits on it.
  useGSAP(
    () => {
      if (!toast.leaving || !ref.current || prefersReducedMotion()) return;
      gsap.to(ref.current, { opacity: 0, y: -8, scale: 0.97, duration: 0.2, ease: EASE.inOut });
    },
    { dependencies: [toast.leaving], scope: ref },
  );

  return (
    <div
      ref={ref}
      data-slot="toast"
      data-anim="in"
      role={role}
      className="panel pointer-events-auto flex items-start gap-2.5 p-3 shadow-md"
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", iconClass)} />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-tight font-medium">{toast.title}</p>
        {toast.description ? (
          <p className="text-muted-foreground mt-0.5 text-xs text-pretty">{toast.description}</p>
        ) : null}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="-mt-1 -mr-1 size-6"
        onClick={() => dismissToast(toast.id)}
        aria-label="Dismiss notification"
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
