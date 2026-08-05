import { ShieldCheck } from "lucide-react";

import { VERIFY_EMOJI, VERIFY_EMOJI_COUNT } from "@/lib/verify";

/**
 * A worked example of the verification fingerprint, using the real alphabet
 * from lib/verify.ts. The emojis here are content - the data a user would
 * compare - not decoration, and they are indexed out of VERIFY_EMOJI rather
 * than typed in, so this illustration can never drift from the app.
 */

/** Fixed picks so the example is stable across builds. Any 10 would do. */
const SAMPLE_INDICES = [8, 19, 33, 2, 56, 41, 14, 27, 60, 5] as const;

export function EmojiFingerprintExample() {
  const emojis = SAMPLE_INDICES.slice(0, VERIFY_EMOJI_COUNT).map(
    (index) => VERIFY_EMOJI[index % VERIFY_EMOJI.length],
  );

  return (
    <figure
      data-slot="emoji-fingerprint-example"
      className="bg-background/50 rounded-lg border p-4"
    >
      <figcaption className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <ShieldCheck aria-hidden className="text-success size-3.5" />
        What a pair fingerprint looks like - both of you see the same ten:
      </figcaption>
      <div
        role="img"
        aria-label={`Example verification emojis: ${emojis.join(" ")}`}
        className="mx-auto mt-3 grid w-fit grid-cols-5 gap-x-3 gap-y-1.5 text-xl"
      >
        {emojis.map((emoji, index) => (
          <span key={index} className="text-center">
            {emoji}
          </span>
        ))}
      </div>
      <p className="text-muted-foreground mt-3 text-center text-xs">
        An example, not your fingerprint. Every pair of people gets its own ten.
      </p>
    </figure>
  );
}
