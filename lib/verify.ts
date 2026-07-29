/**
 * Emoji fingerprints for peer verification, Signal-style.
 *
 * Every WebRTC link is protected by DTLS: each browser proves possession of a
 * certificate whose fingerprint travels in the signed SDP. If the two people
 * compare a digest of BOTH fingerprints out of band (reading emojis aloud on
 * the call, or in person) and they match, no relay or middlebox is sitting
 * between them re-encrypting traffic — the encryption is end-to-end for
 * everything the link carries: notes, doc edits, files, audio and video.
 *
 * The digest is rendered as 10 emojis from a 64-entry alphabet (~60 bits),
 * far beyond what an attacker could collide in the lifetime of a session.
 * Both sides sort the two fingerprints before hashing, so they compute the
 * same sequence without exchanging anything extra.
 */

/** Exactly 64 entries: 256 % 64 === 0, so byte-indexing stays unbiased. */
export const VERIFY_EMOJI = [
  "🐶", "🐱", "🦊", "🐼", "🐸", "🐢", "🦋", "🐝",
  "🦉", "🐬", "🦁", "🐘", "🦒", "🦓", "🐙", "🦀",
  "🌵", "🌲", "🍀", "🌸", "🌻", "🍁", "🍄", "🌍",
  "🌙", "⭐", "🔥", "🌈", "☔", "❄️", "🍎", "🍌",
  "🍇", "🍓", "🍕", "🍔", "🍩", "🎂", "☕", "🥑",
  "⚽", "🏀", "🎲", "🎸", "🎺", "🎨", "🎭", "🚀",
  "✈️", "🚗", "🚲", "⛵", "🗼", "🏰", "⛺", "💎",
  "🔑", "🔔", "📚", "✏️", "📌", "✂️", "🧲", "🔍",
] as const;

export const VERIFY_EMOJI_COUNT = 10;

export type PairFingerprint = {
  /** Hex digest of both DTLS fingerprints; the durable verification key. */
  digest: string;
  /** The digest rendered for humans: 10 emojis, identical on both sides. */
  emojis: string[];
};

/** Derives the pair fingerprint from the two certificate fingerprints. */
export async function pairFingerprint(
  localFingerprint: string,
  remoteFingerprint: string,
): Promise<PairFingerprint> {
  // Sorted so both ends hash the identical string without coordinating.
  const [a, b] = [localFingerprint, remoteFingerprint].sort();
  const bytes = new TextEncoder().encode(`${a}|${b}`);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

  const digest = [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const emojis = [...hash.slice(0, VERIFY_EMOJI_COUNT)].map(
    (byte) => VERIFY_EMOJI[byte % VERIFY_EMOJI.length],
  );
  return { digest, emojis };
}

/**
 * The set of digests this browser's user has personally verified. Keyed by
 * digest, not by peer: what was verified is the key material itself.
 */
const STORAGE_KEY = "instant-verified-digests";
const MAX_STORED = 200;

function readStore(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === "string") : [];
  } catch {
    return [];
  }
}

export function isDigestVerified(digest: string): boolean {
  return readStore().includes(digest);
}

export function markDigestVerified(digest: string) {
  try {
    const store = readStore().filter((d) => d !== digest);
    store.push(digest);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store.slice(-MAX_STORED)));
  } catch {
    // Storage unavailable: verification still holds for this page's lifetime
    // via the hook's state.
  }
}

export function unmarkDigestVerified(digest: string) {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(readStore().filter((d) => d !== digest)),
    );
  } catch {
    // Ignore.
  }
}
