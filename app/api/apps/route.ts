import { APPS_FALLBACK } from "@/lib/apps-fallback";
import { APPS_LIMITS, parseAppsManifest, type AppEntry } from "@/lib/apps-registry";

/**
 * Same-origin proxy for the remote apps registry.
 *
 * The browser talks only to this route, which is why the feature needs NO CSP
 * change: `connect-src 'self'` already permits it. Everything else follows from
 * that one decision:
 *
 *  - The remote host never sees a visitor's IP, referrer, or that they exist.
 *  - The room id cannot leak to a host the browser never contacts. That is a
 *    structural guarantee rather than one `Referrer-Policy` header away.
 *  - One cached fetch serves every visitor instead of one per browser.
 *
 * The trade is that the app gains its first server-side outbound call, so it is
 * isolated here behind a hard timeout and can never fail the request: any throw
 * still answers 200 with the fallback list. A launcher must not be able to take
 * a room down.
 */

export const runtime = "nodejs";
/** Shared across all visitors; an edit to the registry lands within this. */
export const revalidate = 600;

const FETCH_TIMEOUT_MS = 3000;

/**
 * Last payload that validated, kept per server instance. A best-effort tier
 * between Next's data cache and the committed fallback - deliberately not
 * over-invested in, since it is empty on a cold instance.
 */
let lastGood: { apps: AppEntry[]; updatedAt: string | null } | null = null;

type Source = "live" | "stale" | "fallback";

function respond(apps: AppEntry[], updatedAt: string | null, source: Source) {
  return new Response(JSON.stringify({ apps, updatedAt, source }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      // Short browser cache, long shared revalidate: a visitor reloading twice
      // does not re-hit this, while the registry edit still lands promptly.
      "cache-control": "public, max-age=60, stale-while-revalidate=600",
      "x-apps-source": source,
    },
  });
}

export async function GET() {
  const registryUrl = process.env.APPS_REGISTRY_URL;

  // Unset is a valid configuration: the launcher runs on the committed list.
  if (!registryUrl) {
    return respond(lastGood?.apps ?? APPS_FALLBACK, lastGood?.updatedAt ?? null, "fallback");
  }

  try {
    const response = await fetch(registryUrl, {
      // Forward NOTHING about the visitor: no cookies, no user agent, no
      // referrer, no forwarded-for. The upstream learns only that this server
      // asked for JSON.
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      next: { revalidate },
    });

    if (!response.ok) throw new Error(`registry responded ${response.status}`);

    // Refuse an oversized body before parsing it. A declared length is a hint
    // only, so the decoded text is checked too.
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > APPS_LIMITS.maxBodyBytes) throw new Error("registry payload too large");

    const text = await response.text();
    if (text.length > APPS_LIMITS.maxBodyBytes) throw new Error("registry payload too large");

    const parsed = parseAppsManifest(JSON.parse(text));
    if (!parsed) throw new Error("registry payload rejected");

    lastGood = parsed;
    return respond(parsed.apps, parsed.updatedAt, "live");
  } catch {
    // Deliberately silent to the client. A registry that is down, slow, or
    // serving nonsense is not the visitor's problem, and an error status here
    // would make a page look broken over a decorative launcher.
    if (lastGood) return respond(lastGood.apps, lastGood.updatedAt, "stale");
    return respond(APPS_FALLBACK, null, "fallback");
  }
}
