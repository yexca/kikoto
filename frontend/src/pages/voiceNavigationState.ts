import { NAVIGATION_EVENT, historyStateWithReturn, normalizeInternalLocation } from "@/lib/browserHistory";

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

export function openVoiceRoute(personId: number) {
  const returnTo = currentVoiceReturnPath();
  window.history.pushState(
    historyStateWithReturn(returnTo, voiceReturnLabelForLocation(returnTo)),
    "",
    `/voices/${personId}`,
  );
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

export function currentVoiceReturnPath() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export function voiceReturnLabelForLocation(location: string) {
  try {
    const pathname = new URL(location, window.location.origin).pathname;
    if (pathname === "/" || pathname === "") return "Back to library";
    if (/^\/favorites\/?$/i.test(pathname)) return "Back to favorites";
    if (/^\/circles(?:\/|$)/i.test(pathname)) return "Back to circles";
    if (/^\/voices\/?$/i.test(pathname)) return "Back to voices";
    if (/^\/settings\/?$/i.test(pathname)) return "Back to settings";
    if (/^\/(?:RJ|BJ|VJ|CC)/i.test(pathname)) return "Back to work";
  } catch {
    // Fall through to the generic label for malformed history state.
  }
  return "Back";
}
