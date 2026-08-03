"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CameraOff, Loader2, QrCode, ScanLine } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { extractRoomId } from "@/lib/scan";
import { cn } from "@/lib/utils";

/** How often to sample a frame. 10/s decodes promptly without pinning a CPU. */
const SAMPLE_INTERVAL_MS = 100;

/** Downscale before decoding; a QR needs far less than a full sensor frame. */
const MAX_SAMPLE_EDGE = 640;

type Status = "idle" | "starting" | "scanning" | "error";

/**
 * Joins a session by pointing the camera at an invite QR code.
 *
 * Decoding happens entirely on-device: the native BarcodeDetector where it
 * exists, otherwise a lazily imported jsQR. No frame ever leaves the browser,
 * which matters because the code being scanned *is* the session credential.
 */
export function ScanInvite({
  className,
  iconOnly = false,
  onBeforeNavigate,
}: {
  className?: string;
  /** Renders as a bare icon, for sitting inside the join field. */
  iconOnly?: boolean;
  /**
   * Runs just before the scanner navigates to the room. A scan skips the join
   * form's submit path, so the host page uses this to persist the typed
   * display name (via lib/identity) - the name reaches the room through
   * localStorage, never through the URL, which is shared and scanned.
   */
  onBeforeNavigate?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Set once a code is accepted, so the loop cannot navigate twice. */
  const doneRef = useRef(false);

  const stop = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    // Release the camera explicitly. Without this the indicator light stays on
    // after the dialog closes, which reads as the app still watching.
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => stop, [stop]);

  const start = useCallback(async () => {
    doneRef.current = false;
    setMessage(null);
    setStatus("starting");

    // getUserMedia is unavailable outside a secure context, which is exactly the
    // case when testing over a plain-HTTP LAN address on a phone. Say so plainly
    // rather than surfacing a bare NotAllowedError.
    if (typeof window !== "undefined" && !window.isSecureContext) {
      setStatus("error");
      setMessage(
        "Scanning needs a secure connection. Open this page over HTTPS (or on localhost), or type the code instead.",
      );
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("error");
      setMessage("This browser does not expose camera access. Type the code instead.");
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        // The rear camera is the one pointed at someone else's screen.
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
    } catch (error) {
      setStatus("error");
      setMessage(describeCameraError(error));
      return;
    }

    streamRef.current = stream;
    const video = videoRef.current;
    if (!video) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }

    video.srcObject = stream;
    try {
      await video.play();
    } catch {
      // Autoplay refusal: opening the dialog was the gesture, so this is rare.
    }
    setStatus("scanning");

    const detect = await createDetector();

    timerRef.current = setInterval(async () => {
      if (doneRef.current) return;

      const text = await sampleFrame(video, canvasRef, detect);
      if (!text) return;

      const roomId = extractRoomId(text);
      if (!roomId) {
        // Keep scanning: the camera may simply have caught an unrelated code.
        setMessage("That code is not an Instant invite. Still looking...");
        return;
      }

      doneRef.current = true;
      stop();
      setOpen(false);
      onBeforeNavigate?.();
      // Route internally by id. The scanned text is never navigated to, so a
      // hostile QR cannot redirect anyone off-site.
      router.push(`/room/${roomId}`);
    }, SAMPLE_INTERVAL_MS);
  }, [router, stop, onBeforeNavigate]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      void start();
    } else {
      stop();
      setStatus("idle");
      setMessage(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        {iconOnly ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Scan a code with your camera"
            title="Scan a code with your camera"
            className={cn("text-muted-foreground hover:text-foreground size-8", className)}
          >
            <QrCode className="size-4" />
          </Button>
        ) : (
          <Button type="button" variant="outline" className={cn("gap-2", className)}>
            <QrCode className="size-4" />
            Scan a code
          </Button>
        )}
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Scan an invite code</DialogTitle>
          <DialogDescription>
            Point your camera at the QR code shown on the other device. Decoding happens on this
            device; no image is uploaded.
          </DialogDescription>
        </DialogHeader>

        <div className="relative aspect-square w-full overflow-hidden rounded-xl border bg-black">
          <video
            ref={videoRef}
            playsInline
            muted
            aria-label="Camera preview"
            className={cn(
              "size-full object-cover",
              status !== "scanning" && "opacity-0",
            )}
          />

          {status === "scanning" ? (
            <>
              {/* Reticle: purely decorative, so it must not swallow pointers. */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-[12%] rounded-lg border-2 border-white/70"
              />
              <ScanLine
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-1/2 size-10 -translate-x-1/2 -translate-y-1/2 animate-pulse text-white/80"
              />
            </>
          ) : null}

          {status === "starting" ? (
            <div className="absolute inset-0 grid place-items-center gap-2 text-white/80">
              <Loader2 className="size-6 animate-spin" />
            </div>
          ) : null}

          {status === "error" ? (
            <div className="absolute inset-0 grid place-items-center p-6 text-center">
              <CameraOff className="mx-auto size-7 text-white/60" />
            </div>
          ) : null}
        </div>

        <p
          role={status === "error" ? "alert" : "status"}
          className={cn(
            "min-h-8 text-center text-xs",
            status === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {message ??
            (status === "scanning"
              ? "Looking for a code..."
              : status === "starting"
                ? "Starting the camera..."
                : "")}
        </p>

        {status === "error" ? (
          <Button variant="secondary" onClick={() => void start()}>
            Try again
          </Button>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

type Detect = (source: HTMLCanvasElement) => Promise<string | null>;

/**
 * Prefers the platform decoder, which is hardware-accelerated where present
 * (Chromium, Android). Falls back to jsQR, imported only once scanning actually
 * starts so it stays out of the home page's initial bundle.
 */
async function createDetector(): Promise<Detect> {
  type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => {
    detect: (source: CanvasImageSource) => Promise<Array<{ rawValue?: string }>>;
  };
  const ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;

  if (ctor) {
    try {
      const detector = new ctor({ formats: ["qr_code"] });
      return async (canvas) => {
        const found = await detector.detect(canvas);
        return found[0]?.rawValue ?? null;
      };
    } catch {
      // Constructed but unusable (format unsupported): fall through to jsQR.
    }
  }

  const { default: jsQR } = await import("jsqr");
  return async (canvas) => {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    const { width, height } = canvas;
    const image = context.getImageData(0, 0, width, height);
    return jsQR(image.data, width, height)?.data ?? null;
  };
}

async function sampleFrame(
  video: HTMLVideoElement,
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  detect: Detect,
): Promise<string | null> {
  if (video.readyState < 2 || !video.videoWidth) return null;

  const scale = Math.min(1, MAX_SAMPLE_EDGE / Math.max(video.videoWidth, video.videoHeight));
  const width = Math.max(1, Math.round(video.videoWidth * scale));
  const height = Math.max(1, Math.round(video.videoHeight * scale));

  const canvas = (canvasRef.current ??= document.createElement("canvas"));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(video, 0, 0, width, height);

  try {
    return await detect(canvas);
  } catch {
    // A single bad frame is not worth reporting; the next tick retries.
    return null;
  }
}

function describeCameraError(error: unknown) {
  if (!(error instanceof Error)) return "Could not start the camera.";

  switch (error.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Camera permission was denied. Allow it in your browser's site settings, or type the code instead.";
    case "NotFoundError":
      return "No camera found on this device. Type the code instead.";
    case "NotReadableError":
    case "TrackStartError":
      return "The camera is in use by another app.";
    default:
      return error.message || "Could not start the camera.";
  }
}
