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
    id: "S3 Manager",
    name: "S3 Manager",
    description: "Fast and secure S3 file manager.",
    url: "https://s3.saurabh-yadav.me",
    icon: "files",
    accent: "primary",
    order: 0,
  }
];
