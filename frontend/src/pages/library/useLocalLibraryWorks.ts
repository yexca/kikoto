import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useStableCallback } from "@/hooks/useStableCallback";
import { api, type LibrarySort, type ListeningStatus, type SortDirection, type Work, type WorksPage } from "@/lib/api";
import type { LocalWorkPageSize } from "@/lib/libraryBrowseState";
import type { SearchClause } from "@/lib/librarySearchClauses";
import { RECOMMENDATION_ALGORITHM_VERSION } from "@/lib/recommendationSession";

import type { LocalLibraryScope } from "./libraryRoutes";
import type { LibraryRecommendations } from "./useLibraryRecommendations";

export type LocalLibraryWorksRequest = {
  page: number;
  pageSize: LocalWorkPageSize;
  /** The compiled Library search query. */
  query: string;
  scope: LocalLibraryScope;
  status: ListeningStatus | "all";
  sort: LibrarySort;
  direction: SortDirection;
  randomSeed: number;
};

/**
 * The page of local or tracked works that matches the browse controls. It
 * loads when the request changes, and keeps the last loaded page on screen
 * while a newer one is on its way or has failed.
 */
export function useLocalLibraryWorks({
  visible,
  ready,
  isRestorePending,
  request,
  recommendations,
  onResultsShown,
  onLoadFailed,
  onPageBeyondTotal,
}: {
  /** The local list is the surface on screen. */
  visible: boolean;
  /** The browse controls of the current route are in place. */
  ready: boolean;
  /** A restored browse state has not reached the controls yet. */
  isRestorePending: () => boolean;
  request: LocalLibraryWorksRequest;
  recommendations: LibraryRecommendations;
  onResultsShown: () => void;
  onLoadFailed: () => void;
  onPageBeyondTotal: (lastPage: number) => void;
}) {
  const { t } = useTranslation();
  const { page, pageSize, query, scope, status, sort, direction, randomSeed } = request;
  const { badgesEnabled, session, setListContext, recordEvents } = recommendations;
  const sessionId = session.id;
  const [works, setWorks] = useState<Work[]>([]);
  const [displayedRecommendationSort, setDisplayedRecommendationSort] = useState(false);
  // True when the loaded page carries ordinary-sort scores, so turning badges
  // on never shows placeholder zeros before the scored page arrives.
  const [displayedRecommendationBadges, setDisplayedRecommendationBadges] = useState(false);
  const worksRef = useRef<Work[]>([]);
  worksRef.current = works;
  // Null until a page response reports the total, so a restored page is not
  // clamped against an empty result before the library has loaded.
  const [total, setTotal] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [recommendationUnavailable, setRecommendationUnavailable] = useState(false);
  // Clauses of an immediate search, matched against the loaded page until its
  // own results arrive.
  const [optimisticSearchClauses, setOptimisticSearchClauses] = useState<SearchClause[] | null>(null);
  const requestSeq = useRef(0);
  const loadedRequestKey = useRef("");
  const skipNextEffect = useRef(false);
  const requestKey = JSON.stringify([
    page,
    pageSize,
    query,
    scope,
    status,
    sort,
    direction,
    randomSeed,
    badgesEnabled,
    sessionId,
  ]);
  const loadErrorMessage = useStableCallback((error: unknown) =>
    error instanceof Error ? error.message : t("library.couldNotLoad"),
  );

  /** Shows a loaded page; `shown` is the request it answers. Returns its recommendation context. */
  const showPage = useCallback(
    (result: WorksPage, shown: { sort: LibrarySort; randomSeed: number; badgesEnabled: boolean }) => {
      const context =
        shown.sort === "recommend" ? { id: result.recommendationContext ?? "", seed: shown.randomSeed } : null;
      setWorks(result.works);
      setDisplayedRecommendationSort(shown.sort === "recommend");
      setDisplayedRecommendationBadges(
        shown.badgesEnabled && shown.sort !== "recommend" && !result.recommendationUnavailable,
      );
      setTotal(result.total);
      setRecommendationUnavailable(Boolean(result.recommendationUnavailable));
      setListContext(context);
      setLoadError("");
      return context;
    },
    [setListContext],
  );

  useEffect(() => {
    if (!visible || !ready || isRestorePending()) return;
    if (skipNextEffect.current) {
      skipNextEffect.current = false;
      return;
    }
    if (loadedRequestKey.current === requestKey) {
      setIsLoading(false);
      return;
    }
    const controller = new AbortController();
    const seq = ++requestSeq.current;
    setLoadError("");
    setIsLoading(true);
    // Let synchronous effect replacement cancel before issuing its GET.
    void Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return api.listWorksPage(
          page,
          pageSize,
          query,
          scope,
          status,
          sort,
          direction,
          randomSeed,
          badgesEnabled && sort !== "recommend",
          controller.signal,
          sessionId,
        );
      })
      .then((result) => {
        if (controller.signal.aborted || seq !== requestSeq.current) return;
        loadedRequestKey.current = requestKey;
        const context = showPage(result, { sort, randomSeed, badgesEnabled });
        if (context) {
          recordEvents(
            result.works.map((work, index) => ({
              workId: work.id,
              eventType: "impression",
              contextId: context.id,
              algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
              seed: randomSeed,
              rank: (result.page - 1) * result.pageSize + index + 1,
              score: work.recommendScore,
            })),
          );
        }
        setOptimisticSearchClauses(null);
        onResultsShown();
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (controller.signal.aborted || seq !== requestSeq.current) return;
        setLoadError(loadErrorMessage(error));
        setOptimisticSearchClauses(null);
        onLoadFailed();
      })
      .finally(() => {
        if (!controller.signal.aborted && seq === requestSeq.current) setIsLoading(false);
      });
    return () => controller.abort();
  }, [
    visible,
    ready,
    isRestorePending,
    requestKey,
    page,
    pageSize,
    query,
    scope,
    status,
    sort,
    direction,
    randomSeed,
    badgesEnabled,
    sessionId,
    showPage,
    recordEvents,
    loadErrorMessage,
    onResultsShown,
    onLoadFailed,
  ]);

  useEffect(() => {
    if (!visible || isLoading || total === null || loadedRequestKey.current !== requestKey) return;
    const lastPage = Math.max(1, Math.ceil(total / pageSize));
    if (page > lastPage) onPageBeyondTotal(lastPage);
  }, [visible, isLoading, requestKey, page, pageSize, total, onPageBeyondTotal]);

  // An immediate load replaces the displayed results without going through the
  // request effect, so the effect's last loaded key no longer describes them.
  const loadNow = (nextQuery: string, nextPage = 1) => {
    const seq = ++requestSeq.current;
    loadedRequestKey.current = "";
    setLoadError("");
    setIsLoading(true);
    api
      .listWorksPage(
        nextPage,
        pageSize,
        nextQuery,
        scope,
        status,
        sort,
        direction,
        randomSeed,
        badgesEnabled && sort !== "recommend",
        undefined,
        sessionId,
      )
      .then((result) => {
        if (seq !== requestSeq.current) return;
        showPage(result, { sort, randomSeed, badgesEnabled });
        setOptimisticSearchClauses(null);
        onResultsShown();
      })
      .catch((error) => {
        if (seq !== requestSeq.current) return;
        setLoadError(loadErrorMessage(error));
        setOptimisticSearchClauses(null);
        onLoadFailed();
      })
      .finally(() => {
        if (seq === requestSeq.current) setIsLoading(false);
      });
  };

  /** Reloads the current request in place, leaving loading state and scroll alone. */
  const refresh = useStableCallback(async () => {
    const result = await api.listWorksPage(
      page,
      pageSize,
      query,
      scope,
      status,
      sort,
      direction,
      randomSeed,
      badgesEnabled && sort !== "recommend",
      undefined,
      sessionId,
    );
    showPage(result, { sort, randomSeed, badgesEnabled });
  });

  const patchWork = (workID: number, patch: Partial<Work>) => {
    setWorks((items) => items.map((item) => (item.id === workID ? { ...item, ...patch } : item)));
  };

  return {
    works,
    worksRef,
    total,
    isLoading,
    loadError,
    recommendationUnavailable,
    displayedRecommendationSort,
    displayedRecommendationBadges,
    optimisticSearchClauses,
    setOptimisticSearchClauses,
    loadNow,
    /** The request effect leaves the next control change to a `loadNow` that already covers it. */
    skipNextLoad: () => {
      skipNextEffect.current = true;
    },
    refresh,
    patchWork,
  };
}
