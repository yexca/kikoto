import { useEffect, useState } from "react";

import { api, type FavoriteList, type WorkDetail } from "@/lib/api";

/**
 * The favorite lists with a work's membership in each, reloaded when the
 * work or its favorite flag changes and after a list save.
 */
export function useWorkFavoriteLists(work: WorkDetail | null) {
  const [favoriteLists, setFavoriteLists] = useState<FavoriteList[]>([]);

  useEffect(() => {
    if (!work?.id) return;
    let cancelled = false;
    api
      .getWorkFavoriteLists(work.id)
      .then((lists) => {
        if (!cancelled) setFavoriteLists(lists);
      })
      .catch(() => {
        if (!cancelled) setFavoriteLists([]);
      });
    return () => {
      cancelled = true;
    };
  }, [work?.id, work?.favorite]);

  // A smart list's rule match is in the list without being a favorite; a work
  // added to a smart list by hand is both, which the work's own flag reports.
  const favoriteSelected =
    favoriteLists.some((list) => list.kind === "user" && list.selected) ||
    (Boolean(work?.favorite) && favoriteLists.some((list) => list.kind === "smart" && list.selected));

  /** Rereads the lists after a save that changed this work's membership. */
  const reloadAfterSave = async (savedWorkID: number) => {
    if (work && savedWorkID === work.id) setFavoriteLists(await api.getWorkFavoriteLists(work.id));
  };

  return { favoriteLists, favoriteSelected, reloadAfterSave };
}
