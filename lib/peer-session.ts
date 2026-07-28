import { FileTransferManager, type Transfer } from "@/lib/file-transfer";
import {
  CHANNEL,
  MAX_NOTE_LENGTH,
  type NoteFrame,
} from "@/lib/peer-protocol";
import { SignalClient } from "@/lib/signal-client";
import type { EndReason, PeerRole, ServerEvent, SignalPayload } from "@/lib/signal-protocol";

export type SessionPhase =
  | "idle"
  | "joining" // opening the signalling stream
  | "waiting" // in the room, alone, waiting for the invitee
  | "connecting" // negotiating ICE/DTLS
  | "connected" // data channels open
  | "ended"; // terminal — requires a brand-new room

export type Note = {
  id: string;
  text: string;
  at: number;
  mine: boolean;
};

export type MediaState = {
  micOn: boolean;
  cameraOn: boolean;
  screenOn: boolean;
  remoteAudioLive: boolean;
  remoteVideoLive: boolean;
  /** Bumped whenever a track is added or removed so views re-attach srcObject. */
  version: number;
};

export type SessionSnapshot = {
  phase: SessionPhase;
  role: PeerRole | null;
  endReason: EndReason | null;
  error: string | null;
  notes: Note[];
  peerTyping: boolean;
  transfers: Transfer[];
  media: MediaState;
  /** True once the file channel can accept data. */
  channelsReady: boolean;
  /** True for the session creator (the room's first occupant). */
  isHost: boolean;
  /** Whether the host has delegated the right to end the session to the guest. */
  guestMayEnd: boolean;
  /** True for the host always; for the guest, mirrors `guestMayEnd`. */
  canEndSession: boolean;
};

/** Timestamps beyond what `Date` can represent would crash `toISOString()`. */
const MAX_NOTE_TIMESTAMP_MS = 8.64e15;

const STUN_SERVERS = ["stun:stun.l.google.com:19302", "stun:global.stun.twilio.com:3478"];

/** How long a `disconnected` ICE state may persist before we give up. */
const ICE_GRACE_MS = 9000;

function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: STUN_SERVERS }];

  // Optional relay for peers behind symmetric NAT. Absent by default — the app
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

/**
 * One browser's half of a strictly two-party session.
 *
 * Lifecycle: `start()` -> joining -> waiting -> connecting -> connected -> `end()`.
 * `end()` is terminal and total: it closes the peer connection, stops every
 * local track, revokes every received-file URL and clears all transcript state.
 * Because the signalling server destroys the room the moment either side
 * disappears, both peers always land in `ended` — there is no half-open state
 * one of them could keep using.
 */
export class PeerSession {
  private pc: RTCPeerConnection | null = null;
  private signal: SignalClient | null = null;
  private files: FileTransferManager | null = null;
  private notesChannel: RTCDataChannel | null = null;
  private filesChannel: RTCDataChannel | null = null;

  private role: PeerRole | null = null;
  private isHost = false;
  private guestMayEnd = false;
  private polite = false;
  private makingOffer = false;
  private ignoreOffer = false;
  private iceRestarted = false;
  private iceTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly localStream = new MediaStream();
  private readonly remoteStream = new MediaStream();
  private audioSender: RTCRtpSender | null = null;
  private videoSender: RTCRtpSender | null = null;
  private micTrack: MediaStreamTrack | null = null;
  private cameraTrack: MediaStreamTrack | null = null;
  private screenTrack: MediaStreamTrack | null = null;

  private notes: Note[] = [];
  private peerTyping = false;
  private typingTimer: ReturnType<typeof setTimeout> | null = null;

  private phase: SessionPhase = "idle";
  private endReason: EndReason | null = null;
  private error: string | null = null;

