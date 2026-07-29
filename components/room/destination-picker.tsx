"use client";

import { useCallback, useEffect, useState } from "react";
import { FolderCheck, FolderOpen, HardDriveDownload, MemoryStick, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { SinkCapability, SinkProvider } from "@/lib/transfer-contract";
import { formatBytes } from "@/lib/utils";

/**
 * Shows -- honestly -- where incoming files will land, and lets the user pick
 * a folder where the browser supports it (File System Access API, Chromium
 * desktop only).
 *
 * Everything rendered here comes from `provider.capability()`, which reports
 * what would actually happen right now. A folder is only ever claimed when
 * the provider says `hasDestination`, which it can only say after a real
 * picker succeeded; on Firefox/Safari/iOS the button simply does not exist.
 */
export function DestinationPicker({
  provider,
}: {
  provider: SinkProvider | null;
}) {
  const [capability, setCapability] = useState<SinkCapability | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    setCapability(provider ? provider.capability() : null);
  }, [provider]);

  // Capability is read in an effect (not during render) so the server render
  // and the first client render agree; the provider only exists client-side.
  useEffect(refresh, [refresh]);

  if (!provider || !capability) return null;

  const canChoose = provider.canChooseFolder();

  const choose = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // chooseFolder resolves false on cancel or failure; either way the
      // refreshed capability is the only source of truth for what we claim.
      await provider.chooseFolder();
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const clear = () => {
    provider.clearFolder();
    refresh();
  };

  const chooseButton = canChoose ? (
    <Button variant="outline" size="sm" onClick={choose} disabled={busy}>
      <FolderOpen />
      Choose a folder
    </Button>
  ) : null;

  return (
    <div
      data-slot="destination-picker"
      className="bg-muted/30 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border px-3 py-2"
    >
      {capability.tier === "filesystem" && capability.hasDestination ? (
        <>
          <span className="flex min-w-0 items-center gap-1.5 text-xs">
            <FolderCheck className="text-success size-3.5 shrink-0" />
            <span className="text-muted-foreground">
              Received files stream straight into{" "}
              <span className="text-foreground max-w-40 truncate font-medium" title={capability.destinationLabel ?? undefined}>
                {capability.destinationLabel ?? "your chosen folder"}
              </span>
            </span>
          </span>
          <span className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={choose} disabled={busy}>
              Change
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={clear}
              aria-label="Stop saving into this folder"
            >
              <X />
            </Button>
          </span>
        </>
      ) : capability.tier === "download" ? (
        <>
          <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <HardDriveDownload className="size-3.5 shrink-0" />
            Received files go to your browser&apos;s downloads folder.
          </span>
          {chooseButton}
        </>
      ) : (
        <>
          <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <MemoryStick className="size-3.5 shrink-0" />
            Received files are held in memory
            {capability.maxBytes !== null
              ? ` (up to ${formatBytes(capability.maxBytes)} per file)`
              : ""}{" "}
            until you save them.
          </span>
          {chooseButton}
        </>
      )}
    </div>
  );
}
