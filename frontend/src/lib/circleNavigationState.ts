import { NAVIGATION_EVENT, historyStateWithReturn, normalizeInternalLocation } from "@/lib/browserHistory";

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

export function openCircleRoute(externalId: string) {
  const returnTo = currentCircleReturnPath();
  window.history.pushState(
    historyStateWithReturn(returnTo, circleReturnLabelForLocation(returnTo)),
    "",
    `/circles/${encodeURIComponent(externalId)}`,
  );
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

export function openCircleSeriesRoute(externalId: string, seriesCode?: string | null) {
  const suffix = seriesCode ? `/series/${encodeURIComponent(seriesCode)}` : "/series";
  const returnTo = currentCircleReturnPath();
  window.history.pushState(
    historyStateWithReturn(returnTo, circleReturnLabelForLocation(returnTo)),
    "",
    `/circles/${encodeURIComponent(externalId)}${suffix}`,
  );
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

export function currentCircleReturnPath() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export function circleReturnLabelForLocation(location: string) {
  try {
    const pathname = new URL(location, window.location.origin).pathname;
    if (pathname === "/" || pathname === "") return "Back to library";
    if (/^\/favorites\/?$/i.test(pathname)) return "Back to favorites";
    if (/^\/circles\/?$/i.test(pathname)) return "Back to circles";
    if (/^\/voices(?:\/|$)/i.test(pathname)) return "Back to voice actors";
    if (/^\/settings\/?$/i.test(pathname)) return "Back to settings";
    if (/^\/RJ|^\/BJ|^\/VJ|^\/CC/i.test(pathname)) return "Back to work";
  } catch {
    // Fall through to the generic label for malformed history state.
  }
  return "Back";
}
