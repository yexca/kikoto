import { ListChecks, Sparkles } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { NotFoundPage } from "@/app/NotFoundPage";
import { PageActiveProvider } from "@/app/pageHeader";
import { openWorkDetail, workDetailCodeFromLocation } from "@/app/workDetailNavigation";
import { useAuth } from "@/auth/AuthProvider";
import { REMOTE_TRACK_PERMISSIONS, usePermissionGate } from "@/auth/usePermissionGate";
import { BrowseLoadingIndicator } from "@/components/collection/BrowseLoadingIndicator";
import { DemoContentNotice, DemoRemoteSourceNotice } from "@/components/DemoReadOnlyNotice";
import { MetadataOnboardingNotice } from "@/components/MetadataOnboardingNotice";
import { IconButton } from "@/components/ui/icon-button";
import { toastFromError, useToast } from "@/components/ui/toast";
import {
  useWorkCollectionLayout,
  workCardLayout,
  WorkCollectionDisplayPicker,
} from "@/components/work-collection/WorkCollectionLayout";
import { preloadWorkDetail } from "@/features/work-detail/lazyWorkDetail";
import type { DetailSourceIntent } from "@/features/work-detail/source/sourceContextModel";
import { openWorkCodeRoute, sourcePresenceActionCode } from "@/features/work-detail/workDetailShared";
import {
  LazyRemoteFetchWorkspaceDialog,
  preloadRemoteFetchWorkspaceDialog,
} from "@/features/work-detail/workflows/LazyRemoteFetchWorkspaceDialog";
import { useRemoteFetchWorkspace } from "@/features/work-detail/workflows/useRemoteFetchWorkspace";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import { useStableCallback } from "@/hooks/useStableCallback";
import i18n from "@/i18n";
import {
  api,
  type LibrarySort,
  type LibrarySource,
  type ListeningStatus,
  type RecommendationEventInput,
  type RemoteWork,
  type SortDirection,
  type SourcePresenceItem,
  type Work,
} from "@/lib/api";
import { historyScrollY, isMobileTabResumeHistoryState, requestHistoryScrollRestoration } from "@/lib/browserHistory";
import { currentClientStorageScope } from "@/lib/clientStorageScope";
import {
  defaultLibraryBrowseState,
  type LibraryBrowseState,
  libraryBrowseStateFromSearch,
  libraryLocation,
  libraryPageSize,
  type LibraryPageSize,
  readLibraryBrowseState,
  readLibrarySortPreference,
  withSharedLibraryQuery,
  writeLibraryBrowseState,
  writeLibrarySortPreference,
} from "@/lib/libraryBrowseState";
import {
  compileLibrarySearchQuery,
  formatRemoteSearchQuery,
  formatSearchClause,
  type SearchClause,
} from "@/lib/librarySearchClauses";
import {
  activeLibraryBrowseState,
  activeRemoteSourceViewState,
  createRandomSortSeed,
  defaultRemoteSourceViewState,
  initialLibraryPageBrowseState,
  libraryBrowseControlsKey,
  libraryBrowseSurfaceState,
  librarySortOptions,
  readLibraryHistoryBrowseState,
  remoteLibrarySort,
  type RemoteSourceViewState,
  remoteSortValues,
  writeLibraryHistoryBrowseState,
} from "@/pages/library/libraryBrowseModel";
import { LibraryDesktopToolbar } from "@/pages/library/LibraryDesktopToolbar";
import { LibraryPrimaryTabs, LibrarySourceMenu } from "@/pages/library/LibraryPrimaryTabs";
import {
  knownLibraryRoute,
  libraryBrowseKey,
  type LibraryTab,
  localBrowseRoute,
  type LocalLibraryScope,
  localScopeFromPath,
  openPersistedRemoteSourceWorkRoute,
  openRemoteSourceWorkRoute,
  pathForActiveLibrary,
  pathForLibraryTab,
  pathForLocalScope,
  recentWorkSourceIntent,
  tabFromPath,
} from "@/pages/library/libraryRoutes";
import { LocalLibraryPanel } from "@/pages/library/LocalLibraryPanel";
import { MobileLibraryToolbar } from "@/pages/library/MobileLibraryToolbar";
import { RecommendationExplanationDialog } from "@/pages/library/RecommendationExplanationDialog";
import { remoteWorkActionCode } from "@/pages/library/remoteSourceBrowseModel";
import { RemoteSourcePanel } from "@/pages/library/RemoteSourcePanel";
import { SearchClauseBadges } from "@/pages/library/SearchClauseEditor";
import { SearchClausePopover, useSearchClauseEditor } from "@/pages/library/SearchClausePopover";
import { useLibraryBrowsePersistence } from "@/pages/library/useLibraryBrowsePersistence";
import { useLibraryCoverSourceMode } from "@/pages/library/useLibraryCoverSourceMode";
import { useLibraryRecommendations } from "@/pages/library/useLibraryRecommendations";
import { useLibraryResultsScroll } from "@/pages/library/useLibraryResultsScroll";
import { useLibrarySearchQuery } from "@/pages/library/useLibrarySearchQuery";
import { useLibrarySources } from "@/pages/library/useLibrarySources";
import { useLibrarySourceVisibility } from "@/pages/library/useLibrarySourceVisibility";
import { useLibraryWorkEvents } from "@/pages/library/useLibraryWorkEvents";
import { useLocalLibraryWorks } from "@/pages/library/useLocalLibraryWorks";
import { useRemoteSourceWorks } from "@/pages/library/useRemoteSourceWorks";
import { remoteOnlyWorkPreview, remoteWorkPreview } from "@/pages/library/workPreviewHistory";

