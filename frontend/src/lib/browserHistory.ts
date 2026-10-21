export const NAVIGATION_EVENT = "kikoto:navigation";
export const HISTORY_ENTRY_UPDATED_EVENT = "kikoto:history-entry-updated";
export const SCROLL_RESTORATION_EVENT = "kikoto:restore-scroll";

const scrollStateKey = "__kikotoScrollY";
const requestedScrollStateKey = "__kikotoRequestedScrollY";
const returnEntryStateKey = "__kikotoReturnEntry";
const mobileTabResumeStateKey = "__kikotoMobileTabResume";
const entryKeyStateKey = "__kikotoEntryKey";
const backStackStateKey = "__kikotoBackStack";
const workspaceSwitchStateKey = "__kikotoWorkspaceSwitch";
const maxHistoryStateLength = 128 * 1024;
const maxBackStackEntries = 30;
const maxBackStackLength = 128 * 1024;

type HistoryStateRecord = Record<string, unknown>;

export type HistoryEntrySnapshot = {
  location: string;
  state: HistoryStateRecord;
  scrollY: number;
};

let inAppBackStack = false;
type HistoryEntryWriter = (state: HistoryStateRecord, location: string) => void;
const replaceHistoryEntry: HistoryEntryWriter = (state, location) => window.history.replaceState(state, "", location);
let writeHistoryEntry = replaceHistoryEntry;

/**
 * Native shells keep one browser history entry. The entry's state carries the
 * in-app back stack of the workspace that shows it, so a bottom-navigation
 * switch is never a Back step and Back never crosses into another workspace's
 * entries. Browsers keep browser history, whose own Back button the app cannot
 * remove.
 */
export function enableInAppBackStack(enabled: boolean) {
  inAppBackStack = enabled;
}

export function usesInAppBackStack() {
  return inAppBackStack;
}

/** Installs the writer that restores a popped entry with its own entry key. */
export function setHistoryEntryWriter(writer: HistoryEntryWriter | null) {
  writeHistoryEntry = writer ?? replaceHistoryEntry;
}

/** The entries Back returns through from this entry, oldest first. */
export function historyBackStack(state: unknown): HistoryEntrySnapshot[] {
  const value = historyStateRecord(state)[backStackStateKey];
  if (!Array.isArray(value)) return [];
  return value.map(historyEntrySnapshotFromValue).filter((entry): entry is HistoryEntrySnapshot => entry !== null);
}

export function historyStateWithBackStack(state: unknown, stack: readonly HistoryEntrySnapshot[]): HistoryStateRecord {
  return { ...historyStateRecord(state), [backStackStateKey]: boundedBackStack(stack) };
}

/** Keeps the current entry's back stack on a replacement that does not set its own. */
export function historyStateKeepingBackStack(state: unknown, current: unknown): HistoryStateRecord {
  const next = historyStateRecord(state);
  if (backStackStateKey in next) return next;
  const stack = historyStateRecord(current)[backStackStateKey];
  return stack === undefined ? next : { ...next, [backStackStateKey]: stack };
}

/**
 * Marks a push as a bottom-navigation switch: the entry keeps the back stack
 * its state carries, or none, instead of stacking the entry it leaves.
 */
export function workspaceSwitchHistoryState(state: unknown): HistoryStateRecord {
  const record = historyStateRecord(state);
  return {
    ...record,
    [backStackStateKey]: historyBackStack(record),
    [workspaceSwitchStateKey]: true,
  };
}

/**
 * The state of an entry pushed from the current one. A workspace switch keeps
 * its own stack; a push that only replaces the current workspace list keeps the
 * current stack; any other push stacks the current entry. State copied from the
 * current entry never brings its stack along.
 */
export function inAppPushHistoryState(state: unknown, { replacesList }: { replacesList: boolean }): HistoryStateRecord {
  const next = { ...historyStateRecord(state) };
  if (next[workspaceSwitchStateKey] === true) {
    delete next[workspaceSwitchStateKey];
    return historyStateWithBackStack(next, historyBackStack(next));
  }
  delete next[backStackStateKey];
  const stack = historyBackStack(window.history.state);
  return historyStateWithBackStack(next, replacesList ? stack : [...stack, currentBackStackEntry()]);
}

/** Drops the in-app stack and switch marker where browser history keeps every push. */
export function browserPushHistoryState(state: unknown): unknown {
  const record = historyStateRecord(state);
  if (!(workspaceSwitchStateKey in record) && !(backStackStateKey in record)) return state;
  const next = { ...record };
  delete next[workspaceSwitchStateKey];
  delete next[backStackStateKey];
  return next;
}

/** Returns to the entry below the current one in the in-app back stack; false when the stack is empty. */
export function navigateInAppBack() {
  const stack = historyBackStack(window.history.state);
  const entry = stack[stack.length - 1];
  if (!entry) return false;
  restoreBackStackEntry(entry, stack.slice(0, -1));
  return true;
}

