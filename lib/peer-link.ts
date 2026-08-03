import {
  FileTransferManager,
  type FileTransferContext,
  type Transfer,
} from "@/lib/file-transfer";
import { CHANNEL, type NoteFrame } from "@/lib/peer-protocol";
import {
  isPolite,
  type Participant,
  type PeerId,
  type SignalPayload,
} from "@/lib/signal-protocol";

/**
 * One peer-to-peer connection inside the mesh: exactly one RTCPeerConnection,
 * its two data channels, its remote MediaStream, and its own perfect-
 * negotiation state. `MeshSession` owns one PeerLink per remote participant.
 *
 * A link is deliberately self-contained: it never touches another link's
 * state, and every failure it can detect is reported *upward* through
 * callbacks rather than acted on globally, so one pair's bad network cannot
 * disturb the rest of the room.
 */

export type PeerLinkState = "connecting" | "connected" | "failed" | "closed";

/** Matches the shape returned by `videoBudget()` in the wire contract. */
export type VideoBudget = { height: number; maxBitrateKbps: number; frameRate: number };

export type PeerLinkCallbacks = {
  /** Route one negotiation payload to this link's remote peer. */
  signal(payload: SignalPayload): void;
  /** The link's connection state changed (connecting/connected/failed). */
  onStateChange(): void;
  /** Fired once, when both data channels first open. */
  onConnected(): void;
  /** A remote track was added, removed, muted or unmuted. */
  onMediaChange(): void;
  /** A parsed frame arrived on the notes channel. Attribution is implicit:
   *  the frame arrived on *this* link, so it was sent by *this* peer. */
  onNoteFrame(frame: NoteFrame): void;
  /** File-transfer progress on this link changed (high-frequency). */
  onTransfersChange(): void;
  /** The link is dead (ICE failed, or a channel closed with no authoritative
   *  reason). Fired at most once. The mesh decides whether to rebuild. */
  onFailed(): void;
  /** Non-fatal problem worth surfacing to the user. */
  onError(message: string): void;
};

export type PeerLinkOptions = {
  selfId: PeerId;
  remote: Participant;
  /** From `isInitiator(self, remote)`: the initiator creates the data
   *  channels, which triggers the pair's very first offer. */
  initiator: boolean;
  /** Unique per link *instance* (a returning peer gets a fresh link), so
   *  transfer keys from an old incarnation can never collide with new ones. */
  uid: string;
  /** The mesh's shared local preview stream; used only to group our outgoing
   *  tracks under one stream id for the receiver. */
  localStream: MediaStream;
  /** Session-level wiring for the file-transfer engine (sinks, resume). */
  transferContext?: FileTransferContext;
  callbacks: PeerLinkCallbacks;
};

/**
 * All five of Google's public STUN servers plus Twilio's: candidate gathering
 * races them, so a slow or unreachable one costs nothing and P2P setup finds
 * a working reflexive address sooner.
 */
const STUN_SERVERS = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
  "stun:stun2.l.google.com:19302",
  "stun:stun3.l.google.com:19302",
  "stun:stun4.l.google.com:19302",
  "stun:global.stun.twilio.com:3478",
];

/** How long a `disconnected` ICE state may persist before the link is dead. */
const ICE_GRACE_MS = 9000;

/**
 * How long to wait, after a data channel closes, for an authoritative reason
 * (`peer-left`, `peer-away`, `ended`) to arrive over signalling. When one
 * does, the mesh destroys this link and the timer dies unfired - so a
 * deliberate departure is never misreported as a connection drop.
 */
const CLOSE_REASON_GRACE_MS = 1500;

/**
 * Ceiling on candidates buffered while waiting for a remote description. A
 * normal negotiation produces a handful; this only exists so a peer that never
 * sends an SDP cannot grow the queue without bound.
 */
const MAX_PENDING_CANDIDATES = 128;

/**
 * How long a link may sit un-connected before the negotiation is retried.
 * Generous enough to cover slow mobile ICE gathering, so a healthy-but-slow
 * link is never disturbed.
 */
const NEGOTIATION_TIMEOUT_MS = 12_000;

/** Retries before the link is declared failed and the mesh rebuilds it. */
const MAX_NEGOTIATION_ATTEMPTS = 3;

