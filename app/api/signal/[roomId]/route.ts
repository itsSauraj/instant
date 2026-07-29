import { isValidRoomId, normalizeRoomId } from "@/lib/ids";
import {
  JOIN_PARAM,
  PEER_ID_HEADER,
  PEER_SECRET_HEADER,
  SIGNAL_LIMITS,
  sanitizeName,
  sanitizeUid,
  type ClientMessage,
  type ServerEvent,
  type SignalPayload,
} from "@/lib/signal-protocol";
import {
  answerKnock,
  closeRoom,
  leaveRoom,
  moderate,
  openStream,
  relaySignal,
  removePeer,
  setCapacity,
  setPin,
  streamAborted,
  type ActionError,
  type ActionResult,
  type Connection,
} from "@/lib/server/rooms";

/**
 * The entire backend: a relay that introduces up to seven browsers to each
 * other and carries their WebRTC negotiation, then gets out of the way.
 *
 *   GET  -> open an SSE stream; found the room, resume a seat, or knock
 *   POST -> one ClientMessage: targeted signal relay or a room action
 *
 * No database, no auth provider. All authority lives in lib/server/rooms.ts;
 * this file only translates HTTP into calls and results into status codes.
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

/** One table so every action maps errors to statuses identically. */
const ERROR_STATUS: Record<ActionError, number> = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  "unknown-room": 410,
  "not-member": 410,
  "unknown-peer": 410,
  "unknown-knock": 410,
  "rate-limited": 429,
};

function actionResponse(result: ActionResult) {
  if (!result.ok) return json({ error: result.error }, ERROR_STATUS[result.error]);
  return json({ ok: true }, 200);
}

function isSignalPayload(data: unknown): data is SignalPayload {
  if (!data || typeof data !== "object") return false;
  const kind = (data as { kind?: unknown }).kind;
  return kind === "description" || kind === "candidate";
}

export async function GET(request: Request, context: RouteContext) {
  const roomId = await resolveRoomId(context);
  if (!roomId) return json({ error: "invalid-room" }, 400);

  const url = new URL(request.url);
  const name = sanitizeName(url.searchParams.get(JOIN_PARAM.name));
  const resumeToken = url.searchParams.get(JOIN_PARAM.resume);
  const uid = sanitizeUid(url.searchParams.get(JOIN_PARAM.uid));

  let close: (() => void) | undefined;
  let conn: Connection | undefined;
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

      // Emits welcome / waiting-approval / ended itself before returning.
      conn = openStream(
        roomId,
        { name, resumeToken, uid },
        { emit: write, disconnect: () => close?.() },
      );

      // Refused on the spot (room-full): the stream is already closed.
      if (conn.phase === "done") return;

      // Proxies and load balancers drop idle streams; knockers wait minutes,
      // so they need the heartbeat as much as seated members do.
      keepAlive = setInterval(() => write({ t: "ping" }), SIGNAL_LIMITS.keepAliveMs);
      keepAlive.unref?.();

      // Tab closed, reload, network drop. NOT a departure: a seated member
      // only goes `away` and keeps its seat for the resume grace period.
      request.signal.addEventListener("abort", () => {
        if (conn) streamAborted(conn);
        close?.();
      });
    },

    cancel() {
      if (conn) streamAborted(conn);
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

  // Every POST is authenticated. Anyone who merely saw an invite link must not
  // be able to relay into, reshape, or end somebody else's session.
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
  if (!message || typeof message !== "object") {
    return json({ error: "invalid-message" }, 400);
  }

  switch (message.t) {
    case "signal": {
      if (typeof message.to !== "string" || !message.to || !isSignalPayload(message.data)) {
        return json({ error: "invalid-message" }, 400);
      }
      return actionResponse(relaySignal(roomId, peerId, secret, message.to, message.data));
    }
    case "leave":
      return actionResponse(leaveRoom(roomId, peerId, secret));
    case "close":
      return actionResponse(closeRoom(roomId, peerId, secret));
    case "admit": {
      if (typeof message.knockId !== "string" || typeof message.allow !== "boolean") {
        return json({ error: "invalid-message" }, 400);
      }
      return actionResponse(answerKnock(roomId, peerId, secret, message.knockId, message.allow));
    }
    case "capacity": {
      if (typeof message.value !== "number" || !Number.isFinite(message.value)) {
        return json({ error: "invalid-message" }, 400);
      }
      return actionResponse(setCapacity(roomId, peerId, secret, message.value));
    }
    case "remove": {
      if (typeof message.peerId !== "string" || !message.peerId) {
        return json({ error: "invalid-message" }, 400);
      }
      return actionResponse(removePeer(roomId, peerId, secret, message.peerId));
    }
    case "pin": {
      if (message.peerId !== null && (typeof message.peerId !== "string" || !message.peerId)) {
        return json({ error: "invalid-message" }, 400);
      }
      return actionResponse(setPin(roomId, peerId, secret, message.peerId));
    }
    case "moderate": {
      // Structural checks only; whether the action string is one of the four
      // allowed values (and whether the caller may moderate) is authority that
      // lives in rooms.ts, like every other semantic rule.
      if (
        (message.peerId !== null && (typeof message.peerId !== "string" || !message.peerId)) ||
        typeof message.action !== "string"
      ) {
        return json({ error: "invalid-message" }, 400);
      }
      return actionResponse(moderate(roomId, peerId, secret, message.peerId, message.action));
    }
    default:
      return json({ error: "invalid-message" }, 400);
  }
}
