import { shouldRetryWithoutAudio, type ScreenAudioSupport } from "@/lib/audio-mix";
import { createSinkProvider } from "@/lib/download-sink";
import {
  createMemorySinkProvider,
  sendFileToManagers,
  FileTransferManager,
  type FileTransferContext,
  type Transfer,
} from "@/lib/file-transfer";
import { getStoredName } from "@/lib/identity";
import { inputConstraint, isMissingDeviceError, loadDeviceChoice } from "@/lib/media-devices";
import { MAX_DOC_LENGTH, MAX_NOTE_LENGTH, type NoteFrame } from "@/lib/peer-protocol";
import { PeerLink, type PeerLinkState } from "@/lib/peer-link";
import { SignalClient } from "@/lib/signal-client";
import type { SendTargets, SinkCapability, SinkProvider } from "@/lib/transfer-contract";
import { openTransferStore, type PartialStore, type StoredPartial } from "@/lib/transfer-store";
import { pairFingerprint, type PairFingerprint } from "@/lib/verify";
import {
  ROOM_CAPACITY,
  isEnforced,
  isInitiator,
  sanitizeName,
  videoBudget,
  type EndReason,
  type ModerationAction,
  type Participant,
  type PeerId,
  type RoomVisibility,
  type ServerEvent,
  type SignalPayload,
} from "@/lib/signal-protocol";

/**
 * One browser's membership of a 2–7 person room: a full mesh of `PeerLink`s
 * (one RTCPeerConnection per remote participant), driven by the authoritative
 * roster from the signalling server.
 *
 * Lifecycle: `start()` → joining → (waiting-approval →) lobby ⇄ connected →
 * `end()`. `end()` is a one-way trapdoor: it tears down every link, stops
 * every local track, revokes every received-file URL and clears all timers.
 * `leave()` (anyone) and `close()` (host, for everyone) both fall through it.
 */

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type MeshPhase =
  | "joining" // opening the signalling stream
  | "waiting-approval" // knocked; the host has been asked
  | "lobby" // seated, alone
  | "connected" // at least one other participant holds a seat
  | "ended"; // terminal - requires a brand-new join

/** A roster entry decorated with the state of our direct link to it. */
export type MeshParticipant = Participant & {
  /** "closed" covers both "no link yet" and "link torn down" (e.g. away). */
  connectionState: PeerLinkState;
};

/** On-demand health of one direct link; see `getLinkQuality`. */
export type LinkQuality = {
  state: PeerLinkState;
  /** Current candidate-pair round trip in ms; null while unmeasured. */
  rttMs: number | null;
};

export type Note = {
  id: string;
  text: string;
  at: number;
  /** Who wrote it - resolved when the note is applied, so the label survives
   *  the author later leaving the room. */
  authorId: PeerId;
  authorName: string;
  mine: boolean;
};

export type DocState = {
  text: string;
  /** Monotonic edit counter shared by the room; the higher revision wins. */
  rev: number;
  at: number;
  /** True when the latest applied edit was made locally. */
  mine: boolean;
};

/** A transfer tagged with the peer it ran against. `key` is mesh-unique. */
export type MeshTransfer = Transfer & {
  peerId: PeerId;
  peerName: string;
};

export type Knock = { knockId: string; name: string };

export type MeshMediaState = {
  micOn: boolean;
  cameraOn: boolean;
  screenOn: boolean;
  /**
   * This client is sending captured desktop/tab audio, in its own slot beside
   * the microphone. Independent of `micOn` in both directions: desktop audio can
   * flow with the mic off, and a host mute stops the mic without touching it.
   */
  screenAudioOn: boolean;
  /**
   * What this browser has shown us about display audio, learned from real
   * capture attempts rather than guessed from the user agent. Stays "unknown"
   * when a capture returns video only, because the user leaving the picker's
   * tick box unticked and a platform quietly ignoring the ask are
   * indistinguishable from here - so the UI must not claim either.
   */
  screenAudioSupport: ScreenAudioSupport;
  /**
   * True when ANY peer is currently sending live audio - from either slot,
   * microphone OR shared desktop audio. These two aggregates exist for the
   * sounds/notifications hooks, which edge-detect them, and for the incoming-
   * audio controls; all of those mean "something audible is arriving", which a
   * shared soundtrack satisfies just as a voice does. Per-peer detail, where
   * the two sources ARE distinguished, lives in `byPeer`.
   */
  remoteAudioLive: boolean;
  remoteVideoLive: boolean;
  /**
   * Per peer, per media slot.
   *  - audioLive is the MICROPHONE alone. Host moderation reads exactly this
   *    ("Mute Ben" vs "Ask Ben to unmute"), so desktop audio must never leak
   *    into it: someone sharing a soundtrack with their mic off reads as muted.
   *  - screenAudioLive is that peer's shared desktop/tab audio.
   */
  byPeer: Record<PeerId, { audioLive: boolean; screenAudioLive: boolean; videoLive: boolean }>;
  /** Bumped whenever a track is added or removed so views re-attach srcObject. */
  version: number;
};

