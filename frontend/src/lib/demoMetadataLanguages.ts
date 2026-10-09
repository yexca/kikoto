import { currentScopedStorageKey } from "./clientStorageScope";

// Every Demo visitor shares one account, so a Demo visitor's metadata language
// priority stays in this browser and travels with each API request instead of
// being saved on the account. The server ignores the header outside Demo.
export const DEMO_METADATA_LANGUAGES_HEADER = "X-Kikoto-Metadata-Languages";

const storageBaseKey = "kikoto:demo-metadata-languages";

let demoUserId: number | null = null;
let current: string[] | null = null;

function storageKey(userId: number) {
  return currentScopedStorageKey(storageBaseKey, userId);
}

function readStored(userId: number): string[] | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey(userId)) ?? "null");
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((value) => typeof value === "string")) {
      return parsed;
    }
  } catch {
    // Unavailable or malformed storage means no preference.
  }
  return null;
}

/** Names the signed-in Demo user, or null outside a Demo session. */
export function setDemoMetadataLanguageUser(userId: number | null) {
  if (userId === demoUserId) return;
  demoUserId = userId;
  current = userId === null ? null : readStored(userId);
}

/**
 * Keeps a Demo visitor's priority for this browser, or clears it for each
 * work's original language. The choice applies to this tab even when the
 * browser cannot store it.
 */
export function writeDemoMetadataLanguages(languages: readonly string[] | null) {
  if (demoUserId === null) return;
  current = languages && languages.length > 0 ? [...languages] : null;
  try {
    if (current) localStorage.setItem(storageKey(demoUserId), JSON.stringify(current));
    else localStorage.removeItem(storageKey(demoUserId));
  } catch {
    // The in-memory choice still applies to this tab.
  }
}

/** The header value for the current Demo choice; empty outside Demo or without a choice. */
export function demoMetadataLanguagesHeaderValue() {
  return current?.join(",") ?? "";
}
