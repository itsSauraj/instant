/**
 * Client half of the "download" sink tier: registers the streaming Service
 * Worker lazily and hands it one ReadableStream per file.
 *
 * How a download works:
 *  1. The page asks the worker (registered on the narrow scope
 *     `/instant-download/`) to adopt a stream under a random token, over a
 *     dedicated MessageChannel. The stream itself is transferred when the
 *     browser supports transferable streams; otherwise chunks are pumped
 *     through the port with pull-based backpressure.
 *  2. A hidden iframe navigates to `/instant-download/<token>/<name>`. An
 *     iframe rather than window.open or a top-level navigation: no popup
 *     blocker applies to iframe navigation, and if the worker is somehow not
 *     there the iframe 404s silently instead of tearing down the app.
 *  3. The worker answers that navigation with the stream plus
 *     `Content-Disposition: attachment`, so the browser's own download
 *     manager writes the file with no memory ceiling.
 *
 * Failure is always loud: if the worker never claims the token, dies
 * mid-download, or the user cancels in the download manager, pending and
 * future write() calls reject rather than hanging.
 */

const SW_URL = "/instant-download-sw.js";
const SW_SCOPE = "/instant-download/";

/** How long the worker gets to activate before we give up on this tier. */
const REGISTER_TIMEOUT_MS = 10_000;
/** How long the iframe navigation gets to reach the worker's fetch handler. */
const STARTED_TIMEOUT_MS = 8_000;
/** Ping the worker while downloads run so the browser keeps it alive. */
const KEEPALIVE_INTERVAL_MS = 15_000;
/**
 * A write that cannot make progress for this long means the consumer is gone
 * (worker killed without the stream cancel propagating). Generous, because a
 * slow disk legitimately stalls the download manager for a while.
 */
const STALL_TIMEOUT_MS = 120_000;

export type ServiceWorkerDownloadHandle = {
  /** Appends bytes. Rejects when the download has died. */
  write(chunk: Uint8Array): Promise<void>;
  /** Finishes the file; the download manager completes it. */
  close(): Promise<void>;
  /** Cancels; the download manager shows the failure. Never throws. */
  abort(): Promise<void>;
};

/** True when this browser can stream downloads through a Service Worker. */
export function serviceWorkerDownloadsAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    Boolean(navigator.serviceWorker) &&
    typeof ReadableStream !== "undefined" &&
    window.isSecureContext !== false
  );
}

// ---------------------------------------------------------------------------
// Lazy registration
// ---------------------------------------------------------------------------

let workerPromise: Promise<ServiceWorker> | null = null;

/**
 * Registers the worker on first use only -- a page that never receives a
 * large file never installs anything. Scope is `/instant-download/`, so the
 * worker cannot intercept any app request even if its fetch handler were
 * wrong: the app's pages and API routes are simply outside its reach.
 */
function ensureWorker(): Promise<ServiceWorker> {
  if (!serviceWorkerDownloadsAvailable()) {
    return Promise.reject(new Error("Service worker downloads are not available here"));
  }
  if (!workerPromise) {
    workerPromise = register().catch((error) => {
      // Let a later download retry registration instead of caching failure.
      workerPromise = null;
      throw error;
    });
  }
  return workerPromise;
}

async function register(): Promise<ServiceWorker> {
  const registration = await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
  const worker = registration.active ?? registration.waiting ?? registration.installing;
  if (!worker) throw new Error("The download service worker failed to install");
  if (worker.state === "activated") return worker;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("The download service worker never activated"));
    }, REGISTER_TIMEOUT_MS);
    const onState = () => {
      if (worker.state === "activated") {
        cleanup();
        resolve();
      } else if (worker.state === "redundant") {
        cleanup();
        reject(new Error("The download service worker was replaced before activating"));
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      worker.removeEventListener("statechange", onState);
    };
    worker.addEventListener("statechange", onState);
  });
  return worker;
}

// ---------------------------------------------------------------------------
// Keepalive: browsers kill idle workers after ~30s; a message resets the clock
// ---------------------------------------------------------------------------

let activeDownloads = 0;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
let keepAliveWorker: ServiceWorker | null = null;

