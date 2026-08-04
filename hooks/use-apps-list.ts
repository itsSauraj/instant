"use client";

import { useEffect, useState } from "react";

import { APPS_FALLBACK } from "@/lib/apps-fallback";
import { parseAppsManifest, type AppEntry } from "@/lib/apps-registry";

/**
 * Reads the app list from the same-origin proxy, with a localStorage warm cache
 * so a repeat visit renders instantly instead of flashing an empty panel.
 *
 * The payload is re-validated here as well as in the route. That is not
 * redundant paranoia: the cached copy comes out of localStorage, which any
 * script on the origin could have written, so it gets the same treatment as the
 * network.
 */

const CACHE_KEY = "instant-apps-v1";

export type AppsListStatus = "cached" | "live" | "fallback";

export type AppsList = {
  apps: AppEntry[];
  status: AppsListStatus;
  updatedAt: string | null;
};

function readCache(): AppsList | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    // Cached bodies are shaped like the manifest so one validator covers both.
    const parsed = parseAppsManifest(JSON.parse(raw));
    if (!parsed || parsed.apps.length === 0) return null;
    return { apps: parsed.apps, status: "cached", updatedAt: parsed.updatedAt };
  } catch {
    return null;
  }
}

function writeCache(apps: AppEntry[], updatedAt: string | null) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ version: 1, updatedAt: updatedAt ?? undefined, apps }),
    );
  } catch {
    // Private browsing or a full quota: the list still works for this page.
  }
}

/**
 * @param enabled defer the request until the launcher is actually opened, so a
 *   visitor who never touches it generates no traffic at all.
 */
export function useAppsList(enabled = true): AppsList {
  // Starts on the committed list so the first paint matches the server render;
  // the cache is adopted in an effect to avoid a hydration mismatch.
  const [state, setState] = useState<AppsList>({
    apps: APPS_FALLBACK,
    status: "fallback",
    updatedAt: null,
  });

  useEffect(() => {
    if (!enabled) return;

    const cached = readCache();
    if (cached) setState(cached);

    const controller = new AbortController();
    fetch("/api/apps", { signal: controller.signal, headers: { accept: "application/json" } })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: unknown) => {
        if (!body || typeof body !== "object") return;
        const { apps, updatedAt } = body as { apps?: unknown; updatedAt?: unknown };
        const parsed = parseAppsManifest({ version: 1, updatedAt, apps });
        // An empty list is treated as no answer: better to keep showing the
        // cached or committed entries than to blank the panel.
        if (!parsed || parsed.apps.length === 0) return;
        setState({ apps: parsed.apps, status: "live", updatedAt: parsed.updatedAt });
        writeCache(parsed.apps, parsed.updatedAt);
      })
      .catch(() => {
        // Offline, aborted, or the route is unreachable. Whatever is already in
        // state stands; the launcher never breaks the page.
      });

    return () => controller.abort();
  }, [enabled]);

  return state;
}
