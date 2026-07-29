/**
 * Streaming download worker for the "download" sink tier.
 *
 * Registered by lib/download-sw-client.ts with scope "/instant-download/",
 * so the ONLY requests this worker can ever see are navigations to its own
 * synthetic download URLs: /instant-download/<token>/<filename>. It never
 * caches anything and never touches any app page, script or API route --
 * those live outside the scope entirely.
 *
 * The page hands over a file as either a transferred ReadableStream (fast
 * path) or a MessagePort it pumps chunks through (fallback for browsers
 * without transferable streams). A hidden iframe then navigates to the
 * synthetic URL and this worker answers with the stream plus
 * "Content-Disposition: attachment", so the browser's download manager
 * writes the bytes straight to disk with no memory ceiling.
 */

"use strict";

/** token -> { stream, port, name, size } for downloads awaiting their fetch. */
const downloads = new Map();

/** An unclaimed handshake must not leak; the page retries registration. */
const CLAIM_TTL_MS = 120000;

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", function (event) {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  // Keepalive ping from the page: receiving any message resets the browser's
  // idle-kill timer for this worker. Nothing to do.
  if (data.type === "ping") return;
  if (data.type !== "download") return;

  const port = event.ports && event.ports[0];
  if (!port || typeof data.token !== "string" || data.token.length === 0) return;

  const usesTransferredStream =
    typeof ReadableStream !== "undefined" && data.stream instanceof ReadableStream;

  const entry = {
    port: port,
    name: typeof data.name === "string" && data.name ? data.name : "download",
    size: typeof data.size === "number" && isFinite(data.size) && data.size >= 0 ? data.size : null,
    stream: usesTransferredStream ? data.stream : makePortStream(port),
  };

  if (usesTransferredStream) {
    // The transferred stream carries data and cancellation by itself; the
    // port only needs to answer keepalive pings and report fetch start.
    port.onmessage = function () {
      /* pings only */
    };
  }

  downloads.set(data.token, entry);

  // Belt and braces: a token whose iframe navigation never arrived (page
  // crashed between postMessage and iframe insert) must not pin the stream
  // in memory forever.
  setTimeout(function () {
    if (downloads.get(data.token) === entry) downloads.delete(data.token);
  }, CLAIM_TTL_MS);
});

/**
 * Fallback transport: builds a ReadableStream fed by the page one chunk per
 * "pull" credit, so backpressure works exactly like the transferred-stream
 * path -- the download manager reading slowly slows the page's writes.
 */
function makePortStream(port) {
  const buffered = [];
  let closed = false;
  let failed = null;
  let notify = null;

  port.onmessage = function (event) {
    const message = event.data || {};
    if (message.type === "chunk" && message.data) {
      buffered.push(new Uint8Array(message.data));
    } else if (message.type === "end") {
      closed = true;
    } else if (message.type === "abort") {
      failed = new Error("The sender abandoned the download");
    } else if (message.type === "ping") {
      return;
    } else {
      return;
    }
    if (notify) {
      const n = notify;
      notify = null;
      n();
    }
  };

  return new ReadableStream({
    pull: function (controller) {
      // The streams spec never runs two pull()s concurrently, so this simple
      // wait loop is safe: ask the page for one chunk, sleep until any
      // message arrives, repeat.
      function step() {
        if (buffered.length > 0) {
          controller.enqueue(buffered.shift());
          return undefined;
        }
        if (failed) {
          controller.error(failed);
          return undefined;
        }
        if (closed) {
          controller.close();
          return undefined;
        }
        port.postMessage({ type: "pull" });
        return new Promise(function (resolve) {
          notify = resolve;
        }).then(step);
      }
      return step();
    },
    cancel: function () {
      // Download manager gave up (user cancelled, disk full): tell the page
      // so its pending writes fail visibly instead of queueing forever.
      try {
        port.postMessage({ type: "cancel" });
      } catch (error) {
        /* page gone */
      }
    },
  });
}

self.addEventListener("fetch", function (event) {
  const url = new URL(event.request.url);

  // The scope already guarantees only /instant-download/* navigations arrive
  // here, but verify anyway: this worker must NEVER answer for anything else.
  const scopePath = new URL(self.registration.scope).pathname;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf(scopePath) !== 0) return;
  if (event.request.method !== "GET") return;

  const token = url.pathname.slice(scopePath.length).split("/")[0];
  const entry = token ? downloads.get(token) : undefined;

  if (!entry) {
    // Unknown or already-claimed token. Answer with a plain 404 rather than
    // letting it hit the server: these URLs are synthetic and mean nothing
    // to the app.
    event.respondWith(
      new Response("Download not found or already claimed.", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    );
    return;
  }

  // One-shot: a token is consumed by its first request so a reload of the
  // synthetic URL cannot re-trigger or hijack a download.
  downloads.delete(token);
  try {
    entry.port.postMessage({ type: "started" });
  } catch (error) {
    /* page gone; the stream will error on its own */
  }

  const headers = new Headers({
    // Always octet-stream: the point is a download, never rendering, and it
    // keeps content-sniffing well away from peer-supplied bytes.
    "Content-Type": "application/octet-stream",
    "Content-Disposition": contentDisposition(entry.name),
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'",
    "Cache-Control": "no-store",
  });
  if (entry.size !== null) headers.set("Content-Length", String(entry.size));

  event.respondWith(new Response(entry.stream, { headers: headers }));
});

/** RFC 6266/5987: an ASCII fallback plus the UTF-8 encoded real name. */
function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "'");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, function (c) {
    return "%" + c.charCodeAt(0).toString(16).toUpperCase();
  });
  return 'attachment; filename="' + ascii + "\"; filename*=UTF-8''" + encoded;
}
