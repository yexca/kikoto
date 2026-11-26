import { useState } from "react";

import { deviceKey, localStore } from "@/lib/clientStorage";

export type FavoriteViewMode = "grid" | "list";

const viewModeStorageKey = deviceKey("kikoto:favorites-view");

function readFavoriteViewMode(): FavoriteViewMode {
  return localStore.read(viewModeStorageKey) === "list" ? "list" : "grid";
}

/** A per-device preference, like the work collection columns. */
export function useFavoriteViewMode() {
  const [viewMode, setViewMode] = useState<FavoriteViewMode>(readFavoriteViewMode);
  const update = (next: FavoriteViewMode) => {
    setViewMode(next);
    // The view still switches for this visit when storage is unavailable.
    localStore.write(viewModeStorageKey, next);
  };
  return [viewMode, update] as const;
}
