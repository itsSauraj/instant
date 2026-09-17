import { getUserId } from "@/lib/identity";
import {
  JOIN_PARAM,
  PEER_ID_HEADER,
  PEER_SECRET_HEADER,
  type ClientMessage,
  type ModerationAction,
  type PeerId,
  type RoomVisibility,
  type ServerEvent,
  type SignalPayload,
} from "@/lib/signal-protocol";

/**
 * Browser side of the signalling relay.
 *
 * Uses `fetch` + a manual SSE parser rather than `EventSource` for two
 * reasons: we need to read HTTP status codes on failure, and we must *not*
 * get EventSource's automatic reconnect. A terminal `ended` means the session
 * is over and silently rejoining would knock on a room we just left. What we
 * DO support is a deliberate `resume()`: after a non-terminal stream drop
 * (reload, network blip) the transport may call it with the stored
 * resumeToken to reclaim the same seat -- the decision to reconnect belongs
 * to the transport, never to this class.
 */

export type SignalClientHandlers = {
  onEvent: (event: ServerEvent) => void;
  /** Fired once per stream, when it ends without a preceding `ended`. The
   *  transport may respond by calling `resume()` with its stored token. */
  onTransportError: (error: Error) => void;
};

export class SignalClient {
  private controller: AbortController | null = null;
  private credentials: { peerId: string; secret: string } | null = null;
  private token: string | null = null;
  private disposed = false;
  /** Set when the server told us why we are ending; suppresses the error path. */
  private sawTerminalEvent = false;

  constructor(
    private readonly roomId: string,
    private readonly handlers: SignalClientHandlers,
  ) {}

  /** The seat's resume token from the last `welcome`; persist it across reloads. */
  get resumeToken(): string | null {
    return this.token;
  }

  /** Our peer id once seated, null while knocking or before connecting. */
  get peerId(): string | null {
    return this.credentials?.peerId ?? null;
  }

  /** First join: founds the room (with the given visibility), walks into a
   *  public one, or knocks on a private one. Resolves when the stream ends,
   *  terminally or not. */
  async connect(name: string, visibility: RoomVisibility = "private") {
    await this.open({
      [JOIN_PARAM.name]: name,
      [JOIN_PARAM.uid]: getUserId(),
      [JOIN_PARAM.visibility]: visibility,
    });
  }

  /** Reclaims an existing seat after a reload or stream drop. A valid token
   *  bypasses the knock and returns `welcome` with `resumed: true`. */
  async resume(name: string, resumeToken: string) {
    await this.open({
      [JOIN_PARAM.name]: name,
      [JOIN_PARAM.resume]: resumeToken,
      [JOIN_PARAM.uid]: getUserId(),
    });
  }

  private async open(params: Record<string, string>) {
    if (this.disposed) return;

    // Each stream gets a fresh controller so a resume after dispose-free drop
    // is not poisoned by the previous stream's state.
    this.controller?.abort();
    this.controller = new AbortController();
    const controller = this.controller;
    this.sawTerminalEvent = false;

    try {
      const query = new URLSearchParams(params).toString();
      const response = await fetch(`/api/signal/${this.roomId}?${query}`, {
        method: "GET",
        headers: { accept: "text/event-stream" },
        cache: "no-store",
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`Signalling server refused the connection (${response.status})`);
      }

      await this.pump(response.body);

      if (!this.disposed && !controller.signal.aborted && !this.sawTerminalEvent) {
        this.handlers.onTransportError(new Error("Signalling stream closed unexpectedly"));
      }
    } catch (error) {
      if (this.disposed || controller.signal.aborted) return;
      this.handlers.onTransportError(
        error instanceof Error ? error : new Error("Signalling transport failed"),
      );
    }
  }

  private async pump(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    // Streaming decode, so a multi-byte character split across two network
    // packets is reassembled rather than mangled.
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line.
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        this.dispatch(frame);
        boundary = buffer.indexOf("\n\n");
      }
    }
  }

  private dispatch(frame: string) {
    const payload = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!payload) return;

    let event: ServerEvent;
    try {
      event = JSON.parse(payload) as ServerEvent;
    } catch {
      return;
    }

    if (event.t === "ping") return;
    if (event.t === "welcome") {
      this.credentials = { peerId: event.self.id, secret: event.secret };
      this.token = event.resumeToken;
    }
    // `ended` is the only terminal event; `peer-left` is somebody ELSE going.
    if (event.t === "ended") {
      this.sawTerminalEvent = true;
    }

    this.handlers.onEvent(event);
  }

  /** Negotiation aimed at exactly one member. Fire-and-forget: a lost ICE
   *  candidate is recovered by the next one, and a lost SDP surfaces as a
   *  failed pair that renegotiation retries. */
  async sendSignal(to: PeerId, data: SignalPayload) {
    await this.post({ t: "signal", to, data });
  }

  /** Leave just this seat; the room and everyone else continue. */
  async leave() {
    await this.post({ t: "leave" }, { keepalive: true });
  }

  /** Host only: end the session for everyone. */
  async closeRoom() {
    await this.post({ t: "close" }, { keepalive: true });
  }

  /** Host only: answer a knock. */
  async admit(knockId: string, allow: boolean) {
    await this.post({ t: "admit", knockId, allow });
  }

  /** Host only: change the participant limit. */
  async setCapacity(value: number) {
    await this.post({ t: "capacity", value });
  }

  /** Host only: open the room to anyone with the link, or make arrivals knock. */
  async setVisibility(value: RoomVisibility) {
    await this.post({ t: "visibility", value });
  }

  /** Host only: eject a participant. */
  async removePeer(peerId: PeerId) {
    await this.post({ t: "remove", peerId });
  }

  /** Host only: hand the room to a seated participant and stay in the call.
   *  Distinct from `leave`, which triggers automatic succession instead. */
  async transferHost(peerId: PeerId) {
    await this.post({ t: "transfer-host", peerId });
  }

  /** Host only: force a pin for everyone. Null clears it. */
  async pin(peerId: PeerId | null) {
    await this.post({ t: "pin", peerId });
  }

  /** Host only: moderate one participant's devices, or everyone else's when
   *  `peerId` is null. Never applies to the host's own devices. */
  async moderate(peerId: PeerId | null, action: ModerationAction) {
    await this.post({ t: "moderate", peerId, action });
  }

  private async post(message: ClientMessage, options?: { keepalive: boolean }) {
    if (!this.credentials || this.disposed) return;
    try {
      await fetch(`/api/signal/${this.roomId}`, {
        method: "POST",
        // `keepalive` only on leave/close so they survive page unload. It is
        // NOT used for signal relays: keepalive bodies are capped at ~64 KiB
        // in-flight, below our 96 KiB SDP ceiling.
        keepalive: options?.keepalive ?? false,
        headers: {
          "content-type": "application/json",
          [PEER_ID_HEADER]: this.credentials.peerId,
          [PEER_SECRET_HEADER]: this.credentials.secret,
        },
        body: JSON.stringify(message),
      });
    } catch {
      // Transport is already failing; the stream reader reports it.
    }
  }

  /** Tears down the local stream. Terminal for this instance; a later resume
   *  needs a fresh SignalClient with the persisted token. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.credentials = null;
    this.controller?.abort();
  }
}
