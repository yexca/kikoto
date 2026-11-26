import { accountScopeKey, sessionStore, type ClientStore } from "@/lib/clientStorage";
import { USER_PREFERENCES_CHANGED } from "@/lib/recommendationSession";

import { parseForYouSnapshot, type ForYouSnapshot } from "./forYouModel";

const storageName = "kikoto:for-you-draw:v1";
const memorySnapshots = new Map<string, ForYouSnapshot>();
let listeningForPreferenceChanges = false;

/**
 * The For you draw last shown for a server-and-user storage scope. It lives in
 * session storage, like the recommendation session: navigation and reloads in
 * one browser tab show the same draw, and a new tab or native-app cold launch
 * draws anew. Memory keeps it when session storage is unavailable or full.
 */
export function readForYouSnapshot(storageScope: string, store: ClientStore = sessionStore): ForYouSnapshot | null {
  listenForPreferenceChanges();
  const key = snapshotKey(storageScope);
  const remembered = memorySnapshots.get(key);
  if (remembered) return remembered;
  const value = store.readJSON(key);
  const stored = value ? parseForYouSnapshot(value) : null;
  if (stored) memorySnapshots.set(key, stored);
  return stored;
}

// Memory still keeps the draw for this page load when storage refuses it.
export function writeForYouSnapshot(storageScope: string, snapshot: ForYouSnapshot, store: ClientStore = sessionStore) {
  listenForPreferenceChanges();
  const key = snapshotKey(storageScope);
  memorySnapshots.set(key, snapshot);
  store.writeJSON(key, snapshot);
}

export function clearForYouSnapshot(storageScope: string, store: ClientStore = sessionStore) {
  const key = snapshotKey(storageScope);
  memorySnapshots.delete(key);
  store.remove(key);
}

function snapshotKey(storageScope: string) {
  return accountScopeKey(storageName, storageScope);
}

// Saved preferences change the taste profile or the shown titles, so the next
// visit draws anew from them.
function listenForPreferenceChanges() {
  if (listeningForPreferenceChanges || typeof window === "undefined") return;
  listeningForPreferenceChanges = true;
  window.addEventListener(USER_PREFERENCES_CHANGED, (event) => {
    const scope = (event as CustomEvent<unknown>).detail;
    if (typeof scope === "string") clearForYouSnapshot(scope);
  });
}
