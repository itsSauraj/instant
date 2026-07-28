"use client";

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";

import { pulse } from "@/lib/animation";
import { cn } from "@/lib/utils";

/** CSS display size; the canvas renders at 2x so it stays crisp on hidpi. */
const QR_SIZE = 168;

type QrState = "pending" | "ready" | "failed";

/**
 * Renders the invite URL as a QR code so a phone can scan it instead of
 * typing a 16-character code.
 *
 * Purely presentational: it knows nothing about the session store, and the
 * code is generated entirely in this browser — the URL is the session
 * credential, so it must never be sent to a QR image service.
 */
export function QrInvite({
  url,
  className,
  showUrl = true,
}: {
  url: string;
  className?: string;
  /** Hide the printed URL where the caller already shows it (e.g. the lobby). */
  showUrl?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<QrState>("pending");

  // Deliberately no `data-anim="in"` markers and no `revealIn` of its own. The
  // lobby already animates the block this sits in, so marking these too made
  // the code fade in twice; and since the global CSS hides `[data-anim="in"]`
  // until GSAP reveals it, marking them without animating here would leave the
  // code invisible wherever it is mounted standalone. `pulse` is enough.

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;

    QRCode.toCanvas(canvas, url, {
      errorCorrectionLevel: "M",
      margin: 2, // quiet zone, part of the spec — scanners rely on it
      width: QR_SIZE * 2,
      // Fixed dark-on-white, independent of the app theme (see backing note).
      color: { dark: "#111318", light: "#ffffff" },
    })
      .then(() => {
        if (cancelled) return;
        // The library sets inline width/height to the raw pixel size; pin the
        // display size back down so the 2x render just adds density.
        canvas.style.width = `${QR_SIZE}px`;
        canvas.style.height = `${QR_SIZE}px`;
        setState("ready");
        pulse(canvas); // respects prefers-reduced-motion internally
      })
      .catch(() => {
        if (!cancelled) setState("failed");
      });

    return () => {
      cancelled = true;
    };
    // Regenerating draws over the previous code in place, so a URL change
    // never flashes an empty square.
  }, [url]);

  return (
    <div className={cn("flex flex-col items-center gap-2", className)}>
      {/*
        The backing is hardcoded white rather than a theme variable: a QR needs
        dark modules on a light ground with a light quiet zone to scan
        reliably, and in dark mode a transparent canvas would sit on a near-
        black panel and become unreadable. The canvas paints its own white
        quiet zone too, so this survives any future theme.

        A canvas is opaque to screen readers, hence role="img" + aria-label
        on the wrapper and aria-hidden on the canvas itself.
      */}
      <div
        role="img"
        aria-label={`QR code for the invite link ${url}`}
        className="grid place-items-center rounded-lg border bg-white p-2 shadow-xs"
        style={{ minWidth: QR_SIZE + 16, minHeight: QR_SIZE + 16 }}
      >
        <canvas
          ref={canvasRef}
          aria-hidden
          width={QR_SIZE}
          height={QR_SIZE}
          className={cn(state === "failed" && "hidden")}
          style={{ width: QR_SIZE, height: QR_SIZE }}
        />
        {state === "failed" ? (
          // Generation failed (out of memory, bizarre URL...): degrade to the
          // URL as selectable text — never a silent blank square.
          <span
            className="p-1 text-center font-mono text-[0.65rem] break-all text-neutral-900 select-all"
            style={{ maxWidth: QR_SIZE }}
          >
            {url}
          </span>
        ) : null}
      </div>

      {/* Visible fallback so the invite works without a camera. */}
      {showUrl ? (
        <p className="text-muted-foreground max-w-full text-center font-mono text-xs break-all select-all">
          {url}
        </p>
      ) : null}
    </div>
  );
}