function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: STUN_SERVERS }];

  // Optional relay for peers behind symmetric NAT. Absent by default - the app
  // has no backend dependency unless you choose to add one.
  const turnUrl = process.env.NEXT_PUBLIC_TURN_URL;
  if (turnUrl) {
    servers.push({
      urls: turnUrl,
      username: process.env.NEXT_PUBLIC_TURN_USERNAME,
      credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL,
    });
  }
  return servers;
}

export class PeerLink {
  readonly uid: string;
  readonly peerId: PeerId;
  /** Exposed for the dev-only debug handle and ICE stats; do not mutate. */
  readonly connection: RTCPeerConnection;
  /** All tracks this peer sends us. Stable identity for the link's lifetime. */
  readonly remoteStream = new MediaStream();

  private readonly initiator: boolean;
  private readonly polite: boolean;
  private readonly localStream: MediaStream;
  private readonly transferContext?: FileTransferContext;
  private readonly callbacks: PeerLinkCallbacks;

  private _state: PeerLinkState = "connecting";
  private destroyed = false;
  private failureReported = false;

  // --- perfect negotiation, per pair -------------------------------------
  private makingOffer = false;
  private ignoreOffer = false;
  /** True once any remote description has been applied; before that, the
   *  non-initiator suppresses its own offers (see onnegotiationneeded). */
  private seenRemoteDescription = false;
  private iceRestarted = false;
  private iceTimer: ReturnType<typeof setTimeout> | null = null;
  private closeGrace: ReturnType<typeof setTimeout> | null = null;
  /** A channel raised `error` during the current grace wait. Only if the wait
   *  expires unexplained is it worth telling the user about. */
  private sawChannelError = false;
  /** Watches for a negotiation that never completes. See armNegotiationWatchdog. */
  private negotiationTimer: ReturnType<typeof setTimeout> | null = null;
  private negotiationAttempts = 0;
  /**
   * Candidates received before a remote description existed to attach them
   * to. Signalling payloads are independent HTTP requests with no ordering
   * guarantee, so a candidate can outrun the description it belongs to -
   * common on mobile, where the SDP is larger and the uplink slower. Adding
   * one early throws "the remote description is null", so hold it. This
   * buffer is per link: every pair negotiates independently.
   */
  private pendingCandidates: Array<RTCIceCandidateInit | null> = [];

  // --- channels and media -------------------------------------------------
  private notesChannel: RTCDataChannel | null = null;
  private filesChannel: RTCDataChannel | null = null;
  private files: FileTransferManager | null = null;
  private audioSender: RTCRtpSender | null = null;
  private videoSender: RTCRtpSender | null = null;
  /** What currently occupies the (single) outgoing video slot. */
  private videoContent: "camera" | "screen" | null = null;

