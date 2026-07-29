/**
 * FROZEN CONTRACT for Phases 2-4 of file transfer.
 *
 * Three lanes build against this simultaneously:
 *   - the download sinks (where received bytes actually land)
 *   - the transfer engine (chunking, targeting, resume)
 *   - the files UI (recipient picker, folder choice, resume affordances)
 *
 * Change it deliberately: all three sides and the verification scripts are
 * written against exactly these shapes.
 */

import type { PeerId } from "@/lib/signal-protocol";

/**
 * Where a received file's bytes go. Three tiers, best first:
 *
 *  - "filesystem": streamed straight into a folder the user picked, via the File
 *    System Access API. Chromium desktop only -- absent in Firefox, Safari and
 *    on iOS entirely, which is why the other tiers exist.
 *  - "download": streamed through a Service Worker into the browser's own
 *    download manager. Works everywhere, no memory ceiling, but the browser
 *    chooses the location.
 *  - "memory": accumulated as a Blob and offered as an object URL. The original
 *    behaviour, kept as a last resort and therefore size-capped.
 */
export type SinkTier = "filesystem" | "download" | "memory";

/** What a tier can promise, so the UI can explain the situation honestly. */
export type SinkCapability = {
  tier: SinkTier;
  /** True when bytes never accumulate in memory. */
  streaming: boolean;
  /** Bytes a single file may reach, or null when effectively unbounded. */
  maxBytes: number | null;
  /** True when the user has chosen a destination folder. */
  hasDestination: boolean;
  /** Human-readable destination, e.g. a folder name. Null when unknown. */
  destinationLabel: string | null;
};

/**
 * A write target for one incoming file. Implementations must be safe to
 * `abort()` at any point, including after `close()`, and must never throw from
 * `abort()`.
 */
export type DownloadSink = {
  readonly tier: SinkTier;
  /** Appends bytes in order. Rejects if the destination is gone. */
  write(chunk: Uint8Array): Promise<void>;
  /** Finalises. Resolves with a URL only for the "memory" tier. */
  close(): Promise<{ url: string | null }>;
  /** Discards a partial file and releases its handles. Never throws. */
  abort(): Promise<void>;
  /** Bytes accepted so far. Drives resume, so it must be exact. */
  readonly written: number;
};

/**
 * Chooses and creates sinks. One instance per session, owned by the transfer
 * engine, provided by the sink lane.
 */
export type SinkProvider = {
  /** What would happen right now, for UI copy and pre-flight checks. */
  capability(): SinkCapability;
  /** True when this browser can offer a folder picker at all. */
  canChooseFolder(): boolean;
  /**
   * Prompts for a destination folder. Must be called from a user gesture.
   * Resolves false when the user cancels.
   */
  chooseFolder(): Promise<boolean>;
  /** Forgets the chosen folder and falls back to the next tier. */
  clearFolder(): void;
  /**
   * Opens a sink for one file. `expectedBytes` lets a tier refuse up front
   * rather than failing halfway. `resumeFrom` is a byte offset a previous
   * partial download reached, for the resumable case.
   */
  open(file: {
    name: string;
    mime: string;
    expectedBytes: number;
    transferId: string;
    resumeFrom?: number;
  }): Promise<DownloadSink>;
};

/**
 * Additive fields the transfer engine must expose on every Transfer so the UI
 * can render targeting, destination and resume state. The engine's existing
 * Transfer fields are unchanged.
 */
export type TransferExtras = {
  /** Who this transfer is with. */
  peerId: PeerId;
  peerName: string;
  /** Which tier received it. Undefined for outgoing transfers. */
  sinkTier?: SinkTier;
  /** Where it landed, when the tier knows. Shown instead of a Save button. */
  savedTo?: string;
  /** True when a partial transfer exists that could be continued. */
  resumable?: boolean;
  /** Bytes already confirmed on the receiving side; the resume point. */
  confirmedBytes?: number;
  /** Set when this transfer picked up from a previous attempt. */
  resumedFrom?: number;
};

/** Recipients for an outgoing send. Empty means every connected peer. */
export type SendTargets = {
  /** Explicit peer ids, or null for "everyone". */
  to: PeerId[] | null;
};

/**
 * Persisted record of a partial incoming transfer, so a reload can offer to
 * continue instead of restarting at zero.
 *
 * Keyed by `id`, which must be stable across a reload and unique per (sender,
 * file) pair -- a sender-generated token, not an array index.
 */
export type PartialTransfer = {
  id: string;
  roomId: string;
  peerName: string;
  name: string;
  mime: string;
  size: number;
  received: number;
  tier: SinkTier;
  updatedAt: number;
};

export const TRANSFER_LIMITS = {
  /**
   * Cap for the memory tier only. The streaming tiers are unbounded, so this
   * exists to stop a tab dying, not to limit the feature.
   */
  maxMemoryBytes: 1024 * 1024 * 1024,
  /** Aggregate memory-tier budget across all incoming transfers in a session. */
  maxSessionMemoryBytes: 2 * 1024 * 1024 * 1024,
  /** Simultaneous incoming transfers per peer. */
  maxActiveIncomingPerPeer: 4,
  /**
   * How long a partial transfer record is kept before it is considered stale
   * and its bytes are discarded. Long enough to survive a reload and a coffee.
   */
  partialTtlMs: 24 * 60 * 60 * 1000,
  /**
   * Receiver acknowledges progress every this many bytes. Resume rewinds to
   * the last acknowledged offset, so smaller means less repeated work but more
   * control traffic.
   */
  ackIntervalBytes: 1024 * 1024,
} as const;
