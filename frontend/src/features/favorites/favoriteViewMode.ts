import { useState } from "react";

export type FavoriteViewMode = "grid" | "list";

const viewModeStorageKey = "kikoto:favorites-view";

function readFavoriteViewMode(): FavoriteViewMode {
  try {
    return window.localStorage.getItem(viewModeStorageKey) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

/** A per-device preference, like the work collection columns. */
export function useFavoriteViewMode() {
  const [viewMode, setViewMode] = useState<FavoriteViewMode>(readFavoriteViewMode);
  const update = (next: FavoriteViewMode) => {
    setViewMode(next);
    try {
      window.localStorage.setItem(viewModeStorageKey, next);
    } catch {
      // The view still switches for this visit when storage is unavailable.
    }
  };
  return [viewMode, update] as const;
}
