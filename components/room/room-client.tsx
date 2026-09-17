"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import {
  AlertTriangle,
  Crown,
  FileText,
  FileUp,
  LogOut,
  Settings,
  StickyNote,
  Video,
  X,
} from "lucide-react";

import { AppsLauncher } from "@/components/apps-launcher";
import { Brand } from "@/components/brand";
import { ConnectionStatus } from "@/components/room/connection-status";
import { DocPanel } from "@/components/room/doc-panel";
import { EndedOverlay } from "@/components/room/ended-overlay";
import { EndSessionDialog } from "@/components/room/end-session-dialog";
import { FilesPanel } from "@/components/room/files-panel";
import { HostPanel } from "@/components/room/host-panel";
import { HostTransferDialog, type TransferIntent } from "@/components/room/host-transfer-dialog";
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
import { VISIBILITY_COPY, VisibilityBadge } from "@/components/room/visibility-toggle";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToastViewport } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePeerSession, type PeerSessionApi } from "@/hooks/use-peer-session";
import { usePeerVerification } from "@/hooks/use-peer-verification";
import { useSessionNotifications } from "@/hooks/use-session-notifications";
import { useSessionSounds } from "@/hooks/use-session-sounds";
import { useTitleAlert } from "@/hooks/use-title-alert";
import { pushToast } from "@/hooks/use-toasts";
import { revealIn } from "@/lib/animation";
import { consumeRoomCreated, hasSeatToken } from "@/lib/identity";
import { prettyRoomId } from "@/lib/ids";
import type { PeerId, RoomVisibility } from "@/lib/signal-protocol";
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

/** One `host-changed` event; derived from the transport's own snapshot type
 *  so any drift in the contract becomes a compile error here. `seq` increases
 *  on EVERY event (repeats included) and is what de-duplication keys on. */
type HostChangeEvent = NonNullable<PeerSessionApi["hostChange"]>;

/**
 * How long a handover waits for the server to ratify before the pending UI
 * gives up and KEEPS the host in the room. Generous next to a normal round
 * trip; leaving on a hunch is exactly the stranding case this guards. The
 * give-up is provisional, not a verdict: a stalled request can ratify AFTER
 * this fires (a dev server mid-compile or a throttled tab easily exceeds it),
 * so a late ratification is still reconciled honestly - see the overdue
 * watcher below.
 */
const HANDOVER_TIMEOUT_MS = 8000;

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
  // The marker also carries the visibility the creator picked on the home
  // page; anyone else founds (if they found at all) a private room.
  const decided = useRef<{ roomId: string; ready: boolean; foundAs: RoomVisibility } | null>(
    null,
  );

  useEffect(() => {
    if (decided.current?.roomId !== roomId) {
      const created = consumeRoomCreated(roomId);
      decided.current = {
        roomId,
        ready: created !== null || hasSeatToken(roomId),
        foundAs: created ?? "private",
      };
    }
    setReady(decided.current.ready);
  }, [roomId]);

  // One blank paint while deciding. Preferable to flashing the gate at the
  // creator, which is the jarring failure mode.
  if (ready === null) return null;
  if (!ready) return <JoinGate roomId={roomId} onSubmit={() => setReady(true)} />;

  return <RoomSession roomId={roomId} foundAs={decided.current?.foundAs ?? "private"} />;
}

