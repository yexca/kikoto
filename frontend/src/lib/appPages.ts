import { WORKFLOWS_PATH } from "./workflowLinks";

/**
 * The app's pages and the address each one opens at. Navigation and history
 * helpers that features and the player share resolve pages from this table;
 * `app/navigation` adds each page's label, icon, audience, and group.
 */
export const pagePaths = {
  library: "/",
  favorites: "/favorites",
  circles: "/circles",
  "voice-actors": "/voices",
  records: "/records",
  "for-you": "/for-you",
  subscriptions: "/discover",
  insights: "/insights",
  tags: "/tags",
  settings: "/settings",
  workflows: WORKFLOWS_PATH,
  metadata: "/metadata",
  translation: "/translation",
  cleanup: "/cleanup",
  system: "/system",
  about: "/about",
} as const;

export type PageID = keyof typeof pagePaths;

const pageIDs = Object.keys(pagePaths) as PageID[];

export function isPageID(value: unknown): value is PageID {
  return typeof value === "string" && (pageIDs as string[]).includes(value);
}

/** The page whose own address is `path` exactly, or undefined. */
export function pageAtPath(path: string): PageID | undefined {
  return pageIDs.find((page) => pagePaths[page] === path);
}
