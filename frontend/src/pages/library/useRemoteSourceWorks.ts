import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "@/hooks/useStableCallback";
import {
  api,
  type LibrarySort,
  type LibrarySource,
  type RemoteWork,
  type RemoteWorksResponse,
  type SortDirection,
} from "@/lib/api";

import { defaultRemoteSourceViewState, remoteLibrarySort, type RemoteSourceViewState } from "./libraryBrowseModel";
import type { LibraryTab } from "./libraryRoutes";

function unavailableRemoteWorks(
  sourceId: number,
  page: number,
  pageSize: number,
  sort: LibrarySort,
  direction: SortDirection,
): RemoteWorksResponse {
  return {
    sourceId,
    works: [],
    page,
    pageSize,
    total: 0,
    status: "unavailable",
    error: {
      code: "unavailable",
      message: "",
      retryable: true,
    },
    sort: remoteLibrarySort(sort),
    direction,
    sortApplied: false,
  };
}

/**
 * The page of a remote source's catalog that matches the browse controls. A
 * failed request becomes an unavailable result, so the source reports its own
 * failure without affecting the local list.
 */
export function useRemoteSourceWorks({
  visible,
  ready,
  isRestorePending,
  tab,
  sourceStates,
  query,
  sort,
  direction,
  randomSeed,
  inlineRecommendations,
  recommendationSessionId,
  onResultsShown,
}: {
  /** The Library list is the surface on screen. */
  visible: boolean;
  /** The browse controls of the current route are in place. */
  ready: boolean;
  /** A restored browse state has not reached the controls yet. */
  isRestorePending: () => boolean;
  tab: LibraryTab;
  sourceStates: Record<number, RemoteSourceViewState>;
  /** The remote form of the search query. */
  query: string;
  sort: LibrarySort;
  direction: SortDirection;
  randomSeed: number;
  inlineRecommendations: boolean;
  recommendationSessionId: string;
  onResultsShown: () => void;
}) {
  const [result, setResult] = useState<RemoteWorksResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const requestSeq = useRef(0);
  const loadedRequestKey = useRef("");
  const skipNextEffect = useRef(false);
  const currentResultSourceId = useStableCallback(() => result?.sourceId);

  useEffect(() => {
    if (!visible || !ready || isRestorePending()) return;
    if (tab.kind !== "source") {
      setResult(null);
      setIsLoading(false);
      return;
    }
    if (skipNextEffect.current) {
      skipNextEffect.current = false;
      return;
    }
    const controller = new AbortController();
    const sourceState = sourceStates[tab.source.id] ?? defaultRemoteSourceViewState;
    const requestKey = JSON.stringify([
      tab.source.id,
      sourceState.page,
      sourceState.pageSize,
      query,
      sort,
      direction,
      randomSeed,
      inlineRecommendations,
      recommendationSessionId,
    ]);
    // Switching to a local tab clears the remote result. The request key can
    // still match a previous successful load, so only reuse it while that
    // result is still present for the active source.
    if (loadedRequestKey.current === requestKey && currentResultSourceId() === tab.source.id) return;
    const seq = ++requestSeq.current;
    setResult((current) => (current?.sourceId === tab.source.id ? current : null));
    setIsLoading(true);
    api
      .listRemoteSourceWorks(
        tab.source.id,
        sourceState.page,
        sourceState.pageSize,
        query,
        remoteLibrarySort(sort),
        direction,
        randomSeed,
        inlineRecommendations,
        controller.signal,
        recommendationSessionId,
      )
      .then((loaded) => {
        if (controller.signal.aborted || seq !== requestSeq.current) return;
        loadedRequestKey.current = requestKey;
        setResult(loaded);
        onResultsShown();
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (controller.signal.aborted || seq !== requestSeq.current) return;
        setResult(unavailableRemoteWorks(tab.source.id, sourceState.page, sourceState.pageSize, sort, direction));
      })
      .finally(() => {
        if (!controller.signal.aborted && seq === requestSeq.current) setIsLoading(false);
      });
    return () => controller.abort();
  }, [
    visible,
    ready,
    isRestorePending,
    tab,
    sourceStates,
    query,
    sort,
    direction,
    randomSeed,
    inlineRecommendations,
    recommendationSessionId,
    currentResultSourceId,
    onResultsShown,
  ]);

  // An immediate load replaces the displayed results without going through the
  // request effect, so the effect's last loaded key no longer describes them.
  const loadNow = (source: LibrarySource, nextQuery: string, page = 1, options: { clearResult?: boolean } = {}) => {
    const sourceState = sourceStates[source.id] ?? defaultRemoteSourceViewState;
    const seq = ++requestSeq.current;
    loadedRequestKey.current = "";
    setIsLoading(true);
    if (options.clearResult !== false && result?.sourceId !== source.id) setResult(null);
    api
      .listRemoteSourceWorks(
        source.id,
        page,
        sourceState.pageSize,
        nextQuery,
        remoteLibrarySort(sort),
        direction,
        randomSeed,
        inlineRecommendations,
        undefined,
        recommendationSessionId,
      )
      .then((loaded) => {
        if (seq !== requestSeq.current) return;
        setResult(loaded);
        onResultsShown();
      })
      .catch(() => {
        if (seq !== requestSeq.current) return;
        setResult(unavailableRemoteWorks(source.id, page, sourceState.pageSize, sort, direction));
      })
      .finally(() => {
        if (seq === requestSeq.current) setIsLoading(false);
      });
  };

  const patchWork = (
    primaryCode: string,
    patch: Partial<Pick<RemoteWork, "workId" | "favorite" | "listeningStatus">>,
  ) => {
    setResult((current) =>
      current
        ? {
            ...current,
            works: current.works.map((item) => (item.primaryCode === primaryCode ? { ...item, ...patch } : item)),
          }
        : current,
    );
  };

  return {
    result,
    isLoading,
    loadNow,
    /** The request effect leaves the next control change to a `loadNow` that already covers it. */
    skipNextLoad: () => {
      skipNextEffect.current = true;
    },
    patchWork,
  };
}
