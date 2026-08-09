import { normalizeInternalLocation } from "@/lib/browserHistory";

const lastCircleListLocationPrefix = "kikoto:circle-list-location:v1:";

export function isCircleListLocation(location: string) {
  const normalized = normalizeInternalLocation(location);
  if (!normalized) return false;
  try {
    return /^\/circles\/?$/i.test(new URL(normalized, "https://kikoto.invalid").pathname);
  } catch {
    return false;
  }
}

export function readLastCircleListLocation(storageScope: string) {
  try {
    const value = window.sessionStorage.getItem(storageKey(storageScope));
    return value && isCircleListLocation(value) ? normalizeInternalLocation(value) : null;
  } catch {
    return null;
  }
}

export function writeLastCircleListLocation(storageScope: string, location: string) {
  const normalized = normalizeInternalLocation(location);
  if (!normalized || !isCircleListLocation(normalized)) return;
  try {
    window.sessionStorage.setItem(storageKey(storageScope), normalized);
  } catch {
    // Navigation remains usable when session storage is unavailable.
  }
}

function storageKey(storageScope: string) {
  return `${lastCircleListLocationPrefix}${storageScope}`;
}
