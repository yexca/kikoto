export const NAVIGATION_EVENT = "kikoto:navigation";
export const HISTORY_ENTRY_UPDATED_EVENT = "kikoto:history-entry-updated";

const scrollStateKey = "__kikotoScrollY";
const requestedScrollStateKey = "__kikotoRequestedScrollY";
const returnEntryStateKey = "__kikotoReturnEntry";
const mobileTabResumeStateKey = "__kikotoMobileTabResume";
const maxHistoryStateLength = 128 * 1024;

type HistoryStateRecord = Record<string, unknown>;

export type HistoryEntrySnapshot = {
  location: string;
  state: HistoryStateRecord;
  scrollY: number;
};

export function normalizeInternalLocation(location: string): string | null {
  const value = location.trim();
  if (!value.startsWith("/") || value.startsWith("//") || value.length > 8192) return null;
  const base = "https://kikoto.invalid";
  try {
    const parsed = new URL(value, base);
    if (parsed.origin !== base) return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

export function currentInternalLocation() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export function historyScrollY(state: unknown, fallback = 0) {
  const value = Number(historyStateRecord(state)[scrollStateKey]);
  return Number.isFinite(value) && value >= 0 ? value : Math.max(0, fallback);
}

export function historyStateWithScroll(state: unknown, scrollY: number): HistoryStateRecord {
  const next = { ...historyStateRecord(state) };
  delete next[requestedScrollStateKey];
  next[scrollStateKey] = finiteScrollY(scrollY);
  return next;
}

export function historyPushStateWithScroll(state: unknown) {
  const requested = Number(historyStateRecord(state)[requestedScrollStateKey]);
  return historyStateWithScroll(state, Number.isFinite(requested) && requested >= 0 ? requested : 0);
}

export function requestHistoryScrollRestoration(state: unknown, scrollY: number): HistoryStateRecord {
  return {
    ...historyStateRecord(state),
    [requestedScrollStateKey]: finiteScrollY(scrollY),
  };
}

export function historyStateWithReturn(returnTo: string, returnLabel: string, state: unknown = {}): HistoryStateRecord {
  const normalizedReturnTo = normalizeInternalLocation(returnTo) ?? "/";
  return {
    ...historyStateRecord(state),
    returnTo: normalizedReturnTo,
    returnLabel,
    [returnEntryStateKey]: currentHistoryEntrySnapshot(),
  };
}

export function mobileTabResumeHistoryState(state: unknown): HistoryStateRecord {
  return {
    ...historyStateRecord(state),
    [mobileTabResumeStateKey]: true,
  };
}

export function navigateToHistoryReturn({
  fallbackLocation,
  fallbackState = {},
}: {
  fallbackLocation: string;
  fallbackState?: unknown;
}) {
  const currentState = historyStateRecord(window.history.state);
  const declaredReturn =
    typeof currentState.returnTo === "string" ? normalizeInternalLocation(currentState.returnTo) : null;
  const fallback = normalizeInternalLocation(fallbackLocation) ?? "/";

  if (declaredReturn && currentState[mobileTabResumeStateKey] !== true) {
    window.history.back();
    return;
  }

  const returnEntry = historyEntrySnapshotFromValue(currentState[returnEntryStateKey]);
  if (declaredReturn && returnEntry?.location === declaredReturn) {
    window.history.pushState(
      requestHistoryScrollRestoration(mobileTabResumeHistoryState(returnEntry.state), returnEntry.scrollY),
      "",
      returnEntry.location,
    );
  } else {
    window.history.pushState(fallbackState, "", declaredReturn ?? fallback);
  }
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

export function historyEntrySnapshotFromValue(value: unknown): HistoryEntrySnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<HistoryEntrySnapshot>;
  const location = typeof candidate.location === "string" ? normalizeInternalLocation(candidate.location) : null;
  const scrollY = Number(candidate.scrollY);
  if (!location || !Number.isFinite(scrollY) || scrollY < 0) return null;
  return {
    location,
    state: cloneHistoryState(candidate.state),
    scrollY,
  };
}

function currentHistoryEntrySnapshot(): HistoryEntrySnapshot {
  return {
    location: currentInternalLocation(),
    state: cloneHistoryState(window.history.state),
    scrollY: finiteScrollY(window.scrollY),
  };
}

function historyStateRecord(value: unknown): HistoryStateRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as HistoryStateRecord) : {};
}

function cloneHistoryState(value: unknown): HistoryStateRecord {
  const state = historyStateRecord(value);
  try {
    const serialized = JSON.stringify(state);
    if (serialized.length > maxHistoryStateLength) return {};
    const cloned = JSON.parse(serialized) as unknown;
    return historyStateRecord(cloned);
  } catch {
    return {};
  }
}

function finiteScrollY(value: number) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
