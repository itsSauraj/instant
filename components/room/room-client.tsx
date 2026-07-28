"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import { AlertTriangle, FileUp, LogOut, StickyNote, Video } from "lucide-react";

import { Brand } from "@/components/brand";
import { ConnectionStatus } from "@/components/room/connection-status";
import { EndedOverlay } from "@/components/room/ended-overlay";
import { FilesPanel } from "@/components/room/files-panel";
import { LobbyOverlay } from "@/components/room/lobby-overlay";
import { MediaPanel } from "@/components/room/media-panel";
import { NotesPanel } from "@/components/room/notes-panel";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePeerSession } from "@/hooks/use-peer-session";
import { revealIn } from "@/lib/animation";
import { prettyRoomId } from "@/lib/ids";

type TabKey = "notes" | "files" | "media";

const TABS: { key: TabKey; label: string; icon: typeof StickyNote }[] = [
  { key: "notes", label: "Notes", icon: StickyNote },
  { key: "files", label: "Files", icon: FileUp },
  { key: "media", label: "Audio & video", icon: Video },
];

export function RoomClient({ roomId }: { roomId: string }) {
  const session = usePeerSession(roomId);
  const [tab, setTab] = useState<TabKey>("notes");
  const scope = useRef<HTMLDivElement>(null);

  useGSAP(() => revealIn(scope.current, { stagger: 0.05, y: 10 }), { scope });

  const inviteUrl = useMemo(() => {
    if (typeof window === "undefined") return `/room/${roomId}`;
    return `${window.location.origin}/room/${roomId}`;
  }, [roomId]);

  const connected = session.phase === "connected" && session.channelsReady;
  const ended = session.phase === "ended";

  // Unread markers, so a note arriving while you're on the Files tab is visible.
  const [seen, setSeen] = useState({ notes: 0, files: 0 });
  useEffect(() => {
    setSeen((prev) => {
      const next = {
        notes: tab === "notes" ? session.notes.length : prev.notes,
        files: tab === "files" ? session.transfers.length : prev.files,
      };
      // Preserve identity when nothing moved, otherwise every snapshot emitted
      // by a running transfer would force an extra render here.
      return next.notes === prev.notes && next.files === prev.files ? prev : next;
    });
  }, [tab, session.notes.length, session.transfers.length]);

  const unread = {
    notes: tab === "notes" ? 0 : Math.max(0, session.notes.length - seen.notes),
    files: tab === "files" ? 0 : Math.max(0, session.transfers.length - seen.files),
    media: 0,
  } satisfies Record<TabKey, number>;

  return (
    <div className="relative mx-auto flex h-dvh w-full max-w-6xl flex-col px-4 py-4 sm:px-6">
      <header ref={scope} className="flex flex-wrap items-center gap-3">
        <Brand />

        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" data-anim="in" className="cursor-default gap-1.5 py-1 font-mono">
              {prettyRoomId(roomId)}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>Session code</TooltipContent>
        </Tooltip>

        <div data-anim="in" className="ml-auto flex items-center gap-2">
          <ConnectionStatus phase={session.phase} />
          <ThemeToggle />
          <Button
            variant="destructive"
            size="sm"
            onClick={session.endSession}
            disabled={ended}
            className="gap-1.5"
          >
            <LogOut className="size-3.5" />
            <span className="hidden sm:inline">End session</span>
          </Button>
        </div>
      </header>

      {session.error && !ended ? (
        <div
          role="alert"
          className="border-destructive/30 bg-destructive/10 text-destructive mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{session.error}</span>
        </div>
      ) : null}

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as TabKey)}
        className="mt-4 min-h-0 flex-1"
      >
        <TabsList className="w-full sm:w-auto">
          {TABS.map(({ key, label, icon: Icon }) => (
            <TabsTrigger key={key} value={key} className="relative">
              <Icon />
              <span className="hidden sm:inline">{label}</span>
              <span className="sm:hidden">{key === "media" ? "A/V" : label}</span>
              {unread[key] > 0 ? (
                <span className="bg-primary text-primary-foreground absolute -top-1 -right-1 grid size-4 place-items-center rounded-full text-[0.6rem] font-semibold">
                  {unread[key] > 9 ? "9+" : unread[key]}
                </span>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* All three panels stay mounted: switching tabs must not interrupt a
            running transfer or drop a live camera track. */}
        <TabsContent value="notes" forceMount hidden={tab !== "notes"} className="min-h-0">
          <NotesPanel
            notes={session.notes}
            peerTyping={session.peerTyping}
            disabled={!connected}
            onSend={session.sendNote}
            onTyping={session.notifyTyping}
          />
        </TabsContent>

        <TabsContent value="files" forceMount hidden={tab !== "files"} className="min-h-0">
          <FilesPanel
            transfers={session.transfers}
            disabled={!connected}
            onSend={session.sendFiles}
            onCancel={session.cancelTransfer}
          />
        </TabsContent>

        <TabsContent value="media" forceMount hidden={tab !== "media"} className="min-h-0">
          <MediaPanel
            media={session.media}
            localStream={session.localStream}
            remoteStream={session.remoteStream}
            disabled={!connected}
            onToggleMic={session.toggleMic}
            onToggleCamera={session.toggleCamera}
            onToggleScreen={session.toggleScreenShare}
          />
        </TabsContent>
      </Tabs>

      {session.phase === "waiting" ? <LobbyOverlay roomId={roomId} inviteUrl={inviteUrl} /> : null}
      {ended ? <EndedOverlay reason={session.endReason} error={session.error} /> : null}
    </div>
  );
}
