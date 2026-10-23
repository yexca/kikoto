import { useCallback, useEffect, useState } from "react";

import { api, type RankingList, type RankingOverview } from "@/lib/api";

/**
 * The tracked rankings and their schedule, shared by the Rankings view, its
 * settings, and the view switch's unseen dot.
 */
export function useRankingOverview() {
  const [overview, setOverview] = useState<RankingOverview | null>(null);
  const [error, setError] = useState<unknown>(null);

  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await api.listRankings(signal);
      setOverview(next);
      setError(null);
    } catch (loadError) {
      if (!signal?.aborted) setError(loadError);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  const updateList = useCallback((list: RankingList) => {
    setOverview((current) =>
      current ? { ...current, lists: current.lists.map((item) => (item.id === list.id ? list : item)) } : current,
    );
  }, []);

  const markSeen = useCallback((listId: number) => {
    setOverview((current) =>
      current
        ? { ...current, lists: current.lists.map((item) => (item.id === listId ? { ...item, unseen: false } : item)) }
        : current,
    );
  }, []);

  return { overview, error, reload, setOverview, updateList, markSeen };
}

export type RankingOverviewState = ReturnType<typeof useRankingOverview>;
