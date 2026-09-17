/**
 * Room codes come in two flavours that share one namespace:
 *
 *  - **Generated** codes (`createRoomId`) are 8 characters from a CSPRNG, about
 *    40 bits of entropy, drawn from a Crockford-style alphabet with no I, L, O
 *    or U so a code survives being read aloud or retyped. Short enough to type
 *    from a phone screen; still far too many to enumerate against a server
 *    that has to be asked one code at a time.
 *
 *  - **Custom** codes are whatever someone types after `/room/`: 4 to 32
 *    letters and digits, case-insensitive. Dashes and spaces are display-only
 *    separators and never part of the code, so `my-team`, `My Team` and
 *    `myteam` are one room. A custom code is only as secret as the person who
 *    chose it, which is why a private room still asks the host before anyone
 *    is seated.
 *
 * For a private room the code gets you to the door, not through it. For a
 * public room the code IS the door, so the UI says so wherever a custom code
 * meets a public room.
 */
const GENERATED_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const GENERATED_LENGTH = 8;
const GROUP = 4;

export const ROOM_CODE = {
  /** Length of a generated code, in characters. */
  generatedLength: GENERATED_LENGTH,
  /** Bounds on a custom code after normalisation. */
  minLength: 4,
  maxLength: 32,
} as const;

function randomChars(length: number) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) {
    // 256 % 32 === 0, so masking to 5 bits stays uniform.
    out += GENERATED_ALPHABET[byte & 31];
  }
  return out;
}

/** Canonical form, e.g. `k3f9mq2t` - grouping is display-only via `prettyRoomId`. */
export function createRoomId() {
  return randomChars(GENERATED_LENGTH);
}

/** Strips formatting so pasted links, spaces, dashes and casing all normalise to one id. */
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
  if (id.length < ROOM_CODE.minLength || id.length > ROOM_CODE.maxLength) return false;
  return /^[0-9a-z]+$/.test(id);
}

/**
 * True when the code has the exact shape `createRoomId` produces. A custom code
 * can collide with this shape (`teamsync` is 8 safe letters), so it is a hint
 * for wording - "this code is easy to guess" - never a security decision.
 */
export function isGeneratedRoomId(input: string) {
  const id = normalizeRoomId(input);
  if (id.length !== GENERATED_LENGTH) return false;
  return [...id].every((char) => GENERATED_ALPHABET.includes(char));
}

/**
 * Display form. Generated codes are grouped in fours (`k3f9-mq2t`) for reading
 * aloud; a custom code is shown exactly as the person chose it, since breaking
 * `standup` into `stan-dup` would only make it harder to recognise.
 */
export function prettyRoomId(input: string) {
  const id = normalizeRoomId(input);
  if (id.length !== GENERATED_LENGTH) return id;
  return id.match(new RegExp(`.{1,${GROUP}}`, "g"))?.join("-") ?? id;
}

/** Opaque per-connection identifiers. Never reused across sessions. */
export function createToken(bytes = 16) {
  return randomChars(bytes * 2);
}
