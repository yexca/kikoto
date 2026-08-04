import type { PageID } from "./navigation";
import { normalizeInternalLocation } from "../lib/browserHistory";

const storagePrefix = "kikoto:mobile-tab-state:v1:";
const maxSnapshotLength = 192 * 1024;

export type MobileTabSnapshot = {
  page: PageID;
  location: string;
  state: Record<string, unknown>;
  scrollY: number;
};

export function readMobileTabSnapshot(storageScope: string, page: PageID): MobileTabSnapshot | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(storageScope, page));
    return raw ? mobileTabSnapshotFromValue(JSON.parse(raw), page) : null;
  } catch {
    return null;
  }
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
  try {
    let serialized = JSON.stringify(snapshot);
    if (serialized.length > maxSnapshotLength) {
      serialized = JSON.stringify({ ...snapshot, state: {} });
    }
    window.sessionStorage.setItem(storageKey(storageScope, page), serialized);
  } catch {
    // Mobile navigation still works when session storage is unavailable.
  }
}

export function mobileTabSnapshotFromValue(value: unknown, expectedPage: PageID): MobileTabSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<MobileTabSnapshot>;
  const location = typeof candidate.location === "string" ? normalizeInternalLocation(candidate.location) : null;
  const scrollY = Number(candidate.scrollY);
  if (candidate.page !== expectedPage || !location || !Number.isFinite(scrollY) || scrollY < 0) return null;
  return {
    page: expectedPage,
    location,
    state: serializableState(candidate.state),
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

function storageKey(storageScope: string, page: PageID) {
  return `${storagePrefix}${storageScope}:${page}`;
}
