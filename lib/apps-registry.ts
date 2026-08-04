/**
 * The apps-launcher registry: types, and the validator for a payload fetched
 * from a remote host you control.
 *
 * The remote supplies DATA, never code. That boundary is deliberate: executing
 * remote JavaScript here would hand another origin the ability to read
 * `window.location` - which carries the room id, the session credential - and
 * `localStorage`, which holds the display name and the per-tab seat token. Four
 * components under `components/room/` carry comments recording that remote
 * resources were removed for exactly that reason. A file that changes by design
 * also cannot be pinned with an integrity hash, so remote code would be
 * unauthenticated as well as over-privileged.
 *
 * Everything here treats the payload as hostile, in the spirit of `lib/scan.ts`:
 * a scanned QR is never navigated to, only mined for a validated room id.
 *
 * Pure module - no DOM, no `node:` imports - so the route handler, the client
 * hook and the verification script can all use it.
 */

/** Icons are chosen by NAME from a local map, never supplied as markup. */
export type AppIconName =
  | "grid"
  | "video"
  | "notes"
  | "files"
  | "chat"
  | "code"
  | "globe"
  | "sparkles"
  | "terminal"
  | "image"
  | "music"
  | "chart";

export type AppAccent = "primary" | "success" | "warning" | "neutral";
export type AppBadge = "new" | "beta" | "soon";

/** What the remote is allowed to say. Every field is re-validated on arrival. */
export type RemoteAppEntry = {
  id: string;
  name: string;
  description?: string;
  url: string;
  icon?: AppIconName;
  accent?: AppAccent;
  badge?: AppBadge;
  group?: string;
  order?: number;
  external?: boolean;
};

export type AppsManifestV1 = {
  version: 1;
  updatedAt?: string;
  apps: RemoteAppEntry[];
};

/**
 * A validated entry. Deliberately a distinct type from `RemoteAppEntry` so
 * nothing unvalidated can reach JSX by accident - the compiler enforces that
 * only `parseAppsManifest` output is renderable.
 */
export type AppEntry = {
  id: string;
  name: string;
  description?: string;
  /** Normalised https URL whose host passed the allow-list. */
  url: string;
  icon: AppIconName;
  accent: AppAccent;
  badge?: AppBadge;
  group?: string;
  order: number;
};

/**
 * Hosts an entry may link to. THIS is the load-bearing control: a compromised
 * or hijacked registry can reorder and rename links, but it cannot point anyone
 * at an attacker's site, because every destination host is committed here.
 */
export const APP_HOST_ALLOWLIST = ["saurabh-yadav.me", "github.com"] as const;

export const APPS_LIMITS = {
  /** Refuse an oversized body before parsing it. */
  maxBodyBytes: 64 * 1024,
  maxEntries: 40,
  maxNameLength: 40,
  maxDescriptionLength: 120,
  maxGroupLength: 24,
  maxIdLength: 32,
} as const;

const ICON_NAMES = new Set<string>([
  "grid",
  "video",
  "notes",
  "files",
  "chat",
  "code",
  "globe",
  "sparkles",
  "terminal",
  "image",
  "music",
  "chart",
]);
const ACCENTS = new Set<string>(["primary", "success", "warning", "neutral"]);
const BADGES = new Set<string>(["new", "beta", "soon"]);

/**
 * Strips control characters and bidi overrides. Those are not merely untidy:
 * RTL-override and isolate characters let a remote label render as a different
 * string than it contains, which is a link-spoofing vector. React escapes HTML
 * for us, so nothing further is needed.
 */
function cleanText(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Returns a normalised https URL whose host is on the allow-list, or null.
 *
 * Uses the URL parser rather than string checks throughout: `startsWith("https")`
 * is defeated by leading whitespace, embedded newlines and unicode look-alikes,
 * all of which the parser normalises or rejects outright.
 */
export function sanitizeAppUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }

  // Exact match, so javascript:, data:, blob:, file: and vbscript: are all out.
  if (url.protocol !== "https:") return null;
  // `https://user:pass@host` renders as a plausible link to the wrong place.
  if (url.username || url.password) return null;

  const host = url.hostname.toLowerCase();
  const allowed = APP_HOST_ALLOWLIST.some(
    // Suffix match on a dot boundary. `includes()` here would accept
    // `saurabh-yadav.me.evil.com`, which is the whole attack.
    (entry) => host === entry || host.endsWith(`.${entry}`),
  );
  if (!allowed) return null;

  // Hand back the parser's own serialisation, not the remote's string.
  return url.toString();
}

function parseEntry(raw: unknown, index: number): AppEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;

  const url = sanitizeAppUrl(entry.url);
  if (!url) return null;

  const name = cleanText(entry.name, APPS_LIMITS.maxNameLength);
  if (!name) return null;

  const id = cleanText(entry.id, APPS_LIMITS.maxIdLength)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");

  const description = cleanText(entry.description, APPS_LIMITS.maxDescriptionLength);
  const group = cleanText(entry.group, APPS_LIMITS.maxGroupLength);
  const order = typeof entry.order === "number" && Number.isFinite(entry.order)
    ? Math.trunc(entry.order)
    : index;

  return {
    // A blank id after sanitising still needs a stable React key.
    id: id || `app-${index}`,
    name,
    description: description || undefined,
    url,
    icon: typeof entry.icon === "string" && ICON_NAMES.has(entry.icon)
      ? (entry.icon as AppIconName)
      : "grid",
    accent: typeof entry.accent === "string" && ACCENTS.has(entry.accent)
      ? (entry.accent as AppAccent)
      : "neutral",
    badge: typeof entry.badge === "string" && BADGES.has(entry.badge)
      ? (entry.badge as AppBadge)
      : undefined,
    group: group || undefined,
    order,
  };
}

export type ParsedManifest = {
  apps: AppEntry[];
  updatedAt: string | null;
};

/**
 * Validates a decoded manifest.
 *
 * Fail-soft per entry: one malformed app is dropped, the rest still render.
 * Fail-closed for the envelope: an unknown `version` rejects everything, so a
 * future v2 remote leaves old consumers on their last-good list rather than
 * silently rendering a shape they do not understand. Returns null on rejection,
 * which callers treat as "keep what you had".
 */
export function parseAppsManifest(raw: unknown): ParsedManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const manifest = raw as Record<string, unknown>;

  if (manifest.version !== 1) return null;
  if (!Array.isArray(manifest.apps)) return null;

  const apps: AppEntry[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of manifest.apps.slice(0, APPS_LIMITS.maxEntries).entries()) {
    const entry = parseEntry(candidate, index);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    apps.push(entry);
  }

  apps.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

  return {
    apps,
    updatedAt: cleanText(manifest.updatedAt, 40) || null,
  };
}
