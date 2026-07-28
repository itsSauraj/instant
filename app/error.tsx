"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, Home, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Route-level error boundary. Catches render-time exceptions anywhere below
 * the root layout so a crash shows a recoverable screen instead of blanking
 * the page. Deliberately no GSAP here — a boundary must render even when an
 * animation module is what threw.
 */
export default function RouteError({
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
    <div className="grid min-h-dvh place-items-center p-5">
      <div role="alert" aria-labelledby="route-error-title" className="panel w-full max-w-md p-6 text-center sm:p-7">
        <span className="bg-destructive/12 ring-destructive/25 mx-auto grid size-14 place-items-center rounded-full ring-1">
          <AlertTriangle className="text-destructive size-6" />
        </span>

        <h1 id="route-error-title" className="mt-5 text-lg font-semibold">
          Something went wrong
        </h1>
        <p className="text-muted-foreground mt-1.5 text-sm text-pretty">
          The page hit an unexpected error and could not be displayed. You can try again, or go back
          to the home page.
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
            <Link href="/">
              <Home className="size-4" />
              Back home
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