function trackActive(delta: number) {
  activeDownloads = Math.max(0, activeDownloads + delta);
  if (activeDownloads > 0 && !keepAliveTimer) {
    keepAliveTimer = setInterval(() => {
      try {
        keepAliveWorker?.postMessage({ type: "ping" });
      } catch {
        // Worker gone; the per-download watchdogs surface that.
      }
    }, KEEPALIVE_INTERVAL_MS);
  }
  if (activeDownloads === 0 && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

// ---------------------------------------------------------------------------
// One download
// ---------------------------------------------------------------------------

export async function openServiceWorkerDownload(file: {
  name: string;
  mime: string;
  expectedBytes: number;
}): Promise<ServiceWorkerDownloadHandle> {
  const worker = await ensureWorker();
  keepAliveWorker = worker;
  const token = crypto.randomUUID();

  let failure: Error | null = null;
  let wake: (() => void) | null = null;
  const notify = () => {
    const w = wake;
    wake = null;
    w?.();
  };

  // ----- pump-mode state (fallback when streams are not transferable)
  type Pending = { chunk: Uint8Array; resolve: () => void; reject: (error: Error) => void };
  const queue: Pending[] = [];
  let credits = 0;

  const rejectQueue = (error: Error) => {
    while (queue.length > 0) queue.shift()!.reject(error);
  };
  const fail = (error: Error) => {
    if (!failure) failure = error;
    rejectQueue(error);
    notify();
  };

  // ----- transfer-mode state
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  const makeStream = () =>
    new ReadableStream<Uint8Array>(
      {
        start(c) {
          controller = c;
        },
        pull() {
          // The consumer made room; release a waiting write().
          notify();
        },
        cancel(reason) {
          // Propagated from the worker side when the browser abandons the
          // response -- the user cancelled the download, or the worker died.
          fail(
            new Error(
              typeof reason === "string" && reason
                ? reason
                : "The download was cancelled by the browser",
            ),
          );
        },
      },
      new CountQueuingStrategy({ highWaterMark: 16 }),
    );

  // Hand the worker the stream. Transferring a ReadableStream is not
  // universally supported (Safari), so fall back to pumping chunks through
  // the MessagePort with pull-based backpressure when the transfer throws.
  let mode: "transfer" | "pump" = "transfer";
  let port: MessagePort;
  const meta = { type: "download", token, name: file.name, size: file.expectedBytes, mime: file.mime };
  try {
    const channel = new MessageChannel();
    const stream = makeStream();
    worker.postMessage({ ...meta, stream }, [channel.port2, stream as unknown as Transferable]);
    port = channel.port1;
  } catch {
    mode = "pump";
    controller = null;
    // Fresh channel: do not reuse ports that a failed postMessage may have
    // left in an indeterminate state.
    const channel = new MessageChannel();
    worker.postMessage(meta, [channel.port2]);
    port = channel.port1;
  }

  const flush = () => {
    while (credits > 0 && queue.length > 0) {
      const item = queue.shift()!;
      credits -= 1;
      try {
        // The chunk was copied at write() time, so transferring is safe.
        port.postMessage({ type: "chunk", data: item.chunk.buffer }, [item.chunk.buffer]);
        item.resolve();
      } catch (error) {
        item.reject(error instanceof Error ? error : new Error("Chunk handoff failed"));
      }
    }
  };

  let onStarted: ((ok: boolean) => void) | null = null;
  port.onmessage = (event: MessageEvent) => {
    const message = (event.data ?? {}) as { type?: string };
    switch (message.type) {
      case "started":
        onStarted?.(true);
        onStarted = null;
        break;
      case "pull":
        credits += 1;
        flush();
        break;
      case "cancel":
        fail(new Error("The download was cancelled"));
        break;
      default:
        break;
    }
  };

  // Trigger the navigation the worker will answer. A hidden iframe: immune to
  // popup blockers, and harmless (a silent 404) if the worker is gone.
  const iframe = document.createElement("iframe");
  iframe.setAttribute("hidden", "");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.display = "none";
  iframe.src = `${SW_SCOPE}${token}/${encodeURIComponent(file.name || "download")}`;
  document.body.appendChild(iframe);

  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    trackActive(-1);
    // The download manager owns the bytes once the response ends; the iframe
    // and port just need to outlive the tail of the stream.
    setTimeout(() => {
      iframe.remove();
      try {
        port.close();
      } catch {
        // Already closed.
      }
    }, 4_000);
  };

  const started = await new Promise<boolean>((resolve) => {
    onStarted = resolve;
    setTimeout(() => {
      onStarted?.(false);
      onStarted = null;
    }, STARTED_TIMEOUT_MS);
  });
  if (!started) {
    iframe.remove();
    try {
      port.close();
    } catch {
      // Ignore.
    }
    throw new Error("The download service worker did not answer; falling back");
  }
  trackActive(1);

  const waitForWake = () =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const stall = new Error("The download stalled -- the service worker may have been stopped");
        fail(stall);
        reject(stall);
      }, STALL_TIMEOUT_MS);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  return {
    async write(chunk: Uint8Array): Promise<void> {
      if (failure) throw failure;
      // Copy: the caller may reuse its buffer, and pump mode transfers ours.
      const copy = chunk.slice();
      if (mode === "transfer") {
        const c = controller!;
        while (!failure && c.desiredSize !== null && c.desiredSize <= 0) {
          await waitForWake();
        }
        if (failure) throw failure;
        c.enqueue(copy);
        return;
      }
      const pending = new Promise<void>((resolve, reject) => {
        queue.push({ chunk: copy, resolve, reject });
      });
      flush();
      if (queue.length > 0) {
        // Not sent yet: watchdog against a worker that stopped pulling.
        const watchdog = setTimeout(() => {
          fail(new Error("The download stalled -- the service worker may have been stopped"));
        }, STALL_TIMEOUT_MS);
        try {
          await pending;
        } finally {
          clearTimeout(watchdog);
        }
        return;
      }
      await pending;
    },

    async close(): Promise<void> {
      if (failure) throw failure;
      if (mode === "transfer") {
        try {
          controller!.close();
        } catch {
          throw failure ?? new Error("The download ended before the file finished");
        }
      } else {
        try {
          port.postMessage({ type: "end" });
        } catch {
          throw failure ?? new Error("The download ended before the file finished");
        }
      }
      settle();
    },

    async abort(): Promise<void> {
      try {
        if (!failure) failure = new Error("Aborted");
        if (mode === "transfer") {
          try {
            controller?.error(new DOMException("Aborted", "AbortError"));
          } catch {
            // Stream already closed or errored.
          }
        } else {
          try {
            port.postMessage({ type: "abort" });
          } catch {
            // Port already closed.
          }
        }
        rejectQueue(failure);
        notify();
        settle();
      } catch {
        // abort() never throws, per the sink contract.
      }
    },
  };
}