  constructor(options: PeerLinkOptions) {
    this.uid = options.uid;
    this.peerId = options.remote.id;
    this.initiator = options.initiator;
    this.polite = isPolite(options.selfId, options.remote.id);
    this.localStream = options.localStream;
    this.transferContext = options.transferContext;
    this.callbacks = options.callbacks;

    const pc = new RTCPeerConnection({ iceServers: iceServers(), bundlePolicy: "max-bundle" });
    this.connection = pc;

    pc.onnegotiationneeded = async () => {
      if (this.destroyed) return;
      // The initiator always negotiates first (it created the data channels,
      // so it always has something to offer). The non-initiator holds its own
      // additions back until that first offer has been applied: per spec the
      // browser re-fires negotiationneeded when the connection returns to
      // stable with un-negotiated changes, so nothing is lost - and the pair's
      // setup never *starts* with two offers in flight.
      if (!this.initiator && !this.seenRemoteDescription) return;
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription) {
          this.callbacks.signal({ kind: "description", description: pc.localDescription });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not create an offer";
        this.callbacks.onError(message);
      } finally {
        this.makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (this.destroyed) return;
      this.callbacks.signal({ kind: "candidate", candidate: candidate ? candidate.toJSON() : null });
    };

    pc.ondatachannel = ({ channel }) => this.attachChannel(channel);

    pc.ontrack = ({ track }) => {
      if (this.destroyed) return;
      this.remoteStream.addTrack(track);

      const refresh = () => {
        if (!this.destroyed) this.callbacks.onMediaChange();
      };
      track.addEventListener("mute", refresh);
      track.addEventListener("unmute", refresh);
      track.addEventListener("ended", () => {
        this.remoteStream.removeTrack(track);
        refresh();
      });

      this.callbacks.onMediaChange();
    };

    pc.onconnectionstatechange = () => {
      if (this.destroyed) return;
      if (pc.connectionState === "failed") {
        this.fail();
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (this.destroyed) return;
      const state = pc.iceConnectionState;

      if (state === "connected" || state === "completed") {
        if (this.iceTimer) {
          clearTimeout(this.iceTimer);
          this.iceTimer = null;
        }
        this.iceRestarted = false;
        return;
      }

      if (state !== "disconnected") return;

      // A brief blip (Wi-Fi handover) is worth one restart attempt; a
      // sustained outage means this pair is done - but only this pair.
      // Exactly one side restarts, the impolite one, so the restart offer
      // cannot glare with a symmetric restart from the other end.
      if (!this.iceRestarted && !this.polite) {
        this.iceRestarted = true;
        try {
          pc.restartIce();
        } catch {
          // Older stacks: fall through to the grace timer.
        }
      }
      if (!this.iceTimer) {
        this.iceTimer = setTimeout(() => {
          this.iceTimer = null;
          if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
            return;
          }
          this.fail();
        }, ICE_GRACE_MS);
      }
    };

    // The initiator owns channel creation; creating them is also what kicks
    // off the pair's first negotiation. Both ordered and reliable: notes must
    // arrive in order, and a missing file chunk is unrecoverable.
    if (this.initiator) {
      this.attachChannel(pc.createDataChannel(CHANNEL.notes, { ordered: true }));
      this.attachChannel(pc.createDataChannel(CHANNEL.files, { ordered: true }));
    }

    // Armed for both sides from the moment the link exists: a lost offer and a
    // lost answer are both invisible failures, and neither side can tell which
    // happened.
    this.armNegotiationWatchdog();
  }

  get state(): PeerLinkState {
    return this._state;
  }

  get notesOpen(): boolean {
    return this.notesChannel?.readyState === "open";
  }

  get filesOpen(): boolean {
    return this.filesChannel?.readyState === "open";
  }

  transfers(): Transfer[] {
    return this.files?.list() ?? [];
  }

  /** The live transfer engine for this link, for session-level fan-out and
   *  resume orchestration. Null until the files channel is attached. */
  get transferManager(): FileTransferManager | null {
    return this.files;
  }

  // ------------------------------------------------------------ negotiation

  /** Applies one relayed payload from this link's peer (perfect negotiation). */
  async handleSignal(payload: SignalPayload) {
    if (this.destroyed) return;
    const pc = this.connection;

    try {
      if (payload.kind === "description") {
        const description = payload.description;
        const collision =
          description.type === "offer" && (this.makingOffer || pc.signalingState !== "stable");

        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;

        await pc.setRemoteDescription(description);
        this.seenRemoteDescription = true;
        // A description is now in place, so anything that arrived early can be
        // applied. Do this before answering: it gets candidates into the ICE
        // agent at the earliest possible moment.
        await this.flushPendingCandidates();

        if (description.type === "offer") {
          await pc.setLocalDescription();
          if (pc.localDescription) {
            this.callbacks.signal({ kind: "description", description: pc.localDescription });
          }
        }
        return;
      }

      if (!pc.remoteDescription) {
        if (this.pendingCandidates.length < MAX_PENDING_CANDIDATES) {
          this.pendingCandidates.push(payload.candidate);
        }
        return;
      }

      await this.addCandidate(payload.candidate);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Negotiation failed";
      this.callbacks.onError(`Connection negotiation failed: ${message}`);
    }
  }

  /** Applies one candidate, tolerating the ones we deliberately dropped. */
  private async addCandidate(candidate: RTCIceCandidateInit | null) {
    try {
      await this.connection.addIceCandidate(candidate ?? undefined);
    } catch (error) {
      // Expected when we deliberately dropped the offer these belong to; a
      // rolled-back description also invalidates candidates already queued.
      if (!this.ignoreOffer) throw error;
    }
  }

