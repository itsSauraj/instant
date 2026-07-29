"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { MeshParticipant } from "@/lib/mesh-session";
import type { PeerId } from "@/lib/signal-protocol";
import {
  isDigestVerified,
  markDigestVerified,
  unmarkDigestVerified,
  type PairFingerprint,
} from "@/lib/verify";

/**
 * Emoji verification state for every connected peer.
 *
 * Fingerprints are recomputed whenever the set of connected peers changes (a
 * rebuilt link means a fresh DTLS certificate, so this must re-read stats,
 * not cache by peer id forever). Verified status is remembered by digest in
 * localStorage: verifying is optional, per user, per pairing.
 */
export function usePeerVerification(
  participants: MeshParticipant[],
  getPairFingerprint: (peerId: PeerId) => Promise<PairFingerprint | null>,
) {
  const [pairs, setPairs] = useState<Record<PeerId, PairFingerprint>>({});
  // Bumped on verify/unverify so `isVerified` consumers re-render.
  const [storeVersion, setStoreVersion] = useState(0);

  const connectedIds = participants
    .filter((peer) => peer.connectionState === "connected" && !peer.away)
    .map((peer) => peer.id)
    .sort()
    .join(",");

  useEffect(() => {
    const ids = connectedIds ? connectedIds.split(",") : [];
    if (ids.length === 0) {
      setPairs({});
      return;
    }
    let cancelled = false;

    const compute = async () => {
      const entries = await Promise.all(
        ids.map(async (id) => [id, await getPairFingerprint(id)] as const),
      );
      if (cancelled) return;
      const next: Record<PeerId, PairFingerprint> = {};
      for (const [id, pair] of entries) {
        if (pair) next[id] = pair;
      }
      setPairs(next);
    };

    void compute();
    // One retry a moment later: stats can lag the "connected" edge slightly.
    const retry = setTimeout(() => void compute(), 2500);
    return () => {
      cancelled = true;
      clearTimeout(retry);
    };
  }, [connectedIds, getPairFingerprint]);

  const isVerified = useCallback(
    (peerId: PeerId) => {
      void storeVersion; // re-evaluate after verify/unverify
      const pair = pairs[peerId];
      return Boolean(pair && isDigestVerified(pair.digest));
    },
    [pairs, storeVersion],
  );

  const verify = useCallback(
    (peerId: PeerId) => {
      const pair = pairs[peerId];
      if (!pair) return;
      markDigestVerified(pair.digest);
      setStoreVersion((v) => v + 1);
    },
    [pairs],
  );

  const unverify = useCallback(
    (peerId: PeerId) => {
      const pair = pairs[peerId];
      if (!pair) return;
      unmarkDigestVerified(pair.digest);
      setStoreVersion((v) => v + 1);
    },
    [pairs],
  );

  /** verified / connected, for the header shield. 0 when nobody is connected. */
  const percent = useMemo(() => {
    const ids = connectedIds ? connectedIds.split(",") : [];
    if (ids.length === 0) return 0;
    const verified = ids.filter((id) => {
      const pair = pairs[id];
      return pair && isDigestVerified(pair.digest);
    }).length;
    return Math.round((verified / ids.length) * 100);
    // storeVersion: recompute after a verify click.
  }, [connectedIds, pairs, storeVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  return { pairs, isVerified, verify, unverify, percent };
}
