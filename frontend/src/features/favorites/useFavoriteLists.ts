import { useEffect, useRef, useState } from "react";

import { api, type CurrentUser, type FavoriteList } from "@/lib/api";
import { startLoad } from "@/lib/effectScope";

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
    setIsLoading(true);
    return startLoad((signal) => api.listFavoriteLists(signal), {
      onSuccess: (lists) => {
        loadedFor.current = principalID;
        setFavoriteLists(lists);
      },
      onError: notifyUnavailable,
      onSettled: () => setIsLoading(false),
    });
  }, [active, user, notifyUnavailable, principalID]);

  return {
    setFavoriteLists,
    isLoading,
    markedList: favoriteLists.find((list) => list.kind === "marked") ?? null,
    userLists: favoriteLists.filter((list) => list.kind !== "marked"),
  };
}
