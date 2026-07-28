"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { gsap, prefersReducedMotion } from "@/lib/animation";
import { cn } from "@/lib/utils";

export function CopyField({
  value,
  label,
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const iconRef = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard blocked (insecure context or denied permission). The value is
      // selectable in the field, so leave it to the user.
      return;
    }
    setCopied(true);
    if (!prefersReducedMotion() && iconRef.current) {
      gsap.fromTo(
        iconRef.current,
        { scale: 0.5, rotate: -20 },
        { scale: 1, rotate: 0, duration: 0.35, ease: "back.out(2)", clearProps: "transform" },
      );
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className={cn("flex items-stretch gap-2", className)}>
      <div className="flex min-w-0 flex-1 items-center rounded-lg border bg-background/50 px-3 shadow-xs">
        <span className="truncate font-mono text-sm" title={value}>
          {value}
        </span>
      </div>
      <Button variant="outline" onClick={copy} aria-label={label ?? "Copy"} className="gap-2">
        <span ref={iconRef} className="grid place-items-center">
          {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
        </span>
        <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
      </Button>
    </div>
  );
}
