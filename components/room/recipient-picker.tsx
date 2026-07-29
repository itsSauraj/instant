"use client";

import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Users } from "lucide-react";

import type { Participant, PeerId } from "@/lib/signal-protocol";
import { cn } from "@/lib/utils";

/**
 * A roster entry as the picker needs it: the plain Participant plus the state
 * of our direct link to them (from the mesh snapshot). `connectionState` is
 * optional and treated as "connected" when absent, so the picker degrades
 * gracefully if the snapshot shape is still in flight.
 */
export type RecipientOption = Participant & {
  connectionState?: string;
};

const isReachable = (peer: RecipientOption) =>
  !peer.away && (peer.connectionState === undefined || peer.connectionState === "connected");

const reachabilityReason = (peer: RecipientOption) =>
  peer.away ? "reconnecting" : "not connected";

/**
 * Chooses who an outgoing file goes to. Selection semantics mirror
 * `SendTargets`: `null` means "everyone connected" (the default, and it keeps
 * meaning everyone as people join), an array means exactly those peers.
 *
 * Renders nothing with zero or one other person -- a picker with a single
 * mandatory choice is noise.
 *
 * There is no checkbox primitive in components/ui, so these are native
 * <input type="checkbox"> elements wrapped in their labels: correct keyboard
 * behaviour, correct screen-reader naming (the reason text for a disabled
 * peer is inside the label and therefore announced), no new dependency.
 */
export function RecipientPicker({
  participants,
  selected,
  onChange,
  disabled,
}: {
  /** Everyone else in the room, self excluded. */
  participants: RecipientOption[];
  /** Peer ids to send to; null means "everyone connected". */
  selected: PeerId[] | null;
  onChange: (selected: PeerId[] | null) => void;
  disabled?: boolean;
}) {
  const reachableIds = participants.filter(isReachable).map((peer) => peer.id);

  const isChecked = (id: PeerId) =>
    selected === null ? reachableIds.includes(id) : selected.includes(id);

  const checkedCount = reachableIds.filter(isChecked).length;
  const allChecked = reachableIds.length > 0 && checkedCount === reachableIds.length;
  const noneChecked = checkedCount === 0;

  // Indeterminate is a DOM property, not an attribute; set it imperatively.
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = !allChecked && !noneChecked;
    }
  }, [allChecked, noneChecked]);

  // With one other person there is nobody to pick between. (After the hooks:
  // hook order must not depend on the roster size.)
  if (participants.length <= 1) return null;

  const toggle = (id: PeerId) => {
    const next = new Set(selected === null ? reachableIds : selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    // Collapse back to "everyone" when the set covers every reachable peer,
    // so future joiners are included again -- the default's real meaning.
    const coversAll =
      reachableIds.length > 0 &&
      reachableIds.every((peerId) => next.has(peerId)) &&
      next.size === reachableIds.length;
    onChange(coversAll ? null : [...next]);
  };

  return (
    <fieldset
      data-slot="recipient-picker"
      disabled={disabled}
      className={cn(
        "bg-muted/30 rounded-lg border px-3 py-2",
        disabled && "opacity-60",
      )}
    >
      <legend className="sr-only">Choose who receives the files</legend>

      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
          <Users className="size-3.5" />
          Send to
        </span>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs">
          <input
            ref={selectAllRef}
            type="checkbox"
            className="accent-primary size-3.5"
            checked={allChecked}
            onChange={(event) => onChange(event.target.checked ? null : [])}
          />
          Select all
        </label>
      </div>

      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
        {participants.map((peer) => {
          const reachable = isReachable(peer);
          return (
            <label
              key={peer.id}
              className={cn(
                "flex items-center gap-1.5 text-sm",
                reachable ? "cursor-pointer" : "cursor-not-allowed opacity-60",
              )}
            >
              <input
                type="checkbox"
                className="accent-primary size-3.5"
                checked={reachable && isChecked(peer.id)}
                disabled={!reachable}
                onChange={() => toggle(peer.id)}
              />
              <span className="max-w-40 truncate" title={peer.name}>
                {peer.name}
              </span>
              {!reachable ? (
                <span className="text-muted-foreground text-xs">
                  ({reachabilityReason(peer)})
                </span>
              ) : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Dev-only test mount for scripts/verify-download-tiers.mjs. The multi-peer
// wiring in room-client.tsx lands with the manager, so until then the suite
// mounts the REAL component standalone to prove its selection semantics.
// Mirrors the __instantPeerConnections convention in lib/mesh-session.ts;
// stripped from production builds by the NODE_ENV guard.
// ---------------------------------------------------------------------------

function RecipientPickerHarness({ participants }: { participants: RecipientOption[] }) {
  const [selected, setSelected] = useState<PeerId[] | null>(null);
  return (
    <div>
      <RecipientPicker participants={participants} selected={selected} onChange={setSelected} />
      <output data-slot="recipient-picker-selection">
        {selected === null ? "everyone" : JSON.stringify([...selected].sort())}
      </output>
    </div>
  );
}

if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  (window as unknown as Record<string, unknown>).__instantRecipientPickerTest = {
    mount(container: Element, participants: RecipientOption[]) {
      const root = createRoot(container);
      root.render(<RecipientPickerHarness participants={participants} />);
      return () => root.unmount();
    },
  };
}
