/**
 * Where received file bytes actually land: the SinkProvider and the three
 * DownloadSink tiers of lib/transfer-contract.ts.
 *
 *  - "filesystem": streamed straight into a user-chosen folder via the File
 *    System Access API (Chromium desktop only). The only tier that can resume.
 *  - "download":   streamed through the Service Worker in
 *    public/instant-download-sw.js into the browser's own download manager.
 *    No memory ceiling, works wherever Service Workers do.
 *  - "memory":     the original Blob behaviour, kept as the last resort and
 *    therefore capped per file and per session.
 *
 * `open()` cascades best-tier-first PER FILE, so one stale folder handle or
 * one failed worker handshake degrades a single transfer instead of the
 * session. `capability()` reports what open() would actually do right now,
 * so the UI never promises a tier that will not happen.
 */

import type { DownloadSink, SinkCapability, SinkProvider } from "@/lib/transfer-contract";
import { TRANSFER_LIMITS } from "@/lib/transfer-contract";
import {
  openServiceWorkerDownload,
  serviceWorkerDownloadsAvailable,
  type ServiceWorkerDownloadHandle,
} from "@/lib/download-sw-client";
import { formatBytes } from "@/lib/utils";

// ---------------------------------------------------------------------------
// File System Access API surface (structural: not everywhere in lib.dom, and
// never to be assumed present at runtime)
// ---------------------------------------------------------------------------

type FsPermissionState = "granted" | "denied" | "prompt";

type WritableHandle = {
  write(data: Uint8Array): Promise<void>;
  seek(offset: number): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
};

type FileHandle = {
  readonly name: string;
  createWritable(options?: { keepExistingData?: boolean }): Promise<WritableHandle>;
};

type DirectoryHandle = {
  readonly name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandle>;
  removeEntry(name: string): Promise<void>;
  queryPermission?(descriptor: { mode: "read" | "readwrite" }): Promise<FsPermissionState>;
  requestPermission?(descriptor: { mode: "read" | "readwrite" }): Promise<FsPermissionState>;
};

type DirectoryPicker = (options?: {
  mode?: "read" | "readwrite";
  id?: string;
}) => Promise<DirectoryHandle>;

