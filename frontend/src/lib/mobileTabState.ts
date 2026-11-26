import { appPageForLocation } from "./appRoutes";
import type { PageID } from "./appPages";
import { historyStateWithWorkDetailOwner, workDetailCodeFromLocation } from "./workDetailNavigation";
import { normalizeInternalLocation } from "./browserHistory";
import { accountScopeKey, sessionStore } from "./clientStorage";

// The version names the location form a snapshot holds; a snapshot under
// another version is not resumed, so its tab opens at its root.
const storageName = "kikoto:mobile-tab-state:v3";
// Room for the entry's own state plus its bounded back stack.
const maxSnapshotLength = 320 * 1024;

export type MobileTabSnapshot = {
  page: PageID;
  location: string;
  state: Record<string, unknown>;
  scrollY: number;
};

export function readMobileTabSnapshot(storageScope: string, page: PageID): MobileTabSnapshot | null {
  return mobileTabSnapshotFromValue(sessionStore.readJSON(mobileTabStorageKey(storageScope, page)), page);
}

export function writeMobileTabSnapshot(
  storageScope: string,
  page: PageID,
  location: string,
  state: unknown,
  scrollY: number,
) {
  const snapshot = mobileTabSnapshotFromValue({ page, location, state, scrollY }, page);
  if (!snapshot) return;
  let serialized = JSON.stringify(snapshot);
  if (serialized.length > maxSnapshotLength) {
    serialized = JSON.stringify({ ...snapshot, state: {} });
  }
  // Mobile navigation still works when session storage is unavailable.
  sessionStore.write(mobileTabStorageKey(storageScope, page), serialized);
}

export function mobileTabSnapshotFromValue(value: unknown, expectedPage: PageID): MobileTabSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<MobileTabSnapshot>;
  const location = typeof candidate.location === "string" ? normalizeInternalLocation(candidate.location) : null;
  const scrollY = Number(candidate.scrollY);
  if (candidate.page !== expectedPage || !location || !Number.isFinite(scrollY) || scrollY < 0) return null;
  const state = serializableState(candidate.state);
  // A work detail entry belongs to the page it was opened from, not to Library.
  if (appPageForLocation(location, state) !== expectedPage) return null;
  const parsed = new URL(location, "https://kikoto.invalid");
  const workDetail = workDetailCodeFromLocation(parsed.pathname, parsed.search) !== null;
  return {
    page: expectedPage,
    location,
    // Resuming pushes this entry from another page, so its owner stays explicit.
    state: workDetail ? historyStateWithWorkDetailOwner(state, expectedPage) : state,
    scrollY,
  };
}

function serializableState(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > maxSnapshotLength) return {};
    const parsed = JSON.parse(serialized) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function mobileTabStorageKey(storageScope: string, page: PageID) {
  return accountScopeKey(storageName, storageScope, page);
}
