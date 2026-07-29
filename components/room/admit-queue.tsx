"use client";

/**
 * Screen-reader announcer for the host's admission queue. The visible queue
 * lives in the participants side panel (which auto-opens on a knock) and the
 * presence pill shows a pending chip; this fixed live region exists because a
 * live region inserted together with its content is often not announced, so
 * it must stay mounted from the start.
 */
export function AdmitQueue({ knocks }: { knocks: Array<{ knockId: string; name: string }> }) {
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {knocks.length === 0
        ? ""
        : knocks.length === 1
          ? `${knocks[0].name} is asking to join.`
          : `${knocks.length} people are asking to join: ${knocks
              .map((knock) => knock.name)
              .join(", ")}.`}
    </p>
  );
}
