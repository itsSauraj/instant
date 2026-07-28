"use client";

import { useEffect } from "react";
import { AlertTriangle, Home, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import "./globals.css";

const THEME_BOOTSTRAP = `
try {
  var stored = localStorage.getItem('instant-theme');
  var dark = stored ? stored === 'dark' : !window.matchMedia('(prefers-color-scheme: light)').matches;
  if (dark) document.documentElement.classList.add('dark');
} catch (e) {
  document.documentElement.classList.add('dark');
}
`;

/**
 * Last-resort boundary. This REPLACES the root layout, so it must render its
 * own <html> and <body>, import the stylesheet itself, and cannot rely on the
 * layout's fonts or providers (font-sans falls back to the system stack).
 * Plain <a> instead of next/link and no GSAP: assume as little as possible
 * still works.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="min-h-dvh font-sans">
        <div className="grid min-h-dvh place-items-center p-5">
          <div
            role="alert"
            aria-labelledby="global-error-title"
            className="panel w-full max-w-md p-6 text-center sm:p-7"
          >
            <span className="bg-destructive/12 ring-destructive/25 mx-auto grid size-14 place-items-center rounded-full ring-1">
              <AlertTriangle className="text-destructive size-6" />
            </span>

            <h1 id="global-error-title" className="mt-5 text-lg font-semibold">
              Something went badly wrong
            </h1>
            <p className="text-muted-foreground mt-1.5 text-sm text-pretty">
              The application hit an error it could not recover from. Any live session on this page
              has been lost. Try reloading, or start over from the home page.
            </p>

            <p className="bg-muted/60 text-muted-foreground mt-4 rounded-lg border px-3 py-2 text-left font-mono text-xs">
              {error.message || "Unknown error"}
              {error.digest ? ` (digest: ${error.digest})` : null}
            </p>

            <div className="mt-6 flex flex-col gap-2 sm:flex-row">
              <Button className="flex-1 gap-2" onClick={reset}>
                <RotateCcw className="size-4" />
                Try again
              </Button>
              <Button asChild variant="outline" className="flex-1 gap-2">
                <a href="/">
                  <Home className="size-4" />
                  Back home
                </a>
              </Button>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
