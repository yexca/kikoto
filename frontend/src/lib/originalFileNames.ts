import { useCallback, useSyncExternalStore } from "react";

import { deviceKey, localStore } from "./clientStorage";

// Whether this viewer asked to see the real names of local files and folders in
// place of their display names. The work detail directory and the player share
// the choice, which stays on this device.

const originalFileNamesStorageKey = deviceKey("kikoto:work-directory-original-names");
const listeners = new Set<() => void>();
let original = readOriginalFileNamesShown();

function readOriginalFileNamesShown() {
  return localStore.read(originalFileNamesStorageKey) === "true";
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const syncFromOtherTab = (event: StorageEvent) => {
    if (event.key !== originalFileNamesStorageKey) return;
    original = readOriginalFileNamesShown();
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
  // Without storage the choice still applies to this page view.
  localStore.write(originalFileNamesStorageKey, String(next));
  for (const listener of listeners) listener();
}

/** The current choice and a toggle for it. */
export function useOriginalFileNames() {
  const shown = useSyncExternalStore(subscribe, originalFileNamesShown);
  const toggle = useCallback(() => setOriginalFileNamesShown(!originalFileNamesShown()), []);
  return [shown, toggle] as const;
}
