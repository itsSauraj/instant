"use client";

import { useEffect, useState } from "react";
import { Check, DoorOpen, Shield, ShieldCheck, UserX, X } from "lucide-react";

import { ParticipantAvatar } from "@/components/room/presence";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Knock, LinkQuality, MeshParticipant } from "@/lib/mesh-session";
import type { Participant, PeerId } from "@/lib/signal-protocol";
import type { PairFingerprint } from "@/lib/verify";
import { cn } from "@/lib/utils";

/** How often the open panel re-reads RTT from each link's stats. */
const POLL_MS = 2000;

type Strength = {
  label: string;
  bars: 0 | 1 | 2 | 3;
  tone: "success" | "warning" | "destructive" | "muted";
};

function strengthOf(quality: LinkQuality | undefined, away: boolean): Strength {
  if (away) return { label: "Reconnecting", bars: 0, tone: "warning" };
  if (!quality || quality.state === "closed") {
    return { label: "No direct link", bars: 0, tone: "muted" };
  }
  if (quality.state === "failed") return { label: "Connection failed", bars: 0, tone: "destructive" };
  if (quality.state === "connecting") return { label: "Connecting", bars: 1, tone: "warning" };
  if (quality.rttMs === null) return { label: "Connected", bars: 2, tone: "success" };
  if (quality.rttMs < 100) return { label: `Strong · ${quality.rttMs} ms`, bars: 3, tone: "success" };
  if (quality.rttMs < 300) return { label: `Good · ${quality.rttMs} ms`, bars: 2, tone: "success" };
  return { label: `Weak · ${quality.rttMs} ms`, bars: 1, tone: "warning" };
}

const TONE_TEXT: Record<Strength["tone"], string> = {
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
};

const TONE_BAR: Record<Strength["tone"], string> = {
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  muted: "bg-muted-foreground",
};

/**
 * Right-hand participants drawer, opened from the presence pill. Shows every
 * seat plus the live health of this browser's direct link to each peer.
 */
