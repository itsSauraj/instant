/**
 * The guide's section registry: one place for ids, order and labels, so the
 * table of contents and the page body can never drift apart. The verify
 * script asserts every one of these anchors exists.
 */
export const GUIDE_SECTIONS = [
  { id: "create", label: "Create a session" },
  { id: "invite", label: "Invite people" },
  { id: "joining", label: "Joining and approval" },
  { id: "reload", label: "Reloads and reconnects" },
  { id: "notes", label: "Notes and the shared doc" },
  { id: "files", label: "Files" },
  { id: "calls", label: "Calls" },
  { id: "host", label: "Host controls" },
  { id: "encryption", label: "Privacy and encryption" },
  { id: "troubleshooting", label: "Troubleshooting" },
] as const;

export type GuideSectionId = (typeof GUIDE_SECTIONS)[number]["id"];
