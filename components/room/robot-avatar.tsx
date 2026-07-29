"use client";

import { useMemo } from "react";

import { cn } from "@/lib/utils";

/**
 * A robot avatar composed in the browser from a seed.
 *
 * Deliberately not fetched from an avatar service. An earlier version used
 * robohash.org with the ROOM ID in the URL, which handed the session credential
 * to a third party on every render. Keying it on the anonymous browser uid
 * removes that, but sending a stable per-browser identifier to an external
 * server would still let it correlate every session the user ever joins. Drawing
 * locally avoids both, keeps the CSP strict (`img-src 'self' blob: data:`),
 * works offline, and still gives every peer the same robot for the same person
 * because the seed travels with the participant.
 */

/** Deterministic 32-bit hash (FNV-1a). Same seed always yields the same robot. */
function hash(seed: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A tiny deterministic PRNG so each trait draws from an independent stream. */
function streams(seed: string) {
  let state = hash(seed) || 1;
  return () => {
    // xorshift32: cheap, and good enough to decorrelate trait choices.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

const BODY_SHAPES = ["round", "boxy", "dome"] as const;
const EYE_SHAPES = ["dots", "visor", "wide", "cyclops"] as const;
const MOUTH_SHAPES = ["grill", "line", "smile", "teeth"] as const;
const ANTENNA = ["ball", "rod", "dish", "none"] as const;

type Traits = {
  hue: number;
  accentHue: number;
  body: (typeof BODY_SHAPES)[number];
  eyes: (typeof EYE_SHAPES)[number];
  mouth: (typeof MOUTH_SHAPES)[number];
  antenna: (typeof ANTENNA)[number];
};

function traitsFor(seed: string): Traits {
  const next = streams(seed);
  const pick = <T,>(list: readonly T[]) => list[Math.floor(next() * list.length)];

  const hue = Math.floor(next() * 360);
  return {
    hue,
    // Complementary-ish accent keeps the face legible against the body.
    accentHue: (hue + 140 + Math.floor(next() * 80)) % 360,
    body: pick(BODY_SHAPES),
    eyes: pick(EYE_SHAPES),
    mouth: pick(MOUTH_SHAPES),
    antenna: pick(ANTENNA),
  };
}

export function RobotAvatar({
  seed,
  className,
  title,
}: {
  /** Stable per-person value. Use the browser uid so it survives reloads. */
  seed: string;
  className?: string;
  /** Optional accessible name; omit where a caption already names the person. */
  title?: string;
}) {
  const t = useMemo(() => traitsFor(seed || "anonymous"), [seed]);

  const body = `oklch(0.74 0.13 ${t.hue})`;
  const bodyDark = `oklch(0.54 0.13 ${t.hue})`;
  const accent = `oklch(0.82 0.16 ${t.accentHue})`;
  const ink = `oklch(0.22 0.05 ${t.hue})`;

  const bodyRadius = t.body === "boxy" ? 6 : t.body === "dome" ? 22 : 14;

  return (
    <svg
      viewBox="0 0 64 64"
      className={cn("size-full", className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {/* Backing plate: gives the robot a consistent silhouette at any size. */}
      <rect x="0" y="0" width="64" height="64" rx="14" fill={bodyDark} opacity="0.25" />

      {t.antenna !== "none" ? (
        <g stroke={bodyDark} strokeWidth="2.5" strokeLinecap="round">
          <line x1="32" y1="14" x2="32" y2="7" />
          {t.antenna === "ball" ? <circle cx="32" cy="5" r="3.4" fill={accent} stroke="none" /> : null}
          {t.antenna === "rod" ? <line x1="32" y1="7" x2="32" y2="3" stroke={accent} /> : null}
          {t.antenna === "dish" ? (
            <path d="M26 5 A6 6 0 0 1 38 5 Z" fill={accent} stroke="none" />
          ) : null}
        </g>
      ) : null}

      {/* Head */}
      <rect x="10" y="14" width="44" height="38" rx={bodyRadius} fill={body} />
      <rect
        x="10"
        y="14"
        width="44"
        height="38"
        rx={bodyRadius}
        fill="none"
        stroke={bodyDark}
        strokeWidth="2"
      />

      {/* Ears */}
      <rect x="5" y="26" width="5" height="12" rx="2.5" fill={bodyDark} />
      <rect x="54" y="26" width="5" height="12" rx="2.5" fill={bodyDark} />

      {/* Eyes */}
      {t.eyes === "dots" ? (
        <>
          <circle cx="24" cy="29" r="4" fill={ink} />
          <circle cx="40" cy="29" r="4" fill={ink} />
        </>
      ) : null}
      {t.eyes === "visor" ? (
        <rect x="17" y="25" width="30" height="9" rx="4.5" fill={ink} />
      ) : null}
      {t.eyes === "wide" ? (
        <>
          <rect x="18" y="25" width="11" height="9" rx="3" fill={ink} />
          <rect x="35" y="25" width="11" height="9" rx="3" fill={ink} />
        </>
      ) : null}
      {t.eyes === "cyclops" ? (
        <>
          <circle cx="32" cy="29" r="7" fill={ink} />
          <circle cx="32" cy="29" r="2.6" fill={accent} />
        </>
      ) : null}

      {/* Mouth */}
      {t.mouth === "grill" ? (
        <g fill={ink}>
          <rect x="22" y="40" width="20" height="2.4" rx="1.2" />
          <rect x="22" y="44" width="20" height="2.4" rx="1.2" />
        </g>
      ) : null}
      {t.mouth === "line" ? <rect x="24" y="42" width="16" height="2.8" rx="1.4" fill={ink} /> : null}
      {t.mouth === "smile" ? (
        <path d="M23 40 Q32 48 41 40" fill="none" stroke={ink} strokeWidth="2.8" strokeLinecap="round" />
      ) : null}
      {t.mouth === "teeth" ? (
        <g>
          <rect x="23" y="39" width="18" height="7" rx="2" fill={ink} />
          <rect x="27" y="39" width="2" height="7" fill={body} />
          <rect x="35" y="39" width="2" height="7" fill={body} />
        </g>
      ) : null}
    </svg>
  );
}
