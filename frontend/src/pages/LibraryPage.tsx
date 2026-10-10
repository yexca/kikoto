import { ListChecks, RefreshCw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { NotFoundPage } from "@/app/NotFoundPage";
import { PageActiveProvider } from "@/app/pageHeader";
import { REMOTE_TRACK_TERMINAL_EVENT, type RemoteTrackTerminalDetail } from "@/app/remoteTrackWorkflows";
import { openWorkDetail, workDetailCodeFromLocation } from "@/app/workDetailNavigation";
import { useAuth } from "@/auth/AuthProvider";
import { REMOTE_TRACK_PERMISSIONS, usePermissionGate } from "@/auth/usePermissionGate";
import { BrowseLoadingIndicator } from "@/components/collection/BrowseLoadingIndicator";
import { DemoContentNotice, DemoRemoteSourceNotice } from "@/components/DemoReadOnlyNotice";
import { MetadataOnboardingNotice } from "@/components/MetadataOnboardingNotice";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { IconButton } from "@/components/ui/icon-button";
import { toastFromError, useToast } from "@/components/ui/toast";
import type { MobileWorkCardLayout } from "@/components/work-card/MobileWorkCard";
import {
  useWorkCollectionLayout,
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
import {
  currentInternalLocation,
  historyEntryKey,
  historyScrollY,
  isMobileTabResumeHistoryState,
  navigateToHistoryReturn,
  requestHistoryScrollRestoration,
} from "@/lib/browserHistory";
import { currentClientStorageScope } from "@/lib/clientStorageScope";
import {
  defaultLibraryBrowseState,
  libraryBrowseSearch,
  type LibraryBrowseState,
  libraryBrowseStateFromSearch,
  libraryLocation,
  localPageSize,
  type LocalWorkPageSize,
  readLastLibraryLocation,
  readLibraryBrowseState,
  readLibrarySortPreference,
  withSharedLibraryQuery,
  writeLastLibraryLocation,
  writeLibraryBrowseState,
  writeLibrarySortPreference,
} from "@/lib/libraryBrowseState";
import {
  compileLibrarySearchQuery,
  formatRemoteSearchQuery,
  formatSearchClause,
  normalizeSearchClauseDraft,
  parseSearchClauses,
  type SearchClause,
} from "@/lib/librarySearchClauses";
import { ContinueListeningRail } from "@/pages/library/ContinueListeningRail";
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
import { LibraryPrimaryTabs } from "@/pages/library/LibraryPrimaryTabs";
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
  remoteTargetFromLocation,
  tabFromPath,
} from "@/pages/library/libraryRoutes";
import { type LibraryRemoteTarget, LibraryWorkDetail } from "@/pages/library/LibraryWorkDetail";
import { LocalLibraryPanel } from "@/pages/library/LocalLibraryPanel";
import { MobileLibraryToolbar } from "@/pages/library/MobileLibraryToolbar";
import { RecommendationExplanationDialog } from "@/pages/library/RecommendationExplanationDialog";
import { remoteWorkActionCode } from "@/pages/library/remoteSourceBrowseModel";
import { RemoteSourcePanel } from "@/pages/library/RemoteSourcePanel";
import {
  SearchClauseBadges,
  SearchClauseEditor,
  type SearchClauseEditorState,
} from "@/pages/library/SearchClauseEditor";
import { useLibraryCoverSourceMode } from "@/pages/library/useLibraryCoverSourceMode";
import { useLibraryRecommendations } from "@/pages/library/useLibraryRecommendations";
import { useLibraryResultsScroll } from "@/pages/library/useLibraryResultsScroll";
import { useLibrarySourceVisibility } from "@/pages/library/useLibrarySourceVisibility";
import { useLibraryWorkDetail } from "@/pages/library/useLibraryWorkDetail";
import { useLocalLibraryWorks } from "@/pages/library/useLocalLibraryWorks";
import { useRemoteSourceWorks } from "@/pages/library/useRemoteSourceWorks";
import { remoteOnlyWorkPreview, remoteWorkPreview, workPreviewFromHistory } from "@/pages/library/workPreviewHistory";

// The app shell starts the detail chunk for a direct work link; this covers a
// detail location reached before the Library chunk finished loading. Both share
// the feature's single dynamic import, so the chunk is fetched once.
if (workDetailCodeFromLocation(window.location.pathname, window.location.search) !== null) preloadWorkDetail();

// An idle Library warms the surfaces it opens on demand.
function preloadLibraryDeferredSurfaces() {
  preloadWorkDetail();
  void preloadRemoteFetchWorkspaceDialog().catch(() => {});
}

const librarySearchDebounceMs = 400;

const remoteSearchDebounceMs = 600;

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
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const [sourceRoutesReady, setSourceRoutesReady] = useState(false);
  const [browseHydrated, setBrowseHydrated] = useState(() => localBrowseRoute(window.location.pathname));
  const [activeTab, setActiveTab] = useState<LibraryTab>(initialBrowse.tab);
  const [localScope, setLocalScope] = useState<LocalLibraryScope>(initialBrowse.scope);
  const [remoteSourceStates, setRemoteSourceStates] = useState<Record<number, RemoteSourceViewState>>({});
  const [remoteSelectionMode, setRemoteSelectionMode] = useState(false);
  const [selectedCode, setSelectedCode] = useState<string | null>(() =>
    workDetailCodeFromLocation(window.location.pathname, window.location.search),
  );
  const [selectedRemoteTarget, setSelectedRemoteTarget] = useState<LibraryRemoteTarget | null>(null);
  const [statusFilter, setStatusFilter] = useState<ListeningStatus | "all">(initialBrowseState.status);
  const [searchQuery, setSearchQuery] = useState(initialBrowseState.query);
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState(initialBrowseState.query);
  const [debouncedRemoteSearchQuery, setDebouncedRemoteSearchQuery] = useState(initialBrowseState.query);
  const [clauseEditor, setClauseEditor] = useState<SearchClauseEditorState | null>(null);
  // The clause editor floats next to whichever control opened it: the add
  // button in the search field or the edited clause badge.
  const clauseEditorAnchorRef = useRef<HTMLElement | null>(null);
  const { mobileColumns, desktopColumns, mobileCompact, setMobileColumns, setDesktopColumns, setMobileCompact } =
    useWorkCollectionLayout({
      mobileColumns: initialBrowseState.mobileColumns,
      desktopColumns: initialBrowseState.desktopColumns,
    });
  const [librarySort, setLibrarySort] = useState<LibrarySort>(initialBrowseState.sort);
  const remoteInlineRecommendations = auth.demoMode && recommendBadgesEnabled;
  const [sortDirection, setSortDirection] = useState<SortDirection>(initialBrowseState.direction);
  const [randomSeed, setRandomSeed] = useState(initialBrowseState.randomSeed);
  const [workPage, setWorkPage] = useState(initialBrowseState.page);
  const [workPageSize, setWorkPageSize] = useState<LocalWorkPageSize>(localPageSize(initialBrowseState.pageSize));
  const [isUntracking, setIsUntracking] = useState(false);
  const requireUntrack = usePermissionGate(REMOTE_TRACK_PERMISSIONS, { deferDemo: true });
  const wasActive = useRef(active);
  const browseSurfaceActive = useRef(true);
  // Activation renders once before the route synchronization updates selection.
  // The current URL must already prevent list effects from writing into a detail.
  const showBrowse =
    selectedCode === null &&
    selectedRemoteTarget === null &&
    workDetailCodeFromLocation(window.location.pathname, window.location.search) === null;
  browseSurfaceActive.current = showBrowse;
  const [listVisited, setListVisited] = useState(showBrowse);
  useEffect(() => {
    if (showBrowse) setListVisited(true);
  }, [showBrowse]);
  const searchClauses = useMemo(() => parseSearchClauses(searchQuery), [searchQuery]);
  const debouncedSearchClauses = useMemo(() => parseSearchClauses(debouncedSearchQuery), [debouncedSearchQuery]);
  const debouncedRemoteSearchClauses = useMemo(
    () => parseSearchClauses(debouncedRemoteSearchQuery),
    [debouncedRemoteSearchQuery],
  );
  const remoteSearchQuery = useMemo(
    () => formatRemoteSearchQuery(debouncedRemoteSearchClauses),
    [debouncedRemoteSearchClauses],
  );
  const librarySearchQuery = useMemo(() => compileLibrarySearchQuery(debouncedSearchClauses), [debouncedSearchClauses]);
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
  const currentActiveTab = useStableCallback(() => activeTab);
  const pendingBrowseKey = useRef<string | null>(null);
  const currentBrowseKey = useStableCallback(() => libraryBrowseControlsKey(activeBrowseState));
  const hasPendingBrowseRestore = useStableCallback(
    () => pendingBrowseKey.current !== null && pendingBrowseKey.current !== currentBrowseKey(),
  );
  useLayoutEffect(() => {
    if (pendingBrowseKey.current === libraryBrowseControlsKey(activeBrowseState)) pendingBrowseKey.current = null;
  });
  const resultsScroll = useLibraryResultsScroll(active && showBrowse);
  const queueResultsScroll = resultsScroll.queue;
  const applyBrowseState = useStableCallback((state: LibraryBrowseState, tab: LibraryTab, restoreScroll = true) => {
    const key = libraryBrowseControlsKey({
      ...state,
      status: tab.kind === "source" ? "all" : state.status,
      sort: tab.kind === "source" ? remoteLibrarySort(state.sort) : state.sort,
      pageSize: tab.kind === "source" ? state.pageSize : localPageSize(state.pageSize),
    });
    pendingBrowseKey.current = key === currentBrowseKey() ? null : key;
    setSearchQuery(state.query);
    setDebouncedSearchQuery(state.query);
    setDebouncedRemoteSearchQuery(state.query);
    setStatusFilter(tab.kind === "source" ? "all" : state.status);
    setLibrarySort(tab.kind === "source" ? remoteLibrarySort(state.sort) : state.sort);
    setSortDirection(state.direction);
    setRandomSeed(state.randomSeed);
    if (restoreScroll) resultsScroll.restore(state.scrollY);
    if (tab.kind === "source") {
      setRemoteSourceStates((states) => ({
        ...states,
        [tab.source.id]: { page: state.page, pageSize: state.pageSize },
      }));
    } else {
      setWorkPage(state.page);
      setWorkPageSize(localPageSize(state.pageSize));
    }
  });

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (searchQuery !== debouncedSearchQuery) {
        queueResultsScroll();
        if (activeTab.kind !== "source") setWorkPage(1);
      }
      setDebouncedSearchQuery(searchQuery);
    }, librarySearchDebounceMs);
    return () => window.clearTimeout(timer);
  }, [activeTab.kind, queueResultsScroll, searchQuery, debouncedSearchQuery]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (searchQuery !== debouncedRemoteSearchQuery) {
        queueResultsScroll();
        if (activeTab.kind === "source") {
          setRemoteSourceStates((states) => ({
            ...states,
            [activeTab.source.id]: {
              ...(states[activeTab.source.id] ?? defaultRemoteSourceViewState),
              page: 1,
            },
          }));
        }
      }
      setDebouncedRemoteSearchQuery(searchQuery);
    }, remoteSearchDebounceMs);
    return () => window.clearTimeout(timer);
  }, [activeTab, queueResultsScroll, searchQuery, debouncedRemoteSearchQuery]);

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

  useEffect(() => {
    if (!active || auth.isLoading || sourceRoutesReady) return;
    const controller = new AbortController();
    let cancelled = false;
    if (!localBrowseRoute(window.location.pathname)) setBrowseHydrated(false);
    setSourceRoutesReady(false);
    api
      .listLibrarySources(controller.signal)
      .then((items) => {
        if (cancelled) return;
        setSources(items);
        setSourceRoutesReady(true);
        if (!knownLibraryRoute(window.location.pathname, window.location.search, items)) return;
        const resolved = tabFromPath(window.location.pathname, items, currentActiveTab());
        const scope = localScopeFromPath(window.location.pathname);
        const stored = readLibraryBrowseState(libraryBrowseKey(resolved, scope, browseStorageScope));
        const sortPreference = readLibrarySortPreference(libraryBrowseKey(resolved, scope, browseStorageScope));
        const routeRemoteTarget = remoteTargetFromLocation(window.location.pathname, window.location.search, items);
        if (
          workDetailCodeFromLocation(window.location.pathname, window.location.search) === null &&
          routeRemoteTarget === null &&
          !localBrowseRoute(window.location.pathname)
        ) {
          const state = libraryBrowseStateFromSearch(
            window.location.search,
            readLibraryHistoryBrowseState(browseStorageScope) ??
              stored ?? { ...sessionDefaultBrowseState, ...sortPreference },
          );
          applyBrowseState(state, resolved, false);
          setActiveTab(resolved);
        }
        if (routeRemoteTarget) setSelectedRemoteTarget(routeRemoteTarget);
      })
      .catch(() => {
        if (cancelled) return;
        setSources([]);
        setSourceRoutesReady(false);
      })
      .finally(() => {
        if (!cancelled) setBrowseHydrated(true);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    active,
    applyBrowseState,
    auth.isLoading,
    browseStorageScope,
    currentActiveTab,
    sessionDefaultBrowseState,
    sourceRoutesReady,
  ]);

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

  const workDetail = useLibraryWorkDetail({
    active,
    principalID,
    selectedCode,
    onCodeResolved: setSelectedCode,
    listedWorksRef: localWorks.worksRef,
    listedWorkCount: localWorks.works.length,
  });
  const setWorkPreview = workDetail.setPreview;

  useLayoutEffect(() => {
    if (!active) {
      wasActive.current = false;
      return;
    }
    const syncFromPath = (restoreListScroll = true) => {
      if (!knownLibraryRoute(window.location.pathname, window.location.search, sources)) return;
      const nextTab = tabFromPath(window.location.pathname, sources, activeTab);
      const nextScope = localScopeFromPath(window.location.pathname);
      const stored = readLibraryBrowseState(libraryBrowseKey(nextTab, nextScope, browseStorageScope));
      const sortPreference = readLibrarySortPreference(libraryBrowseKey(nextTab, nextScope, browseStorageScope));
      const nextCode = workDetailCodeFromLocation(window.location.pathname, window.location.search);
      const remoteTarget = remoteTargetFromLocation(window.location.pathname, window.location.search, sources);
      if (nextCode === null && remoteTarget === null) {
        const state = libraryBrowseStateFromSearch(
          window.location.search,
          readLibraryHistoryBrowseState(browseStorageScope) ??
            stored ?? { ...sessionDefaultBrowseState, ...sortPreference },
        );
        applyBrowseState(
          { ...state, scrollY: historyScrollY(window.history.state, state.scrollY) },
          nextTab,
          restoreListScroll,
        );
        setActiveTab(nextTab);
        setLocalScope(nextScope);
      }
      setSelectedCode(nextCode);
      setWorkPreview(workPreviewFromHistory(nextCode));
      setSelectedRemoteTarget(remoteTarget);
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
  }, [active, applyBrowseState, sources, activeTab, browseStorageScope, sessionDefaultBrowseState, setWorkPreview]);

  useEffect(() => {
    if (
      !active ||
      !browseHydrated ||
      hasPendingBrowseRestore() ||
      !showBrowse ||
      !knownLibraryRoute(window.location.pathname, window.location.search, sources)
    )
      return;
    const browseState = { ...activeBrowseState, scrollY: window.scrollY };
    writeLibraryBrowseState(libraryBrowseKey(activeTab, localScope, browseStorageScope), browseState);
    writeLibrarySortPreference(libraryBrowseKey(activeTab, localScope, browseStorageScope), librarySort, sortDirection);
    const nextSearch = libraryBrowseSearch(activeBrowseState);
    if (sourceRoutesReady) {
      writeLastLibraryLocation(browseStorageScope, `${pathForActiveLibrary(activeTab, localScope)}${nextSearch}`);
    }
    window.history.replaceState(
      {
        ...(window.history.state && typeof window.history.state === "object" ? window.history.state : {}),
        libraryBrowseScope: browseStorageScope,
        libraryBrowseState: browseState,
      },
      "",
      `${window.location.pathname}${nextSearch}`,
    );
  }, [
    active,
    activeBrowseState,
    activeTab,
    browseHydrated,
    hasPendingBrowseRestore,
    browseStorageScope,
    desktopColumns,
    librarySort,
    localScope,
    mobileColumns,
    randomSeed,
    searchQuery,
    showBrowse,
    sortDirection,
    sourceRoutesReady,
    statusFilter,
    workPage,
    workPageSize,
    remoteSourceStates,
    sources,
  ]);

  useEffect(() => {
    // Initial local defaults must not become a remote route's history snapshot
    // before its source and saved browse controls have been restored.
    if (
      !active ||
      !browseHydrated ||
      hasPendingBrowseRestore() ||
      !showBrowse ||
      !knownLibraryRoute(window.location.pathname, window.location.search, sources)
    )
      return;
    let pendingWrite: number | null = null;
    // Cleanup runs after another workspace has replaced this one in the shared
    // window scroll, so persist the last offset observed while this list was visible.
    let lastScrollY = window.scrollY;
    const entryKey = historyEntryKey(window.history.state);
    const location = currentInternalLocation();
    const flushScroll = () => {
      if (pendingWrite !== null) window.clearTimeout(pendingWrite);
      pendingWrite = null;
      if (historyEntryKey(window.history.state) !== entryKey || currentInternalLocation() !== location) return;
      const browseState = { ...activeBrowseState, scrollY: lastScrollY };
      writeLibraryBrowseState(libraryBrowseKey(activeTab, localScope, browseStorageScope), browseState);
      writeLibraryHistoryBrowseState(browseStorageScope, browseState);
    };
    const rememberScroll = () => {
      lastScrollY = window.scrollY;
      if (pendingWrite !== null) return;
      pendingWrite = window.setTimeout(flushScroll, 150);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushScroll();
    };
    window.addEventListener("scroll", rememberScroll, { passive: true });
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("scroll", rememberScroll);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (pendingWrite !== null) {
        window.clearTimeout(pendingWrite);
        pendingWrite = null;
      }
      if (browseSurfaceActive.current) flushScroll();
    };
  }, [
    active,
    activeBrowseState,
    activeTab,
    browseHydrated,
    browseStorageScope,
    hasPendingBrowseRestore,
    localScope,
    showBrowse,
    searchQuery,
    statusFilter,
    librarySort,
    randomSeed,
    sortDirection,
    mobileColumns,
    desktopColumns,
    workPage,
    workPageSize,
    remoteSourceStates,
    sources,
  ]);

  const openWork = (work: Work, sourceIntent: DetailSourceIntent = localScope === "tracked" ? "tracked" : "local") => {
    recordWorkRecommendationEvent(work, "open");
    const browseState = { ...activeBrowseState, scrollY: window.scrollY };
    writeLibraryBrowseState(libraryBrowseKey(activeTab, localScope, browseStorageScope), browseState);
    writeLibraryHistoryBrowseState(browseStorageScope, browseState);
    setSelectedRemoteTarget(null);
    openWorkDetail(
      {
        kind: "known",
        canonicalCode: work.primaryCode,
        view: sourceIntent === "tracked" ? "tracked" : "local",
      },
      {
        returnTo: libraryLocation(pathForActiveLibrary(activeTab, localScope), activeBrowseState),
        returnLabel: t("nav.library"),
        workPreview: work,
      },
    );
    setWorkPreview(work);
    setSelectedCode(work.primaryCode);
  };

  const openRemotePreview = (source: LibrarySource, work: RemoteWork) => {
    const code = remoteWorkActionCode(work);
    if (!code) return;
    const browseState = { ...activeBrowseState, scrollY: window.scrollY };
    writeLibraryBrowseState(libraryBrowseKey(activeTab, localScope, browseStorageScope), browseState);
    writeLibraryHistoryBrowseState(browseStorageScope, browseState);
    if (work.workId !== null && work.primaryCode) {
      const preview = remoteWorkPreview(work);
      setSelectedRemoteTarget(null);
      openPersistedRemoteSourceWorkRoute(
        source.id,
        work.primaryCode,
        code,
        libraryLocation(pathForActiveLibrary(activeTab, localScope), activeBrowseState),
        t("nav.library"),
        preview,
      );
      setWorkPreview(preview);
      setSelectedCode(work.primaryCode);
      return;
    }
    const preview = remoteOnlyWorkPreview(work);
    setSelectedRemoteTarget({ source, code, preview });
    openRemoteSourceWorkRoute(
      source.id,
      code,
      libraryLocation(pathForActiveLibrary(activeTab, localScope), activeBrowseState),
      t("nav.library"),
      preview,
    );
    setSelectedCode(workDetailCodeFromLocation(window.location.pathname, window.location.search));
  };

  const backToLibrary = () => {
    const fallbackLocation =
      readLastLibraryLocation(browseStorageScope) ??
      libraryLocation(pathForActiveLibrary(activeTab, localScope), activeBrowseState);
    navigateToHistoryReturn({
      fallbackLocation,
      fallbackState: { libraryBrowseScope: browseStorageScope, libraryBrowseState: activeBrowseState },
    });
  };

  const changeTab = (tab: LibraryTab) => {
    const currentState = { ...activeBrowseState, scrollY: window.scrollY };
    writeLibraryBrowseState(libraryBrowseKey(activeTab, localScope, browseStorageScope), currentState);
    writeLibraryHistoryBrowseState(browseStorageScope, currentState);
    const nextScope: LocalLibraryScope = tab.kind === "all" ? "local" : localScope;
    const nextKey = libraryBrowseKey(tab, nextScope, browseStorageScope);
    const nextState = withSharedLibraryQuery(
      readLibraryBrowseState(nextKey) ?? { ...sessionDefaultBrowseState, ...readLibrarySortPreference(nextKey) },
      searchQuery,
    );
    setActiveTab(tab);
    if (tab.kind === "all") setLocalScope(nextScope);
    applyBrowseState(nextState, tab);
    setSelectedRemoteTarget(null);
    const path = libraryLocation(pathForLibraryTab(tab), nextState);
    if (`${window.location.pathname}${window.location.search}` !== path) {
      window.history.pushState(
        requestHistoryScrollRestoration(
          { libraryBrowseScope: browseStorageScope, libraryBrowseState: nextState },
          nextState.scrollY,
        ),
        "",
        path,
      );
      window.dispatchEvent(new Event("kikoto:navigation"));
    }
  };

  const changeLocalScope = (scope: LocalLibraryScope) => {
    const currentState = { ...activeBrowseState, scrollY: window.scrollY };
    writeLibraryBrowseState(libraryBrowseKey(activeTab, localScope, browseStorageScope), currentState);
    writeLibraryHistoryBrowseState(browseStorageScope, currentState);
    const nextTab: LibraryTab = { kind: "all" };
    const nextKey = libraryBrowseKey(nextTab, scope, browseStorageScope);
    const nextState = withSharedLibraryQuery(
      readLibraryBrowseState(nextKey) ?? { ...sessionDefaultBrowseState, ...readLibrarySortPreference(nextKey) },
      searchQuery,
    );
    setActiveTab({ kind: "all" });
    setLocalScope(scope);
    applyBrowseState(nextState, nextTab);
    setSelectedRemoteTarget(null);
    const basePath = pathForLocalScope(scope);
    const path = basePath ? libraryLocation(basePath, nextState) : null;
    if (path && `${window.location.pathname}${window.location.search}` !== path) {
      window.history.pushState(
        requestHistoryScrollRestoration(
          { libraryBrowseScope: browseStorageScope, libraryBrowseState: nextState },
          nextState.scrollY,
        ),
        "",
        path,
      );
      window.dispatchEvent(new Event("kikoto:navigation"));
    }
  };

  const changePrimaryTab = (tab: "local" | "tracked") => {
    changeLocalScope(tab);
  };

  const updateWorkStatus = async (workID: number, status: ListeningStatus) => {
    try {
      const result = await api.updateWorkUserState(workID, { listeningStatus: status });
      const patch = { listeningStatus: result.listeningStatus, favorite: result.favorite };
      localWorks.patchWork(workID, patch);
      workDetail.patchWork(workID, patch);
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

  const refreshAfterTrack = useStableCallback((event: Event) => {
    const terminal = (event as CustomEvent<RemoteTrackTerminalDetail>).detail;
    if (!terminal || (terminal.status !== "succeeded" && terminal.status !== "partial")) return;
    if (activeTab.kind === "source") {
      if (activeTab.source.id === terminal.sourceId) {
        remoteWorks.loadNow(activeTab.source, remoteSearchQuery, activeRemoteSourceState.page, { clearResult: false });
      }
      return;
    }
    void refreshCurrentWorksPage();
  });
  useEffect(() => {
    if (!active) return;
    window.addEventListener(REMOTE_TRACK_TERMINAL_EVENT, refreshAfterTrack);
    return () => window.removeEventListener(REMOTE_TRACK_TERMINAL_EVENT, refreshAfterTrack);
  }, [active, refreshAfterTrack]);

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
    setSelectedCode(null);
    setSelectedRemoteTarget(null);
    workDetail.clearLoadFailure();
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
    setSearchQuery(nextQuery);
    setDebouncedSearchQuery(nextQuery);
    setDebouncedRemoteSearchQuery(nextQuery);
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

  const removeSearchClause = (index: number) => {
    updateSearchClauses(searchClauses.filter((_clause, clauseIndex) => clauseIndex !== index));
    setClauseEditor(null);
  };

  const openAddClauseEditor = (anchor: HTMLElement) => {
    if (clauseEditor?.mode === "add") {
      setClauseEditor(null);
      return;
    }
    clauseEditorAnchorRef.current = anchor;
    setClauseEditor({ mode: "add", index: null, draft: { kind: "text", value: "" } });
  };

  const openEditClauseEditor = (clause: SearchClause, index: number, anchor: HTMLElement) => {
    if (clauseEditor?.mode === "edit" && clauseEditor.index === index) {
      setClauseEditor(null);
      return;
    }
    clauseEditorAnchorRef.current = anchor;
    setClauseEditor({ mode: "edit", index, draft: { kind: clause.kind, value: clause.value } });
  };
  const closeClauseEditor = useCallback((open: boolean) => {
    if (!open) setClauseEditor(null);
  }, []);

  const saveClauseEditor = () => {
    if (!clauseEditor) return;
    const clause = normalizeSearchClauseDraft(clauseEditor.draft);
    if (!clause) return;
    if (clauseEditor.mode === "add") {
      updateSearchClauses([...searchClauses, clause]);
    } else if (clauseEditor.index !== null) {
      updateSearchClauses(searchClauses.map((item, index) => (index === clauseEditor.index ? clause : item)));
    }
    setClauseEditor(null);
  };

  // Stable card handlers let unchanged cards skip rendering when the page
  // re-renders, such as when a tab switch toggles `active`.
  const openCardWork = useStableCallback((work: Work) => openWork(work));
  const openCardRecommendation = useStableCallback((work: Work) => recommendations.openExplanation(work, randomSeed));
  const changeCardStatus = useStableCallback(updateWorkStatus);
  const saveCardFavorite = useStableCallback((work: Work, favorite: boolean) => {
    localWorks.patchWork(work.id, { favorite });
    workDetail.patchWork(work.id, { favorite });
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
  const changeWorkPageSize = (pageSize: LocalWorkPageSize) => {
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
  };
  const displayPicker = (
    <WorkCollectionDisplayPicker
      mobileColumns={mobileColumns}
      desktopColumns={desktopColumns}
      onMobileColumnsChange={setMobileColumns}
      onDesktopColumnsChange={setDesktopColumns}
      mobileCompact={mobileCompact}
      onMobileCompactChange={setMobileCompact}
      pageSize={activePageSize}
      pageSizeOptions={activePageSizeOptions}
      onPageSizeChange={(value) => {
        queueResultsScroll();
        if (activeTab.kind === "source") {
          updateRemoteSourceState(activeTab.source.id, { pageSize: value, page: 1 });
          return;
        }
        changeWorkPageSize(value as LocalWorkPageSize);
      }}
      coverSources={{ mode: coverSourceMode, onChange: setCoverSourceMode }}
    />
  );
  const recommendationAction =
    librarySort === "recommend" ? (
      <IconButton title={t("library.refreshRecommendations")} disabled={localWorks.isLoading} onClick={reshuffle}>
        <RefreshCw className={`h-4 w-4 ${localWorks.isLoading ? "animate-spin" : ""}`} />
      </IconButton>
    ) : (
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
  const showContinueListening =
    activeTab.kind !== "source" && searchClauses.length === 0 && statusFilter === "all" && currentWorkPage === 1;
  // Phones with compact cards on: one column reads as rows, two as short tiles.
  const mobileCardLayout: MobileWorkCardLayout | null =
    mobileNavigationLayout && mobileCompact ? (mobileColumns === 2 ? "tile" : "row") : null;
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
          sourceTabs={<LibraryPrimaryTabs variant="chips" {...primaryTabs} />}
          searchQuery={searchQuery}
          onSearchChange={changeSearchQuery}
          onAddClause={openAddClauseEditor}
          addClauseOpen={clauseEditor?.mode === "add"}
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
          actions={
            <>
              {recommendationAction}
              {displayPicker}
              {selectionToggle}
            </>
          }
          statusFilter={activeTab.kind === "source" ? null : statusFilter}
          onStatusFilterChange={changeStatusFilter}
        >
          {showContinueListening && <ContinueListeningRail active={active && showBrowse} onOpen={openRecentWork} />}
        </MobileLibraryToolbar>
      ) : (
        <LibraryDesktopToolbar
          sourceTabs={<LibraryPrimaryTabs {...primaryTabs} />}
          searchQuery={searchQuery}
          onSearchChange={changeSearchQuery}
          onAddClause={openAddClauseEditor}
          addClauseOpen={clauseEditor?.mode === "add"}
          onOpenRecent={openRecentWork}
          displayPicker={displayPicker}
          recommendationAction={recommendationAction}
          sort={sort}
          selectionToggle={selectionToggle}
          statusFilter={statusFilter}
          onStatusFilterChange={changeStatusFilter}
        />
      )}
      <SearchClauseBadges
        clauses={searchClauses}
        editor={clauseEditor}
        onEdit={openEditClauseEditor}
        onRemove={removeSearchClause}
      />
      <AnchoredPopover
        open={active && showBrowse && clauseEditor !== null}
        anchorRef={clauseEditorAnchorRef}
        align="start"
        ariaLabel={clauseEditor?.mode === "edit" ? t("library.editSearchCondition") : t("library.addSearchCondition")}
        onOpenChange={closeClauseEditor}
        className="w-[min(24rem,calc(100vw-1.5rem))] p-3"
      >
        {clauseEditor && (
          <SearchClauseEditor
            editor={clauseEditor}
            onChange={(draft) => setClauseEditor((current) => (current ? { ...current, draft } : current))}
            onCancel={() => setClauseEditor(null)}
            onSave={saveClauseEditor}
          />
        )}
      </AnchoredPopover>
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
            mobileCardLayout={mobileCardLayout}
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
          mobileCardLayout={mobileCardLayout}
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
    <>
      <LibraryWorkDetail
        remoteTarget={selectedRemoteTarget}
        code={selectedCode}
        detail={workDetail}
        sources={sources}
        principalID={principalID}
        onBack={backToLibrary}
        onOpenLibrary={openLibraryHome}
        onStatusChange={updateWorkStatus}
        onPlay={() => {
          const sourceWork = localWorks.worksRef.current.find((candidate) => candidate.id === workDetail.work?.id);
          if (sourceWork) recordWorkRecommendationEvent(sourceWork, "play");
        }}
        onWorksChanged={refreshCurrentWorksPage}
      />
      {(listVisited || showBrowse) && (
        <PageActiveProvider value={active && showBrowse}>{browseContent}</PageActiveProvider>
      )}
    </>
  );
}