export type MeshSnapshot = {
  phase: MeshPhase;
  self: Participant | null;
  /** Everyone else on the roster (self is separate), ordered by `joinedAt`.
   *  Away peers stay listed - their seat is held while they reload. */
  participants: MeshParticipant[];
  capacity: number;
  /** Whether arrivals knock (`private`) or walk straight in (`public`).
   *  Authoritative from the server; the host's toggle is applied
   *  optimistically and the next roster confirms or corrects it. */
  visibility: RoomVisibility;
  isHost: boolean;
  pinnedByHost: PeerId | null;
  /** Host only: pending join requests. Always empty for guests. */
  knocks: Knock[];
  notes: Note[];
  typingPeers: PeerId[];
  /** Convenience aggregate of `typingPeers` (legacy consumers). */
  peerTyping: boolean;
  transfers: MeshTransfer[];
  media: MeshMediaState;
  /** What the current save destination can do (tier, ceiling, folder label). */
  sink: SinkCapability;
  /** True when this browser can offer a folder picker at all. */
  canChooseFolder: boolean;
  /** The live-synced shared document. Survives the session via localStorage. */
  doc: DocState;
  /** Most recent moderation event aimed at THIS client. `seq` increases on
   *  EVERY event (even two identical actions in a row) so the UI can
   *  de-duplicate without missing a repeat. Null until the first event. */
  moderation: { seq: number; action: ModerationAction; byName: string } | null;
  /**
   * Most recent host-change notification, on the same contract as
   * `moderation`: `seq` increases on EVERY `host-changed` event - repeats
   * included - so a UI that de-duplicates by `seq` reacts exactly once per
   * handover and can never swallow a second one. `becameHost` is true only on
   * the client that just became host; `byChoice` distinguishes a deliberate
   * handover from automatic succession. Null until the first event.
   *
   * This is a NOTIFICATION only. `isHost` (and each participant's host flag)
   * comes from the authoritative roster; if the two ever disagree, the roster
   * wins.
   */
  hostChange: {
    seq: number;
    peerId: PeerId;
    name: string;
    becameHost: boolean;
    byChoice: boolean;
  } | null;
  error: string | null;
  endReason: EndReason | null;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Timestamps beyond what `Date` can represent would crash `toISOString()`. */
const MAX_NOTE_TIMESTAMP_MS = 8.64e15;

/**
 * Whether a live track already comes from the chosen device. Unknowable for
 * the system default (null), which is therefore always worth re-opening.
 */
function sameDevice(track: MediaStreamTrack, deviceId: string | null) {
  if (!deviceId) return false;
  try {
    return track.getSettings().deviceId === deviceId;
  } catch {
    return false;
  }
}

/** A peer that stops typing without telling us is common; self-expire. */
const TYPING_EXPIRE_MS = 4000;

/**
 * After a link dies locally (ICE failure, silent channel close) the initiator
 * side rebuilds it. The delay gives the other end time to notice the same
 * failure and tear down its half, so the fresh offer lands on a fresh
 * connection - and gives an in-flight authoritative `peer-away`/`peer-left`
 * a chance to arrive first and cancel the rebuild entirely.
 */
const LINK_REBUILD_DELAY_MS = 2500;

/** Dev-only window handle: Map<PeerId, RTCPeerConnection>, one entry per live
 *  link, used by the verification scripts to inspect ICE stats. */
const DEBUG_HANDLE = "__instantPeerConnections";

/** sessionStorage (per-tab, so a second tab is a distinct participant and the
 *  token never leaks across tabs) key for the seat-resume token. */
const resumeKey = (roomId: string) => `instant-resume-${roomId}`;

function loadResumeToken(roomId: string): string | null {
  try {
    return sessionStorage.getItem(resumeKey(roomId));
  } catch {
    return null;
  }
}

function storeResumeToken(roomId: string, token: string) {
  try {
    sessionStorage.setItem(resumeKey(roomId), token);
  } catch {
    // Private browsing or storage full: a reload simply cannot resume.
  }
}

function clearResumeToken(roomId: string) {
  try {
    sessionStorage.removeItem(resumeKey(roomId));
  } catch {
    // Ignore.
  }
}

// ---------------------------------------------------------------------------
// The mesh
// ---------------------------------------------------------------------------

type RetiredTransfers = {
  uid: string;
  peerId: PeerId;
  peerName: string;
  manager: FileTransferManager;
};

export class MeshSession {
  private signal: SignalClient | null = null;
  private started = false;

  private self: Participant | null = null;
  private isHost = false;
  private capacity: number = ROOM_CAPACITY.default;
  private visibility: RoomVisibility;
  private pinnedByHost: PeerId | null = null;

  /** Roster minus self, keyed by peer id. Authoritative (server-driven). */
  private readonly others = new Map<PeerId, Participant>();
  /** One live link per *present* remote participant. */
  private readonly links = new Map<PeerId, PeerLink>();
  /** Monotonic counter so every PeerLink instance gets a unique uid. */
  private linkGeneration = 0;
  /** Managers of destroyed links, kept so completed received files stay
   *  downloadable until end() revokes their URLs. */
  private retired: RetiredTransfers[] = [];
  private readonly rebuildTimers = new Map<PeerId, ReturnType<typeof setTimeout>>();

  private knocks: Knock[] = [];
  private notes: Note[] = [];
  private readonly typingTimers = new Map<PeerId, ReturnType<typeof setTimeout>>();

  private doc: DocState;
  private docSendTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly localStream = new MediaStream();
  private micTrack: MediaStreamTrack | null = null;
  private cameraTrack: MediaStreamTrack | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  /** Desktop/tab audio from the same getDisplayMedia capture as `screenTrack`.
   *  Deliberately NOT added to `localStream`: that stream is the self preview,
   *  which is always muted (hearing your own capture is a feedback loop), and
   *  an audio track in it would make the self tile's mic reading ambiguous. */
  private screenAudioTrack: MediaStreamTrack | null = null;
  private screenAudioSupport: ScreenAudioSupport = "unknown";
  private mediaVersion = 0;
  /**
   * Which microphone and camera to capture from, remembered per browser
   * (lib/media-devices.ts). Applied as an `ideal` constraint on every capture,
   * so an unplugged favourite falls back to the system default instead of
   * failing. The speaker is the tiles' business, not the transport's.
   */
  private readonly inputChoice: { audioinput: string | null; videoinput: string | null };

  private phase: MeshPhase = "joining";
  private endReason: EndReason | null = null;
  private error: string | null = null;

  /** Latest host-moderation event aimed at this client; see MeshSnapshot. */
  private moderation: { seq: number; action: ModerationAction; byName: string } | null = null;
  private moderationSeq = 0;

  /** Latest host-change notification; see MeshSnapshot. */
  private hostChange: MeshSnapshot["hostChange"] = null;
  private hostChangeSeq = 0;

  // --- transfer infrastructure (sinks, resume) -----------------------------
  /** Where received bytes land. Starts as the plain in-memory tier and is
   *  swapped for the real browser provider once `initTransferInfra` runs. */
  private sinkProvider: SinkProvider = createMemorySinkProvider();
  /** IndexedDB partial-transfer store; null where storage is unavailable
   *  (private browsing) - resume degrades, transfers still work. */
  private partialStore: PartialStore | null = null;
  /** Resolves when provider + store are settled; the engine awaits this
   *  before making resume decisions so a fast peer cannot outrun setup. */
  private readonly infraReady: Promise<void>;
  /** Cached partial records for this room, newest first. */
  private partials: StoredPartial[] = [];
  /** Receiver-side annotations, e.g. "the sender must re-select this file". */
  private readonly partialNotes = new Map<string, string>();
  /** Files this session has offered, by transfer uid - the resume registry.
   *  Dies with the page: a File object cannot survive a reload, which is why
   *  a reloaded SENDER must re-select files (see the resume-req handling). */
  private readonly outgoingFiles = new Map<string, File>();

  private listeners = new Set<() => void>();
  private snapshot: MeshSnapshot;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly roomId: string,
    private readonly displayName = "",
    /**
     * `visibility` is the room the creator WANTS if this join turns out to
     * found one. The server reads it only on the founding GET; when the room
     * already exists the authoritative value arrives in `welcome` instead.
     */
    options: { visibility?: RoomVisibility } = {},
  ) {
    this.visibility = options.visibility ?? "private";
    const devices = loadDeviceChoice();
    this.inputChoice = { audioinput: devices.audioinput, videoinput: devices.videoinput };
    this.doc = this.loadDoc();
    this.infraReady = this.initTransferInfra();
    this.snapshot = this.build();

    if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
      // Dev-only handle so the transfer verification scripts can reach the
      // live session (same convention as __instantPeerConnections).
      (window as unknown as Record<string, unknown>).__instantMeshSession = this;
    }
  }

  /**
   * Loads the sink provider and the partial store. Runs once, at
   * construction; everything transfer-related awaits `infraReady` before
   * trusting either. `__instantSinkProviderOverride` is a dev/test hook so
   * the verification suites can pin a deterministic tier.
   */
  private async initTransferInfra(): Promise<void> {
    if (typeof window === "undefined") return;
    try {
      const override =
        process.env.NODE_ENV !== "production"
          ? (window as unknown as Record<string, unknown>).__instantSinkProviderOverride
          : undefined;
      if (override) {
        this.sinkProvider = (
          typeof override === "function" ? override() : override
        ) as SinkProvider;
      } else {
        this.sinkProvider = createSinkProvider();
      }
    } catch {
      // Keep the memory fallback; every tier decision degrades gracefully.
    }
    this.partialStore = await openTransferStore(this.roomId);
    await this.refreshPartials();
  }

  private async refreshPartials(): Promise<void> {
    this.partials = this.partialStore ? await this.partialStore.list() : [];
    if (this.phase !== "ended") this.emitSoon();
  }

  // ------------------------------------------------------------------ store

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  getLocalStream = () => this.localStream;

  /** The remote MediaStream for one peer - their microphone and video - or
   *  null when no link is live. Their shared desktop audio is NOT in it; see
   *  `getRemoteShareAudioStream`. */
  getRemoteStream = (peerId: PeerId): MediaStream | null =>
    this.links.get(peerId)?.remoteStream ?? null;

  /**
   * One peer's shared desktop/tab audio, alone, for its own audio element.
   *
   * It needs a second element: a media element fed a MediaStream renders only
   * the FIRST audio track in Chromium (and mixes them all in Gecko), so putting
   * this beside their microphone in one stream would be silent in one browser
   * and doubled in the other. `media.byPeer[peerId].screenAudioLive` says
   * whether there is anything in it right now.
   */
  getRemoteShareAudioStream = (peerId: PeerId): MediaStream | null =>
    this.links.get(peerId)?.remoteShareAudioStream ?? null;

  /**
   * The provider the engine actually writes received files through.
   *
   * Exposed because the destination picker must steer THIS instance. Left to
   * construct its own, the UI would show a folder chooser that changed where
   * nothing was written -- a control that silently does nothing.
   */
  getSinkProvider = (): SinkProvider => this.sinkProvider;

  /**
   * Live quality of the direct link to one peer: its negotiation state plus
   * the current-candidate-pair round-trip time. RTT is read from getStats on
   * demand (callers poll while a participants view is open) rather than being
   * part of the snapshot, so nothing pays for it when nobody is looking.
   */
  getLinkQuality = async (peerId: PeerId): Promise<LinkQuality> => {
    const link = this.links.get(peerId);
    if (!link) return { state: "closed", rttMs: null };

    let rttMs: number | null = null;
    try {
      const stats = await link.connection.getStats();
      stats.forEach((report) => {
        if (
          report.type === "candidate-pair" &&
          (report as RTCIceCandidatePairStats).state === "succeeded" &&
          typeof (report as RTCIceCandidatePairStats).currentRoundTripTime === "number"
        ) {
          const ms = Math.round(
            ((report as RTCIceCandidatePairStats).currentRoundTripTime ?? 0) * 1000,
          );
          // Several pairs can linger in the report; the nominated one is the
          // active route, but Firefox omits `nominated`, so take the best.
          rttMs = rttMs === null ? ms : Math.min(rttMs, ms);
        }
      });
    } catch {
      // Stats unavailable (link mid-teardown): state alone still informs.
    }
    return { state: link.state, rttMs };
  };

  /**
   * The emoji fingerprint of the DTLS pair securing our link to one peer, for
   * out-of-band verification (see lib/verify.ts). Null until the link is up -
   * fingerprints only exist once certificates have been exchanged.
   */
  getPairFingerprint = async (peerId: PeerId): Promise<PairFingerprint | null> => {
    const link = this.links.get(peerId);
    if (!link || link.state !== "connected") return null;

    try {
      const stats = await link.connection.getStats();
      let localCertId: string | undefined;
      let remoteCertId: string | undefined;
      const certs = new Map<string, string>();

      stats.forEach((report) => {
        if (report.type === "transport") {
          const transport = report as RTCTransportStats;
          // Take the first transport carrying certificates (bundled, so one).
          if (transport.localCertificateId && transport.remoteCertificateId) {
            localCertId ??= transport.localCertificateId;
            remoteCertId ??= transport.remoteCertificateId;
          }
        } else if (report.type === "certificate") {
          // Not in TS's dom lib yet; the shape is standardised.
          const cert = report as { id: string; fingerprint?: string };
          if (cert.fingerprint) certs.set(cert.id, cert.fingerprint);
        }
      });

      const local = localCertId ? certs.get(localCertId) : undefined;
      const remote = remoteCertId ? certs.get(remoteCertId) : undefined;
      if (!local || !remote) return null;

      return await pairFingerprint(local, remote);
    } catch {
      return null;
    }
  };

  private build(): MeshSnapshot {
    const participants: MeshParticipant[] = [...this.others.values()]
      // Server clock at first join: a stable order for the video grid that
      // every member computes identically.
      .sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1))
      .map((p) => ({ ...p, connectionState: this.links.get(p.id)?.state ?? "closed" }));

    const byPeer: MeshMediaState["byPeer"] = {};
    let remoteAudioLive = false;
    let remoteVideoLive = false;
    for (const [peerId, link] of this.links) {
      // Straight from the link's fixed slots, so the microphone and a shared
      // soundtrack are never confused for one another. Guessing from
      // `remoteStream.getAudioTracks()` is what made a peer sharing desktop
      // audio with their mic off report as unmuted.
      const { micLive, shareAudioLive, videoLive } = link.remoteMedia();
      byPeer[peerId] = { audioLive: micLive, screenAudioLive: shareAudioLive, videoLive };
      remoteAudioLive ||= micLive || shareAudioLive;
      remoteVideoLive ||= videoLive;
    }

    // Precedence per uid: a LIVE transfer on a current link tells the freshest
    // story; a persisted PARTIAL row (resumable, with the durable offset and
    // any re-select note) supersedes the RETIRED failed record the same
    // interruption left behind - otherwise the resume affordance would be
    // invisible until the session ended.
    const transfers: MeshTransfer[] = [];
    for (const [peerId, link] of this.links) {
      const peerName = this.others.get(peerId)?.name ?? "Peer";
      for (const t of link.transfers()) {
        transfers.push({ ...t, key: `${link.uid}:${t.key}`, peerId, peerName });
      }
    }
    const liveUids = new Set(
      transfers.filter((t) => t.direction === "incoming").map((t) => t.uid),
    );
    const partialUids = new Set(this.partials.map((p) => p.id));
    for (const r of this.retired) {
      for (const t of r.manager.list()) {
        if (t.direction === "incoming" && !liveUids.has(t.uid) && partialUids.has(t.uid)) {
          continue; // superseded by the resumable partial row below
        }
        transfers.push({ ...t, key: `${r.uid}:${t.key}`, peerId: r.peerId, peerName: r.peerName });
      }
    }

    // Persisted partials from earlier sessions/links surface as resumable
    // rows - unless a live or finished record for the same uid already tells
    // a fresher story (e.g. the transfer resumed and is running right now).
    const knownUids = new Set(
      transfers.filter((t) => t.direction === "incoming").map((t) => t.uid),
    );
    for (const partial of this.partials) {
      if (knownUids.has(partial.id)) continue;
      transfers.push({
        id: -1,
        key: `partial:${partial.id}`,
        uid: partial.id,
        direction: "incoming",
        name: partial.name,
        size: partial.size,
        mime: partial.mime,
        transferred: partial.received,
        status: "failed",
        error:
          this.partialNotes.get(partial.id) ??
          "Interrupted - will continue when the sender reconnects",
        isImage: partial.mime.startsWith("image/"),
        startedAt: partial.updatedAt,
        peerId: partial.peerId,
        peerName: partial.peerName,
        sinkTier: partial.tier,
        resumable: true,
        confirmedBytes: partial.received,
      });
    }
    transfers.sort((a, b) => a.startedAt - b.startedAt);

    return {
      phase: this.phase,
      self: this.self,
      participants,
      capacity: this.capacity,
      visibility: this.visibility,
      isHost: this.isHost,
      pinnedByHost: this.pinnedByHost,
      knocks: this.knocks,
      notes: this.notes,
      typingPeers: [...this.typingTimers.keys()],
      peerTyping: this.typingTimers.size > 0,
      transfers,
      sink: this.sinkProvider.capability(),
      canChooseFolder: this.sinkProvider.canChooseFolder(),
      media: {
        micOn: Boolean(this.micTrack),
        cameraOn: Boolean(this.cameraTrack),
        screenOn: Boolean(this.screenTrack),
        // The captured track IS what is sent now (its own slot, no mixing), so
        // holding one is the whole condition.
        screenAudioOn: Boolean(this.screenAudioTrack),
        screenAudioSupport: this.screenAudioSupport,
        remoteAudioLive,
        remoteVideoLive,
        byPeer,
        version: this.mediaVersion,
      },
      doc: this.doc,
      moderation: this.moderation,
      hostChange: this.hostChange,
      error: this.error,
      endReason: this.endReason,
    };
  }

  private emit() {
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    this.snapshot = this.build();
    for (const listener of this.listeners) listener();
  }

  /** Coalesces high-frequency updates (transfer progress) into ~20fps. */
  private emitSoon = () => {
    if (this.throttleTimer) return;
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null;
      this.snapshot = this.build();
      for (const listener of this.listeners) listener();
    }, 50);
  };

  private setPhase(phase: MeshPhase) {
    if (this.phase === phase) return;
    // `ended` is a trapdoor; late async callbacks must not resurrect a session.
    if (this.phase === "ended") return;
    this.phase = phase;
    this.emit();
  }

  private fail(message: string) {
    this.error = message;
    this.emit();
  }

  /** Room-level phase from the roster. Terminal `ended` is never overwritten. */
  private updatePhase() {
    if (this.phase === "ended" || !this.self) return;
    // Away peers still hold a seat, so they keep the room "connected"; the
    // per-participant connectionState carries the nuance.
    this.setPhase(this.others.size > 0 ? "connected" : "lobby");
  }

  // -------------------------------------------------------------- lifecycle

  start() {
    if (this.started || this.phase === "ended") return;
    this.started = true;

    // An explicit name wins; otherwise the one the join UI persisted via
    // lib/identity.ts. It rides the joining GET as `JOIN_PARAM.name`.
    const name = sanitizeName(this.displayName) || getStoredName();

    this.signal = new SignalClient(this.roomId, {
      onEvent: (event) => this.onSignalEvent(event),
      onTransportError: (error) => {
        if (this.phase === "ended") return;
        this.error = error.message;
        this.end("transport-error");
      },
    });

    // A token stored by a previous page load reclaims the same seat (the
    // server holds it for `awayTtlMs`), bypassing the knock entirely.
    const token = loadResumeToken(this.roomId);
    if (token) {
      void this.signal.resume(name || "Guest", token);
    } else {
      void this.signal.connect(name || "Guest", this.visibility);
    }
  }

  /** Leave voluntarily. Any participant may; the room survives without us. */
  leave() {
    if (this.phase === "ended") return;
    const signal = this.signal;
    this.signal = null;
    if (signal) {
      // The goodbye must reach the server before the stream is torn down:
      // aborting first races the POST, and the others would be told we merely
      // disconnected (seat held 45s) rather than deliberately left.
      void signal.leave().finally(() => signal.dispose());
    }
    this.end("self-left");
  }

  /** Host only: end the session for everyone. The server enforces the rule;
   *  for a guest this is a no-op rather than a surprise self-leave. */
  close() {
    if (this.phase === "ended" || !this.isHost) return;
    const signal = this.signal;
    this.signal = null;
    if (signal) {
      void signal.closeRoom().finally(() => signal.dispose());
    }
    this.end("host-closed");
  }

  /**
   * The page is being unloaded (reload or tab close). Tear everything down
   * locally but do NOT send `leave` and do NOT burn the resume token: the
   * server holds the seat for `awayTtlMs`, and if this was a reload the next
   * page load reclaims it with the token. WebRTC connections are page-scoped
   * and always die here regardless.
   */
  handlePageHide() {
    if (this.phase === "ended") return;
    const signal = this.signal;
    this.signal = null;
    signal?.dispose();
    this.end("transport-error", { keepResumeToken: true });
  }

  /**
   * Terminal teardown. Idempotent, and safe to call from any callback.
   * Everything the session holds - links, tracks, timers, object URLs - is
   * released here; nothing after this can resurrect the instance.
   */
  end(reason: EndReason, options?: { keepResumeToken?: boolean }) {
    if (this.phase === "ended") return;

    this.endReason = reason;
    this.phase = "ended";

    // A deliberate or server-decided ending explains itself; a per-link error
    // that raced it (the far side's pc.close() raises channel errors moments
    // before the authoritative `ended`/`peer-left` arrives) must not linger to
    // be rendered beside that explanation. A transport-error end keeps its
    // message - there the error IS the explanation.
    if (reason !== "transport-error") this.error = null;

    // A refresh may reclaim the seat only when the session ended by accident.
    // Every deliberate or server-decided ending burns the token, so revisiting
    // the URL later knocks like a stranger instead of replaying a dead seat.
    // A session that never start()ed (the StrictMode probe instance) owns no
    // seat and must not burn the token its successor is about to consume.
    const keepToken = options?.keepResumeToken ?? reason === "transport-error";
    if (this.started && !keepToken) clearResumeToken(this.roomId);

    for (const timer of this.rebuildTimers.values()) clearTimeout(timer);
    this.rebuildTimers.clear();
    for (const timer of this.typingTimers.values()) clearTimeout(timer);
    this.typingTimers.clear();
    if (this.docSendTimer) {
      clearTimeout(this.docSendTimer);
      this.docSendTimer = null;
    }
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    // The doc itself deliberately survives teardown: it is persisted per room
    // in localStorage so nothing is lost when a session ends.

    if (this.signal) {
      // leave()/close() already said goodbye and nulled this; getting here
      // means the server ended things (or the transport died) - just abort.
      const signal = this.signal;
      this.signal = null;
      signal.dispose();
    }

    // Tear down every link. Transfers were either already failed by their
    // link dying, or fail now with the session-level reason.
    for (const peerId of [...this.links.keys()]) {
      this.destroyLink(peerId, "Session ended");
    }
    // Now revoke every object URL, live and retired. A session that ended
    // leaves nothing behind for a later occupant of this browser tab.
    for (const r of this.retired) r.manager.dispose();
    this.retired = [];

    this.stopLocalMedia();

    // The outgoing-file registry holds real File handles; a dead session must
    // not pin them. Persisted PARTIAL records survive on purpose - they are
    // what the next session resumes from.
    this.outgoingFiles.clear();
    this.partialNotes.clear();

    if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
      delete (window as unknown as Record<string, unknown>)[DEBUG_HANDLE];
      const holder = window as unknown as Record<string, unknown>;
      if (holder.__instantMeshSession === this) delete holder.__instantMeshSession;
    }

    // Wipe the transcript (in-memory only; see report - notes do not survive
    // a reload either, by design for this phase).
    this.notes = [];
    this.knocks = [];
    this.mediaVersion += 1;

    this.emit();
  }

  private stopLocalMedia() {
    for (const track of [
      this.micTrack,
      this.cameraTrack,
      this.screenTrack,
      this.screenAudioTrack,
    ]) {
      if (!track) continue;
      track.onended = null;
      track.stop();
    }
    this.micTrack = null;
    this.cameraTrack = null;
    this.screenTrack = null;
    this.screenAudioTrack = null;
    for (const track of this.localStream.getTracks()) {
      this.localStream.removeTrack(track);
    }
  }

  // ------------------------------------------------------------- signalling

  private onSignalEvent(event: ServerEvent) {
    if (this.phase === "ended") return;

    switch (event.t) {
      case "welcome": {
        this.self = event.self;
        this.isHost = event.self.isHost;
        this.capacity = event.capacity;
        this.pinnedByHost = event.pinned;
        storeResumeToken(this.roomId, event.resumeToken);
        this.reconcileRoster(event.roster, event.capacity, event.visibility);
        break;
      }

      case "waiting-approval": {
        this.setPhase("waiting-approval");
        break;
      }

      case "roster": {
        this.reconcileRoster(event.roster, event.capacity, event.visibility);
        break;
      }

      case "peer-joined": {
        this.upsertParticipant(event.peer);
        break;
      }

      case "peer-left": {
        const timer = this.rebuildTimers.get(event.peerId);
        if (timer) {
          clearTimeout(timer);
          this.rebuildTimers.delete(event.peerId);
        }
        // Destroy before forgetting the roster entry: the retired transfer
        // records keep the peer's display name for the Files list.
        this.destroyLink(event.peerId, "Peer left");
        this.others.delete(event.peerId);
        this.applyAllBudgets();
        this.updatePhase();
        this.emit();
        break;
      }

      case "peer-away": {
        const peer = this.others.get(event.peerId);
        if (!peer) break;
        this.others.set(event.peerId, { ...peer, away: event.away });
        if (event.away) {
          // Their page is gone (reload/blip); the RTCPeerConnection is dead
          // even though the seat is held. Tear our half down so a *fresh*
          // link is built when they return - the roster entry stays visible.
          this.destroyLink(event.peerId, "Peer reconnecting");
        } else {
          this.ensureLink(this.others.get(event.peerId)!);
        }
        this.applyAllBudgets();
        this.emit();
        break;
      }

      case "knock": {
        if (!this.knocks.some((k) => k.knockId === event.knockId)) {
          this.knocks = [...this.knocks, { knockId: event.knockId, name: event.name }];
        }
        this.emit();
        break;
      }

      case "knock-withdrawn": {
        this.knocks = this.knocks.filter((k) => k.knockId !== event.knockId);
        this.emit();
        break;
      }

      case "signal": {
        let link: PeerLink | null = this.links.get(event.from) ?? null;
        if (!link) {
          // A signal from a rostered peer with no live link means the far side
          // is (re)building its half - after a failure we tore down, or a
          // return from away racing the roster update. Create ours lazily so
          // the negotiation is not lost; if we happen to be the initiator for
          // this pair too, perfect negotiation absorbs the offer glare.
          const peer = this.others.get(event.from);
          if (!peer) return;
          link = this.createLink(peer);
          if (!link) return;
          this.emit();
        }
        void link.handleSignal(event.data);
        break;
      }

      case "pin": {
        this.pinnedByHost = event.peerId;
        this.emit();
        break;
      }

      case "host-changed": {
        // Notification only. Host-ness itself (this.isHost, and each roster
        // entry's flag) is applied exclusively from the authoritative roster
        // the server emits alongside this event - deriving it here could
        // disagree with that roster, and the roster must win. `seq` moves on
        // EVERY event, repeats included, so a UI de-duplicating by `seq` can
        // never swallow a second handover.
        this.hostChangeSeq += 1;
        this.hostChange = {
          seq: this.hostChangeSeq,
          peerId: event.peerId,
          name: event.name,
          becameHost: event.becameHost,
          byChoice: event.byChoice,
        };
        this.emit();
        break;
      }

      case "ended": {
        this.end(event.reason);
        break;
      }

      case "moderated": {
        // Enforced mutes are applied IMMEDIATELY, through the exact same path
        // as the local toggle, so the track genuinely stops and every peer
        // sees it stop. Already-off is a no-op (the guard), never an error.
        // The ask-* actions deliberately touch NOTHING here: a remote party
        // must never be able to switch someone's microphone or camera ON -
        // the media panel prompts and the user decides.
        if (isEnforced(event.action)) {
          // "Mute" means the MICROPHONE, and only that. Desktop audio the user
          // deliberately chose to share is not their microphone, so it keeps
          // flowing: toggleMic stops the mic capture and calls syncMic, which
          // touches the mic slot alone - the share-audio slot has one writer
          // (syncShareAudio) and nothing on this path calls it. A control that
          // said "mute" and also killed a shared soundtrack would be doing
          // something other than it says.
          if (event.action === "mute-audio" && this.micTrack) void this.toggleMic();
          if (event.action === "mute-video") {
            // "Turn off their camera" must stop ALL outgoing video, screen share
            // included. Stopping only the camera would leave the host looking at
            // the very content they just tried to stop, which is the failure
            // that matters here -- a moderation control that visibly does
            // nothing is worse than not having one.
            //
            // This DOES take any shared desktop audio with it, because that
            // audio came from the screen capture being stopped: ending the
            // picture but leaving the soundtrack playing would be the stranger
            // outcome. Only mute-audio is scoped to the microphone.
            if (this.cameraTrack) void this.toggleCamera();
            if (this.screenTrack) void this.toggleScreenShare();
          }
        }
        // `seq` must move on EVERY event, including a repeat of the same
        // action, or the UI's de-duplication would swallow a second "mute"
        // issued after the user unmuted.
        this.moderationSeq += 1;
        this.moderation = { seq: this.moderationSeq, action: event.action, byName: event.byName };
        this.emit();
        break;
      }

      case "ping":
        break;
    }
  }

  /**
   * Reconciliation from the authoritative roster. Idempotent by construction
   * - a reload replays it, and the server resends it on every membership or
   * capacity change - so every step is "ensure", never "assume new".
   */
  private reconcileRoster(
    roster: Participant[],
    capacity: number,
    visibility: RoomVisibility,
  ) {
    this.capacity = capacity;
    this.visibility = visibility;

    const seen = new Set<PeerId>();
    for (const p of roster) {
      if (this.self && p.id === this.self.id) {
        this.self = p;
        this.isHost = p.isHost;
        continue;
      }
      seen.add(p.id);
      this.others.set(p.id, p);
    }

    // Drop whoever the server no longer lists. Destroy before forgetting the
    // roster entry so retired transfers keep the peer's display name.
    for (const peerId of [...this.others.keys()]) {
      if (seen.has(peerId)) continue;
      const timer = this.rebuildTimers.get(peerId);
      if (timer) {
        clearTimeout(timer);
        this.rebuildTimers.delete(peerId);
      }
      this.destroyLink(peerId, "Peer left");
      this.others.delete(peerId);
    }

    // Ensure exactly one link per *present* peer; none for away seats (their
    // page - and therefore their RTCPeerConnection - no longer exists).
    for (const p of this.others.values()) {
      if (p.away) {
        this.destroyLink(p.id, "Peer reconnecting");
      } else {
        this.ensureLink(p);
      }
    }

    this.applyAllBudgets();
    this.updatePhase();
    this.emit();
  }

  private upsertParticipant(peer: Participant) {
    if (this.self && peer.id === this.self.id) return;
    this.others.set(peer.id, peer);
    if (!peer.away) this.ensureLink(peer);
    this.applyAllBudgets();
    this.updatePhase();
    this.emit();
  }

  // ------------------------------------------------------------------ links

  private ensureLink(peer: Participant): PeerLink | null {
    return this.links.get(peer.id) ?? this.createLink(peer);
  }

  private createLink(peer: Participant): PeerLink | null {
    const self = this.self;
    // No event should beat `welcome` (SSE is ordered), but a link built
    // without knowing who we are could not negotiate roles; refuse instead
    // of throwing from deep inside an event handler.
    if (!self) return null;
    const peerId = peer.id;

    const link = new PeerLink({
      selfId: self.id,
      remote: peer,
      // The peer already in the room offers to the newcomer, so a pair's
      // setup never begins with a glare; ties broken deterministically.
      initiator: isInitiator(self, peer),
      uid: `${peerId}~${this.linkGeneration++}`,
      localStream: this.localStream,
      transferContext: this.transferContext(peer),
      callbacks: {
        signal: (data: SignalPayload) => {
          void this.signal?.sendSignal(peerId, data);
        },
        onStateChange: () => this.emit(),
        onConnected: () => this.onLinkConnected(peerId),
        onMediaChange: () => this.bumpMedia(),
        onNoteFrame: (frame) => this.onPeerFrame(peerId, frame),
        onTransfersChange: this.emitSoon,
        onFailed: () => this.onLinkFailed(peerId),
        onError: (message) => this.fail(message),
      },
    });
    this.links.set(peerId, link);

    // Fan every current capture out to the new pair, each into its own slot, so
    // someone joining mid-call hears and sees exactly what everyone else does.
    // The slots already exist, so these are plain replaceTrack calls that fold
    // into the link's first negotiation.
    link.setMicTrack(this.micTrack);
    link.setShareAudioTrack(this.screenAudioTrack);
    const video = this.screenTrack ?? this.cameraTrack;
    if (video) link.setVideoTrack(video, this.screenTrack ? "screen" : "camera");
    link.applyVideoBudget(this.currentBudget());

    if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
      // Dev-only handle so the mesh verification scripts can inspect ICE
      // stats per pair and confirm each route is actually peer-to-peer.
      const holder = window as unknown as Record<string, unknown>;
      const map = (holder[DEBUG_HANDLE] as Map<PeerId, RTCPeerConnection>) ?? new Map();
      holder[DEBUG_HANDLE] = map;
      map.set(peerId, link.connection);
    }

    return link;
  }

  private destroyLink(peerId: PeerId, failTransfersReason: string | null) {
    const link = this.links.get(peerId);

    const typing = this.typingTimers.get(peerId);
    if (typing) {
      clearTimeout(typing);
      this.typingTimers.delete(peerId);
    }
    if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
      const map = (window as unknown as Record<string, unknown>)[DEBUG_HANDLE] as
        | Map<PeerId, RTCPeerConnection>
        | undefined;
      map?.delete(peerId);
    }

    if (!link) return;
    this.links.delete(peerId);
    const manager = link.destroy(failTransfersReason);
    if (manager) {
      // Keep completed received files alive (their object URLs) until end().
      this.retired.push({
        uid: link.uid,
        peerId,
        peerName: this.others.get(peerId)?.name ?? "Peer",
        manager,
      });
    }
  }

  /** Both channels just opened for this pair. */
  private onLinkConnected(peerId: PeerId) {
    // Encodings only exist after the first negotiation completes, so this is
    // the reliable moment to cap the new pair's outgoing camera.
    this.links.get(peerId)?.applyVideoBudget(this.currentBudget());
    // Offer whatever doc this side already has (restored from a previous
    // session, or typed while alone); the newcomer keeps the newer revision.
    if (this.doc.rev > 0) this.sendDocFrame(this.links.get(peerId));
    this.error = null;
    this.emit();
  }

  /**
   * This link died locally (ICE failure, or a channel closed with no
   * authoritative reason). Only this pair is affected: tear it down and - on
   * the initiator side only - rebuild after a short delay. The non-initiator
   * simply waits; the rebuilt side's offer recreates its half lazily (see the
   * `signal` event handler), so both ends converge without ever double-
   * offering.
   */
  private onLinkFailed(peerId: PeerId) {
    if (this.phase === "ended") return;
    this.destroyLink(peerId, "Connection to this peer was lost");

    const self = this.self;
    const peer = this.others.get(peerId);
    if (!self || !peer || peer.away) {
      this.emit();
      return;
    }

    if (isInitiator(self, peer) && !this.rebuildTimers.has(peerId)) {
      const timer = setTimeout(() => {
        this.rebuildTimers.delete(peerId);
        if (this.phase === "ended") return;
        const current = this.others.get(peerId);
        if (!current || current.away) return;
        this.ensureLink(current);
        this.emit();
      }, LINK_REBUILD_DELAY_MS);
      this.rebuildTimers.set(peerId, timer);
    }
    this.emit();
  }

  // ------------------------------------------------------------------ notes

  private onPeerFrame(peerId: PeerId, frame: NoteFrame) {
    if (this.phase === "ended") return;
    const author = this.others.get(peerId);

    if (frame.k === "typing") {
      const existing = this.typingTimers.get(peerId);
      if (existing) clearTimeout(existing);
      if (frame.on) {
        this.typingTimers.set(
          peerId,
          setTimeout(() => {
            this.typingTimers.delete(peerId);
            this.emit();
          }, TYPING_EXPIRE_MS),
        );
      } else {
        this.typingTimers.delete(peerId);
      }
      this.emit();
      return;
    }

    if (frame.k === "doc") {
      if (typeof frame.text !== "string" || typeof frame.rev !== "number") return;
      if (!Number.isFinite(frame.rev) || frame.rev < 0) return;

      const at = this.safeTimestamp(frame.at);
      // Last-writer-wins across the whole room: apply only strictly newer
      // edits; equal revisions (concurrent typing) are broken by timestamp.
      const newer = frame.rev > this.doc.rev || (frame.rev === this.doc.rev && at > this.doc.at);
      if (!newer) return;

      this.doc = { text: frame.text.slice(0, MAX_DOC_LENGTH), rev: frame.rev, at, mine: false };
      this.persistDoc();
      this.emit();
      return;
    }

    if (frame.k !== "note" || typeof frame.text !== "string") return;

    this.notes = [
      ...this.notes,
      {
        id:
          typeof frame.id === "string" && frame.id.length > 0 && frame.id.length <= 128
            ? frame.id
            : crypto.randomUUID(),
        text: frame.text.slice(0, MAX_NOTE_LENGTH),
        at: this.safeTimestamp(frame.at),
        // Attribution comes from the link the frame arrived on - the wire
        // frame is untouched, so a peer cannot impersonate another.
        authorId: peerId,
        authorName: author?.name ?? "Peer",
        mine: false,
      },
    ];
    const typing = this.typingTimers.get(peerId);
    if (typing) {
      clearTimeout(typing);
      this.typingTimers.delete(peerId);
    }
    this.emit();
  }

  /** Never trust a peer-supplied timestamp: |at| beyond what Date can
   *  represent makes `new Date(at).toISOString()` throw in the notes panel,
   *  so a single hostile frame would crash the whole room UI. */
  private safeTimestamp(at: unknown): number {
    return typeof at === "number" && Number.isFinite(at) && Math.abs(at) <= MAX_NOTE_TIMESTAMP_MS
      ? at
      : Date.now();
  }

  /** Broadcasts one note to every connected pair and appends it locally. */
  sendNote(rawText: string) {
    const self = this.self;
    const text = rawText.trim().slice(0, MAX_NOTE_LENGTH);
    if (!text || !self || this.phase === "ended") return;

    const frame: NoteFrame = { k: "note", id: crypto.randomUUID(), text, at: Date.now() };
    let delivered = false;
    for (const link of this.links.values()) {
      delivered = link.sendNoteFrame(frame) || delivered;
    }
    if (!delivered) return; // nobody connected; the composer is disabled anyway

    this.notes = [
      ...this.notes,
      { id: frame.id, text, at: frame.at, authorId: self.id, authorName: self.name, mine: true },
    ];
    this.emit();
  }

  setTyping(on: boolean) {
    const frame: NoteFrame = { k: "typing", on };
    for (const link of this.links.values()) link.sendNoteFrame(frame);
  }

  /**
   * Changes the display name everyone sees from now on. Applied to `self`
   * optimistically so the tile answers at once; the roster the server sends
   * back is what holds. Notes already sent keep the name they carried, by the
   * same rule that keeps an author's label after they leave.
   */
  rename(rawName: string) {
    const name = sanitizeName(rawName);
    if (!name || !this.self || this.phase === "ended") return;
    if (name === this.self.name) return;
    this.self = { ...this.self, name };
    void this.signal?.rename(name);
    this.emit();
  }

  // -------------------------------------------------------------------- doc

  private docStorageKey() {
    return `instant-doc-${this.roomId}`;
  }

  private loadDoc(): DocState {
    try {
      const raw = localStorage.getItem(this.docStorageKey());
      if (raw) {
        const saved = JSON.parse(raw) as Partial<DocState>;
        if (typeof saved.text === "string" && typeof saved.rev === "number") {
          return {
            text: saved.text.slice(0, MAX_DOC_LENGTH),
            rev: saved.rev,
            at: typeof saved.at === "number" ? saved.at : 0,
            mine: true,
          };
        }
      }
    } catch {
      // Private browsing or corrupt entry: start empty.
    }
    return { text: "", rev: 0, at: 0, mine: false };
  }

  private persistDoc() {
    try {
      const { text, rev, at } = this.doc;
      localStorage.setItem(this.docStorageKey(), JSON.stringify({ text, rev, at }));
    } catch {
      // Storage full or unavailable: the in-memory copy still works.
    }
  }

  /** Apply a local edit and sync it to every pair (debounced per keystroke). */
  updateDoc(rawText: string) {
    if (this.phase === "ended") return;
    const text = rawText.slice(0, MAX_DOC_LENGTH);
    if (text === this.doc.text) return;

    this.doc = { text, rev: this.doc.rev + 1, at: Date.now(), mine: true };
    this.persistDoc();
    this.emit();

    // Trailing debounce: one frame per pause in typing, and the frame always
    // carries the latest full text, so dropping intermediates loses nothing.
    if (this.docSendTimer) clearTimeout(this.docSendTimer);
    this.docSendTimer = setTimeout(() => {
      this.docSendTimer = null;
      this.sendDocFrame();
    }, 200);
  }

  /** Sends the current doc to one link, or broadcasts it to all. */
  private sendDocFrame(only?: PeerLink | null) {
    const { text, rev, at } = this.doc;
    const frame: NoteFrame = { k: "doc", text, rev, at };
    if (only) {
      only.sendNoteFrame(frame);
      return;
    }
    for (const link of this.links.values()) link.sendNoteFrame(frame);
  }

  // ------------------------------------------------------------------ files

  /** Session-level wiring the per-link transfer engines run against. */
  private transferContext(peer: Participant): FileTransferContext {
    const peerId = peer.id;
    return {
      peerId,
      peerName: peer.name,
      roomId: this.roomId,
      ready: this.infraReady,
      provider: () => this.sinkProvider,
      store: () => this.partialStore,
      lookupOutgoing: (uid) => this.outgoingFiles.get(uid),
      registerOutgoing: (uid, file) => {
        this.outgoingFiles.set(uid, file);
      },
      onResumeMissing: ({ name, received, size }) => {
        // The honest sender-reload story: the File object died with the page,
        // so only the user re-selecting the file can continue the transfer.
        const percent = size > 0 ? Math.round((received / size) * 100) : 0;
        const peerName = this.others.get(peerId)?.name ?? peer.name;
        this.fail(
          `${peerName} already has ${percent}% of "${name}". ` +
            `Re-select the file and send it again to continue from there.`,
        );
      },
      onResumeNack: (uid, reason) => {
        this.partialNotes.set(
          uid,
          reason && reason.trim().length > 0 && reason.length <= 200
            ? reason
            : "The sender must re-select this file to continue",
        );
        this.emitSoon();
      },
      onPartialsChanged: () => {
        void this.refreshPartials();
      },
    };
  }

  /**
   * Streams files to the selected peers - a `SendTargets` list, a single peer
   * id (legacy), or everyone connected. Each file is read from disk exactly
   * once per chunk and fanned out to every recipient's channel; only the
   * 4-byte id framing is per-recipient work (see `sendFileToManagers`).
   */
  async sendFiles(files: File[], to?: SendTargets | PeerId | null) {
    if (files.length === 0 || this.phase === "ended") return;

    const wanted: PeerId[] | null =
      to === undefined || to === null ? null : typeof to === "string" ? [to] : to.to;

    const links =
      wanted === null
        ? [...this.links.values()]
        : wanted
            .map((id) => this.links.get(id))
            .filter((link): link is PeerLink => Boolean(link));

    const managers = links
      .map((link) => link.transferManager)
      .filter((manager): manager is FileTransferManager => manager !== null);
    if (managers.length === 0) return;

    // Sequential per file on purpose: one file saturates the channels, and
    // serialising keeps per-file progress honest instead of showing several
    // stalled bars.
    for (const file of files) {
      // Widen: awaited sends can end the session behind TS's narrowing.
      if ((this.phase as MeshPhase) === "ended") return;
      const uid = crypto.randomUUID();
      this.outgoingFiles.set(uid, file);
      await sendFileToManagers(file, uid, managers);
    }
  }

  /**
   * Asks the sender of a persisted partial (`partial:<uid>` snapshot key) to
   * continue it. Works only while that peer is connected; the engine handles
   * everything else (validation, offsets, honest failure).
   */
  resumeTransfer(key: string) {
    if (!key.startsWith("partial:") || this.phase === "ended") return;
    const uid = key.slice("partial:".length);
    const partial = this.partials.find((p) => p.id === uid);
    if (!partial) return;
    const manager = this.links.get(partial.peerId)?.transferManager;
    if (!manager) {
      this.fail(`${partial.peerName} is not connected right now, so "${partial.name}" cannot continue yet.`);
      return;
    }
    this.partialNotes.delete(uid);
    manager.requestResume(partial);
  }

  /** Forgets a persisted partial (`partial:<uid>` key): record and bytes. */
  discardPartial(key: string) {
    if (!key.startsWith("partial:")) return;
    const uid = key.slice("partial:".length);
    this.partialNotes.delete(uid);
    const store = this.partialStore;
    if (!store) return;
    void store.discard(uid).then(() => this.refreshPartials());
  }

  /** Prompts for a save folder (must be called from a user gesture). */
  async chooseSaveFolder(): Promise<boolean> {
    const chosen = await this.sinkProvider.chooseFolder();
    this.emit(); // capability changed either way (label, tier)
    return chosen;
  }

  /** Forgets the chosen folder; the provider falls back to the next tier. */
  clearSaveFolder() {
    this.sinkProvider.clearFolder();
    this.emit();
  }

  /** `key` is the mesh-unique snapshot key (`<linkUid>:<out|in>:<n>`). */
  cancelTransfer(key: string) {
    const split = key.indexOf(":");
    if (split === -1) return;
    const uid = key.slice(0, split);
    const inner = key.slice(split + 1);
    for (const link of this.links.values()) {
      if (link.uid === uid) {
        link.cancelTransfer(inner);
        return;
      }
    }
    // Retired managers hold no cancellable (running) transfers.
  }

  // ------------------------------------------------------------------ media

  async toggleMic() {
    if (this.micTrack) {
      const track = this.micTrack;
      this.micTrack = null;
      track.onended = null;
      // Stopped, not just detached from the slot: leaving the capture running
      // would keep the browser's recording indicator lit, which would make
      // "muted" a lie.
      track.stop();
      this.localStream.removeTrack(track);
      this.syncMic();
      this.bumpMedia();
      return;
    }
    const stream = await this.requestMic();
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    this.micTrack = track;
    this.localStream.addTrack(track);
    this.syncMic();
    this.bumpMedia();
  }

  /**
   * Switches the microphone or camera to another device. Remembered either
   * way; when that capture is live right now, the new device is opened FIRST
   * and only then does the old track stop and the new one take its slot in
   * every link, so a device that cannot be opened leaves the call exactly as
   * it was (the error goes to the caller). The slot swap is a `replaceTrack`,
   * so nobody renegotiates.
   */
  async setInputDevice(kind: "audioinput" | "videoinput", deviceId: string | null) {
    this.inputChoice[kind] = deviceId;
    if (this.phase === "ended") return;

    if (kind === "audioinput") {
      const current = this.micTrack;
      if (!current || sameDevice(current, deviceId)) return;
      const stream = await this.requestMic();
      const next = stream.getAudioTracks()[0];
      if (!next) return;
      // The mic may have been turned off while the prompt was up.
      if (this.micTrack !== current) {
        next.stop();
        return;
      }
      current.onended = null;
      current.stop();
      this.localStream.removeTrack(current);
      this.micTrack = next;
      this.localStream.addTrack(next);
      this.syncMic();
      this.bumpMedia();
      return;
    }

    const current = this.cameraTrack;
    if (!current || sameDevice(current, deviceId)) return;
    const stream = await this.requestCamera();
    const next = stream.getVideoTracks()[0];
    if (!next) return;
    if (this.cameraTrack !== current) {
      next.stop();
      return;
    }
    current.onended = null;
    current.stop();
    this.localStream.removeTrack(current);
    this.cameraTrack = next;
    this.localStream.addTrack(next);
    // Screen share owns the outgoing video slot while it is on; then the
    // camera is preview-only and the senders carry on untouched.
    if (!this.screenTrack) {
      for (const link of this.links.values()) link.setVideoTrack(next, "camera");
      this.applyAllBudgets();
    }
    this.bumpMedia();
  }

  /**
   * Opens the chosen microphone, or the default when none is chosen. The
   * chosen device is asked for exactly - browsers treat `ideal` as a hint and
   * hand back the default - and if it turns out to be gone (unplugged since
   * last time) the capture retries on the default rather than failing. Any
   * other failure (permission refused, device busy) is the caller's to show.
   */
  private requestMic() {
    const choice = this.inputChoice.audioinput;
    return this.requestWithFallback(
      { audio: choice ? inputConstraint(choice) : true },
      choice ? { audio: true } : null,
    );
  }

  private requestCamera() {
    const choice = this.inputChoice.videoinput;
    const shape = { width: 1280, height: 720 };
    return this.requestWithFallback(
      { video: { ...shape, ...inputConstraint(choice) } },
      choice ? { video: shape } : null,
    );
  }

  private async requestWithFallback(
    constraints: MediaStreamConstraints,
    fallback: MediaStreamConstraints | null,
  ) {
    try {
      return await this.request(constraints);
    } catch (error) {
      if (!fallback || !isMissingDeviceError(error)) throw error;
      return this.request(fallback);
    }
  }

  async toggleCamera() {
    if (this.cameraTrack) {
      const track = this.cameraTrack;
      this.cameraTrack = null;
      track.onended = null;
      track.stop();
      this.localStream.removeTrack(track);
      // Screen share owns the outgoing video slot while it is on; if it is,
      // the camera was preview-only and the senders carry on untouched.
      if (!this.screenTrack) {
        for (const link of this.links.values()) link.setVideoTrack(null, null);
      }
      this.bumpMedia();
      return;
    }

    const stream = await this.requestCamera();
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    this.cameraTrack = track;
    this.localStream.addTrack(track);

    if (!this.screenTrack) {
      for (const link of this.links.values()) link.setVideoTrack(track, "camera");
      this.applyAllBudgets();
    }
    this.bumpMedia();
  }

  async toggleScreenShare() {
    if (this.screenTrack) {
      this.stopScreenShare();
      return;
    }

    const stream = await this.captureDisplay();
    const track = stream.getVideoTracks()[0];
    const audio = stream.getAudioTracks()[0] ?? null;

    // A capture with no picture is unusable, and a session that ended while the
    // picker was open must not leave one running. Both cases release EVERY
    // track: forgetting the audio half would keep a capture indicator lit with
    // nothing sending.
    if (!track || this.phase === "ended") {
      for (const t of stream.getTracks()) t.stop();
      return;
    }

    this.screenTrack = track;
    this.localStream.addTrack(track);
    // The browser's own "Stop sharing" bar bypasses our UI.
    track.onended = () => this.stopScreenShare();

    if (audio) {
      this.screenAudioTrack = audio;
      // The same bar (and, on Chromium, the shared tab simply going away) can
      // end the audio track independently of the video one, so the share-audio
      // slot is cleared from whichever track actually stopped.
      audio.onended = () => this.onScreenAudioEnded();
    }

    for (const link of this.links.values()) link.setVideoTrack(track, "screen");
    this.syncShareAudio();
    // Re-run the budgets: the links now carry screen content, which is exempt,
    // so this pass *clears* the camera caps left on those senders.
    this.applyAllBudgets();
    this.bumpMedia();
  }

  /**
   * Opens a display capture, asking for audio.
   *
   * Audio is requested every time it might be granted: on Chromium the ask is
   * what puts the "also share tab/system audio" tick box in the picker, and the
   * user ticking it is the ONLY way to get it - it cannot be forced. Resolving
   * with zero audio tracks is therefore normal, not a failure; the share simply
   * proceeds silently.
   */
  private async captureDisplay(): Promise<MediaStream> {
    const media = navigator.mediaDevices;
    if (!media?.getDisplayMedia) {
      throw new Error("This browser does not support screen sharing.");
    }

    // A browser that has already proved it refuses the audio ask is never asked
    // again: the retry below costs a second trip through the picker, and once is
    // enough to learn from.
    if (this.screenAudioSupport === "unavailable") {
      return media.getDisplayMedia({ video: true, audio: false });
    }

    const startedAt = Date.now();
    try {
      const stream = await media.getDisplayMedia({ video: true, audio: true });
      if (stream.getAudioTracks().length > 0) this.screenAudioSupport = "available";
      // Zero audio tracks leaves the flag alone: an unticked box and a platform
      // that quietly ignores the ask look identical from here.
      return stream;
    } catch (error) {
      if (!shouldRetryWithoutAudio(error, Date.now() - startedAt)) throw error;
      // Firefox and Safari can reject the WHOLE request because audio was asked
      // for, rather than degrading to video only. Without this retry, adding
      // desktop audio would cost those browsers screen sharing altogether.
      const stream = await media.getDisplayMedia({ video: true, audio: false });
      this.screenAudioSupport = "unavailable";
      return stream;
    }
  }

  /**
   * Drops the desktop-audio branch while the picture keeps flowing.
   *
   * There is deliberately no counterpart that turns it back on: only a fresh
   * getDisplayMedia can grant display audio, so re-enabling it means re-picking
   * the source. A UI toggle here would be a switch that cannot switch back.
   */
  stopScreenAudio() {
    if (!this.screenAudioTrack) return;
    this.releaseScreenAudio();
    this.syncShareAudio();
    this.bumpMedia();
  }

  /** The display audio track ended on its own (sharing bar, or the shared tab
   *  went away). The video share, if any, is untouched. */
  private onScreenAudioEnded() {
    if (this.phase === "ended") return;
    this.stopScreenAudio();
  }

  private stopScreenShare() {
    if (!this.screenTrack) return;
    this.screenTrack.onended = null;
    this.screenTrack.stop();
    this.localStream.removeTrack(this.screenTrack);
    this.screenTrack = null;
    // The desktop audio came from THIS capture, so it ends with it: leaving a
    // soundtrack playing from a screen nobody can see any more would be a
    // stranger outcome than silence, and the user asked to stop *sharing*.
    this.releaseScreenAudio();
    this.syncShareAudio();

    // Hand the video slot back to the camera if it is still running; with no
    // camera left, the senders are removed outright so each peer's track mutes.
    if (this.cameraTrack) {
      const track = this.cameraTrack;
      for (const link of this.links.values()) link.setVideoTrack(track, "camera");
      this.applyAllBudgets();
    } else {
      for (const link of this.links.values()) link.setVideoTrack(null, null);
    }
    this.bumpMedia();
  }

  /** Releases the display-audio capture only. Callers `syncShareAudio` after. */
  private releaseScreenAudio() {
    const track = this.screenAudioTrack;
    if (!track) return;
    this.screenAudioTrack = null;
    track.onended = null;
    track.stop();
  }

  /**
   * Fans the microphone out to every link's mic slot. The ONLY writer of that
   * slot, which is what makes a host mute provably scoped: it can move nothing
   * but the microphone (see the `moderated` handler).
   *
   * A slot swap is a `replaceTrack` on a sender that already exists, so this
   * renegotiates nothing - the mesh no longer pays 6 SDP round trips to mute.
   */
  private syncMic() {
    for (const link of this.links.values()) link.setMicTrack(this.micTrack);
  }

  /** Fans shared desktop audio out to every link's share-audio slot. The only
   *  writer of that slot; nothing about the microphone can reach it. */
  private syncShareAudio() {
    for (const link of this.links.values()) link.setShareAudioTrack(this.screenAudioTrack);
  }

  private async request(constraints: MediaStreamConstraints) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not expose camera or microphone access.");
    }
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    if (this.phase === "ended") {
      for (const track of stream.getTracks()) track.stop();
      throw new Error("Session ended");
    }
    return stream;
  }

  /**
   * The budget counts the peers actually meshed with us (non-away seats,
   * self included): each of them costs one uploaded copy of our video, which
   * is what a home uplink runs out of. Away seats cost nothing - their
   * connection is gone - so they do not depress everyone else's quality.
   */
  private currentBudget() {
    let count = 1; // self
    for (const p of this.others.values()) {
      if (!p.away) count += 1;
    }
    return videoBudget(count);
  }

  /** Re-applied on every membership/away change and device toggle. Each link
   *  exempts screen-share content itself (see PeerLink.applyVideoBudget). */
  private applyAllBudgets() {
    const budget = this.currentBudget();
    for (const link of this.links.values()) link.applyVideoBudget(budget);
  }

  private bumpMedia() {
    this.mediaVersion += 1;
    this.emit();
  }

  // ----------------------------------------------------------- host controls

  /** Host only: answer a knock. Optimistically clears it from the list. */
  admit(knockId: string, allow: boolean) {
    if (!this.isHost || this.phase === "ended") return;
    this.knocks = this.knocks.filter((k) => k.knockId !== knockId);
    void this.signal?.admit(knockId, allow);
    this.emit();
  }

  /** Host only: raise/lower the participant limit. Roster event confirms. */
  setCapacity(value: number) {
    if (!this.isHost || this.phase === "ended") return;
    void this.signal?.setCapacity(value);
  }

  /**
   * Host only: open the room to anyone with the link, or make arrivals knock
   * again. Applied optimistically so the toggle answers the click; the roster
   * the server sends back is what actually holds. Opening seats whoever is
   * waiting, so the local knock list is cleared for the same reason `admit`
   * clears one entry: the server is about to resolve them all.
   */
  setVisibility(value: RoomVisibility) {
    if (!this.isHost || this.phase === "ended") return;
    if (this.visibility === value) return;
    this.visibility = value;
    if (value === "public") this.knocks = [];
    void this.signal?.setVisibility(value);
    this.emit();
  }

  /** Host only: eject a participant. The `peer-left` event confirms. */
  removePeer(peerId: PeerId) {
    if (!this.isHost || this.phase === "ended") return;
    void this.signal?.removePeer(peerId);
  }

  /** Host only: pin one participant for everyone (null clears). Applied
   *  optimistically so the host's own UI does not wait for the echo. */
  pin(peerId: PeerId | null) {
    if (!this.isHost || this.phase === "ended") return;
    this.pinnedByHost = peerId;
    void this.signal?.pin(peerId);
    this.emit();
  }

  /** Host only: moderate one participant's devices, or everyone else's when
   *  `peerId` is null. The local guard only saves a pointless request - the
   *  SERVER is what enforces host-ness (403 for anyone else). */
  moderate(peerId: PeerId | null, action: ModerationAction) {
    if (!this.isHost || this.phase === "ended") return;
    void this.signal?.moderate(peerId, action);
  }

  /**
   * Host only: hand the room to `peerId` and stay in it as a guest.
   *
   * Nothing is asserted locally. The server is the authority: it emits
   * `host-changed` to everyone (`becameHost: true` only in the new host's
   * copy) plus a fresh roster, and `isHost` on every client - this one
   * included - follows that roster. So a host who transfers and then
   * `leave()`s cannot re-assert host-ness locally: no code path sets
   * `isHost` except `welcome` and the roster.
   */
  transferHost(peerId: PeerId) {
    if (!this.isHost || this.phase === "ended") return;
    if (!this.self || peerId === this.self.id) return;
    void this.signal?.transferHost(peerId);
  }
}
