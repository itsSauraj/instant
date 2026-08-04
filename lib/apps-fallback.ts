import type { AppEntry } from "@/lib/apps-registry";

/**
 * The list shown when the remote registry has never answered since boot.
 *
 * Committed on purpose: it is the floor the launcher can never sink below, so a
 * registry that is down, slow or misconfigured shows a shorter list rather than
 * an empty panel. Everything here must satisfy the same allow-list the remote is
 * held to, since it is rendered by the same component.
 */
export const APPS_FALLBACK: AppEntry[] = [
  {
    id: "instant",
    name: "Instant",
    description: "Notes, files and video, browser to browser.",
    url: "https://saurabh-yadav.me",
    icon: "video",
    accent: "primary",
    order: 0,
  },
  {
    id: "source",
    name: "Source",
    description: "The code behind these apps.",
    url: "https://github.com/itsSauraj",
    icon: "code",
    accent: "neutral",
    order: 1,
  },
];
