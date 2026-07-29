/**
 * Transitional shim — the one-to-one `PeerSession` is gone.
 *
 * The session is now a full mesh: `lib/mesh-session.ts` (`MeshSession`) owns
 * one `lib/peer-link.ts` (`PeerLink`) per remote participant. The old type
 * names are re-exported here so not-yet-migrated imports (components/, docs)
 * keep resolving while their owners rewrite them against the mesh shapes.
 *
 * New code must import from `@/lib/mesh-session`. Delete this file once
 * nothing references it.
 */
export type {
  DocState,
  MeshMediaState as MediaState,
  MeshPhase as SessionPhase,
  MeshSnapshot as SessionSnapshot,
  Note,
} from "@/lib/mesh-session";
