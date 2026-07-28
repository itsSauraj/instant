import {
  PEER_ID_HEADER,
  PEER_SECRET_HEADER,
  type ClientMessage,
  type ServerEvent,
  type SignalPayload,
} from "@/lib/signal-protocol";

/**
 * Browser side of the signalling relay.
 *
 * Uses `fetch` + a manual SSE parser rather than `EventSource` for two reasons:
 * we need to read HTTP status codes on failure, and we must *not* get
 * EventSource's automatic reconnect — a dropped stream means the session is
 * over, and silently rejoining would re-open a room we just tore down.
 */

export type SignalClientHandlers = {
  onEvent: (event: ServerEvent) => void;
  /** Fired once, when the stream ends without a preceding `peer-left`. */
  onTransportError: (error: Error) => void;
};

export class SignalClient {
  private controller = new AbortController();
  private credentials: { peerId: string; secret: string } | null = null;
  private closed = false;
  /** Set when the server told us why we are ending; suppresses the error path. */
  private sawTerminalEvent = false;

  constructor(
    private readonly roomId: string,
    private readonly handlers: SignalClientHandlers,
  ) {}

  async connect() {
    try {
      const response = await fetch(`/api/signal/${this.roomId}`, {
        method: "GET",
        headers: { accept: "text/event-stream" },
        cache: "no-store",
        signal: this.controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`Signalling server refused the connection (${response.status})`);
      }

      await this.pump(response.body);

      if (!this.closed && !this.sawTerminalEvent) {
        this.handlers.onTransportError(new Error("Signalling stream closed unexpectedly"));
      }
    } catch (error) {
      if (this.closed || this.controller.signal.aborted) return;
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
      this.credentials = { peerId: event.peerId, secret: event.secret };
    }
    if (event.t === "peer-left") {
      this.sawTerminalEvent = true;
    }

    this.handlers.onEvent(event);
  }

  /** Fire-and-forget: signalling is idempotent enough that a lost ICE candidate
   *  is recovered by the next one, and a lost SDP surfaces as a failed session. */
  async send(payload: SignalPayload) {
    await this.post({ t: "signal", data: payload });
  }

  /** Tells the peer the hang-up was deliberate. Best effort by design — if it
   *  fails, the stream teardown delivers `peer-left` a moment later anyway. */
  async sayGoodbye() {
    await this.post({ t: "bye" });
  }

  private async post(message: ClientMessage) {
    if (!this.credentials || this.closed) return;
    try {
      await fetch(`/api/signal/${this.roomId}`, {
        method: "POST",
        keepalive: true,
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

  close() {
    if (this.closed) return;
    this.closed = true;
    this.credentials = null;
    this.controller.abort();
  }
}
