import { NAVIGATION_EVENT, historyStateWithReturn, normalizeInternalLocation } from "@/lib/browserHistory";
import { voiceDetailPath, voiceRouteKeyFromPath } from "@/lib/voiceRoute";
import { isWorkCodePath } from "@/lib/workCode";

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

/** Opens the voice detail page a server-reported route key addresses. */
export function openVoiceRoute(routeKey: string | null | undefined) {
  const path = voiceDetailPath(routeKey);
  if (!path) return;
  const returnTo = currentVoiceReturnPath();
  window.history.pushState(historyStateWithReturn(returnTo, voiceReturnLabelForLocation(returnTo)), "", path);
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

/**
 * Replaces a voice detail URL that is still open at the requested route key
 * with the person's canonical key, keeping the entry's query, hash, and state.
 */
export function replaceVoiceRouteKey(requestedKey: string, canonicalKey: string) {
  const path = voiceDetailPath(canonicalKey);
  if (!path || requestedKey === canonicalKey || voiceRouteKeyFromPath(window.location.pathname) !== requestedKey)
    return;
  window.history.replaceState(window.history.state, "", `${path}${window.location.search}${window.location.hash}`);
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
    if (isWorkCodePath(pathname)) return "Back to work";
  } catch {
    // Fall through to the generic label for malformed history state.
  }
  return "Back";
}
