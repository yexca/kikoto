import { useEffect, useRef, useState } from "react";

import { api, type CurrentUser, type FavoriteList } from "@/lib/api";

/**
 * The signed-in user's favorite lists, read once per user while the page is
 * active. `notifyUnavailable` reports a failed read.
 */
export function useFavoriteLists({
  active,
  user,
  notifyUnavailable,
}: {
  active: boolean;
  user: CurrentUser | null;
  notifyUnavailable: (error: unknown) => void;
}) {
  const principalID = user?.id ?? null;
  const [favoriteLists, setFavoriteLists] = useState<FavoriteList[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const loadedFor = useRef<number | null>(null);

  useEffect(() => {
    if (!user) {
      loadedFor.current = null;
      setFavoriteLists([]);
      setIsLoading(false);
      return;
    }
    if (!active || loadedFor.current === principalID) return;
    const controller = new AbortController();
    let cancelled = false;
    setIsLoading(true);
    api
      .listFavoriteLists(controller.signal)
      .then((lists) => {
        if (!cancelled) {
          loadedFor.current = principalID;
          setFavoriteLists(lists);
        }
      })
      .catch((error) => {
        if (!cancelled) notifyUnavailable(error);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [active, user, notifyUnavailable, principalID]);

  return {
    setFavoriteLists,
    isLoading,
    markedList: favoriteLists.find((list) => list.kind === "marked") ?? null,
    userLists: favoriteLists.filter((list) => list.kind !== "marked"),
  };
}
