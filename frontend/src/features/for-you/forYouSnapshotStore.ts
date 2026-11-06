import { USER_PREFERENCES_CHANGED } from "@/lib/recommendationSession";

import { parseForYouSnapshot, type ForYouSnapshot } from "./forYouModel";

type SnapshotStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const storagePrefix = "kikoto:for-you-draw:v1:";
const memorySnapshots = new Map<string, ForYouSnapshot>();
let listeningForPreferenceChanges = false;

/**
 * The For you draw last shown for a server-and-user storage scope. It lives in
 * session storage, like the recommendation session: navigation and reloads in
 * one browser tab show the same draw, and a new tab or native-app cold launch
 * draws anew. Memory keeps it when session storage is unavailable or full.
 */
export function readForYouSnapshot(
  storageScope: string,
  storage: SnapshotStorage | null = browserSessionStorage(),
): ForYouSnapshot | null {
  listenForPreferenceChanges();
  const key = snapshotKey(storageScope);
  const remembered = memorySnapshots.get(key);
  if (remembered) return remembered;
  let stored: ForYouSnapshot | null = null;
  try {
    const raw = storage?.getItem(key);
    stored = raw ? parseForYouSnapshot(JSON.parse(raw)) : null;
  } catch {
    stored = null;
  }
  if (stored) memorySnapshots.set(key, stored);
  return stored;
}

export function writeForYouSnapshot(
  storageScope: string,
  snapshot: ForYouSnapshot,
  storage: SnapshotStorage | null = browserSessionStorage(),
) {
  listenForPreferenceChanges();
  const key = snapshotKey(storageScope);
  memorySnapshots.set(key, snapshot);
  try {
    storage?.setItem(key, JSON.stringify(snapshot));
  } catch {
    // Memory still keeps the draw for this page load.
  }
}

export function clearForYouSnapshot(storageScope: string, storage: SnapshotStorage | null = browserSessionStorage()) {
  const key = snapshotKey(storageScope);
  memorySnapshots.delete(key);
  try {
    storage?.removeItem(key);
  } catch {
    // Nothing else holds the draw.
  }
}

function snapshotKey(storageScope: string) {
  return `${storagePrefix}${storageScope}`;
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

function browserSessionStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
