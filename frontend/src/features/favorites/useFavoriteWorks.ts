import { useEffect, useRef, useState } from "react";

import type { FavoritesBrowseState } from "@/features/favorites/favoritesBrowseState";
import { api, type CurrentUser, type FavoriteWorksPage, type Work } from "@/lib/api";

/**
 * The favorite works page that the browse state asks for, with the shelf,
 * list, and status counts that arrive with it. A creator shelf opened first
 * still reads the works shelf counts so the navigation can label them.
 */
export function useFavoriteWorks({
  active,
  user,
  browse,
  newOnly,
  hasPendingRestoration,
  notifyUnavailable,
}: {
  active: boolean;
  user: CurrentUser | null;
  browse: FavoritesBrowseState;
  /** Shows only the works new in the open smart list. */
  newOnly: boolean;
  /** True while a history entry is being restored; requests wait for it. */
  hasPendingRestoration: () => boolean;
  notifyUnavailable: (error: unknown, setLoadError: (message: string) => void) => void;
}) {
  const principalID = user?.id ?? null;
  const {
    entity: favoriteEntity,
    query,
    status: statusFilter,
    availability: availabilityFilter,
    list: activeList,
    page,
    pageSize,
    sort,
    direction: sortDirection,
    randomSeed,
  } = browse;
  const [works, setWorks] = useState<Work[]>([]);
  const [totalWorks, setTotalWorks] = useState(0);
  const [favoriteTotal, setFavoriteTotal] = useState(0);
  const [listCounts, setListCounts] = useState<Record<string, number>>({});
  const [newCounts, setNewCounts] = useState<Record<string, number>>({});
  const [newWorkIDs, setNewWorkIDs] = useState<Set<number>>(() => new Set());
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [snapshotUserID, setSnapshotUserID] = useState<number | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [shelfCountsUserID, setShelfCountsUserID] = useState<number | null>(null);
  const requestSeq = useRef(0);
  const loadedRequestKey = useRef("");
  const requestKey = JSON.stringify([
    newOnly,
    principalID,
    page,
    pageSize,
    query,
    activeList,
    statusFilter,
    availabilityFilter,
    sort,
    sortDirection,
    randomSeed,
    reloadToken,
  ]);
  const hasSnapshot = snapshotUserID === principalID;

  const applyPage = (result: FavoriteWorksPage) => {
    setWorks(result.works);
    setTotalWorks(result.total);
    setFavoriteTotal(result.shelfTotal);
    setListCounts(result.listCounts);
    setNewCounts(result.newCounts ?? {});
    setNewWorkIDs(new Set(result.newWorkIds ?? []));
    setStatusCounts(result.statusCounts);
  };

  useEffect(() => {
    if (!user) {
      loadedRequestKey.current = "";
      setWorks([]);
      setTotalWorks(0);
      setFavoriteTotal(0);
      setListCounts({});
      setNewCounts({});
      setNewWorkIDs(new Set());
      setStatusCounts({});
      setSnapshotUserID(null);
      setLoadError("");
      setIsLoading(false);
      return;
    }
    if (favoriteEntity !== "works") {
      setIsLoading(false);
      return;
    }
    if (!active || hasPendingRestoration()) return;
    const currentRequestKey = requestKey;
    if (loadedRequestKey.current === currentRequestKey) {
      setIsLoading(false);
      return;
    }
    const controller = new AbortController();
    const seq = ++requestSeq.current;
    setIsLoading(true);
    setLoadError("");
    api
      .listFavoriteWorksPage(
        page,
        pageSize,
        query,
        activeList,
        statusFilter,
        availabilityFilter,
        sort,
        sortDirection,
        randomSeed,
        controller.signal,
        newOnly,
      )
      .then((result) => {
        if (controller.signal.aborted || seq !== requestSeq.current) return;
        loadedRequestKey.current = currentRequestKey;
        setWorks(result.works);
        setTotalWorks(result.total);
        setFavoriteTotal(result.shelfTotal);
        setListCounts(result.listCounts);
        setNewCounts(result.newCounts ?? {});
        setNewWorkIDs(new Set(result.newWorkIds ?? []));
        setStatusCounts(result.statusCounts);
        setSnapshotUserID(principalID);
      })
      .catch((error) => {
        if (controller.signal.aborted || seq !== requestSeq.current) return;
        notifyUnavailable(error, setLoadError);
      })
      .finally(() => {
        if (!controller.signal.aborted && seq === requestSeq.current) setIsLoading(false);
      });
    return () => controller.abort();
  }, [
    active,
    activeList,
    availabilityFilter,
    user,
    favoriteEntity,
    hasPendingRestoration,
    newOnly,
    notifyUnavailable,
    page,
    pageSize,
    principalID,
    query,
    randomSeed,
    sort,
    sortDirection,
    statusFilter,
    reloadToken,
    requestKey,
  ]);

  // A creator shelf opened first still labels the works shelves, from a one-item request.
  useEffect(() => {
    if (!active || !user || favoriteEntity === "works" || hasSnapshot) return;
    if (shelfCountsUserID === principalID) return;
    const controller = new AbortController();
    api
      .listFavoriteWorksPage(1, 1, "", "all", "all", "all", "added", "desc", 1, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setFavoriteTotal(result.shelfTotal);
        setListCounts(result.listCounts);
        setNewCounts(result.newCounts ?? {});
        setShelfCountsUserID(principalID);
      })
      .catch(() => {
        // The shelves stay usable; their counts appear once works load.
      });
    return () => controller.abort();
  }, [active, user, favoriteEntity, hasSnapshot, principalID, shelfCountsUserID]);

  return {
    works,
    setWorks,
    totalWorks,
    favoriteTotal,
    listCounts,
    newCounts,
    newWorkIDs,
    statusCounts,
    isLoading,
    hasSnapshot,
    /** The shelf counts are known, from the works page or the creator-shelf request. */
    shelfCountsKnown: hasSnapshot || shelfCountsUserID === principalID,
    loadError,
    reloadToken,
    reload: () => setReloadToken((value) => value + 1),
    // Read during render: the shown works answer the current request.
    isCurrent: loadedRequestKey.current === requestKey,
    /** Reads the given page of the current request again without the loading state. */
    refetch: async (targetPage: number) => {
      applyPage(
        await api.listFavoriteWorksPage(
          targetPage,
          pageSize,
          query,
          activeList,
          statusFilter,
          availabilityFilter,
          sort,
          sortDirection,
          randomSeed,
          undefined,
          newOnly,
        ),
      );
    },
  };
}