  /**
   * Drains candidates that arrived before any remote description. A failure
   * here must not abort the rest: one stale candidate from a superseded
   * negotiation should not prevent the valid ones from being applied.
   */
  private async flushPendingCandidates() {
    if (this.pendingCandidates.length === 0) return;

    const queued = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of queued) {
      try {
        await this.addCandidate(candidate);
      } catch {
        // Keep going; ICE only needs one workable pair.
      }
    }
  }

  // ---------------------------------------------------------------- channels

  private attachChannel(channel: RTCDataChannel) {
    // A non-conforming peer can announce a second channel with a label we have
    // already bound. Replacing the live one would strand its listeners - and
    // for files, orphan a FileTransferManager whose object URLs never get
    // revoked. Keep the first, refuse the duplicate.
    if (
      (channel.label === CHANNEL.notes && this.notesChannel) ||
      (channel.label === CHANNEL.files && this.filesChannel)
    ) {
      try {
        channel.close();
      } catch {
        // Never opened; nothing to release.
      }
      return;
    }

    if (channel.label === CHANNEL.notes) {
      this.notesChannel = channel;
      channel.addEventListener("message", (event) => this.onNoteMessage(event));
    } else if (channel.label === CHANNEL.files) {
      this.filesChannel = channel;
      channel.binaryType = "arraybuffer";
      this.files = new FileTransferManager(
        channel,
        {
          onChange: () => {
            if (!this.destroyed) this.callbacks.onTransfersChange();
          },
          onError: (message) => {
            if (!this.destroyed) this.callbacks.onError(message);
          },
        },
        this.transferContext,
      );
    } else {
      // Unexpected label: an out-of-spec peer. Refuse it rather than guess.
      try {
        channel.close();
      } catch {
        // Ignore.
      }
      return;
    }

    channel.addEventListener("open", () => {
      if (this.destroyed) return;
      if (this.notesChannel?.readyState === "open" && this.filesChannel?.readyState === "open") {
        this._state = "connected";
        this.clearNegotiationWatchdog();
        this.callbacks.onStateChange();
        this.callbacks.onConnected();
      }
    });

    // The channel dying is terminal for this link either way, but the events
    // do not say *why*. A peer that pressed Leave (or was removed, or whose
    // host just closed the room) tears its RTCPeerConnection down while the
    // authoritative signalling event (`peer-left`, `peer-away`, `ended`) is
    // still in flight; that event makes the mesh destroy this link, and the
    // grace timer dies with it, unfired. Only when nothing authoritative
    // arrives do we conclude the connection actually dropped.
    //
    // `error` is handled through the SAME grace wait as `close`, not reported
    // on the spot: a deliberate remote pc.close() raises `error` on the
    // channels it kills, and it fires BEFORE `close` -- so any guard keyed on
    // the close handler having already run can never catch it. Report the
    // error only if the grace expires unexplained; that keeps a genuine
    // transport failure loud while a clean goodbye stays clean.
    channel.addEventListener("close", () => {
      if (this.destroyed) return;
      this.armCloseGrace();
    });

    channel.addEventListener("error", () => {
      if (this.destroyed) return;
      this.sawChannelError = true;
      this.armCloseGrace();
    });
  }

  private onNoteMessage(event: MessageEvent) {
    if (this.destroyed || typeof event.data !== "string") return;

    let frame: NoteFrame;
    try {
      frame = JSON.parse(event.data) as NoteFrame;
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object" || typeof frame.k !== "string") return;

    // Semantic validation (lengths, timestamps, revisions) happens in the
    // mesh, which owns the room-level transcript this frame lands in.
    this.callbacks.onNoteFrame(frame);
  }

  /** @returns true when the frame was actually handed to an open channel. */
  sendNoteFrame(frame: NoteFrame): boolean {
    if (this.notesChannel?.readyState !== "open") return false;
    this.notesChannel.send(JSON.stringify(frame));
    return true;
  }

  // ------------------------------------------------------------------- files

  async sendFiles(files: File[]) {
    if (!this.files || this.filesChannel?.readyState !== "open" || files.length === 0) return;
    await this.files.sendFiles(files);
  }

  cancelTransfer(key: string) {
    this.files?.cancel(key);
  }

  // ------------------------------------------------------------------- media

  /** Attach/replace/remove the outgoing microphone track. */
  setAudioTrack(track: MediaStreamTrack | null) {
    if (this.destroyed) return;
    if (track === null) {
      if (this.audioSender) {
        this.removeSender(this.audioSender);
        this.audioSender = null;
      }
      return;
    }
    if (this.audioSender) {
      // replaceTrack, not remove+add: it swaps the payload without an SDP
      // round trip, so toggling a device does not renegotiate the whole mesh.
      void this.audioSender.replaceTrack(track);
      return;
    }
    this.audioSender = this.connection.addTrack(track, this.localStream);
  }

  /**
   * Attach/replace/remove the single outgoing video slot (camera or screen).
   * removeTrack rather than replaceTrack(null) on removal: merely stopping
   * the RTP flow never mutes the receiver's track in Chromium, so the peer
   * would keep rendering a frozen last frame. Removing the sender
   * renegotiates and the peer's track goes muted, which is what drives its
   * "camera off" UI.
   */
  setVideoTrack(track: MediaStreamTrack | null, content: "camera" | "screen" | null) {
    if (this.destroyed) return;
    if (track === null) {
      if (this.videoSender) {
        this.removeSender(this.videoSender);
        this.videoSender = null;
      }
      this.videoContent = null;
      return;
    }
    this.videoContent = content;
    if (this.videoSender) {
      void this.videoSender.replaceTrack(track);
      return;
    }
    this.videoSender = this.connection.addTrack(track, this.localStream);
  }

  /**
   * Caps the outgoing camera encoding to the mesh-wide budget. Screen share
   * is exempt on purpose: it is usually the point of the call, mostly static,
   * and compresses far better than a camera feed - so when the slot carries a
   * screen track the caps are *cleared*, including any left over from the
   * camera that occupied this sender a moment ago.
   */
  applyVideoBudget(budget: VideoBudget) {
    if (this.destroyed || !this.videoSender) return;
    const sender = this.videoSender;

    // setParameters demands the object last returned by getParameters -
    // building encodings from scratch throws InvalidModificationError.
    const parameters = sender.getParameters();
    if (!parameters.encodings || parameters.encodings.length === 0) {
      // Before the first negotiation completes some engines report no
      // encodings yet; the mesh re-applies budgets when the link connects.
      return;
    }
    const encoding = parameters.encodings[0];

    if (this.videoContent === "screen") {
      encoding.maxBitrate = undefined;
      encoding.maxFramerate = undefined;
      encoding.scaleResolutionDownBy = undefined;
    } else {
      const captureHeight = sender.track?.getSettings().height ?? 720;
      encoding.maxBitrate = budget.maxBitrateKbps * 1000;
      encoding.maxFramerate = budget.frameRate;
      encoding.scaleResolutionDownBy = Math.max(1, captureHeight / budget.height);
    }

    sender.setParameters(parameters).catch(() => {
      // Transient (a concurrent negotiation raced us). The budget is
      // re-applied on every participant-count change, so a miss self-heals.
    });
  }

  private removeSender(sender: RTCRtpSender) {
    try {
      this.connection.removeTrack(sender);
    } catch {
      // The connection is already closing; nothing left to renegotiate.
    }
  }

  // -------------------------------------------------- negotiation watchdog

  /**
   * Guards against a negotiation that silently never completes.
   *
   * Signalling payloads are independent POSTs, so an offer or answer can simply
   * be lost. Nothing in WebRTC reports that: ICE never starts, no state change
   * fires, and the link sits in "connecting" forever. With one peer that was a
   * rare annoyance; a 7-way mesh has 21 links, so the same per-link risk turns
   * into a likely-broken session, which is why this exists.
   *
   * Both sides arm it, because either direction's message can be the one lost:
   * the side that offered re-sends, and a side that has heard nothing makes its
   * own offer. That deliberately bypasses the non-initiator's usual offer
   * suppression -- if the collision is real, perfect negotiation resolves it.
   */
  private armNegotiationWatchdog() {
    if (this.destroyed || this._state === "connected" || this.negotiationTimer) return;

    this.negotiationTimer = setTimeout(() => {
      this.negotiationTimer = null;
      if (this.destroyed || this._state === "connected") return;

      this.negotiationAttempts += 1;
      if (this.negotiationAttempts > MAX_NEGOTIATION_ATTEMPTS) {
        // Out of retries: hand it to the mesh, which rebuilds the link from
        // scratch rather than nursing this connection any further.
        this.fail();
        return;
      }

      void this.renegotiate();
      this.armNegotiationWatchdog();
    }, NEGOTIATION_TIMEOUT_MS);
    this.negotiationTimer.unref?.();
  }

  private clearNegotiationWatchdog() {
    if (this.negotiationTimer) {
      clearTimeout(this.negotiationTimer);
      this.negotiationTimer = null;
    }
  }

  /** One retry attempt: resend what we have, or open negotiation ourselves. */
  private async renegotiate() {
    const pc = this.connection;
    if (this.destroyed || pc.signalingState === "closed") return;

    try {
      if (pc.signalingState !== "stable" && pc.localDescription) {
        // We are mid-negotiation with a local description already set, so the
        // likely loss is that description in transit. Resending is idempotent.
        this.callbacks.signal({ kind: "description", description: pc.localDescription });
        return;
      }

      // Stable with no connection means either our offer never arrived or the
      // offer we were waiting for never came. Offering covers both.
      this.makingOffer = true;
      await pc.setLocalDescription();
      if (pc.localDescription && !this.destroyed) {
        this.callbacks.signal({ kind: "description", description: pc.localDescription });
      }
    } catch {
      // Leave it to the next watchdog tick; a transient failure here is not
      // worth surfacing to the user while retries remain.
    } finally {
      this.makingOffer = false;
    }
  }

  // ---------------------------------------------------------------- teardown

  /**
   * Starts (or joins) the wait for an authoritative reason after a channel
   * reported `close` or `error`. If the mesh destroys this link first (a
   * `peer-left`/`peer-away`/`ended` arrived), the timer is cleared in
   * destroy() and nothing is ever reported. Only an unexplained expiry
   * surfaces the buffered channel error and declares the link dead.
   */
  private armCloseGrace() {
    if (this.closeGrace) return;
    this.closeGrace = setTimeout(() => {
      this.closeGrace = null;
      if (this.sawChannelError) {
        this.sawChannelError = false;
        this.callbacks.onError("A data channel reported an error.");
      }
      // An `error` with both channels still open was transient (e.g. a failed
      // send): worth reporting, not worth tearing a working link down for.
      if (this.notesOpen && this.filesOpen) return;
      this.fail();
    }, CLOSE_REASON_GRACE_MS);
  }

  /** Funnel for every locally-detected death of this link. Fires once. */
  private fail() {
    if (this.destroyed || this.failureReported) return;
    this.failureReported = true;
    this._state = "failed";
    this.callbacks.onStateChange();
    this.callbacks.onFailed();
  }

  /**
   * Total, idempotent teardown of this link only. Never touches shared local
   * tracks - the mesh owns those; this link merely borrowed them.
   *
   * @param failTransfersReason marks still-running transfers failed. Pass
   *   `null` when they were already resolved (e.g. session end handles it).
   * @returns the FileTransferManager, NOT disposed: completed incoming files
   *   keep their object URLs so a peer leaving does not snatch back what it
   *   already sent. The mesh retires the manager and disposes it at end().
   */
  destroy(failTransfersReason: string | null): FileTransferManager | null {
    if (this.destroyed) return null;
    this.destroyed = true;
    if (this._state !== "failed") this._state = "closed";

    if (this.iceTimer) {
      clearTimeout(this.iceTimer);
      this.iceTimer = null;
    }
    if (this.closeGrace) {
      clearTimeout(this.closeGrace);
      this.closeGrace = null;
    }
    this.clearNegotiationWatchdog();
    this.pendingCandidates = [];

    const files = this.files;
    this.files = null;
    if (files && failTransfersReason !== null) {
      files.failAll(failTransfersReason);
    }

    for (const channel of [this.notesChannel, this.filesChannel]) {
      try {
        channel?.close();
      } catch {
        // Already closed with the peer connection.
      }
    }
    this.notesChannel = null;
    this.filesChannel = null;

    for (const track of this.remoteStream.getTracks()) {
      track.stop();
      this.remoteStream.removeTrack(track);
    }

    const pc = this.connection;
    pc.ontrack = null;
    pc.ondatachannel = null;
    pc.onicecandidate = null;
    pc.onnegotiationneeded = null;
    pc.onconnectionstatechange = null;
    pc.oniceconnectionstatechange = null;
    try {
      pc.close();
    } catch {
      // Nothing to do; we are discarding it anyway.
    }

    this.audioSender = null;
    this.videoSender = null;
    this.videoContent = null;

    return files;
  }
}