export function ParticipantsPanel({
  open,
  modal = true,
  onClose,
  self,
  participants,
  isHost,
  knocks,
  onAdmit,
  onRemove,
  getLinkQuality,
  verification,
}: {
  open: boolean;
  /**
   * Whether to dim and block the room behind the panel.
   *
   * True when the host opened it deliberately: the panel is anchored over the
   * video strip, so without a scrim it silently swallows clicks on the tile
   * controls underneath. False when it auto-opened for a knock -- blocking the
   * whole UI because somebody else knocked would be worse than either problem.
   */
  modal?: boolean;
  onClose: () => void;
  self: Participant | null;
  participants: MeshParticipant[];
  isHost: boolean;
  /** Host only: pending join requests, answered inline in this panel. */
  knocks: Knock[];
  onAdmit: (knockId: string, allow: boolean) => void;
  onRemove: (peerId: PeerId) => void;
  getLinkQuality: (peerId: PeerId) => Promise<LinkQuality>;
  /** Emoji fingerprints per connected peer; see hooks/use-peer-verification. */
  verification: {
    pairs: Record<PeerId, PairFingerprint>;
    isVerified: (peerId: PeerId) => boolean;
    verify: (peerId: PeerId) => void;
    unverify: (peerId: PeerId) => void;
  };
}) {
  const [quality, setQuality] = useState<Record<PeerId, LinkQuality>>({});
  /** Which row's emoji fingerprint is expanded. */
  const [keyOpenFor, setKeyOpenFor] = useState<PeerId | null>(null);
  const peerKey = participants.map((peer) => peer.id).join(",");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const probe = async () => {
      const ids = peerKey ? peerKey.split(",") : [];
      const entries = await Promise.all(
        ids.map(async (id) => [id, await getLinkQuality(id)] as const),
      );
      if (!cancelled) setQuality(Object.fromEntries(entries));
    };

    void probe();
    const timer = setInterval(() => void probe(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // Keyed on the id list, not the array: snapshots rebuild `participants`
    // constantly and resetting the poll on every render would defeat it.
  }, [open, peerKey, getLinkQuality]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const headcount = participants.length + (self ? 1 : 0);

  return (
    <>
      {/*
        A scrim, because this panel is anchored to the right edge -- exactly
        where the video strip lives. Without it the panel silently covers the
        strip's per-tile controls: clicks land on the panel and the buttons
        underneath simply appear dead. The scrim makes the modality visible and
        gives a click-anywhere-to-close escape, alongside Escape above.
      */}
      {modal ? (
        <div
          aria-hidden
          onClick={onClose}
          className="fixed inset-0 z-30 bg-black/20 backdrop-blur-[1px]"
        />
      ) : null}
      <aside
        role="dialog"
        aria-modal={modal || undefined}
        aria-label="Participants"
        className="panel fixed inset-y-0 right-0 z-40 flex w-80 max-w-[85vw] flex-col rounded-none border-l shadow-xl sm:inset-y-3 sm:right-3 sm:rounded-xl sm:border"
      >
      <header className="flex shrink-0 items-center gap-2 border-b p-3 sm:px-4">
        <h2 className="text-sm font-semibold">Participants</h2>
        <span className="text-muted-foreground text-xs">{headcount} in session</span>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Close participants"
          className="ml-auto size-7"
        >
          <X className="size-4" />
        </Button>
      </header>

      {isHost && knocks.length > 0 ? (
        <section
          aria-label="People asking to join"
          className="border-warning/40 bg-warning/10 shrink-0 border-b p-2"
        >
          <p className="text-warning mb-1.5 flex items-center gap-1.5 px-1 text-xs font-medium">
            <DoorOpen className="size-3.5" aria-hidden />
            {knocks.length === 1 ? "Someone is asking to join" : "People are asking to join"}
          </p>
          <ul className="space-y-1">
            {knocks.map((knock) => (
              <li
                key={knock.knockId}
                className="bg-background/60 flex h-10 items-center gap-2 rounded-lg border px-2"
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{knock.name}</span>
                <Button
                  type="button"
                  size="sm"
                  aria-label={`Let ${knock.name} in`}
                  onClick={() => onAdmit(knock.knockId, true)}
                  className="h-7 gap-1 px-2"
                >
                  <Check className="size-3.5" />
                  Admit
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={`Turn ${knock.name} away`}
                  onClick={() => onAdmit(knock.knockId, false)}
                  className="text-destructive hover:text-destructive h-7 px-2"
                >
                  <X className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ul className="scroll-slim min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
        {self ? (
          <li className="flex items-center gap-2.5 rounded-lg p-2">
            <ParticipantAvatar entry={{ ...self, isSelf: true }} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {self.name} <span className="text-muted-foreground font-normal">(you)</span>
              </p>
              <p className="text-muted-foreground text-xs">
                {self.isHost ? "Host · this device" : "This device"}
              </p>
            </div>
          </li>
        ) : null}

        {participants.map((peer) => {
          const strength = strengthOf(quality[peer.id], peer.away);
          const pair = verification.pairs[peer.id];
          const verified = verification.isVerified(peer.id);
          const keyOpen = keyOpenFor === peer.id;
          return (
            <li key={peer.id} className="hover:bg-accent/40 rounded-lg p-2">
              <div className="flex items-center gap-2.5">
                <ParticipantAvatar entry={{ ...peer, isSelf: false }} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {peer.name}
                    {peer.isHost ? (
                      <span className="text-muted-foreground font-normal"> · host</span>
                    ) : null}
                  </p>
                  <p className={cn("flex items-center gap-1.5 text-xs", TONE_TEXT[strength.tone])}>
                    <SignalBars bars={strength.bars} tone={strength.tone} />
                    {strength.label}
                  </p>
                </div>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={!pair}
                      onClick={() => setKeyOpenFor(keyOpen ? null : peer.id)}
                      aria-expanded={keyOpen}
                      aria-label={
                        verified
                          ? `Encryption with ${peer.name} verified`
                          : `Show encryption key for ${peer.name}`
                      }
                      className={cn(
                        "size-7",
                        verified
                          ? "text-success hover:text-success"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {verified ? <ShieldCheck className="size-4" /> : <Shield className="size-4" />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {!pair
                      ? "Key appears once you are directly connected"
                      : verified
                        ? "Encryption verified · click to review"
                        : "Verify encryption (optional)"}
                  </TooltipContent>
                </Tooltip>

                {isHost ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => onRemove(peer.id)}
                        aria-label={`Remove ${peer.name}`}
                        className="text-muted-foreground hover:text-destructive size-7"
                      >
                        <UserX className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Remove from session</TooltipContent>
                  </Tooltip>
                ) : null}
              </div>

              {keyOpen && pair ? (
                <div className="bg-background/60 mt-2 rounded-lg border p-2.5">
                  <p className="text-muted-foreground text-xs">
                    Ask {peer.name} to open your entry in their participants list. If both of you
                    see these emojis in this order, everything between you (notes, doc, files,
                    audio and video) is encrypted end to end with no one in the middle.
                  </p>
                  <div
                    role="img"
                    aria-label={`Verification emojis: ${pair.emojis.join(" ")}`}
                    className="mx-auto mt-2 grid w-fit grid-cols-5 gap-x-2.5 gap-y-1 text-lg"
                  >
                    {pair.emojis.map((emoji, index) => (
                      <span key={index} className="text-center">
                        {emoji}
                      </span>
                    ))}
                  </div>
                  <div className="mt-2.5 flex items-center justify-end gap-2">
                    {verified ? (
                      <>
                        <span className="text-success mr-auto flex items-center gap-1 text-xs">
                          <ShieldCheck className="size-3.5" /> Verified
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => verification.unverify(peer.id)}
                        >
                          Remove verification
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        className="h-7 gap-1 px-2.5 text-xs"
                        onClick={() => {
                          verification.verify(peer.id);
                        }}
                      >
                        <ShieldCheck className="size-3.5" />
                        They match - verify
                      </Button>
                    )}
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <p className="text-muted-foreground shrink-0 border-t p-3 text-xs sm:px-4">
        Strength is the direct link from this device to each person.
      </p>
      </aside>
    </>
  );
}

function SignalBars({ bars, tone }: { bars: 0 | 1 | 2 | 3; tone: Strength["tone"] }) {
  return (
    <span className="flex items-end gap-px" aria-hidden>
      {[1, 2, 3].map((level) => (
        <span
          key={level}
          className={cn(
            "w-1 rounded-[1px]",
            level === 1 ? "h-1.5" : level === 2 ? "h-2.5" : "h-3.5",
            level <= bars ? TONE_BAR[tone] : "bg-muted-foreground/25",
          )}
        />
      ))}
    </span>
  );
}