function RoomSession({ roomId, foundAs }: { roomId: string; foundAs: RoomVisibility }) {
  const session = usePeerSession(roomId, "", foundAs);
  const [tab, setTab] = useState<TabKey>("notes");
  // The creator may close the waiting overlay and use the room alone; the
  // Invite button in the header brings the same content back at any time.
  const [lobbyDismissed, setLobbyDismissed] = useState(false);
  // Right-hand participants drawer, opened by clicking the presence pill.
  const [participantsOpen, setParticipantsOpen] = useState(false);
  // Modal only when the host opened it themselves; see the knock effect below.
  const [participantsModal, setParticipantsModal] = useState(true);
  const openParticipants = useCallback(() => {
    setParticipantsModal(true);
    setParticipantsOpen(true);
  }, []);
  const scope = useRef<HTMLDivElement>(null);

  // Optional emoji verification of each direct link's DTLS keys.
  const verification = usePeerVerification(session.participants, session.getPairFingerprint);

  // A knock auto-opens the participants panel, because the admit controls live
  // there and nothing else can answer one.
  //
  // It opens NON-MODAL though. The panel is anchored over the video strip, so
  // when the host opens it deliberately it gets a scrim -- otherwise it silently
  // swallows clicks on the tile controls underneath. But a scrim on an
  // auto-opened panel would let anyone knocking take the host's whole UI
  // hostage until they dismissed it, which is worse than either problem.
  const knockCount = session.knocks.length;
  const seenKnocks = useRef(0);
  useEffect(() => {
    if (knockCount > seenKnocks.current) {
      setParticipantsOpen(true);
      setParticipantsModal(false);
    }
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

  // ------------------------------------------------------------- host handover
  const { leaveSession, closeSession, isHost, transferHost, hostChange } = session;

  // The host's End-session entry point (two choices) and its follow-up picker.
  const [endOpen, setEndOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  // What the open picker is FOR: "leave" hands over then leaves; "stay" hands
  // over and remains (the host panel's Transfer hosting action). One dialog
  // serves both, so the intent travels with the open state.
  const [transferIntent, setTransferIntent] = useState<TransferIntent>("leave");
  // Set between "transfer requested" and "server ratified it"; the follow-up
  // (leave, or a stay-put confirmation) happens only on ratification (see
  // below), never on hope.
  const [handover, setHandover] = useState<{
    peerId: PeerId;
    name: string;
    intent: TransferIntent;
  } | null>(null);
  // The last handover the watchdog gave up on. The server may still ratify it
  // late; when that lands, the "you are still the host" story told at timeout
  // must be corrected honestly (the roster demotes this client regardless).
  const overdueHandover = useRef<{ peerId: PeerId; name: string; intent: TransferIntent } | null>(
    null,
  );
  // The "you are now the host" banner; dismissible, and cleared by time.
  const [hostNotice, setHostNotice] = useState<string | null>(null);

  // Exactly one notification per handover: `seq` increases on every event
  // (repeats included), so a re-rendered identical snapshot never re-fires â€”
  // the same idiom media-panel.tsx uses for `moderation`.
  const lastHostChangeSeq = useRef(0);
  const applyHostChange = useCallback((event: HostChangeEvent) => {
    if (!Number.isFinite(event.seq) || event.seq === lastHostChangeSeq.current) return;
    lastHostChangeSeq.current = event.seq;
    if (!event.becameHost) return;
    // The new host must be TOLD they now hold the admit/close keys.
    const description = event.byChoice
      ? "The previous host handed the session to you. Only you can let people in or close the room now."
      : "The previous host left, so hosting passed to you. Only you can let people in or close the room now.";
    pushToast({ title: "You are now the host", description, variant: "info" });
    setHostNotice(description);
  }, []);

  useEffect(() => {
    if (hostChange) applyHostChange(hostChange);
  }, [hostChange, applyHostChange]);

  // The banner is a reminder, not a modal: it dismisses itself after a while
  // and the toast has already done the announcing.
  useEffect(() => {
    if (!hostNotice) return;
    const timer = window.setTimeout(() => setHostNotice(null), 15_000);
    return () => window.clearTimeout(timer);
  }, [hostNotice]);

  // Dev-only test hook (same convention as media-panel's moderation hooks):
  // lets the verification suite inject `host-changed` events â€” including
  // repeats with the same seq â€” before/without the live transport.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const holder = window as unknown as Record<string, unknown>;
    holder.__instantHostChangeTest = (event: HostChangeEvent) => applyHostChange(event);
    return () => {
      delete holder.__instantHostChangeTest;
    };
  }, [applyHostChange]);

  /** A handover, in the only safe order: transfer FIRST, then act (leave, or
   *  simply stand down) once the roster proves the successor really holds the
   *  role. Leaving on an unratified transfer is exactly the stranding case
   *  this feature exists to prevent, so a refused/failed transfer keeps the
   *  host in the room - and in the role. */
  const beginHandover = useCallback(
    (peerId: PeerId) => {
      const target = session.participants.find((peer) => peer.id === peerId);
      if (!target || target.away) {
        pushToast({
          title: "Host transfer failed",
          description: "That person is no longer available, so you are still the host.",
          variant: "error",
        });
        return;
      }
      // A fresh attempt supersedes any earlier one still awaiting a late
      // ratification; two overlapping stories would both be wrong.
      overdueHandover.current = null;
      transferHost(peerId);
      setHandover({ peerId, name: target.name, intent: transferIntent });
    },
    [session.participants, transferHost, transferIntent],
  );

  // Ratification watcher. The roster is authoritative for `isHost`, so the
  // follow-up fires only once the chosen peer actually appears as host (the
  // explicit `hostChange` event is accepted as equivalent proof).
  useEffect(() => {
    if (!handover) return;
    const successor = session.participants.find((peer) => peer.id === handover.peerId);
    const ratified =
      successor?.isHost === true ||
      (hostChange !== null && hostChange.byChoice && hostChange.peerId === handover.peerId);
    if (ratified) {
      setHandover(null);
      setTransferOpen(false);
      if (handover.intent === "leave") {
        leaveSession();
      } else {
        // Transfer-only: the ex-host stays. Their host controls disappear via
        // the roster-driven isHost flip; this is the honest receipt for it.
        pushToast({
          title: "Hosting transferred",
          description: `${handover.name} is now the host. You are still in the session as a regular participant.`,
          variant: "success",
        });
      }
      return;
    }
    if (!successor) {
      // The chosen person vanished before the server ratified the handover.
      setHandover(null);
      pushToast({
        title: "Host transfer failed",
        description: `${handover.name} is no longer in the session, so you are still the host.`,
        variant: "error",
      });
    }
  }, [handover, session.participants, hostChange, leaveSession]);

  // Give up (but stay!) when no ratification arrives in time: server refusal
  // is silent from here, and an unanswered transfer must never turn into a
  // leave. The wording is deliberately provisional - "not confirmed", not
  // "nothing changed" - because a stalled request can still ratify after this
  // fires; the overdue watcher below owns that correction.
  useEffect(() => {
    if (!handover) return;
    const timer = window.setTimeout(() => {
      overdueHandover.current = handover;
      setHandover(null);
      setTransferOpen(false);
      pushToast({
        title: "Host transfer not confirmed",
        description:
          "The room did not confirm the handover in time, so for now you are still the host and still in the session. If it does complete late, you will be told here - you will never be taken out of the session without that confirmation.",
        variant: "error",
      });
    }, HANDOVER_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [handover]);

  // Late-ratification reconciliation. The 8s give-up is a guess, and it can
  // lose the race: a transfer request stalled past the watchdog (slow server,
  // throttled tab) still ratifies on arrival, and the authoritative roster
  // then demotes this client whatever the earlier toast said. Correct the
  // record the moment that happens. Deliberately NO automatic leave here,
  // even for a leave-intent handover: the user was told they are still the
  // host and may have re-engaged, so yanking them out seconds or minutes
  // later would be worse than asking for one more click.
  useEffect(() => {
    const overdue = overdueHandover.current;
    if (!overdue || handover) return;
    const successor = session.participants.find((peer) => peer.id === overdue.peerId);
    const ratified =
      successor?.isHost === true ||
      (hostChange !== null && hostChange.byChoice && hostChange.peerId === overdue.peerId);
    if (!ratified) return;
    overdueHandover.current = null;
    pushToast({
      title: "Host transfer completed after all",
      description:
        `The confirmation arrived late: ${overdue.name} is now the host. You are still in the session as a regular participant.` +
        (overdue.intent === "leave" ? " Use the Leave control whenever you want to go." : ""),
      variant: "info",
    });
  }, [handover, session.participants, hostChange]);

  // If the role or the session goes away under an open dialog, close it via
  // its own open state: unmounting an open Radix dialog can leave the body
  // scroll/pointer lock behind, which would dead-click the EndedOverlay.
  useEffect(() => {
    if (isHost && !ended) return;
    setEndOpen(false);
    setTransferOpen(false);
  }, [isHost, ended]);

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

        {/* Everyone sees whether the door is open, not just the host: a guest
            deciding what to share should know that anyone with the link can
            walk in. The host changes it under Settings. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <span data-anim="in" className="inline-flex cursor-default">
              <VisibilityBadge visibility={session.visibility} />
            </span>
          </TooltipTrigger>
          <TooltipContent>{VISIBILITY_COPY[session.visibility].summary}</TooltipContent>
        </Tooltip>

        <span data-anim="in">
          <VerifiedShield
            percent={verification.percent}
            connectedPeers={
              session.participants.filter(
                (peer) => peer.connectionState === "connected" && !peer.away,
              ).length
            }
            onClick={openParticipants}
          />
        </span>

        <div data-anim="in" className="ml-auto flex items-center gap-2">
          {/* Smallest, most recessive treatment, and leftmost in this cluster:
              the header is already dense and session controls must stay
              rightmost. It fetches nothing until opened, so a participant who
              never touches it costs a call nothing. */}
          <AppsLauncher variant="ghost" size="sm" align="end" placement="bottom" layout="list" />
          <Presence
            participants={roster}
            selfId={selfId}
            pending={session.isHost ? session.knocks.length : 0}
            onOpenList={openParticipants}
          />
          <InviteDialog roomId={roomId} inviteUrl={inviteUrl} visibility={session.visibility} />
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

      {/* Fired once per handover (seq-deduplicated above): the person who just
          inherited the room must be told, or they never learn they now hold
          the admit/close keys. The toast announces; this banner lingers. */}
      {hostNotice && !ended ? (
        <div
          role="status"
          data-slot="host-notice"
          className="border-success/40 bg-success/10 mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm"
        >
          <Crown className="text-success mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="font-medium">You are now the host.</span>{" "}
            <span className="text-muted-foreground">{hostNotice}</span>
          </span>
          <button
            type="button"
            aria-label="Dismiss host notice"
            onClick={() => setHostNotice(null)}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 -m-1 grid size-7 shrink-0 place-items-center rounded-md outline-none focus-visible:ring-[3px]"
          >
            <X className="size-4" />
          </button>
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
            {/* One control, two meanings. For a guest it is a plain leave that
                removes only them. For the host it opens the choice dialog:
                leaving (with a successor) and closing are different acts, and
                a bare "Leave" would hide the difference until too late. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={isHost ? () => setEndOpen(true) : leaveSession}
                  disabled={ended}
                  aria-label={isHost ? "End session" : "Leave session"}
                  className="text-destructive hover:text-destructive"
                >
                  <LogOut />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">
                {isHost ? "End session" : "Leave session"}
              </TooltipContent>
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
                visibility={session.visibility}
                participants={roster}
                onCapacityChange={session.setCapacity}
                onVisibilityChange={session.setVisibility}
                onTransferHost={() => {
                  // Transfer-only: the picker opens in "stay" mode, so the
                  // confirm copy promises exactly what happens - no leave.
                  setTransferIntent("stay");
                  setTransferOpen(true);
                }}
                onClose={session.closeSession}
                className="mt-0"
              />
            ) : (
              <p className="text-muted-foreground text-sm">
                Session settings (who can join, the participant limit, closing the room) belong to
                the host. Sound and theme controls live at the bottom of the left rail.
              </p>
            )}
          </div>
        </TabsContent>
        </div>
      </Tabs>

      <ParticipantsPanel
        open={participantsOpen}
        modal={participantsModal}
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
          visibility={session.visibility}
          // Alone in the lobby means host, but the server is the judge of
          // that; a guest's toggle would be refused, so offer it only when the
          // roster says we hold the role.
          onVisibilityChange={session.isHost ? session.setVisibility : undefined}
          onDismiss={() => setLobbyDismissed(true)}
        />
      ) : null}

      {session.phase === "waiting-approval" ? (
        <WaitingApproval hostName={hostName} onLeave={session.leaveSession} />
      ) : null}

      {ended ? (
        <EndedOverlay reason={session.endReason} error={session.error} roomId={roomId} />
      ) : null}

      {/* Host only in effect: a guest's rail button leaves directly and can
          never set these open, so a closed Radix dialog renders NOTHING for
          them. Kept mounted (rather than gated on isHost/ended) so a dialog
          that is open when the role or phase flips closes cleanly instead of
          being unmounted mid-open, which strands Radix's body scroll lock. */}
      <>
          <EndSessionDialog
            open={endOpen}
            onOpenChange={setEndOpen}
            othersCount={session.participants.length}
            onChooseLeave={() => {
              // The choice is made; the follow-up question (who takes over,
              // or the honest no-successor path) lives in its own dialog.
              setEndOpen(false);
              setTransferIntent("leave");
              setTransferOpen(true);
            }}
            onCloseForEveryone={() => {
              setEndOpen(false);
              closeSession();
            }}
          />
          <HostTransferDialog
            open={transferOpen}
            onOpenChange={(next) => {
              // While a transfer awaits ratification the dialog stays put:
              // closing it would hide the only progress indicator.
              if (!handover) setTransferOpen(next);
            }}
            intent={transferIntent}
            participants={session.participants}
            pendingName={handover?.name ?? null}
            onTransfer={beginHandover}
            onLeaveWithoutTransfer={() => {
              // Only reachable when there is no eligible successor (alone, or
              // everyone away); the dialog has already named what this means.
              setTransferOpen(false);
              leaveSession();
            }}
          />
      </>

      {/* Mounted unconditionally for the host: the live region must exist
          before the first knock arrives or it is not announced. The visible
          queue lives in the participants panel, which auto-opens on a knock. */}
      {session.isHost ? <AdmitQueue knocks={session.knocks} /> : null}

      <ToastViewport />
    </div>
  );
}
