"use client";

import { useLayoutEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  Download,
  FileUp,
  Paperclip,
  X,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { Transfer } from "@/lib/file-transfer";
import { MAX_RECEIVE_BYTES } from "@/lib/peer-protocol";
import { pulse } from "@/lib/animation";
import { cn, formatBytes } from "@/lib/utils";

export function FilesPanel({
  transfers,
  disabled,
  onSend,
  onCancel,
}: {
  transfers: Transfer[];
  disabled: boolean;
  onSend: (files: File[]) => void;
  onCancel: (key: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const lastCount = useRef(transfers.length);

  useLayoutEffect(() => {
    if (transfers.length > lastCount.current) {
      pulse(listRef.current?.lastElementChild ?? null);
    }
    lastCount.current = transfers.length;
  }, [transfers.length]);

  const pick = (fileList: FileList | null) => {
    const files = fileList ? [...fileList] : [];
    if (files.length > 0) onSend(files);
  };

  // Counting drag events avoids the classic flicker when the pointer crosses
  // child elements inside the drop zone.
  const dragDepth = useRef(0);

  return (
    <div className="panel flex h-full flex-col overflow-hidden">
      <div
        onDragEnter={(event) => {
          event.preventDefault();
          dragDepth.current += 1;
          if (!disabled) setDragging(true);
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
          if (!disabled) pick(event.dataTransfer.files);
        }}
        className={cn(
          "m-3 flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors sm:m-4",
          dragging ? "border-primary bg-primary/10" : "border-border bg-muted/30",
          disabled && "opacity-60",
        )}
      >
        <FileUp className={cn("size-7", dragging ? "text-primary" : "text-muted-foreground")} />
        <div>
          <p className="text-sm font-medium">
            {dragging ? "Drop to send" : "Drag files here to send them"}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            Sent directly to the other browser · up to {formatBytes(MAX_RECEIVE_BYTES)} each
          </p>
        </div>
        <Button variant="outline" size="sm" disabled={disabled} onClick={() => inputRef.current?.click()}>
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

      <div ref={listRef} className="scroll-slim flex-1 space-y-2 overflow-y-auto px-3 pb-3 sm:px-4 sm:pb-4">
        {transfers.length === 0 ? (
          <p className="text-muted-foreground py-6 text-center text-sm">
            Transfers appear here as they run.
          </p>
        ) : (
          transfers.map((transfer) => (
            <TransferRow key={transfer.key} transfer={transfer} onCancel={onCancel} />
          ))
        )}
      </div>
    </div>
  );
}

function TransferRow({
  transfer,
  onCancel,
}: {
  transfer: Transfer;
  onCancel: (key: string) => void;
}) {
  const percent = transfer.size === 0 ? 100 : (transfer.transferred / transfer.size) * 100;
  const running = transfer.status === "active" || transfer.status === "pending";
  const incoming = transfer.direction === "incoming";

  return (
    <div className="bg-card/60 rounded-lg border p-3">
      <div className="flex items-start gap-3">
        <Thumbnail transfer={transfer} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium" title={transfer.name}>
              {transfer.name}
            </p>
            <StatusBadge transfer={transfer} />
          </div>

          <p className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-xs tabular-nums">
            {incoming ? (
              <ArrowDownToLine className="size-3" />
            ) : (
              <ArrowUpFromLine className="size-3" />
            )}
            {running
              ? `${formatBytes(transfer.transferred)} of ${formatBytes(transfer.size)}`
              : formatBytes(transfer.size)}
            {transfer.error ? <span className="text-destructive">· {transfer.error}</span> : null}
          </p>

          {running ? (
            <Progress
              value={percent}
              className="mt-2"
              indicatorClassName={incoming ? "bg-success" : "bg-primary"}
            />
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {transfer.status === "complete" && transfer.url ? (
            <Button asChild variant="outline" size="sm">
              <a href={transfer.url} download={transfer.name}>
                <Download />
                Save
              </a>
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

function Thumbnail({ transfer }: { transfer: Transfer }) {
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

function StatusBadge({ transfer }: { transfer: Transfer }) {
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
