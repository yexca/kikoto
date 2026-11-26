import { useState } from "react";

import { deviceKey, localStore, type ClientStore } from "@/lib/clientStorage";

const shelfListHiddenStorageKey = deviceKey("kikoto:favorites-shelves-hidden");

export function readFavoriteShelfListHidden(store: ClientStore = localStore): boolean {
  return store.read(shelfListHiddenStorageKey) === "true";
}

// The list still hides for this visit when storage is unavailable.
export function storeFavoriteShelfListHidden(hidden: boolean, store: ClientStore = localStore) {
  store.write(shelfListHiddenStorageKey, String(hidden));
}

/** Whether the wide layout hides its shelf list: a per-device preference, like the view mode. */
export function useFavoriteShelfListHidden() {
  const [hidden, setHidden] = useState(() => readFavoriteShelfListHidden());
  const toggle = () => {
    const next = !hidden;
    setHidden(next);
    storeFavoriteShelfListHidden(next);
  };
  return [hidden, toggle] as const;
}
