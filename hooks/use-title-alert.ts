"use client";

import { useEffect, useRef } from "react";

/**
 * Prefixes the document title with an unread count while the tab is hidden,
 * e.g. `(2) Instant - session`, and restores the original title exactly when
 * the tab regains focus (or the component unmounts).
 *
 * `activity` is any monotonically increasing counter of noteworthy events -
 * e.g. `notes.length + completedTransfers`. The count shown is the number of
 * events since the tab was hidden, so pre-existing state never alerts.
 */
export function useTitleAlert(activity: number) {
  // Activity level at the moment the tab went hidden; null while visible.
  const baseline = useRef<number | null>(null);
  // The exact title we overwrote, so restoration is byte-for-byte.
  const savedTitle = useRef<string | null>(null);
  const activityRef = useRef(activity);

  useEffect(() => {
    activityRef.current = activity;
    if (baseline.current === null) return;
    const count = activity - baseline.current;
    if (count <= 0) return;
    // Capture the title only once per hidden period, right before the first
    // rewrite - anything the app set earlier is preserved verbatim.
    if (savedTitle.current === null) savedTitle.current = document.title;
    document.title = `(${count}) ${savedTitle.current}`;
  }, [activity]);

  useEffect(() => {
    const restore = () => {
      if (savedTitle.current !== null) {
        document.title = savedTitle.current;
        savedTitle.current = null;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        baseline.current = activityRef.current;
      } else {
        baseline.current = null;
        restore();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    // Mounted while already hidden (e.g. opened in a background tab): start
    // counting from here rather than never counting at all.
    if (document.visibilityState === "hidden") baseline.current = activityRef.current;

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      restore(); // never leave a stale "(n)" behind after unmount
    };
  }, []);
}
