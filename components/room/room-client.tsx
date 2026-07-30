"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import {
  AlertTriangle,
  FileText,
  FileUp,
  LogOut,
  Settings,
  StickyNote,
  Video,
} from "lucide-react";

import { Brand } from "@/components/brand";
import { ConnectionStatus } from "@/components/room/connection-status";
import { DocPanel } from "@/components/room/doc-panel";
import { EndedOverlay } from "@/components/room/ended-overlay";
import { FilesPanel } from "@/components/room/files-panel";
import { HostPanel } from "@/components/room/host-panel";
import { InviteDialog } from "@/components/room/invite-dialog";
import { LobbyOverlay } from "@/components/room/lobby-overlay";
import { MediaPanel } from "@/components/room/media-panel";
import { NotesPanel } from "@/components/room/notes-panel";
import { AdmitQueue } from "@/components/room/admit-queue";
import { JoinGate } from "@/components/room/join-gate";
import { ParticipantsPanel } from "@/components/room/participants-panel";
import { Presence } from "@/components/room/presence";
import { WaitingApproval } from "@/components/room/waiting-approval";
import { SoundToggle } from "@/components/room/sound-toggle";
import { VerifiedShield } from "@/components/room/verified-shield";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToastViewport } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePeerSession } from "@/hooks/use-peer-session";
import { usePeerVerification } from "@/hooks/use-peer-verification";
import { useSessionNotifications } from "@/hooks/use-session-notifications";
import { useSessionSounds } from "@/hooks/use-session-sounds";
import { useTitleAlert } from "@/hooks/use-title-alert";
import { revealIn } from "@/lib/animation";
import { consumeRoomCreated, hasSeatToken } from "@/lib/identity";
import { prettyRoomId } from "@/lib/ids";
import { cn } from "@/lib/utils";

type TabKey = "notes" | "files" | "media" | "doc" | "settings";

/** The content tabs at the top of the rail; Settings has its own trigger at
 *  the bottom of the rail, next to the quick controls it belongs with. */
const TABS: { key: TabKey; label: string; icon: typeof StickyNote }[] = [
  { key: "notes", label: "Notes", icon: StickyNote },
  { key: "doc", label: "Doc", icon: FileText },
  { key: "files", label: "Files", icon: FileUp },
  { key: "media", label: "Audio & video", icon: Video },
];

/**
 * Decides whether this visitor may knock yet.
 *
 * Someone opening an invite link has never seen the home page, so without this
 * they would knock anonymously and the host would be approving "Guest 3". The
 * signalling stream is not opened until a name exists, which is why this is a
 * wrapper rather than a prompt inside the session: no stream, no knock.
 *
 * Skipped for the creator (they just named themselves) and for a reload that is
 * reclaiming a seat (asking again would defeat the whole point of the token).
 */
export function RoomClient({ roomId }: { roomId: string }) {
  const [ready, setReady] = useState<boolean | null>(null);
  // Keyed by room and consumed once: `consumeRoomCreated` clears the marker, so
  // StrictMode's double-invoked effect would otherwise show the creator a gate.
  const decided = useRef<{ roomId: string; ready: boolean } | null>(null);

  useEffect(() => {
    if (decided.current?.roomId !== roomId) {
      decided.current = {
        roomId,
        ready: consumeRoomCreated(roomId) || hasSeatToken(roomId),
      };
    }
    setReady(decided.current.ready);
  }, [roomId]);

  // One blank paint while deciding. Preferable to flashing the gate at the
  // creator, which is the jarring failure mode.
  if (ready === null) return null;
  if (!ready) return <JoinGate roomId={roomId} onSubmit={() => setReady(true)} />;

  return <RoomSession roomId={roomId} />;
}

