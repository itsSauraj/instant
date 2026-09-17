import { isValidRoomId, normalizeRoomId } from "@/lib/ids";

/**
 * Turns whatever a camera decoded into a room id, or null.
 *
 * A QR code is untrusted input: it can encode any string at all, including a
 * URL to an attacker's site. So this never returns something navigable - only a
 * validated room id, which the caller routes to internally. Nothing here is
 * ever fed to `location.assign` or an anchor href.
 *
 * Accepts an invite link from any origin (people scan a code generated on a
 * different host than the one they are browsing) as well as a bare code, but
 * only ever keeps the room-id portion.
 */
export function extractRoomId(scanned: string): string | null {
  if (typeof scanned !== "string") return null;

  // Guard against a pathological payload before running any regex over it.
  const text = scanned.trim().slice(0, 2048);
  if (!text) return null;

  const candidates: string[] = [];

  // A URL of any scheme: take the segment after the last /room/ and nothing
  // else, so query strings, fragments and trailing paths are all discarded.
  const fromPath = /\/room\/([^/?#\s]+)/i.exec(text);
  if (fromPath) candidates.push(fromPath[1]);

  // A bare code, possibly hyphen- or space-grouped as the UI displays it. Now
  // that custom codes are any run of letters and digits, the bare form is
  // accepted only when the WHOLE payload is such a run: `https://evil.example`
  // would otherwise normalise to a plausible-looking code and land the scanner
  // in a room nobody meant to open.
  if (/^[0-9a-z]+(?:[\s-]+[0-9a-z]+)*$/i.test(text)) candidates.push(text);

  for (const candidate of candidates) {
    const id = normalizeRoomId(candidate);
    if (isValidRoomId(id)) return id;
  }
  return null;
}
