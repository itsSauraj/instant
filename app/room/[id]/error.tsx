"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Home, PlugZap, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Room-level error boundary. If anything inside the session UI throws during
 * render, the live peer session it was managing is torn down with it - so be
 * honest: the connection is gone. "Try again" re-renders the segment, which
 * attempts a fresh join of the same room; it cannot resume the old connection.
 * Deliberately no GSAP - this must render even if an animation module threw.
 */
export default function RoomError({
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
      <div role="alert" aria-labelledby="room-error-title" className="panel w-full max-w-md p-6 text-center sm:p-7">
        <span className="bg-destructive/12 ring-destructive/25 mx-auto grid size-14 place-items-center rounded-full ring-1">
          <PlugZap className="text-destructive size-6" />
        </span>

        <h1 id="room-error-title" className="mt-5 text-lg font-semibold">
          The session could not be displayed
        </h1>
        <p className="text-muted-foreground mt-1.5 text-sm text-pretty">
          Something went wrong while rendering this session, and the peer connection has been lost.
          Notes and files shared here lived only in this page and are gone. Trying again reloads the
          session view, but it cannot bring the old connection back. You may need a fresh invite.
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