// The app shell starts the detail chunk for a direct work link; this covers a
// detail location reached before the Library chunk finished loading. Both share
// the feature's single dynamic import, so the chunk is fetched once.
if (workDetailCodeFromLocation(window.location.pathname, window.location.search) !== null) preloadWorkDetail();

// An idle Library warms the surfaces it opens on demand.
function preloadLibraryDeferredSurfaces() {
  preloadWorkDetail();
  void preloadRemoteFetchWorkspaceDialog().catch(() => {});
}

export function LibraryPage({ active = true }: { active?: boolean }) {
  useEffect(() => {
    if (!active) return;
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(preloadLibraryDeferredSurfaces, { timeout: 4000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(preloadLibraryDeferredSurfaces, 1500);
    return () => window.clearTimeout(timer);
  }, [active]);
  const toast = useToast();
  const auth = useAuth();
  const { t } = useTranslation();
  const mobileNavigationLayout = useMobileNavigationLayout();
  const principalID = auth.user?.id ?? null;
  const browseStorageScope = currentClientStorageScope(principalID);
  const recommendations = useLibraryRecommendations(browseStorageScope);
  const recommendationSession = recommendations.session;
  const recommendBadgesEnabled = recommendations.badgesEnabled;
  const sessionDefaultBrowseState = useMemo(
    () => ({ ...defaultLibraryBrowseState, randomSeed: recommendationSession.seed }),
    [recommendationSession.seed],
  );
  const initialBrowse = useRef(initialLibraryPageBrowseState(browseStorageScope, sessionDefaultBrowseState)).current;
  const initialBrowseState = initialBrowse.state;
  const [activeTab, setActiveTab] = useState<LibraryTab>(initialBrowse.tab);
  const [localScope, setLocalScope] = useState<LocalLibraryScope>(initialBrowse.scope);
  const [remoteSourceStates, setRemoteSourceStates] = useState<Record<number, RemoteSourceViewState>>({});
  const [remoteSelectionMode, setRemoteSelectionMode] = useState(false);
  const [statusFilter, setStatusFilter] = useState<ListeningStatus | "all">(initialBrowseState.status);
  const {
    mobileColumns,
    desktopColumns,
    mobileCardMode,
    desktopCardMode,
    setMobileColumns,
    setDesktopColumns,
    setMobileCardMode,
    setDesktopCardMode,
  } = useWorkCollectionLayout({
    mobileColumns: initialBrowseState.mobileColumns,
    desktopColumns: initialBrowseState.desktopColumns,
  });
  const [librarySort, setLibrarySort] = useState<LibrarySort>(initialBrowseState.sort);
  const remoteInlineRecommendations = auth.demoMode && recommendBadgesEnabled;
  const [sortDirection, setSortDirection] = useState<SortDirection>(initialBrowseState.direction);
  const [randomSeed, setRandomSeed] = useState(initialBrowseState.randomSeed);
  const [workPage, setWorkPage] = useState(initialBrowseState.page);
  const [workPageSize, setWorkPageSize] = useState<LibraryPageSize>(libraryPageSize(initialBrowseState.pageSize));
  const [isUntracking, setIsUntracking] = useState(false);
  const requireUntrack = usePermissionGate(REMOTE_TRACK_PERMISSIONS, { deferDemo: true });
  const wasActive = useRef(active);
  const browseSurfaceActive = useRef(true);
  // Work detail is another page that hides this one. The current URL must
  // already prevent list effects from writing into a detail entry.
  const showBrowse = workDetailCodeFromLocation(window.location.pathname, window.location.search) === null;
  browseSurfaceActive.current = showBrowse;
  const isBrowseSurfaceActive = useStableCallback(() => browseSurfaceActive.current);
  const [listVisited, setListVisited] = useState(showBrowse);
  useEffect(() => {
    if (showBrowse) setListVisited(true);
  }, [showBrowse]);
  const resultsScroll = useLibraryResultsScroll(active && showBrowse);
  const queueResultsScroll = resultsScroll.queue;
  const { searchQuery, setSearchQuery, searchClauses, librarySearchQuery, remoteSearchQuery, settleSearchQuery } =
    useLibrarySearchQuery({
      initialQuery: initialBrowseState.query,
      activeTab,
      queueResultsScroll,
      setWorkPage,
      setRemoteSourceStates,
    });
  /** The browse state a location shows: its search over the entry's, the saved, or the default controls. */
  const locationBrowseState = useStableCallback((tab: LibraryTab, scope: LocalLibraryScope) => {
    const key = libraryBrowseKey(tab, scope, browseStorageScope);
    return libraryBrowseStateFromSearch(
      window.location.search,
      readLibraryHistoryBrowseState(browseStorageScope) ??
        readLibraryBrowseState(key) ?? { ...sessionDefaultBrowseState, ...readLibrarySortPreference(key) },
    );
  });
  // Resolves the current route against the sources once they load.
  const resolveSourceRoute = useStableCallback((items: LibrarySource[]) => {
    if (!knownLibraryRoute(window.location.pathname, window.location.search, items)) return;
    const resolved = tabFromPath(window.location.pathname, items, activeTab);
    const scope = localScopeFromPath(window.location.pathname);
    if (
      workDetailCodeFromLocation(window.location.pathname, window.location.search) === null &&
      !localBrowseRoute(window.location.pathname)
    ) {
      applyBrowseState(locationBrowseState(resolved, scope), resolved, false);
      setActiveTab(resolved);
    }
  });
  const { sources, sourceRoutesReady, browseHydrated } = useLibrarySources({
    active,
    authLoading: auth.isLoading,
    onLoaded: resolveSourceRoute,
  });
  const activePrimaryTab: "local" | "tracked" | null = activeTab.kind === "source" ? null : localScope;
  const activeRemoteSourceState = activeRemoteSourceViewState(activeTab, remoteSourceStates);
  const [coverSourceMode, setCoverSourceMode] = useLibraryCoverSourceMode(browseStorageScope);
  const sourceVisibility = useLibrarySourceVisibility({
    storageScope: browseStorageScope,
    sources,
    active,
    refreshKey: localScope,
  });
  const activeBrowseState = useMemo(
    () =>
      activeLibraryBrowseState({
        activeTab,
        remoteSourceState: activeRemoteSourceState,
        searchQuery,
        workPage,
        workPageSize,
        statusFilter,
        librarySort,
        sortDirection,
        randomSeed,
        mobileColumns,
        desktopColumns,
      }),
    [
      activeTab,
      activeRemoteSourceState,
      searchQuery,
      workPage,
      workPageSize,
      statusFilter,
      librarySort,
      sortDirection,
      randomSeed,
      mobileColumns,
      desktopColumns,
    ],
  );
  const pendingBrowseKey = useRef<string | null>(null);
  const currentBrowseKey = useStableCallback(() => libraryBrowseControlsKey(activeBrowseState));
  const hasPendingBrowseRestore = useStableCallback(
    () => pendingBrowseKey.current !== null && pendingBrowseKey.current !== currentBrowseKey(),
  );
  useLayoutEffect(() => {
    if (pendingBrowseKey.current === libraryBrowseControlsKey(activeBrowseState)) pendingBrowseKey.current = null;
  });
  const applyBrowseState = useStableCallback((state: LibraryBrowseState, tab: LibraryTab, restoreScroll = true) => {
    const key = libraryBrowseControlsKey({
      ...state,
      status: tab.kind === "source" ? "all" : state.status,
      sort: tab.kind === "source" ? remoteLibrarySort(state.sort) : state.sort,
      pageSize: libraryPageSize(state.pageSize),
    });
    pendingBrowseKey.current = key === currentBrowseKey() ? null : key;
    settleSearchQuery(state.query);
    setStatusFilter(tab.kind === "source" ? "all" : state.status);
    setLibrarySort(tab.kind === "source" ? remoteLibrarySort(state.sort) : state.sort);
    setSortDirection(state.direction);
    setRandomSeed(state.randomSeed);
    if (restoreScroll) resultsScroll.restore(state.scrollY);
    if (tab.kind === "source") {
      setRemoteSourceStates((states) => ({
        ...states,
        [tab.source.id]: { page: state.page, pageSize: libraryPageSize(state.pageSize) },
      }));
    } else {
      setWorkPage(state.page);
      setWorkPageSize(libraryPageSize(state.pageSize));
    }
  });

  const localWorks = useLocalLibraryWorks({
    visible: active && showBrowse && activeTab.kind !== "source",
    ready: browseHydrated,
    isRestorePending: hasPendingBrowseRestore,
    request: {
      page: workPage,
      pageSize: workPageSize,
      query: librarySearchQuery,
      scope: localScope,
      status: statusFilter,
      sort: librarySort,
      direction: sortDirection,
      randomSeed,
    },
    recommendations,
    onResultsShown: resultsScroll.complete,
    onLoadFailed: resultsScroll.cancel,
    onPageBeyondTotal: setWorkPage,
  });
  const recordWorkRecommendationEvent = (work: Work, eventType: RecommendationEventInput["eventType"]) =>
    recommendations.recordWorkEvent(work, eventType, localWorks.worksRef.current);

  const remoteWorks = useRemoteSourceWorks({
    visible: active && showBrowse,
    ready: browseHydrated,
    isRestorePending: hasPendingBrowseRestore,
    tab: activeTab,
    sourceStates: remoteSourceStates,
    query: remoteSearchQuery,
    sort: librarySort,
    direction: sortDirection,
    randomSeed,
    inlineRecommendations: remoteInlineRecommendations,
    recommendationSessionId: recommendationSession.id,
    onResultsShown: resultsScroll.complete,
  });

  const activeRemoteSourceId = activeTab.kind === "source" ? activeTab.source.id : 0;
  useEffect(() => {
    setRemoteSelectionMode(false);
  }, [activeTab.kind, activeRemoteSourceId]);

  useLayoutEffect(() => {
    if (!active) {
      wasActive.current = false;
      return;
    }
    const syncFromPath = (restoreListScroll = true) => {
      if (workDetailCodeFromLocation(window.location.pathname, window.location.search) !== null) return;
      if (!knownLibraryRoute(window.location.pathname, window.location.search, sources)) return;
      const nextTab = tabFromPath(window.location.pathname, sources, activeTab);
      const nextScope = localScopeFromPath(window.location.pathname);
      const state = locationBrowseState(nextTab, nextScope);
      applyBrowseState(
        { ...state, scrollY: historyScrollY(window.history.state, state.scrollY) },
        nextTab,
        restoreListScroll,
      );
      setActiveTab(nextTab);
      setLocalScope(nextScope);
    };
    const becameActive = !wasActive.current;
    wasActive.current = true;
    // A resumed bottom-navigation workspace keeps its rendered list; the app shell
    // restores that entry's scroll offset before paint.
    if (becameActive) syncFromPath(!isMobileTabResumeHistoryState(window.history.state));
    const handlePopState = () => syncFromPath();
    const handleAppNavigation = () => syncFromPath();
    window.addEventListener("popstate", handlePopState);
    window.addEventListener("kikoto:navigation", handleAppNavigation);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("kikoto:navigation", handleAppNavigation);
    };
  }, [
    active,
    applyBrowseState,
    locationBrowseState,
    sources,
    activeTab,
    browseStorageScope,
    sessionDefaultBrowseState,
  ]);

  useLibraryBrowsePersistence({
    active,
    browseHydrated,
    hasPendingBrowseRestore,
    showBrowse,
    browseSurfaceActive: isBrowseSurfaceActive,
    sources,
    sourceRoutesReady,
    activeBrowseState,
    activeTab,
    localScope,
    browseStorageScope,
    librarySort,
    sortDirection,
  });

  /** Saves the shown browse state with its scroll offset before the Library leaves it. */
  const saveBrowseSnapshot = () => {
    const browseState = { ...activeBrowseState, scrollY: window.scrollY };
    writeLibraryBrowseState(libraryBrowseKey(activeTab, localScope, browseStorageScope), browseState);
    writeLibraryHistoryBrowseState(browseStorageScope, browseState);
  };
  const returnLocation = () => libraryLocation(pathForActiveLibrary(activeTab, localScope), activeBrowseState);

  const openWork = (work: Work, sourceIntent: DetailSourceIntent = localScope === "tracked" ? "tracked" : "local") => {
    recordWorkRecommendationEvent(work, "open");
    saveBrowseSnapshot();
    openWorkDetail(
      {
        kind: "known",
        canonicalCode: work.primaryCode,
        view: sourceIntent === "tracked" ? "tracked" : "local",
      },
      {
        returnTo: returnLocation(),
        returnLabel: t("nav.library"),
        workPreview: work,
      },
    );
  };

  const openRemotePreview = (source: LibrarySource, work: RemoteWork) => {
    const code = remoteWorkActionCode(work);
    if (!code) return;
    saveBrowseSnapshot();
    if (work.workId !== null && work.primaryCode) {
      openPersistedRemoteSourceWorkRoute(
        source.id,
        work.primaryCode,
        code,
        returnLocation(),
        t("nav.library"),
        remoteWorkPreview(work),
      );
      return;
    }
    openRemoteSourceWorkRoute(source.id, code, returnLocation(), t("nav.library"), remoteOnlyWorkPreview(work));
  };

  /**
   * Leaves the shown browse state for another tab or scope: saves it, restores
   * the destination's own controls with the shared search query, and pushes
   * the destination location when it differs.
   */
  const switchBrowse = (
    tab: LibraryTab,
    scope: LocalLibraryScope,
    path: (state: LibraryBrowseState) => string | null,
  ) => {
    saveBrowseSnapshot();
    const nextKey = libraryBrowseKey(tab, scope, browseStorageScope);
    const nextState = withSharedLibraryQuery(
      readLibraryBrowseState(nextKey) ?? { ...sessionDefaultBrowseState, ...readLibrarySortPreference(nextKey) },
      searchQuery,
    );
    setActiveTab(tab);
    if (tab.kind === "all") setLocalScope(scope);
    applyBrowseState(nextState, tab);
    const nextPath = path(nextState);
    if (nextPath && `${window.location.pathname}${window.location.search}` !== nextPath) {
      window.history.pushState(
        requestHistoryScrollRestoration(
          { libraryBrowseScope: browseStorageScope, libraryBrowseState: nextState },
          nextState.scrollY,
        ),
        "",
        nextPath,
      );
      window.dispatchEvent(new Event("kikoto:navigation"));
    }
  };

  const changeTab = (tab: LibraryTab) =>
    switchBrowse(tab, tab.kind === "all" ? "local" : localScope, (state) =>
      libraryLocation(pathForLibraryTab(tab), state),
    );

  const changeLocalScope = (scope: LocalLibraryScope) =>
    switchBrowse({ kind: "all" }, scope, (state) => {
      const basePath = pathForLocalScope(scope);
      return basePath ? libraryLocation(basePath, state) : null;
    });

  const changePrimaryTab = (tab: "local" | "tracked") => {
    changeLocalScope(tab);
  };

  const updateWorkStatus = async (workID: number, status: ListeningStatus) => {
    try {
      const result = await api.updateWorkUserState(workID, { listeningStatus: status });
      const patch = { listeningStatus: result.listeningStatus, favorite: result.favorite };
      localWorks.patchWork(workID, patch);
      const work = localWorks.worksRef.current.find((item) => item.id === workID);
      if (work && ["relisten", "paused"].includes(status)) {
        recordWorkRecommendationEvent(work, status === "paused" ? "paused_mark" : "positive_mark");
      }
    } catch (error) {
      toast.notify(toastFromError(error, t("errors.unavailable")));
    }
  };

  const untrackWorkSource = async (work: Work, source: SourcePresenceItem) => {
    const sourceID = source.fileSourceId;
    const ownerWorkID = source.workId || work.id;
    if (!sourceID || !ownerWorkID || !requireUntrack()) return;
    setIsUntracking(true);
    try {
      await api.untrackWorkSource(ownerWorkID, sourceID);
      toast.success(
        i18n.t("libraryDetail.untrackedFromSource", {
          code: work.primaryCode,
          source: source.fileSourceName || source.fileSourceCode || i18n.t("libraryDetail.sourceInfo"),
        }),
      );
      await refreshCurrentWorksPage();
    } catch (error) {
      toast.notify(toastFromError(error, t("errors.unavailable")));
    } finally {
      setIsUntracking(false);
    }
  };

  const updateRemoteSourceState = (sourceID: number, patch: Partial<RemoteSourceViewState>) => {
    setRemoteSourceStates((states) => ({
      ...states,
      [sourceID]: {
        ...(states[sourceID] ?? defaultRemoteSourceViewState),
        ...patch,
      },
    }));
  };

  const refreshCurrentWorksPage = useStableCallback(async () => {
    if (activeTab.kind === "source") return;
    await localWorks.refresh();
  });

  useLibraryWorkEvents({
    active,
    activeTab,
    localWorks,
    reloadRemoteSource: () => {
      if (activeTab.kind !== "source") return;
      remoteWorks.loadNow(activeTab.source, remoteSearchQuery, activeRemoteSourceState.page, { clearResult: false });
    },
    refreshLocalWorks: refreshCurrentWorksPage,
    recordWorkEvent: recordWorkRecommendationEvent,
  });

  const trackedFetchWorkspace = useRemoteFetchWorkspace({ onWorksChanged: refreshCurrentWorksPage });
  const openTrackedFetchSelection = (work: Work, presence: SourcePresenceItem) => {
    if (!presence.fileSourceId) return;
    const source = sources.find((item) => item.id === presence.fileSourceId);
    if (!source) return;
    void trackedFetchWorkspace.open({
      sourceId: source.id,
      remoteCode: sourcePresenceActionCode(presence, work.primaryCode),
      canonicalCode: work.primaryCode,
      sourceDisplayName: source.displayName,
    });
  };

  const openLibraryHome = () => {
    window.history.pushState({}, "", "/");
    window.dispatchEvent(new Event("kikoto:navigation"));
  };

  const updateSearchClauses = (clauses: SearchClause[]) => {
    localWorks.setOptimisticSearchClauses(null);
    setSearchQuery(clauses.map(formatSearchClause).join(" "));
  };

  const addNamedTagSearchClause = (kind: "tag" | "user_tag", tag: string) => {
    const value = tag.trim();
    if (!value) return;
    const next = searchClauses.filter(
      (clause) => !(clause.kind === kind && clause.value.toLowerCase() === value.toLowerCase()),
    );
    const nextClauses = [...next, { kind, value }];
    const nextQuery = nextClauses.map(formatSearchClause).join(" ");
    const nextLibraryQuery = compileLibrarySearchQuery(nextClauses);
    const nextRemoteQuery = formatRemoteSearchQuery(nextClauses);
    settleSearchQuery(nextQuery);
    queueResultsScroll();
    if (activeTab.kind === "source") {
      remoteWorks.skipNextLoad();
      updateRemoteSourceState(activeTab.source.id, { page: 1 });
      remoteWorks.loadNow(activeTab.source, nextRemoteQuery, 1, { clearResult: false });
      return;
    }
    setWorkPage(1);
    localWorks.setOptimisticSearchClauses(nextClauses);
    localWorks.skipNextLoad();
    localWorks.loadNow(nextLibraryQuery, 1);
  };
  const addTagSearchClause = (tag: string) => addNamedTagSearchClause("tag", tag);
  const addUserTagSearchClause = (tag: string) => addNamedTagSearchClause("user_tag", tag);

  const clauseEditor = useSearchClauseEditor({ clauses: searchClauses, onClausesChange: updateSearchClauses });

  // Stable card handlers let unchanged cards skip rendering when the page
  // re-renders, such as when a tab switch toggles `active`.
  const openCardWork = useStableCallback((work: Work) => openWork(work));
  const openCardRecommendation = useStableCallback((work: Work) => recommendations.openExplanation(work, randomSeed));
  const changeCardStatus = useStableCallback(updateWorkStatus);
  const saveCardFavorite = useStableCallback((work: Work, favorite: boolean) => {
    localWorks.patchWork(work.id, { favorite });
    if (favorite) recordWorkRecommendationEvent(work, "positive_mark");
  });
  const openCardTag = useStableCallback(addTagSearchClause);
  const openCardUserTag = useStableCallback(addUserTagSearchClause);
  const untrackCardSource = useStableCallback(untrackWorkSource);
  const fetchCardSource = useStableCallback((work: Work, source: SourcePresenceItem) => {
    void openTrackedFetchSelection(work, source);
  });

  // A hidden retained workspace sees another destination's location; keep its
  // last rendered list instead of replacing it with a route-not-found view.
  if (active && sourceRoutesReady && !knownLibraryRoute(window.location.pathname, window.location.search, sources)) {
    return (
      <NotFoundPage
        onBack={() => (window.history.length > 1 ? window.history.back() : openLibraryHome())}
        onOpenLibrary={openLibraryHome}
      />
    );
  }

  const { visibleWorks, totalWorkPages, currentWorkPage, activePageSize, activePageSizeOptions } =
    libraryBrowseSurfaceState({
      works: localWorks.works,
      optimisticSearchClauses: localWorks.optimisticSearchClauses,
      workTotal: localWorks.total ?? 0,
      workPage,
      workPageSize,
      activeTab,
      remoteSourceState: activeRemoteSourceState,
    });
  const changeSearchQuery = (value: string) => {
    localWorks.setOptimisticSearchClauses(null);
    setSearchQuery(value);
  };
  const changeWorkPage = (page: number) => {
    queueResultsScroll();
    setWorkPage(page);
  };
  const changeWorkPageSize = (pageSize: LibraryPageSize) => {
    queueResultsScroll();
    setWorkPage(1);
    setWorkPageSize(pageSize);
  };
  const changeLibrarySort = (sort: LibrarySort) => {
    queueResultsScroll();
    if (activeTab.kind === "source") updateRemoteSourceState(activeTab.source.id, { page: 1 });
    else setWorkPage(1);
    if (sort === "random") setRandomSeed(createRandomSortSeed());
    writeLibrarySortPreference(libraryBrowseKey(activeTab, localScope, browseStorageScope), sort, sortDirection);
    setLibrarySort(sort);
  };
  const reshuffle = () => {
    if (librarySort === "recommend") recommendations.recordReshuffle();
    queueResultsScroll();
    if (activeTab.kind === "source") updateRemoteSourceState(activeTab.source.id, { page: 1 });
    else setWorkPage(1);
    setRandomSeed(createRandomSortSeed());
  };
  const changeSortDirection = (direction: SortDirection) => {
    queueResultsScroll();
    if (activeTab.kind === "source") updateRemoteSourceState(activeTab.source.id, { page: 1 });
    else setWorkPage(1);
    writeLibrarySortPreference(libraryBrowseKey(activeTab, localScope, browseStorageScope), librarySort, direction);
    setSortDirection(direction);
  };
  const changeStatusFilter = (status: ListeningStatus | "all") => {
    queueResultsScroll();
    setWorkPage(1);
    setStatusFilter(status);
  };
  const openRecentWork = (work: Work) => openWork(work, recentWorkSourceIntent(work));
  const browseRefreshing =
    activeTab.kind === "source" ? remoteWorks.isLoading && remoteWorks.result !== null : localWorks.isLoading;
  const browseLoadingLabel =
    activeTab.kind === "source" ? t("library.refreshingRemoteWorks") : t("library.refreshingLibraryWorks");
  const primaryTabs = {
    active: activePrimaryTab,
    activeSourceId: activeTab.kind === "source" ? activeTab.source.id : null,
    sources,
    sourceVisibility,
    onChange: changePrimaryTab,
    onSourceChange: (source: LibrarySource) => changeTab({ kind: "source", source }),
  };
  const sort = {
    options:
      activeTab.kind === "source"
        ? librarySortOptions.filter((option) => remoteSortValues.includes(option.value))
        : librarySortOptions,
    value: librarySort,
    direction: sortDirection,
    onChange: changeLibrarySort,
    onDirectionChange: changeSortDirection,
    onReshuffle: reshuffle,
    reshuffling: librarySort === "recommend" && localWorks.isLoading,
  };
  const displayPicker = (
    <WorkCollectionDisplayPicker
      mobileColumns={mobileColumns}
      desktopColumns={desktopColumns}
      onMobileColumnsChange={setMobileColumns}
      onDesktopColumnsChange={setDesktopColumns}
      cardModes={{
        mobile: mobileCardMode,
        desktop: desktopCardMode,
        onMobileChange: setMobileCardMode,
        onDesktopChange: setDesktopCardMode,
      }}
      pageSize={activePageSize}
      pageSizeOptions={activePageSizeOptions}
      onPageSizeChange={(value) => {
        queueResultsScroll();
        if (activeTab.kind === "source") {
          updateRemoteSourceState(activeTab.source.id, { pageSize: libraryPageSize(value), page: 1 });
          return;
        }
        changeWorkPageSize(libraryPageSize(value));
      }}
      coverSources={{ mode: coverSourceMode, onChange: setCoverSourceMode }}
    />
  );
  // The recommended order scores every work, so it has no badge switch.
  const recommendationBadgeToggle =
    librarySort === "recommend" ? null : (
      <IconButton
        title={recommendBadgesEnabled ? t("library.hideRecommendationBadges") : t("library.showRecommendationBadges")}
        onClick={recommendations.toggleBadges}
      >
        <Sparkles className={`h-4 w-4 ${recommendBadgesEnabled ? "fill-current text-primary" : ""}`} />
      </IconButton>
    );
  const selectionToggle =
    activeTab.kind === "source" ? (
      <IconButton
        title={remoteSelectionMode ? t("library.cancelSelection") : t("library.select")}
        aria-pressed={remoteSelectionMode}
        onClick={() => setRemoteSelectionMode((current) => !current)}
      >
        <ListChecks className={`h-4 w-4 ${remoteSelectionMode ? "text-primary" : ""}`} />
      </IconButton>
    ) : null;
  const cardLayout = workCardLayout(
    mobileNavigationLayout ? mobileCardMode : desktopCardMode,
    !mobileNavigationLayout,
    mobileColumns,
  );
  const browseContent = (
    <div className="relative space-y-5" hidden={!showBrowse}>
      {auth.demoMode &&
        (activeTab.kind === "source" ? (
          <DemoRemoteSourceNotice sourceName={activeTab.source.displayName} />
        ) : (
          <DemoContentNotice surface="library" />
        ))}
      <MetadataOnboardingNotice active={active && showBrowse} />
      {mobileNavigationLayout ? (
        <MobileLibraryToolbar
          sourceMenu={<LibrarySourceMenu {...primaryTabs} />}
          searchQuery={searchQuery}
          onSearchChange={changeSearchQuery}
          onAddClause={clauseEditor.openAdd}
          addClauseOpen={clauseEditor.editor?.mode === "add"}
          resultCount={activeTab.kind === "source" ? (remoteWorks.result?.total ?? null) : localWorks.total}
          resultPage={
            activeTab.kind === "source"
              ? {
                  page: activeRemoteSourceState.page,
                  totalPages: Math.max(
                    1,
                    Math.ceil((remoteWorks.result?.total ?? 0) / activeRemoteSourceState.pageSize),
                  ),
                }
              : { page: currentWorkPage, totalPages: totalWorkPages }
          }
          sort={sort}
          extras={recommendationBadgeToggle}
          actions={
            <>
              {displayPicker}
              {selectionToggle}
            </>
          }
          statusFilter={activeTab.kind === "source" ? null : statusFilter}
          onStatusFilterChange={changeStatusFilter}
          onOpenRecent={openRecentWork}
          active={active}
        />
      ) : (
        <LibraryDesktopToolbar
          sourceTabs={<LibraryPrimaryTabs {...primaryTabs} />}
          searchQuery={searchQuery}
          onSearchChange={changeSearchQuery}
          onAddClause={clauseEditor.openAdd}
          addClauseOpen={clauseEditor.editor?.mode === "add"}
          onOpenRecent={openRecentWork}
          displayPicker={displayPicker}
          recommendationAction={recommendationBadgeToggle}
          sort={sort}
          selectionToggle={selectionToggle}
          statusFilter={statusFilter}
          onStatusFilterChange={changeStatusFilter}
        />
      )}
      <SearchClauseBadges
        clauses={searchClauses}
        editor={clauseEditor.editor}
        onEdit={clauseEditor.openEdit}
        onRemove={clauseEditor.remove}
      />
      <SearchClausePopover open={active && showBrowse} control={clauseEditor} />
      <div ref={resultsScroll.anchorRef} className="scroll-mt-24" />

      {activeTab.kind === "source" ? (
        <div className="space-y-3">
          <RemoteSourcePanel
            source={activeTab.source}
            recommendationsEnabled={active && showBrowse && recommendBadgesEnabled}
            recommendationSessionId={recommendationSession.id}
            result={remoteWorks.result}
            loading={remoteWorks.isLoading}
            viewState={activeRemoteSourceState}
            selectionMode={remoteSelectionMode}
            onSelectionModeChange={setRemoteSelectionMode}
            searchClauses={searchClauses}
            mobileColumns={mobileColumns}
            desktopColumns={desktopColumns}
            cardLayout={cardLayout}
            coverSourceMode={coverSourceMode}
            onClearSearch={() => setSearchQuery("")}
            onPageChange={(page) => {
              queueResultsScroll();
              updateRemoteSourceState(activeTab.source.id, { page });
            }}
            onOpenPreview={(work) => openRemotePreview(activeTab.source, work)}
            onTagOpen={addTagSearchClause}
            onWorkStateChanged={remoteWorks.patchWork}
            onSynced={async (workId, options) => {
              if (workId <= 0) {
                remoteWorks.loadNow(activeTab.source, remoteSearchQuery, activeRemoteSourceState.page, {
                  clearResult: false,
                });
                return;
              }
              if (!options?.openTracked) return;
              const detail = await api.getWork(workId);
              openWorkCodeRoute(detail.primaryCode, "tracked", activeTab.source.id);
            }}
            onRetry={() => remoteWorks.loadNow(activeTab.source, remoteSearchQuery, activeRemoteSourceState.page)}
          />
        </div>
      ) : (
        <LocalLibraryPanel
          scope={localScope}
          works={visibleWorks}
          pagination={{
            page: currentWorkPage,
            pageSize: workPageSize,
            totalItems: localWorks.total ?? 0,
            totalPages: totalWorkPages,
            onPageChange: changeWorkPage,
          }}
          loadError={localWorks.loadError}
          isLoading={localWorks.isLoading}
          onRetry={() => localWorks.loadNow(librarySearchQuery, currentWorkPage)}
          recommendationBadgesUnavailable={
            localWorks.recommendationUnavailable && recommendBadgesEnabled && librarySort !== "recommend"
          }
          filtered={searchQuery.trim() !== "" || statusFilter !== "all"}
          onClearFilters={() => {
            setSearchQuery("");
            changeStatusFilter("all");
          }}
          showRecommendationScore={
            localWorks.displayedRecommendationSort ||
            (recommendBadgesEnabled && localWorks.displayedRecommendationBadges)
          }
          mobileColumns={mobileColumns}
          desktopColumns={desktopColumns}
          cardLayout={cardLayout}
          coverSourceMode={coverSourceMode}
          onOpen={openCardWork}
          onRecommendationOpen={openCardRecommendation}
          onStatusChange={changeCardStatus}
          onFavoriteSaved={saveCardFavorite}
          onTagOpen={openCardTag}
          onUserTagOpen={openCardUserTag}
          onUntrack={localScope === "tracked" ? untrackCardSource : undefined}
          canUntrack={requireUntrack}
          isUntracking={isUntracking}
          onFetch={localScope === "tracked" ? fetchCardSource : undefined}
          isFetchBusy={trackedFetchWorkspace.isBusy}
        />
      )}
      {active && showBrowse && recommendations.explanation && (
        <RecommendationExplanationDialog
          state={recommendations.explanation}
          onClose={recommendations.closeExplanation}
        />
      )}
      {active && showBrowse && <LazyRemoteFetchWorkspaceDialog workspace={trackedFetchWorkspace} />}
      <BrowseLoadingIndicator refreshing={active && showBrowse && browseRefreshing} label={browseLoadingLabel} />
    </div>
  );
  return (
    (listVisited || showBrowse) && <PageActiveProvider value={active && showBrowse}>{browseContent}</PageActiveProvider>
  );
}
