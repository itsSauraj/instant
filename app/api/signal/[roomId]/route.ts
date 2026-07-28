import { isValidRoomId, normalizeRoomId } from "@/lib/ids";
import {
  PEER_ID_HEADER,
  PEER_SECRET_HEADER,
  SIGNAL_LIMITS,
  type ClientMessage,
  type ServerEvent,
} from "@/lib/signal-protocol";
import { endSession, joinRoom, leaveRoom, relay, setGuestMayEnd } from "@/lib/server/rooms";

/**
 * The entire backend: a relay that carries WebRTC offers, answers and ICE
 * candidates between exactly two browsers, then gets out of the way.
 *
 *   GET  -> join the room and open an SSE stream (the join *is* the GET)
 *   POST -> forward one signalling payload to the other peer
 *
 * No database, no auth provider, no state that outlives the two streams.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ roomId: string }> };

const encoder = new TextEncoder();

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function resolveRoomId(context: RouteContext) {
  const { roomId } = await context.params;
  const id = normalizeRoomId(roomId ?? "");
  return isValidRoomId(id) ? id : null;
}

export async function GET(request: Request, context: RouteContext) {
  const roomId = await resolveRoomId(context);
  if (!roomId) return json({ error: "invalid-room" }, 400);

  let close: (() => void) | undefined;
  let joined: { peerId: string; secret: string } | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;

      const write = (event: ServerEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          open = false;
        }
      };

      close = () => {
        if (!open) return;
        open = false;
        if (keepAlive) clearInterval(keepAlive);
        try {
          controller.close();
        } catch {
          // Consumer already detached.
        }
      };

      const result = joinRoom(roomId, { emit: write, disconnect: () => close?.() });

      if (!result.ok) {
        // Either a third participant, or someone re-opening a code whose session
        // is already over. Refuse, and leave any established pair alone.
        write({ t: "peer-left", reason: result.error === "spent" ? "session-over" : "room-full" });
        close();
        return;
      }

      joined = { peerId: result.peerId, secret: result.secret };
      write({
        t: "welcome",
        peerId: result.peerId,
        secret: result.secret,
        role: result.role,
        peerPresent: result.peerPresent,
        isHost: result.isHost,
        guestMayEnd: result.guestMayEnd,
      });

      // Proxies and load balancers drop idle streams; a comment frame is enough.
      keepAlive = setInterval(() => write({ t: "ping" }), SIGNAL_LIMITS.keepAliveMs);
      keepAlive.unref?.();

      // Tab closed, navigated away, laptop lid shut: the room dies with it.
      request.signal.addEventListener("abort", () => {
        if (joined) leaveRoom(roomId, joined.peerId, "peer-left");
        close?.();
      });
    },

    cancel() {
      if (joined) leaveRoom(roomId, joined.peerId, "peer-left");
      close?.();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

export async function POST(request: Request, context: RouteContext) {
  const roomId = await resolveRoomId(context);
  if (!roomId) return json({ error: "invalid-room" }, 400);

  const peerId = request.headers.get(PEER_ID_HEADER);
  const secret = request.headers.get(PEER_SECRET_HEADER);
  if (!peerId || !secret) return json({ error: "unauthorized" }, 401);

  const raw = await request.text();
  if (raw.length > SIGNAL_LIMITS.maxMessageBytes) {
    return json({ error: "payload-too-large" }, 413);
  }

  let message: ClientMessage;
  try {
    message = JSON.parse(raw) as ClientMessage;
  } catch {
    return json({ error: "invalid-json" }, 400);
  }

  if (message.t === "bye") {
    // Deliberate hang-up. Authenticated (anyone who merely saw the invite link
    // must not be able to kill a live session) and authorised (only the host,
    // or a guest the host has empowered, may end it on purpose).
    const result = endSession(roomId, peerId, secret);
    if (!result.ok) {
      const status =
        result.error === "unknown-room" ? 410 : result.error === "forbidden" ? 403 : 401;
      return json({ error: result.error }, status);
    }
    return json({ ok: true }, 200);
  }

  if (message.t === "permission") {
    if (typeof message.allow !== "boolean") return json({ error: "invalid-message" }, 400);
    const result = setGuestMayEnd(roomId, peerId, secret, message.allow);
    if (!result.ok) {
      const status =
        result.error === "unknown-room" ? 410 : result.error === "forbidden" ? 403 : 401;
      return json({ error: result.error }, status);
    }
    return json({ ok: true }, 200);
  }

  if (message.t !== "signal" || !message.data || typeof message.data !== "object") {
    return json({ error: "invalid-message" }, 400);
  }

  const kind = (message.data as { kind?: unknown }).kind;
  if (kind !== "description" && kind !== "candidate") {
    return json({ error: "invalid-message" }, 400);
  }

  const result = relay(roomId, peerId, secret, { t: "signal", data: message.data });
  if (!result.ok) {
    const status =
      result.error === "unknown-room" ? 410 : result.error === "rate-limited" ? 429 : 401;
    return json({ error: result.error }, status);
  }

  return json({ ok: true, delivered: result.delivered }, 200);
}
