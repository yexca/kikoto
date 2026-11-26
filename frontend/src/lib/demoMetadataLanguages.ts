import { accountKey, localStore } from "./clientStorage";

// Every Demo visitor shares one account, so a Demo visitor's metadata language
// priority stays in this browser and travels with each API request instead of
// being saved on the account. The server ignores the header outside Demo.
export const DEMO_METADATA_LANGUAGES_HEADER = "X-Kikoto-Metadata-Languages";

const storageBaseKey = "kikoto:demo-metadata-languages";

let demoUserId: number | null = null;
let current: string[] | null = null;

function demoMetadataLanguagesStorageKey(userId: number) {
  return accountKey(storageBaseKey, userId);
}

/** The stored priority; unavailable or malformed storage means no preference. */
function readStoredLanguages(userId: number): string[] | null {
  const parsed = localStore.readJSON(demoMetadataLanguagesStorageKey(userId));
  if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((value) => typeof value === "string")) {
    return parsed;
  }
  return null;
}

/** Names the signed-in Demo user, or null outside a Demo session. */
export function setDemoMetadataLanguageUser(userId: number | null) {
  if (userId === demoUserId) return;
  demoUserId = userId;
  current = userId === null ? null : readStoredLanguages(userId);
}

/**
 * Keeps a Demo visitor's priority for this browser, or clears it for each
 * work's original language. The choice applies to this tab even when the
 * browser cannot store it.
 */
export function writeDemoMetadataLanguages(languages: readonly string[] | null) {
  if (demoUserId === null) return;
  current = languages && languages.length > 0 ? [...languages] : null;
  if (current) localStore.writeJSON(demoMetadataLanguagesStorageKey(demoUserId), current);
  else localStore.remove(demoMetadataLanguagesStorageKey(demoUserId));
}

/** The header value for the current Demo choice; empty outside Demo or without a choice. */
export function demoMetadataLanguagesHeaderValue() {
  return current?.join(",") ?? "";
}
