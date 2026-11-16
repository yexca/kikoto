import { useState } from "react";

const shelfListHiddenStorageKey = "kikoto:favorites-shelves-hidden";

export function readFavoriteShelfListHidden(storage: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return storage?.getItem(shelfListHiddenStorageKey) === "true";
  } catch {
    return false;
  }
}

export function storeFavoriteShelfListHidden(storage: Pick<Storage, "setItem"> | undefined, hidden: boolean) {
  try {
    storage?.setItem(shelfListHiddenStorageKey, String(hidden));
  } catch {
    // The list still hides for this visit when storage is unavailable.
  }
}

function browserStorage() {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** Whether the wide layout hides its shelf list: a per-device preference, like the view mode. */
export function useFavoriteShelfListHidden() {
  const [hidden, setHidden] = useState(() => readFavoriteShelfListHidden(browserStorage()));
  const toggle = () => {
    const next = !hidden;
    setHidden(next);
    storeFavoriteShelfListHidden(browserStorage(), next);
  };
  return [hidden, toggle] as const;
}
