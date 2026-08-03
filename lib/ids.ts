/**
 * Room ids are the only thing standing between a session and an uninvited
 * third party, so they are generated from a CSPRNG with ~80 bits of entropy
 * (16 chars x 5 bits). Crockford-style alphabet: no I, L, O, U, so the id
 * survives being read aloud or retyped.
 */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const ROOM_ID_LENGTH = 16;
const GROUP = 4;

function randomChars(length: number) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) {
    // 256 % 32 === 0, so masking to 5 bits stays uniform.
    out += ALPHABET[byte & 31];
  }
  return out;
}

/** Canonical form, e.g. `k3f9mq2t8xbv7rn0` - grouping is display-only via `prettyRoomId`. */
export function createRoomId() {
  return randomChars(ROOM_ID_LENGTH);
}

/** Strips formatting so pasted links, spaces and casing all normalise to one id. */
export function normalizeRoomId(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/^.*\/room\//, "")
    .replace(/[?#].*$/, "")
    .replace(/[^0-9a-z]/g, "");
}

export function isValidRoomId(input: string) {
  const id = normalizeRoomId(input);
  if (id.length !== ROOM_ID_LENGTH) return false;
  return [...id].every((char) => ALPHABET.includes(char));
}

export function prettyRoomId(input: string) {
  const id = normalizeRoomId(input);
  return id.match(new RegExp(`.{1,${GROUP}}`, "g"))?.join("-") ?? id;
}

/** Opaque per-connection identifiers. Never reused across sessions. */
export function createToken(bytes = 16) {
  return randomChars(bytes * 2);
}