/** Back from a page control: the in-app back stack or browser history, else the fallback. */
export function navigateBackOr(fallback: () => void) {
  if (inAppBackStack) {
    if (!navigateInAppBack()) fallback();
    return;
  }
  if (window.history.length > 1) window.history.back();
  else fallback();
}

function restoreBackStackEntry(entry: HistoryEntrySnapshot, stack: readonly HistoryEntrySnapshot[]) {
  writeHistoryEntry(
    historyStateWithBackStack(historyStateWithScroll(entry.state, entry.scrollY), stack),
    entry.location,
  );
  // Pages restore a returned-to entry the way they do after browser Back.
  window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
}

function currentBackStackEntry(): HistoryEntrySnapshot {
  return {
    location: currentInternalLocation(),
    state: cloneHistoryState(window.history.state),
    scrollY: historyScrollY(window.history.state, window.scrollY),
  };
}

/** Keeps the newest entries within the entry count and serialized size bounds. */
function boundedBackStack(stack: readonly HistoryEntrySnapshot[]) {
  const bounded = stack.slice(-maxBackStackEntries);
  while (bounded.length > 0 && JSON.stringify(bounded).length > maxBackStackLength) bounded.shift();
  return bounded;
}

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

export function historyEntryKey(state: unknown): string | null {
  const key = historyStateRecord(state)[entryKeyStateKey];
  return typeof key === "string" ? key : null;
}

export function historyStateWithEntryKey(state: unknown, key: string): HistoryStateRecord {
  return { ...historyStateRecord(state), [entryKeyStateKey]: key };
}

/** Ask the shell to restore this entry after a retained list becomes visible. */
export function restoreCurrentHistoryScroll(scrollY: number) {
  window.history.replaceState(historyStateWithScroll(window.history.state, scrollY), "");
  window.dispatchEvent(new Event(SCROLL_RESTORATION_EVENT));
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

export function isMobileTabResumeHistoryState(state: unknown) {
  return historyStateRecord(state)[mobileTabResumeStateKey] === true;
}

export function historyReturnLocation(state: unknown): string | null {
  const returnTo = historyStateRecord(state).returnTo;
  return typeof returnTo === "string" ? normalizeInternalLocation(returnTo) : null;
}

export function historyReturnEntry(state: unknown): HistoryEntrySnapshot | null {
  return historyEntrySnapshotFromValue(historyStateRecord(state)[returnEntryStateKey]);
}

export function navigateToHistoryReturn({
  fallbackLocation,
  fallbackState = {},
}: {
  fallbackLocation: string;
  fallbackState?: unknown;
}) {
  const currentState = historyStateRecord(window.history.state);
  const declaredReturn = historyReturnLocation(currentState);
  const fallback = normalizeInternalLocation(fallbackLocation) ?? "/";

  if (inAppBackStack) {
    if (navigateInAppBack()) return;
    // With nothing stacked, the return replaces this entry rather than adding one.
    const returnEntry = historyReturnEntry(currentState);
    if (declaredReturn && returnEntry?.location === declaredReturn) {
      restoreBackStackEntry(returnEntry, []);
      return;
    }
    window.history.replaceState(historyStateWithBackStack(fallbackState, []), "", declaredReturn ?? fallback);
    window.dispatchEvent(new Event(NAVIGATION_EVENT));
    return;
  }

  if (declaredReturn && currentState[mobileTabResumeStateKey] !== true) {
    window.history.back();
    return;
  }

  const returnEntry = historyReturnEntry(currentState);
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

export function navigateToWorkspaceUp({
  mobile,
  fallbackLocation,
  fallbackState = {},
  isWorkspaceListLocation,
}: {
  mobile: boolean;
  fallbackLocation: string;
  fallbackState?: unknown;
  isWorkspaceListLocation: (location: string) => boolean;
}) {
  if (!mobile) {
    navigateToHistoryReturn({ fallbackLocation, fallbackState });
    return;
  }

  if (inAppBackStack) {
    // Up pops the workspace's own stack to its nearest list entry.
    const stack = historyBackStack(window.history.state);
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      if (!isWorkspaceListLocation(stack[index].location)) continue;
      restoreBackStackEntry(stack[index], stack.slice(0, index));
      return;
    }
    const fallback = normalizeInternalLocation(fallbackLocation) ?? "/";
    window.history.replaceState(historyStateWithBackStack(fallbackState, []), "", fallback);
    window.dispatchEvent(new Event(NAVIGATION_EVENT));
    return;
  }

  const currentState = historyStateRecord(window.history.state);
  const declaredReturn = historyReturnLocation(currentState);
  if (declaredReturn && isWorkspaceListLocation(declaredReturn)) {
    navigateToHistoryReturn({ fallbackLocation, fallbackState });
    return;
  }

  const fallback = normalizeInternalLocation(fallbackLocation) ?? "/";
  window.history.replaceState(historyStateRecord(fallbackState), "", fallback);
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

/** Copies an entry's state for a snapshot, which never nests another back stack. */
function cloneHistoryState(value: unknown): HistoryStateRecord {
  const state = { ...historyStateRecord(value) };
  delete state[backStackStateKey];
  delete state[workspaceSwitchStateKey];
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
