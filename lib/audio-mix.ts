/**
 * What this client has learned about capturing desktop/tab audio, and whether a
 * refused request is worth retrying. Pure, so it can be verified without a
 * browser.
 *
 * The microphone and captured desktop audio are NOT mixed together: each
 * `PeerLink` carries them in two fixed transceiver slots, so a receiver can
 * tell them apart (a shared soundtrack must never read as "their mic is on")
 * and a host mute can clear the microphone alone.
 */

/** What a client has learned about this browser's display-audio support. */
export type ScreenAudioSupport =
  | "unknown" // never asked, or asked and got video only (ambiguous)
  | "available" // a capture in this session actually produced an audio track
  | "unavailable"; // asking for audio broke the whole request here

/**
 * Nobody can find and dismiss the display picker faster than this, while a
 * platform refusing the audio constraint comes back before a picker is even
 * drawn.
 */
const PICKER_DISMISSAL_FLOOR_MS = 400;

/** Error names that mean "the user said no", not "that constraint is refused". */
const DISMISSAL_ERRORS = new Set(["NotAllowedError", "AbortError", "SecurityError"]);

/**
 * Whether a failed `getDisplayMedia({ audio: true })` should be retried
 * without audio.
 *
 * Firefox and Safari can reject the WHOLE request because audio was asked for
 * rather than degrading to video only, so without a retry, asking for desktop
 * audio would cost those browsers screen sharing altogether. But a dismissed
 * picker and a refused constraint both surface as NotAllowedError, and
 * retrying a real dismissal would put a second picker in the user's face -
 * so elapsed time separates them where the error name cannot.
 *
 * Residual risk: an unusually fast Escape on Chromium reads as a refusal and
 * costs one extra picker. That is the mild failure of the two.
 */
export function shouldRetryWithoutAudio(error: unknown, elapsedMs: number): boolean {
  const name = error instanceof Error ? error.name : "";
  if (!DISMISSAL_ERRORS.has(name)) return true;
  return elapsedMs < PICKER_DISMISSAL_FLOOR_MS;
}
