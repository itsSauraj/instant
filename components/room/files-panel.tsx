"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  Download,
  FileUp,
  FolderCheck,
  HardDriveDownload,
  Paperclip,
  RotateCcw,
  User,
  X,
  XCircle,
} from "lucide-react";

import { DestinationPicker } from "@/components/room/destination-picker";
import { RecipientPicker, type RecipientOption } from "@/components/room/recipient-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { getDefaultSinkProvider } from "@/lib/download-sink";
import type { Transfer } from "@/lib/file-transfer";
import type { PeerId } from "@/lib/signal-protocol";
import type { SendTargets, SinkProvider, TransferExtras } from "@/lib/transfer-contract";
import { pulse } from "@/lib/animation";
import { cn, formatBytes } from "@/lib/utils";

/**
 * A transfer as the panel renders it: the engine's Transfer plus the
 * contract's TransferExtras. Everything from the extras is treated as
 * optional at runtime -- the engine rewrite lands concurrently, so a missing
 * field must degrade the row, never crash it.
 */
export type PanelTransfer = Transfer & Partial<TransferExtras>;

export function FilesPanel({
  transfers,
  participants = [],
  disabled,
  sinkProvider = null,
  onSend,
  onCancel,
  onResume,
}: {
  transfers: PanelTransfer[];
  /** Everyone else in the room (self excluded), for the recipient picker. */
  participants?: RecipientOption[];
  disabled: boolean;
  /**
   * The session's SinkProvider (owned by the transfer engine). When absent,
   * a page-wide default keeps the destination UI functional and honest.
   */
  sinkProvider?: SinkProvider | null;
  /**
   * `targets` is omitted entirely for "everyone" (the default), matching the
   * contract's "null/absent means every connected peer".
   */
  onSend: (files: File[], targets?: SendTargets) => void;
  onCancel: (key: string) => void;
  /** Resume for a partial transfer; the affordance renders only when wired. */
  onResume?: (key: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const lastCount = useRef(transfers.length);

  // The provider is browser-only; adopt it after mount so the server render
  // and the first client render agree (both render the picker as absent).
  const [provider, setProvider] = useState<SinkProvider | null>(null);
  useEffect(() => {
    setProvider(sinkProvider ?? getDefaultSinkProvider());
  }, [sinkProvider]);

  // Who the next send goes to. null = everyone connected (the default).
  const [recipients, setRecipients] = useState<PeerId[] | null>(null);
  // Drop selections of people who have left; null ("everyone") needs no care.
  const effectiveRecipients = useMemo(
    () =>
      recipients === null
        ? null
        : recipients.filter((id) => participants.some((peer) => peer.id === id)),
    [recipients, participants],
  );
  const nobodySelected =
    participants.length > 1 && effectiveRecipients !== null && effectiveRecipients.length === 0;

  useLayoutEffect(() => {
    if (transfers.length > lastCount.current) {
      pulse(listRef.current?.lastElementChild ?? null);
    }
    lastCount.current = transfers.length;
  }, [transfers.length]);

  const pick = (fileList: FileList | null) => {
    const files = fileList ? [...fileList] : [];
    if (files.length === 0 || nobodySelected) return;
    if (effectiveRecipients === null) onSend(files);
    else onSend(files, { to: effectiveRecipients });
  };

  // Counting drag events avoids the classic flicker when the pointer crosses
  // child elements inside the drop zone.
  const dragDepth = useRef(0);

  // Group by peer as soon as transfers involve more than one, so six
  // simultaneous transfers with different people read as sections rather
  // than an interleaved wall of rows.
  const groups = useMemo(() => {
    const map = new Map<string, { peerName: string; items: PanelTransfer[] }>();
    for (const transfer of transfers) {
      const key = transfer.peerId ?? "unknown";
      const group = map.get(key) ?? { peerName: transfer.peerName ?? "Peer", items: [] };
      group.items.push(transfer);
      map.set(key, group);
    }
    return [...map.entries()].map(([peerId, group]) => ({ peerId, ...group }));
  }, [transfers]);
  const grouped = groups.length > 1;

  const sendBlocked = disabled || nobodySelected;

  return (
    <div className="panel flex h-full flex-col overflow-hidden">
      <div
        onDragEnter={(event) => {
          event.preventDefault();
          dragDepth.current += 1;
          if (!sendBlocked) setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          event.preventDefault();
          dragDepth.current -= 1;
          if (dragDepth.current <= 0) {
            dragDepth.current = 0;
            setDragging(false);
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          if (!sendBlocked) pick(event.dataTransfer.files);
        }}
        // Deliberately not focusable and no role: drag-and-drop is a pointer
        // shortcut, and the "Choose files" button is the accessible path.
        aria-disabled={sendBlocked || undefined}
        className={cn(
          "m-3 mb-0 flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-6 text-center transition-colors sm:m-4 sm:mb-0",
          dragging ? "border-primary bg-primary/10" : "border-border bg-muted/30",
          sendBlocked && "opacity-60",
        )}
      >
        <FileUp className={cn("size-7", dragging ? "text-primary" : "text-muted-foreground")} />
        <div>
          <p className="text-sm font-medium">
            {dragging ? "Drop to send" : "Drag files here to send them"}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            {nobodySelected
              ? "Select at least one recipient below"
              : "Sent directly, browser to browser"}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={sendBlocked}
          onClick={() => inputRef.current?.click()}
        >
          <Paperclip />
          Choose files
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            pick(event.target.files);
            // Reset so picking the same file twice still fires a change event.
            event.target.value = "";
          }}
        />
      </div>

      <div className="space-y-2 px-3 pt-2 sm:px-4">
        <RecipientPicker
          participants={participants}
          selected={recipients}
          onChange={setRecipients}
          disabled={disabled}
        />
        <DestinationPicker provider={provider} />
      </div>

      <div
        ref={listRef}
        className="scroll-slim mt-2 flex-1 space-y-2 overflow-y-auto px-3 pb-3 sm:px-4 sm:pb-4"
      >
        {transfers.length === 0 ? (
          <p className="text-muted-foreground py-6 text-center text-sm">
            Transfers appear here as they run.
          </p>
        ) : grouped ? (
          groups.map((group) => (
            <section
              key={group.peerId}
              aria-label={`Transfers with ${group.peerName}`}
              className="space-y-2"
            >
              <h3 className="text-muted-foreground flex items-center gap-1.5 px-1 pt-1 text-xs font-medium">
                <User className="size-3" aria-hidden />
                {group.peerName}
              </h3>
              {group.items.map((transfer) => (
                <TransferRow
                  key={transfer.key}
                  transfer={transfer}
                  showPeer={false}
                  onCancel={onCancel}
                  onResume={onResume}
                />
              ))}
            </section>
          ))
        ) : (
          transfers.map((transfer) => (
            <TransferRow
              key={transfer.key}
              transfer={transfer}
              showPeer
              onCancel={onCancel}
              onResume={onResume}
            />
          ))
        )}
      </div>
    </div>
  );
}

function TransferRow({
  transfer,
  showPeer,
  onCancel,
  onResume,
}: {
  transfer: PanelTransfer;
  showPeer: boolean;
  onCancel: (key: string) => void;
  onResume?: (key: string) => void;
}) {
  const percent = transfer.size === 0 ? 100 : (transfer.transferred / transfer.size) * 100;
  const running = transfer.status === "active" || transfer.status === "pending";
  const incoming = transfer.direction === "incoming";
  const stopped = transfer.status === "failed" || transfer.status === "cancelled";
  const resumable = transfer.resumable === true && stopped;
  // "Saved straight to disk": there is nothing left to save, so no button.
  const savedToDisk =
    incoming &&
    transfer.status === "complete" &&
    (transfer.sinkTier === "filesystem" || transfer.savedTo !== undefined);
  const savedByBrowser =
    incoming && transfer.status === "complete" && transfer.sinkTier === "download";

  return (
    <div className="bg-card/60 rounded-lg border p-3">
      <div className="flex items-start gap-3">
        <Thumbnail transfer={transfer} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium" title={transfer.name}>
              {transfer.name}
            </p>
            {/* Live region on the coarse status only -- the byte counter below
                ticks ~20x/s and must never be announced. */}
            <span role="status" className="flex shrink-0 items-center">
              <span className="sr-only">{transfer.name}: </span>
              <StatusBadge transfer={transfer} />
            </span>
          </div>

          <p className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs tabular-nums">
            {incoming ? (
              <ArrowDownToLine className="size-3" />
            ) : (
              <ArrowUpFromLine className="size-3" />
            )}
            {showPeer && transfer.peerName ? (
              <span className="max-w-32 truncate" title={transfer.peerName}>
                {incoming ? "from" : "to"} {transfer.peerName}
              </span>
            ) : null}
            <span>
              {running
                ? `${formatBytes(transfer.transferred)} of ${formatBytes(transfer.size)}`
                : formatBytes(transfer.size)}
            </span>
            {running && transfer.resumedFrom !== undefined && transfer.resumedFrom > 0 ? (
              <span>{"·"} resumed at {formatBytes(transfer.resumedFrom)}</span>
            ) : null}
            {resumable ? (
              <span>
                {"·"} {formatBytes(transfer.confirmedBytes ?? transfer.transferred)} received
                so far
              </span>
            ) : null}
            {transfer.error ? <span className="text-destructive">{"·"} {transfer.error}</span> : null}
          </p>

          {savedToDisk ? (
            <p className="text-muted-foreground mt-0.5 flex items-center gap-1 text-xs">
              <FolderCheck className="text-success size-3" aria-hidden />
              <span className="truncate" title={transfer.savedTo}>
                Saved to {transfer.savedTo ?? "your chosen folder"}
              </span>
            </p>
          ) : null}
          {savedByBrowser ? (
            <p className="text-muted-foreground mt-0.5 flex items-center gap-1 text-xs">
              <HardDriveDownload className="size-3" aria-hidden />
              <span>Saved to your downloads folder</span>
            </p>
          ) : null}

          {running ? (
            <Progress
              value={percent}
              aria-label={`${incoming ? "Receiving" : "Sending"} ${transfer.name}`}
              className="mt-2"
              indicatorClassName={incoming ? "bg-success" : "bg-primary"}
            />
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {/* The Save button exists only for the memory tier: the streaming
              tiers already put the file on disk. */}
          {transfer.status === "complete" && transfer.url && !savedToDisk && !savedByBrowser ? (
            <Button asChild variant="outline" size="sm">
              <a href={transfer.url} download={transfer.name}>
                <Download />
                Save
              </a>
            </Button>
          ) : null}
          {resumable && onResume ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onResume(transfer.key)}
              aria-label={`Resume ${transfer.name}`}
            >
              <RotateCcw />
              Resume
            </Button>
          ) : null}
          {running ? (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onCancel(transfer.key)}
              aria-label={`Cancel ${transfer.name}`}
            >
              <X />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Thumbnail({ transfer }: { transfer: PanelTransfer }) {
  if (transfer.isImage && transfer.url && transfer.status === "complete") {
    return (
      // Object URLs point at in-memory blobs, so next/image would add nothing here.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={transfer.url}
        alt={transfer.name}
        className="size-11 shrink-0 rounded-md border object-cover"
      />
    );
  }
  return (
    <div className="bg-muted text-muted-foreground grid size-11 shrink-0 place-items-center rounded-md border">
      <Paperclip className="size-4" />
    </div>
  );
}

function StatusBadge({ transfer }: { transfer: PanelTransfer }) {
  if (transfer.status === "complete") {
    return (
      <Badge variant="success" className="shrink-0">
        <CheckCircle2 />
        {transfer.direction === "incoming" ? "Received" : "Sent"}
      </Badge>
    );
  }
  if (transfer.status === "cancelled" || transfer.status === "failed") {
    return (
      <Badge variant="destructive" className="shrink-0">
        <XCircle />
        {transfer.status === "cancelled" ? "Cancelled" : "Failed"}
      </Badge>
    );
  }
  return (
    <Badge variant="muted" className="shrink-0">
      {transfer.direction === "incoming" ? "Receiving" : "Sending"}
    </Badge>
  );
}