function directoryPicker(): DirectoryPicker | null {
  if (typeof window === "undefined") return null;
  const picker = (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  return typeof picker === "function" ? (picker.bind(window) as DirectoryPicker) : null;
}

// ---------------------------------------------------------------------------
// Filename sanitising: the name comes from a REMOTE PEER and lands on the
// receiver's disk, so it is treated as hostile input.
// ---------------------------------------------------------------------------

/** Windows device names, reserved even with an extension ("CON.txt"). */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Generous for real names, far below every filesystem's component limit. */
const MAX_FILENAME_LENGTH = 150;

/**
 * Reduces a peer-supplied name to a single safe filesystem component:
 * basename only (no traversal), no control/format characters, no
 * Windows-reserved characters or device names, no leading dots (hidden files
 * and ".."), no trailing dots/spaces (silently eaten by Windows), capped
 * length with the extension preserved. Anything left empty becomes
 * "download".
 */
export function sanitizeFileName(raw: unknown): string {
  if (typeof raw !== "string") return "download";

  // Basename only: both separator styles, so "..\..\x" cannot traverse.
  let name = raw.replace(/[\\/]+/g, "/");
  const lastSlash = name.lastIndexOf("/");
  if (lastSlash !== -1) name = name.slice(lastSlash + 1);

  // Control chars (incl. NUL) and invisible format chars (RTL override etc.).
  name = name.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\p{Cf}/gu, "");

  // Characters Windows refuses outright; ':' also breaks macOS Finder.
  name = name.replace(/[<>:"|?*]/g, "_");

  // Leading dots hide files on unix and are all that is left of "..".
  name = name.replace(/^[.\s]+/, "");
  // Trailing dots and spaces are silently dropped by Windows: drop them first.
  name = name.replace(/[.\s]+$/, "");

  if (name.length === 0) return "download";

  // "CON", "con.txt", "LPT1.log" are device names on Windows.
  const stem = name.split(".")[0];
  if (WINDOWS_RESERVED.test(stem)) name = `_${name}`;

  if (name.length > MAX_FILENAME_LENGTH) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
    name = name.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext;
  }
  return name;
}

/** "report.pdf" -> "report (2).pdf" for n = 2. n = 1 is the name itself. */
function withSuffix(name: string, n: number): string {
  if (n <= 1) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  return `${stem} (${n})${ext}`;
}

// ---------------------------------------------------------------------------
// Tier "filesystem"
// ---------------------------------------------------------------------------

class FileSystemSink implements DownloadSink {
  readonly tier = "filesystem" as const;
  /**
   * Extra beyond the contract: the on-disk name after sanitising and
   * de-duplication, for the engine to surface as `TransferExtras.savedTo`.
   */
  readonly savedAs: string;
  written: number;
  private closed = false;

  constructor(
    private readonly dir: DirectoryHandle,
    savedAs: string,
    private readonly writable: WritableHandle,
    resumeFrom: number,
  ) {
    this.savedAs = savedAs;
    // Absolute file offset: resumed sinks continue the count they seeked to,
    // because `written` drives resume bookkeeping and must be exact.
    this.written = resumeFrom;
  }

  async write(chunk: Uint8Array): Promise<void> {
    await this.writable.write(chunk);
    this.written += chunk.byteLength;
  }

  async close(): Promise<{ url: string | null }> {
    await this.writable.close();
    this.closed = true;
    return { url: null };
  }

  async abort(): Promise<void> {
    // After close() the file is complete; a late abort must not delete it.
    if (this.closed) return;
    try {
      await this.writable.abort();
    } catch {
      // Already closed or errored.
    }
    try {
      await this.dir.removeEntry(this.savedAs);
    } catch {
      // Folder gone or file never materialised; nothing to discard.
    }
  }
}

// ---------------------------------------------------------------------------
// Tier "download"
// ---------------------------------------------------------------------------

class ServiceWorkerSink implements DownloadSink {
  readonly tier = "download" as const;
  written = 0;

  constructor(private readonly handle: ServiceWorkerDownloadHandle) {}

  async write(chunk: Uint8Array): Promise<void> {
    await this.handle.write(chunk);
    this.written += chunk.byteLength;
  }

  async close(): Promise<{ url: string | null }> {
    await this.handle.close();
    return { url: null };
  }

  async abort(): Promise<void> {
    await this.handle.abort(); // never throws, by its own contract
  }
}

// ---------------------------------------------------------------------------
// Tier "memory"
// ---------------------------------------------------------------------------

type MemoryBudget = {
  perFileBytes: number;
  /** Reserve n more bytes; false when the session budget is exhausted. */
  take(n: number): boolean;
  give(n: number): void;
};

class MemoryDownloadSink implements DownloadSink {
  readonly tier = "memory" as const;
  written = 0;
  private chunks: Uint8Array[] = [];
  private reserved: number;
  private done = false;

  constructor(
    private readonly mime: string,
    initialReservation: number,
    private readonly budget: MemoryBudget,
  ) {
    this.reserved = initialReservation;
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.done) throw new Error("This transfer is already finished");
    const next = this.written + chunk.byteLength;
    if (next > this.budget.perFileBytes) {
      throw new Error(
        `File exceeds the ${formatBytes(this.budget.perFileBytes)} in-memory limit`,
      );
    }
    if (next > this.reserved) {
      // The sender is exceeding its declared size; account for every byte.
      if (!this.budget.take(next - this.reserved)) {
        throw new Error("The session's receive-memory budget is exhausted");
      }
      this.reserved = next;
    }
    // Copy: the caller may reuse its buffer, and the Blob keeps these alive.
    this.chunks.push(chunk.slice());
    this.written = next;
  }

  async close(): Promise<{ url: string | null }> {
    if (this.done) throw new Error("This transfer is already finished");
    this.done = true;
    // Give back the over-reservation; the written bytes stay held: the Blob
    // occupies them until the session is disposed and its URL revoked.
    if (this.reserved > this.written) {
      this.budget.give(this.reserved - this.written);
      this.reserved = this.written;
    }
    const blob = new Blob(this.chunks as BlobPart[], {
      type: this.mime || "application/octet-stream",
    });
    this.chunks = [];
    return { url: URL.createObjectURL(blob) };
  }

  async abort(): Promise<void> {
    if (this.done) return;
    this.done = true;
    this.chunks = [];
    try {
      this.budget.give(this.reserved);
    } catch {
      // abort() never throws.
    }
    this.reserved = 0;
  }
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

type Limits = {
  maxMemoryBytes: number;
  maxSessionMemoryBytes: number;
};

export class BrowserSinkProvider implements SinkProvider {
  private directory: DirectoryHandle | null = null;
  /** transferId -> on-disk filename actually used, so a resume reopens the
   *  SAME file rather than de-duplicating into a fresh one. */
  private readonly assignedNames = new Map<string, string>();
  /** Bytes the memory tier holds or has reserved this session. */
  private memoryHeldBytes = 0;
  private readonly limits: Limits;

  constructor(options?: { limits?: Partial<Limits> }) {
    this.limits = {
      maxMemoryBytes: options?.limits?.maxMemoryBytes ?? TRANSFER_LIMITS.maxMemoryBytes,
      maxSessionMemoryBytes:
        options?.limits?.maxSessionMemoryBytes ?? TRANSFER_LIMITS.maxSessionMemoryBytes,
    };
  }

  capability(): SinkCapability {
    if (this.directory && directoryPicker() !== null) {
      return {
        tier: "filesystem",
        streaming: true,
        maxBytes: null,
        hasDestination: true,
        destinationLabel: this.directory.name || "Chosen folder",
      };
    }
    if (serviceWorkerDownloadsAvailable()) {
      return {
        tier: "download",
        streaming: true,
        maxBytes: null,
        hasDestination: false,
        destinationLabel: null,
      };
    }
    const remaining = Math.max(0, this.limits.maxSessionMemoryBytes - this.memoryHeldBytes);
    return {
      tier: "memory",
      streaming: false,
      maxBytes: Math.min(this.limits.maxMemoryBytes, remaining),
      hasDestination: false,
      destinationLabel: null,
    };
  }

  canChooseFolder(): boolean {
    return directoryPicker() !== null;
  }

  async chooseFolder(): Promise<boolean> {
    const picker = directoryPicker();
    if (!picker) return false;
    try {
      const dir = await picker({ mode: "readwrite", id: "instant-received-files" });
      if (!dir) return false;
      this.directory = dir;
      return true;
    } catch {
      // AbortError (the user cancelled) or a security refusal: either way,
      // no folder was chosen and we must never claim otherwise.
      return false;
    }
  }

  clearFolder(): void {
    this.directory = null;
  }

  async open(file: {
    name: string;
    mime: string;
    expectedBytes: number;
    transferId: string;
    resumeFrom?: number;
  }): Promise<DownloadSink> {
    const resumeFrom = Math.max(0, Math.floor(file.resumeFrom ?? 0));

    if (this.directory) {
      try {
        return await this.openFileSystemSink(file, resumeFrom);
      } catch (error) {
        if (resumeFrom > 0) throw error; // a resume must not restart in another tier
        // Folder deleted, permission revoked, hostile name the FS refused:
        // degrade this one file to the next tier.
      }
    }

    if (resumeFrom > 0) {
      // Only the filesystem tier can seek; the download manager and a Blob
      // cannot append. The engine restarts from zero instead.
      throw new Error("Resuming needs the folder the file was being saved into");
    }

    if (serviceWorkerDownloadsAvailable()) {
      try {
        return await this.openServiceWorkerSink(file);
      } catch {
        // Registration or handshake failed; memory still works.
      }
    }

    return this.openMemorySink(file);
  }

  // ----------------------------------------------------------- filesystem

  private async openFileSystemSink(
    file: { name: string; transferId: string },
    resumeFrom: number,
  ): Promise<DownloadSink> {
    const dir = this.directory;
    if (!dir) throw new Error("No folder chosen");
    await this.ensurePermission(dir);

    let name: string;
    if (resumeFrom > 0 && this.assignedNames.has(file.transferId)) {
      name = this.assignedNames.get(file.transferId)!;
    } else if (resumeFrom > 0) {
      // Resume across a reload: the in-memory assignment is gone, so reopen
      // the sanitised name as-is -- de-duplicating here would append the
      // remainder to a brand-new empty file.
      name = sanitizeFileName(file.name);
    } else {
      name = await this.pickFreeName(dir, sanitizeFileName(file.name));
    }

    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable({ keepExistingData: resumeFrom > 0 });
    if (resumeFrom > 0) await writable.seek(resumeFrom);

    this.assignedNames.set(file.transferId, name);
    return new FileSystemSink(dir, name, writable, resumeFrom);
  }

  /**
   * A granted directory handle goes stale (browser restart, user revocation),
   * so re-check before every file. `requestPermission` outside a user gesture
   * simply rejects/denies in current Chromium, which correctly drops us to
   * the next tier rather than silently overwriting nothing.
   */
  private async ensurePermission(dir: DirectoryHandle): Promise<void> {
    if (typeof dir.queryPermission !== "function") return; // older impl: surface errors on write
    let state = await dir.queryPermission({ mode: "readwrite" });
    if (state === "prompt" && typeof dir.requestPermission === "function") {
      try {
        state = await dir.requestPermission({ mode: "readwrite" });
      } catch {
        state = "denied";
      }
    }
    if (state !== "granted") {
      throw new Error("Permission to the chosen folder was lost");
    }
  }

  /**
   * Collision policy: NEVER overwrite. The peer chooses the filename, so an
   * existing "report.pdf" (the user's own file, or an earlier transfer) gets
   * a sibling "report (2).pdf" instead of being clobbered.
   */
  private async pickFreeName(dir: DirectoryHandle, base: string): Promise<string> {
    const inFlight = new Set(this.assignedNames.values());
    for (let n = 1; n <= 200; n += 1) {
      const candidate = withSuffix(base, n);
      if (inFlight.has(candidate)) continue;
      let exists = true;
      try {
        await dir.getFileHandle(candidate);
      } catch {
        exists = false; // NotFoundError: the name is free
      }
      if (!exists) return candidate;
    }
    // 200 collisions is not a folder, it is an attack; stay unique anyway.
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    return `${stem} (${crypto.randomUUID().slice(0, 8)})${ext}`;
  }

  // ------------------------------------------------------------- download

  private async openServiceWorkerSink(file: {
    name: string;
    mime: string;
    expectedBytes: number;
  }): Promise<DownloadSink> {
    const handle = await openServiceWorkerDownload({
      // Sanitised even though the download manager re-sanitises: the name
      // also rides a URL path and a Content-Disposition header.
      name: sanitizeFileName(file.name),
      mime: file.mime,
      expectedBytes: file.expectedBytes,
    });
    return new ServiceWorkerSink(handle);
  }

  // --------------------------------------------------------------- memory

  private openMemorySink(file: { name: string; mime: string; expectedBytes: number }): DownloadSink {
    const expected = Math.max(0, Math.floor(file.expectedBytes) || 0);
    if (expected > this.limits.maxMemoryBytes) {
      throw new Error(
        `Larger than the ${formatBytes(this.limits.maxMemoryBytes)} in-memory limit`,
      );
    }
    if (this.memoryHeldBytes + expected > this.limits.maxSessionMemoryBytes) {
      throw new Error(
        `The session's ${formatBytes(this.limits.maxSessionMemoryBytes)} receive-memory budget is exhausted`,
      );
    }
    this.memoryHeldBytes += expected;
    return new MemoryDownloadSink(file.mime, expected, {
      perFileBytes: this.limits.maxMemoryBytes,
      take: (n) => {
        if (this.memoryHeldBytes + n > this.limits.maxSessionMemoryBytes) return false;
        this.memoryHeldBytes += n;
        return true;
      },
      give: (n) => {
        this.memoryHeldBytes = Math.max(0, this.memoryHeldBytes - n);
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** One instance per session, owned by the transfer engine (per the contract). */
export function createSinkProvider(options?: {
  limits?: Partial<Limits>;
}): BrowserSinkProvider {
  return new BrowserSinkProvider(options);
}

let defaultProvider: BrowserSinkProvider | null = null;

/**
 * Page-wide fallback instance so the destination UI can work before (or
 * without) the engine passing its own provider down. The engine's instance
 * should be preferred everywhere once wired.
 */
export function getDefaultSinkProvider(): BrowserSinkProvider | null {
  if (typeof window === "undefined") return null;
  if (!defaultProvider) defaultProvider = new BrowserSinkProvider();
  return defaultProvider;
}

// Dev-only handle for scripts/verify-download-tiers.mjs, mirroring the
// __instantPeerConnections convention in lib/mesh-session.ts.
if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  (window as unknown as Record<string, unknown>).__instantDownloadSink = {
    createSinkProvider,
    getDefaultSinkProvider,
    sanitizeFileName,
  };
}
