import { useCallback, useSyncExternalStore } from "react";

// Whether this viewer asked to see the real names of local files and folders in
// place of their display names. The work detail directory and the player share
// the choice, which stays on this device.

const storageKey = "kikoto:work-directory-original-names";
const listeners = new Set<() => void>();
let original = readStored();

function readStored() {
  try {
    return localStorage.getItem(storageKey) === "true";
  } catch {
    return false;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const syncFromOtherTab = (event: StorageEvent) => {
    if (event.key !== storageKey) return;
    original = readStored();
    listener();
  };
  window.addEventListener("storage", syncFromOtherTab);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", syncFromOtherTab);
  };
}

/** The current choice, for code outside rendering such as a toast. */
export function originalFileNamesShown() {
  return original;
}

export function setOriginalFileNamesShown(next: boolean) {
  original = next;
  try {
    localStorage.setItem(storageKey, String(next));
  } catch {
    // The choice still applies to this page view.
  }
  for (const listener of listeners) listener();
}

/** The current choice and a toggle for it. */
export function useOriginalFileNames() {
  const shown = useSyncExternalStore(subscribe, originalFileNamesShown);
  const toggle = useCallback(() => setOriginalFileNamesShown(!originalFileNamesShown()), []);
  return [shown, toggle] as const;
}
