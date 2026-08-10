import { normalizeInternalLocation } from "@/lib/browserHistory";

const lastVoiceListLocationPrefix = "kikoto:voice-list-location:v1:";

export function isVoiceListLocation(location: string) {
  const normalized = normalizeInternalLocation(location);
  if (!normalized) return false;
  try {
    return /^\/voices\/?$/i.test(new URL(normalized, "https://kikoto.invalid").pathname);
  } catch {
    return false;
  }
}

export function readLastVoiceListLocation(storageScope: string) {
  try {
    const value = window.sessionStorage.getItem(storageKey(storageScope));
    return value && isVoiceListLocation(value) ? normalizeInternalLocation(value) : null;
  } catch {
    return null;
  }
}

export function writeLastVoiceListLocation(storageScope: string, location: string) {
  const normalized = normalizeInternalLocation(location);
  if (!normalized || !isVoiceListLocation(normalized)) return;
  try {
    window.sessionStorage.setItem(storageKey(storageScope), normalized);
  } catch {
    // Navigation remains usable when session storage is unavailable.
  }
}

function storageKey(storageScope: string) {
  return `${lastVoiceListLocationPrefix}${storageScope}`;
}