function RoomSession({ roomId }: { roomId: string }) {
  const session = usePeerSession(roomId);
  const [tab, setTab] = useState<TabKey>("notes");
  // The creator may close the waiting overlay and use the room alone; the
  // Invite button in the header brings the same content back at any time.
  const [lobbyDismissed, setLobbyDismissed] = useState(false);
  // Right-hand participants drawer, opened by clicking the presence pill.
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const scope = useRef<HTMLDivElement>(null);

  // Optional emoji verification of each direct link's DTLS keys.
  const verification = usePeerVerification(session.participants, session.getPairFingerprint);

  // A new knock surfaces in the participants panel, so bring it into view.
  const knockCount = session.knocks.length;
  const seenKnocks = useRef(0);
  useEffect(() => {
    if (knockCount > seenKnocks.current) setParticipantsOpen(true);
    seenKnocks.current = knockCount;
  }, [knockCount]);

  // Each of these edge-detects on the session snapshot, so they must see every
  // render. Sounds and toasts are deliberately separate: muting the audio must
  // not also silence the visual notifications.
  useSessionSounds(session);
  const activity = useSessionNotifications(session);
  useTitleAlert(activity);

  useGSAP(() => revealIn(scope.current, { stagger: 0.05, y: 10 }), { scope });

  const inviteUrl = useMemo(() => {
    if (typeof window === "undefined") return `/room/${roomId}`;
    return `${window.location.origin}/room/${roomId}`;
  }, [roomId]);

  const connected = session.phase === "connected";
  const ended = session.phase === "ended";
  // Only the host may close the session for everyone; anyone else can leave,
  // which removes just them and leaves the room running.
  const selfId = session.self?.id ?? null;
  const hostName = session.participants.find((peer) => peer.isHost)?.name ?? null;

  // The snapshot keeps `self` separate from the other participants; the roster
  // and the host panel both want one list, sorted by arrival.
  const roster = useMemo(
    () =>
      (session.self ? [session.self, ...session.participants] : session.participants).slice().sort(
        (a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id),
      ),
    [session.self, session.participants],
  );

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
    // Media has no history to be unread; the tab shows liveness instead. The
    // doc is one continuously-edited surface rather than a queue of events.
    media: 0,
    doc: 0,
    settings: 0,
  } satisfies Record<TabKey, number>;

  const transferRunning = session.transfers.some(
    (transfer) => transfer.status === "active" || transfer.status === "pending",
  );
  const mediaLive = session.media.remoteAudioLive || session.media.remoteVideoLive;

  return (
    <div className="relative flex h-dvh w-full flex-col px-4 py-4 sm:px-6 xl:px-10">
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

        <span data-anim="in">
          <VerifiedShield
            percent={verification.percent}
            connectedPeers={
              session.participants.filter(
                (peer) => peer.connectionState === "connected" && !peer.away,
              ).length
            }
            onClick={() => setParticipantsOpen(true)}
          />
        </span>

        <div data-anim="in" className="ml-auto flex items-center gap-2">
          <Presence
            participants={roster}
            selfId={selfId}
            pending={session.isHost ? session.knocks.length : 0}
            onOpenList={() => setParticipantsOpen(true)}
          />
          <InviteDialog roomId={roomId} inviteUrl={inviteUrl} />
          <ConnectionStatus phase={session.phase} peers={session.participants.length} />
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
        className="mt-4 min-h-0 flex-1 flex-row gap-3"
      >
        {/* Left rail: the tab switcher on top, quick controls at the bottom. */}
        <aside className="flex shrink-0 flex-col items-center justify-between gap-3">
          <TabsList className="h-auto w-auto flex-col">
            {TABS.map(({ key, label, icon: Icon }) => (
              <Tooltip key={key}>
                <TooltipTrigger asChild>
                  <TabsTrigger
                    value={key}
                    aria-label={label}
                    className="relative size-10 flex-none p-0"
                  >
                    <Icon />

                    {/* Two different signals: a count for things that queue up,
                        and a pulsing dot for something happening right now. */}
                    {unread[key] > 0 ? (
                      <span
                        aria-label={`${unread[key]} new`}
                        className="bg-primary text-primary-foreground absolute -top-1 -right-1 grid size-4 place-items-center rounded-full text-[0.6rem] font-semibold"
                      >
                        {unread[key] > 9 ? "9+" : unread[key]}
                      </span>
                    ) : null}

                    {(key === "media" && mediaLive) || (key === "files" && transferRunning) ? (
                      <span
                        aria-label={key === "media" ? "Receiving media" : "Transfer in progress"}
                        className="absolute -top-0.5 -right-0.5 flex size-2"
                      >
                        <span className="bg-success absolute inline-flex size-full animate-ping rounded-full opacity-70" />
                        <span className="bg-success relative inline-flex size-2 rounded-full" />
                      </span>
                    ) : null}
                  </TabsTrigger>
                </TooltipTrigger>
                <TooltipContent side="right">{label}</TooltipContent>
              </Tooltip>
            ))}
          </TabsList>

          <div className="bg-muted/60 flex flex-col items-center gap-1 rounded-xl border p-1 backdrop-blur">
            <SoundToggle />
            <ThemeToggle />
            {/* Leaving removes only you; closing the whole session is the
                host's act and lives in the Settings tab behind confirmation. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={session.leaveSession}
                  disabled={ended}
                  aria-label="Leave session"
                  className="text-destructive hover:text-destructive"
                >
                  <LogOut />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Leave session</TooltipContent>
            </Tooltip>
            <span aria-hidden className="bg-border my-0.5 h-px w-5" />
            {/* A second TabsList inside the same Tabs root: the Settings tab
                lives with the controls it configures, not among the content. */}
            <TabsList className="border-0 bg-transparent p-0 backdrop-blur-none">
              <Tooltip>
                <TooltipTrigger asChild>
                  <TabsTrigger
                    value="settings"
                    aria-label="Settings"
                    className="size-9 flex-none p-0"
                  >
                    <Settings />
                  </TabsTrigger>
                </TooltipTrigger>
                <TooltipContent side="right">Settings</TooltipContent>
              </Tooltip>
            </TabsList>
          </div>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* All panels stay mounted: switching tabs must not interrupt a
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

        <TabsContent value="doc" forceMount hidden={tab !== "doc"} className="min-h-0">
          <DocPanel
            doc={session.doc}
            roomId={roomId}
            connected={connected}
            onUpdate={session.updateDoc}
          />
        </TabsContent>

        <TabsContent value="files" forceMount hidden={tab !== "files"} className="min-h-0">
          <FilesPanel
            transfers={session.transfers}
            participants={session.participants}
            disabled={!connected}
            // The engine's own provider, not the panel's default: a folder
            // chosen in the UI has to steer the sink the engine writes through,
            // or the picker would silently affect nothing.
            sinkProvider={session.sinkProvider ?? null}
            onSend={session.sendFiles}
            onCancel={session.cancelTransfer}
            onResume={session.resumeTransfer}
          />
        </TabsContent>

        <TabsContent value="media" forceMount hidden={tab !== "media"} className="min-h-0">
          {/* The multi-participant grid: per-viewer local pinning lives inside
              the panel; the host's forced pin arrives via `pinnedByHost` and
              is set through `pinPeer`. */}
          <MediaPanel
            media={session.media}
            self={session.self}
            participants={session.participants}
            localStream={session.localStream}
            getRemoteStream={session.getRemoteStream}
            pinnedByHost={session.pinnedByHost}
            isHost={session.isHost}
            disabled={!connected}
            onPinPeer={session.pinPeer}
            // Enforcement lives in the transport, which turns the device off on
            // receipt; the panel only attributes the result and prompts for the
            // ask-* actions. `seq` increments per event so a repeated mute is
            // not de-duplicated away.
            onModerate={session.moderate}
            moderation={session.moderation}
            onToggleMic={session.toggleMic}
            onToggleCamera={session.toggleCamera}
            onToggleScreen={session.toggleScreenShare}
          />
        </TabsContent>

        <TabsContent value="settings" forceMount hidden={tab !== "settings"} className="min-h-0">
          <div className="panel scroll-slim h-full space-y-4 overflow-y-auto p-4 sm:p-5">
            <h2 className="text-sm font-semibold">Settings</h2>

            {session.isHost ? (
              /* `roster` rather than `session.participants`: the snapshot keeps
                 self out of that list, and the capacity readout must count
                 everyone. */
              <HostPanel
                capacity={session.capacity}
                participants={roster}
                onCapacityChange={session.setCapacity}
                onClose={session.closeSession}
                className="mt-0"
              />
            ) : (
              <p className="text-muted-foreground text-sm">
                Session settings (participant limit, closing the room) belong to the host. Sound
                and theme controls live at the bottom of the left rail.
              </p>
            )}
          </div>
        </TabsContent>
        </div>
      </Tabs>

      <ParticipantsPanel
        open={participantsOpen}
        onClose={() => setParticipantsOpen(false)}
        self={session.self}
        participants={session.participants}
        isHost={session.isHost}
        knocks={session.knocks}
        onAdmit={session.admit}
        onRemove={session.removePeer}
        getLinkQuality={session.getLinkQuality}
        verification={verification}
      />

      {session.phase === "lobby" && !lobbyDismissed ? (
        <LobbyOverlay
          roomId={roomId}
          inviteUrl={inviteUrl}
          onDismiss={() => setLobbyDismissed(true)}
        />
      ) : null}

      {session.phase === "waiting-approval" ? (
        <WaitingApproval hostName={hostName} onLeave={session.leaveSession} />
      ) : null}

      {ended ? (
        <EndedOverlay reason={session.endReason} error={session.error} roomId={roomId} />
      ) : null}

      {/* Mounted unconditionally for the host: the live region must exist
          before the first knock arrives or it is not announced. The visible
          queue lives in the participants panel, which auto-opens on a knock. */}
      {session.isHost ? <AdmitQueue knocks={session.knocks} /> : null}

      <ToastViewport />
    </div>
  );
}
