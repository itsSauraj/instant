/**
 * The local display name, remembered across visits.
 *
 * Stored in `localStorage` (key mirrors `instant-theme` / `instant-sound`)
 * rather than carried in the room URL: an invite link gets pasted, shared and
 * scanned, and a name embedded in it would leak to everyone the link reaches —
 * and would overwrite the *recipient's* name with the sender's. Local storage
 * also survives a page reload, which matters because a reload now reclaims the
 * same session seat and must re-present the same identity.
 *
 * Every access is guarded: this module is imported by server-rendered
 * components, and `localStorage` can also throw in private browsing modes.
 */

import { sanitizeName } from "@/lib/signal-protocol";

const STORAGE_KEY = "instant-name";

/** The remembered display name, already sanitized. Empty when unset or on SSR. */
export function getStoredName(): string {
  if (typeof window === "undefined") return "";
  try {
    return sanitizeName(window.localStorage.getItem(STORAGE_KEY) ?? "");
  } catch {
    return "";
  }
}

/**
 * Persists the name (sanitized) and returns what was stored. An empty result
 * clears the key so the server's placeholder logic stays the single fallback.
 */
export function setStoredName(raw: string): string {
  const name = sanitizeName(raw);
  if (typeof window !== "undefined") {
    try {
      if (name) window.localStorage.setItem(STORAGE_KEY, name);
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage unavailable: the name still applies for this page's lifetime
      // via component state; it just won't survive a reload.
    }
  }
  return name;
}

/** Re-exported so UI code has one import for everything name-related. */
export { sanitizeName };

/**
 * A stable, anonymous id for this browser, minted once and remembered in
 * localStorage. It never appears in URLs and carries no personal data; it
 * exists so features that need to recognise "the same person as last time"
 * (notification tags, future seat identity) have something durable to key on.
 */
const USER_ID_KEY = "instant-user-id";

export function getUserId(): string {
  if (typeof window === "undefined") return "";
  try {
    const existing = window.localStorage.getItem(USER_ID_KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    window.localStorage.setItem(USER_ID_KEY, id);
    return id;
  } catch {
    // Private browsing with storage disabled: a per-page id is the best we
    // can do, and callers treat the id as advisory anyway.
    return crypto.randomUUID();
  }
}

/**
 * Marks that this tab just created a room, so the room page seats the creator
 * straight away instead of showing the join gate: they typed their name on the
 * home page a moment ago and asking again would be nonsense.
 *
 * Per-tab and single-use. Anyone arriving at the link any other way -- pasted,
 * scanned, from a chat -- has no marker and is asked for a name first.
 */
const CREATED_KEY = (roomId: string) => `instant-created-${roomId}`;

export function markRoomCreated(roomId: string) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(CREATED_KEY(roomId), "1");
  } catch {
    // Worst case the creator sees the gate with their name prefilled.
  }
}

/** Reads and clears the marker, so a later revisit is treated as a join. */
export function consumeRoomCreated(roomId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const key = CREATED_KEY(roomId);
    const found = window.sessionStorage.getItem(key) === "1";
    if (found) window.sessionStorage.removeItem(key);
    return found;
  } catch {
    return false;
  }
}

/**
 * True when this tab holds a seat in the room already, i.e. we are returning
 * from a reload. Mirrors the key `lib/mesh-session.ts` writes; the gate must
 * not appear in this case or a refresh would demand the name again and defeat
 * seat reclamation.
 */
export function hasSeatToken(roomId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return Boolean(window.sessionStorage.getItem(`instant-resume-${roomId}`));
  } catch {
    return false;
  }
}