  private listeners = new Set<() => void>();
  private snapshot: SessionSnapshot = this.build();
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly roomId: string) {}

  // ------------------------------------------------------------------ store

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  getLocalStream = () => this.localStream;
  getRemoteStream = () => this.remoteStream;

  private build(): SessionSnapshot {
    return {
      phase: this.phase,
      role: this.role,
      endReason: this.endReason,
      error: this.error,
      notes: this.notes,
      peerTyping: this.peerTyping,
      transfers: this.files?.list() ?? [],
      media: {
        micOn: Boolean(this.micTrack),
        cameraOn: Boolean(this.cameraTrack),
        screenOn: Boolean(this.screenTrack),
        remoteAudioLive: this.remoteStream
          .getAudioTracks()
          .some((track) => !track.muted && track.readyState === "live"),
        remoteVideoLive: this.remoteStream
          .getVideoTracks()
          .some((track) => !track.muted && track.readyState === "live"),
        version: this.mediaVersion,
      },
      channelsReady: this.filesChannel?.readyState === "open",
      isHost: this.isHost,
      guestMayEnd: this.guestMayEnd,
      canEndSession: this.isHost || this.guestMayEnd,
    };
  }

  private mediaVersion = 0;

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

  private setPhase(phase: SessionPhase) {
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

  // -------------------------------------------------------------- lifecycle

  start() {
    if (this.phase !== "idle") return;
    this.setPhase("joining");

    this.signal = new SignalClient(this.roomId, {
      onEvent: (event) => this.onSignalEvent(event),
      onTransportError: (error) => {
        if (this.phase === "ended") return;
        this.error = error.message;
        this.end("transport-error");
      },
    });

    void this.signal.connect();
  }

  /**
   * Terminal teardown. Idempotent, and safe to call from any callback.
   *
   * `notifyPeer` is true only for a deliberate local hang-up; when we are
   * reacting to the peer's departure the room is already gone.
   */
  end(reason: EndReason, notifyPeer = false) {
    if (this.phase === "ended") return;

    this.endReason = reason;
    this.phase = "ended";

    if (this.iceTimer) {
      clearTimeout(this.iceTimer);
      this.iceTimer = null;
    }
    if (this.typingTimer) {
      clearTimeout(this.typingTimer);
      this.typingTimer = null;
    }

    if (this.signal) {
      const signal = this.signal;
      this.signal = null;
      if (notifyPeer) {
        // The goodbye must reach the server before the stream is torn down:
        // aborting first races the bye POST, and the peer would be told we
        // merely disconnected rather than deliberately ended the session.
        void signal.sayGoodbye().finally(() => signal.close());
      } else {
        signal.close();
      }
    }

    this.files?.failAll("Session ended");
    this.files?.dispose();
    this.files = null;

    for (const channel of [this.notesChannel, this.filesChannel]) {
      try {
        channel?.close();
      } catch {
        // Already closed with the peer connection.
      }
    }
    this.notesChannel = null;
    this.filesChannel = null;

    this.stopLocalMedia();
    for (const track of this.remoteStream.getTracks()) {
      track.stop();
      this.remoteStream.removeTrack(track);
    }

    if (this.pc) {
      this.pc.ontrack = null;
      this.pc.ondatachannel = null;
      this.pc.onicecandidate = null;
      this.pc.onnegotiationneeded = null;
      this.pc.onconnectionstatechange = null;
      this.pc.oniceconnectionstatechange = null;
      try {
        this.pc.close();
      } catch {
        // Nothing to do; we are discarding it anyway.
      }
      this.pc = null;
    }
    if (process.env.NODE_ENV !== "production") {
      delete (window as unknown as Record<string, unknown>).__instantPeerConnection;
    }

    // Wipe the transcript. A session that ended leaves nothing behind for a
    // later occupant of this browser tab to read.
    this.notes = [];
    this.peerTyping = false;
    this.audioSender = null;
    this.videoSender = null;
    this.mediaVersion += 1;

    this.emit();
  }

  private stopLocalMedia() {
    for (const track of [this.micTrack, this.cameraTrack, this.screenTrack]) {
      if (!track) continue;
      track.onended = null;
      track.stop();
    }
    this.micTrack = null;
    this.cameraTrack = null;
    this.screenTrack = null;
    for (const track of this.localStream.getTracks()) {
      this.localStream.removeTrack(track);
    }
  }

  // -------------------------------------------------------------- signalling

  private onSignalEvent(event: ServerEvent) {
    if (this.phase === "ended") return;

    switch (event.t) {
      case "welcome": {
        this.role = event.role;
        this.isHost = event.isHost;
        this.guestMayEnd = event.guestMayEnd;
        // Perfect negotiation: exactly one side must be impolite.
        this.polite = event.role === "responder";
        this.createPeerConnection();
        if (event.peerPresent) {
          this.setPhase("connecting");
        } else {
          this.setPhase("waiting");
        }
        this.emit();
        break;
      }

      case "peer-joined": {
        this.setPhase("connecting");
        // The initiator owns channel creation; that also kicks off negotiation.
        this.openDataChannels();
        break;
      }

      case "signal": {
        void this.onRemoteSignal(event.data);
        break;
      }

      case "permission": {
        this.guestMayEnd = event.guestMayEnd;
        this.emit();
        break;
      }

      case "peer-left": {
        this.end(event.reason);
        break;
      }
    }
  }

  /**
   * Host only: grants or revokes the guest's right to end the session. The
   * server is the authority — a non-host call is refused there too, so the
   * local guard just avoids a pointless request.
   */
  setGuestMayEnd(allow: boolean) {
    if (!this.isHost || this.phase === "ended") return;
    this.guestMayEnd = allow;
    void this.signal?.setPermission(allow);
    this.emit();
  }

  private send(payload: SignalPayload) {
    void this.signal?.send(payload);
  }

  private async onRemoteSignal(payload: SignalPayload) {
    const pc = this.pc;
    if (!pc) return;

    try {
      if (payload.kind === "description") {
        const description = payload.description;
        const collision =
          description.type === "offer" && (this.makingOffer || pc.signalingState !== "stable");

        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;

        await pc.setRemoteDescription(description);
        if (description.type === "offer") {
          await pc.setLocalDescription();
          if (pc.localDescription) {
            this.send({ kind: "description", description: pc.localDescription });
          }
        }
        return;
      }

      try {
        await pc.addIceCandidate(payload.candidate ?? undefined);
      } catch (error) {
        // Expected when we deliberately dropped the offer these belong to.
        if (!this.ignoreOffer) throw error;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Negotiation failed";
      this.fail(`Connection negotiation failed: ${message}`);
    }
  }

  // ------------------------------------------------------- peer connection

  private createPeerConnection() {
    if (this.pc) return;

    const pc = new RTCPeerConnection({ iceServers: iceServers(), bundlePolicy: "max-bundle" });
    this.pc = pc;

    // Development-only handle so the end-to-end script can inspect ICE stats and
    // confirm the chosen route is actually peer-to-peer.
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as Record<string, unknown>).__instantPeerConnection = pc;
    }

    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription) {
          this.send({ kind: "description", description: pc.localDescription });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not create an offer";
        this.fail(message);
      } finally {
        this.makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      this.send({ kind: "candidate", candidate: candidate ? candidate.toJSON() : null });
    };

    pc.ondatachannel = ({ channel }) => this.attachChannel(channel);

    pc.ontrack = ({ track }) => {
      this.remoteStream.addTrack(track);
      this.mediaVersion += 1;

      const refresh = () => this.emit();
      track.addEventListener("mute", refresh);
      track.addEventListener("unmute", refresh);
      track.addEventListener("ended", () => {
        this.remoteStream.removeTrack(track);
        this.mediaVersion += 1;
        this.emit();
      });

      this.emit();
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        this.fail("Could not establish a direct connection. Your networks may need a TURN relay.");
        this.end("transport-error");
      }
    };

    pc.oniceconnectionstatechange = () => {
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

      // A brief blip (Wi-Fi handover) is worth one restart attempt; a sustained
      // outage means the peer is gone and both sides must reset.
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
          this.fail("The connection dropped.");
          this.end("peer-left");
        }, ICE_GRACE_MS);
      }
    };
  }

  private openDataChannels() {
    const pc = this.pc;
    if (!pc || this.role !== "initiator" || this.notesChannel) return;

    // Both ordered and reliable: notes must arrive in order, and a missing file
    // chunk is unrecoverable.
    this.attachChannel(pc.createDataChannel(CHANNEL.notes, { ordered: true }));
    this.attachChannel(pc.createDataChannel(CHANNEL.files, { ordered: true }));
  }

  private attachChannel(channel: RTCDataChannel) {
    // A non-conforming peer can announce a second channel with a label we have
    // already bound. Replacing the live one would strand its listeners — and
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
      this.files = new FileTransferManager(channel, {
        onChange: this.emitSoon,
        onError: (message) => this.fail(message),
      });
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
      if (this.notesChannel?.readyState === "open" && this.filesChannel?.readyState === "open") {
        this.error = null;
        this.setPhase("connected");
      }
      this.emit();
    });

    channel.addEventListener("close", () => {
      if (this.phase === "ended") return;
      // The channel only closes when the transport dies or the peer left; both
      // are terminal for a two-party session.
      this.end("peer-left");
    });

    channel.addEventListener("error", () => {
      if (this.phase === "ended") return;
      this.fail("The data channel reported an error.");
    });
  }

  // ------------------------------------------------------------------ notes

  private onNoteMessage(event: MessageEvent) {
    if (typeof event.data !== "string") return;

    let frame: NoteFrame;
    try {
      frame = JSON.parse(event.data) as NoteFrame;
    } catch {
      return;
    }

    if (frame.k === "typing") {
      this.peerTyping = Boolean(frame.on);
      if (this.typingTimer) clearTimeout(this.typingTimer);
      if (this.peerTyping) {
        // Self-expiring: a peer that stops typing without telling us is common.
        this.typingTimer = setTimeout(() => {
          this.peerTyping = false;
          this.emit();
        }, 4000);
      }
      this.emit();
      return;
    }

    if (frame.k !== "note" || typeof frame.text !== "string") return;

    // Never trust a peer-supplied timestamp: |at| beyond what Date can
    // represent makes `new Date(at).toISOString()` throw in the notes panel,
    // so a single hostile frame would crash the whole room UI.
    const at =
      typeof frame.at === "number" &&
      Number.isFinite(frame.at) &&
      Math.abs(frame.at) <= MAX_NOTE_TIMESTAMP_MS
        ? frame.at
        : Date.now();

    this.notes = [
      ...this.notes,
      {
        id:
          typeof frame.id === "string" && frame.id.length > 0 && frame.id.length <= 128
            ? frame.id
            : crypto.randomUUID(),
        text: frame.text.slice(0, MAX_NOTE_LENGTH),
        at,
        mine: false,
      },
    ];
    this.peerTyping = false;
    this.emit();
  }

  sendNote(rawText: string) {
    const text = rawText.trim().slice(0, MAX_NOTE_LENGTH);
    if (!text || this.notesChannel?.readyState !== "open") return;

    const note: Note = { id: crypto.randomUUID(), text, at: Date.now(), mine: true };
    this.notesChannel.send(JSON.stringify({ k: "note", id: note.id, text, at: note.at }));
    this.notes = [...this.notes, note];
    this.emit();
  }

  setTyping(on: boolean) {
    if (this.notesChannel?.readyState !== "open") return;
    this.notesChannel.send(JSON.stringify({ k: "typing", on } satisfies NoteFrame));
  }

  // ------------------------------------------------------------------ files

  async sendFiles(files: File[]) {
    if (!this.files || this.filesChannel?.readyState !== "open" || files.length === 0) return;
    await this.files.sendFiles(files);
  }

  cancelTransfer(key: string) {
    this.files?.cancel(key);
  }

  // ------------------------------------------------------------------ media

  async toggleMic() {
    if (this.micTrack) {
      this.releaseTrack(this.micTrack, this.audioSender);
      this.audioSender = null;
      this.micTrack = null;
      this.bumpMedia();
      return;
    }
    const stream = await this.request({ audio: true });
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    this.micTrack = track;
    this.audioSender = this.publish(track, this.audioSender);
    this.bumpMedia();
  }

  async toggleCamera() {
    if (this.cameraTrack) {
      this.releaseTrack(this.cameraTrack, this.screenTrack ? null : this.videoSender);
      if (!this.screenTrack) this.videoSender = null;
      this.cameraTrack = null;
      this.bumpMedia();
      return;
    }

    const stream = await this.request({ video: { width: 1280, height: 720 } });
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    this.cameraTrack = track;
    this.localStream.addTrack(track);

    // Screen share owns the outgoing video slot while it is on; the camera then
    // only feeds the local preview until sharing stops.
    if (!this.screenTrack) {
      this.videoSender = this.publish(track, this.videoSender, false);
    }
    this.bumpMedia();
  }

  async toggleScreenShare() {
    if (this.screenTrack) {
      this.stopScreenShare();
      return;
    }

    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const track = stream.getVideoTracks()[0];
    if (!track) return;

    if (this.phase === "ended") {
      track.stop();
      return;
    }

    this.screenTrack = track;
    this.localStream.addTrack(track);
    // The browser's own "Stop sharing" bar bypasses our UI.
    track.onended = () => this.stopScreenShare();
    this.videoSender = this.publish(track, this.videoSender, false);
    this.bumpMedia();
  }

  private stopScreenShare() {
    if (!this.screenTrack) return;
    this.screenTrack.onended = null;
    this.screenTrack.stop();
    this.localStream.removeTrack(this.screenTrack);
    this.screenTrack = null;

    // Hand the video slot back to the camera if it is still running; with no
    // camera left, the sender is removed outright so the peer's track mutes.
    if (this.videoSender) {
      if (this.cameraTrack) {
        void this.videoSender.replaceTrack(this.cameraTrack);
      } else {
        this.removeSender(this.videoSender);
        this.videoSender = null;
      }
    }
    this.bumpMedia();
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
   * Adds a track to the outgoing connection. Reuses an existing sender via
   * `replaceTrack` when possible so toggling a device does not force an SDP
   * round trip.
   */
  private publish(track: MediaStreamTrack, sender: RTCRtpSender | null, addToPreview = true) {
    if (addToPreview) this.localStream.addTrack(track);
    if (!this.pc) return sender;

    if (sender) {
      void sender.replaceTrack(track);
      return sender;
    }
    return this.pc.addTrack(track, this.localStream);
  }

  private releaseTrack(track: MediaStreamTrack, sender: RTCRtpSender | null) {
    track.onended = null;
    track.stop();
    this.localStream.removeTrack(track);
    // removeTrack rather than replaceTrack(null): merely stopping the RTP flow
    // never mutes the receiver's track in Chromium, so the peer would keep
    // rendering a frozen last frame. Removing the sender renegotiates and the
    // peer's track goes muted, which is what drives its "camera off" UI.
    if (sender) this.removeSender(sender);
  }

  private removeSender(sender: RTCRtpSender) {
    try {
      this.pc?.removeTrack(sender);
    } catch {
      // The connection is already closing; nothing left to renegotiate.
    }
  }

  private bumpMedia() {
    this.mediaVersion += 1;
    this.emit();
  }
}
