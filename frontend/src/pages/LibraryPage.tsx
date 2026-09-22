import {
  api,
  ApiError,
  type LibrarySort,
  type LibrarySource,
  type ListeningStatus,
  type RecommendationBreakdown,
  type RecommendationEventInput,
  type RemoteWork,
  type RemoteWorksResponse,
  type SortDirection,
  type SourcePresenceItem,
  type Work,
  type WorkDetail,
} from "@/lib/api";
import {
  defaultLibraryBrowseState,
  libraryBrowseSearch,
  type LibraryBrowseState,
  libraryBrowseStateFromSearch,
  libraryBrowseStateFromValue,
  type LibraryColumnSetting,
  libraryLocation,
  localPageSize,
  type LocalWorkPageSize,
  localWorkPageSizeOptions,
  normalizeLibraryBrowseLocation,
  readLastLibraryLocation,
  readLibraryBrowseState,
  readLibrarySortPreference,
  withSharedLibraryQuery,
  writeLastLibraryLocation,
  writeLibraryBrowseState,
  writeLibrarySortPreference,
} from "@/pages/libraryBrowseState";
import {
  compileLibrarySearchQuery,
  editableSearchClauseKinds,
  formatRemoteSearchQuery,
  formatSearchClause,
  normalizeSearchClauseDraft,
  parseSearchClauses,
  type SearchClause,
  type SearchClauseDraft,
  type SearchClauseKind,
} from "@/pages/librarySearchClauses";
import { toastFromError, useToast } from "@/components/ui/toast";
import { useAuth } from "@/auth/AuthProvider";
import { useTranslation } from "react-i18next";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import { type ClientPrincipalID, currentClientStorageScope } from "@/lib/clientStorageScope";
import {
  memo,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { readOrCreateRecommendationSession, RECOMMENDATION_ALGORITHM_VERSION } from "@/lib/recommendationSession";
import {
  useWorkCollectionLayout,
  workCollectionClassName,
  WorkCollectionLayoutPicker as LayoutPicker,
  workCollectionStyle,
} from "@/components/work-collection/WorkCollectionLayout";
import {
  getCachedWorkMedia,
  invalidateCachedWorkMedia,
  setCachedWorkMedia,
} from "@/features/work-detail/media/workMediaCache";
import { isMobileTabResumeHistoryState, navigateToWorkspaceUp } from "@/lib/browserHistory";
import { type DetailSourceIntent, remoteSourceTabKey } from "@/features/work-detail/source/sourceContextModel";
import { openWorkDetail, REMOTE_SOURCE_WORK_PATTERN, workDetailCodeFromLocation } from "@/app/workDetailNavigation";
import i18n from "@/i18n";
import {
  announceRemoteTrackCreated,
  REMOTE_TRACK_TERMINAL_EVENT,
  type RemoteTrackTerminalDetail,
} from "@/app/remoteTrackWorkflows";
import { useRemoteFetchWorkspace } from "@/features/work-detail/workflows/useRemoteFetchWorkspace";
import { useStableCallback } from "@/hooks/useStableCallback";
import { NotFoundPage } from "@/app/NotFoundPage";
import { WorkCollectionPagination } from "@/components/work-collection/WorkCollectionPagination";
import { MetadataOnboardingNotice } from "@/components/MetadataOnboardingNotice";
import {
  ArrowDownAZ,
  ArrowDownZA,
  ArrowUpDown,
  BookmarkPlus,
  Check,
  CheckCircle2,
  Circle,
  Cloud,
  CloudOff,
  Edit3,
  ExternalLink,
  Filter,
  GitBranchPlus,
  HardDrive,
  HardDriveDownload,
  Headphones,
  ListChecks,
  PauseCircle,
  Plus,
  RefreshCw,
  Repeat2,
  Search,
  Sparkles,
  Unlink,
  X,
} from "lucide-react";
import { dismissKeyboardOnEnter } from "@/lib/keyboard";
import { RecentlyPlayedPicker } from "@/pages/library/RecentlyPlayedPicker";
import { PageSizePicker } from "@/components/collection/PageSizePicker";
import { Badge } from "@/components/ui/badge";
import { RecommendationExplanationDialog } from "@/pages/library/RecommendationExplanationDialog";
import {
  LazyRemoteFetchWorkspaceDialog,
  preloadRemoteFetchWorkspaceDialog,
} from "@/features/work-detail/workflows/LazyRemoteFetchWorkspaceDialog";
import {
  PersistedWorkDetailController,
  preloadWorkDetail,
  RemoteOnlyWorkDetailController,
} from "@/features/work-detail/lazyWorkDetail";
import { BrowseLoadingIndicator } from "@/components/collection/BrowseLoadingIndicator";
import {
  directoryLoadErrorMessage,
  dlsiteWorkURL,
  listeningStatusOptions,
  openWorkCodeRoute,
  type RemoteWorkPreview,
  safeExternalHTTPURL,
  sourcePresenceActionCode,
  type WorkPreview,
} from "@/features/work-detail/workDetailShared";
import { IconButton } from "@/components/ui/icon-button";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import type { TFunction } from "i18next";
import { usePermissionGate } from "@/auth/usePermissionGate";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SaveConfirmDialog } from "@/pages/library/SaveConfirmDialog";
import {
  dlsiteTagBadges,
  userTagBadges,
  WorkCardActionButton,
  WorkCardDLsiteAction,
  WorkCardFooter,
  WorkCardListButton,
  WorkCardQuickMarkButton,
  WorkCardSelection,
  WorkCardShell,
  type WorkCardViewModel,
} from "@/components/work-card/WorkCardShell";
import { openCircleRoute, openCircleSeriesRoute } from "@/pages/circleNavigationState";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { hasPlaybackHistory } from "@/lib/playbackHistory";
import { sourcePresenceBadges } from "@/components/work-card/sourceBadges";
import { useDismissiblePopover } from "@/hooks/useDismissiblePopover";
import { FloatingSelect } from "@/components/ui/floating-select";
import { Input } from "@/components/ui/input";
import { WORK_CODE_PATH_PATTERN } from "@/lib/workCode";

// The app shell starts the detail chunk for a direct work link; this covers a
// detail location reached before the Library chunk finished loading. Both share
// the feature's single dynamic import, so the chunk is fetched once.
if (workDetailCodeFromLocation(window.location.pathname, window.location.search) !== null) preloadWorkDetail();

// An idle Library warms the surfaces it opens on demand.
function preloadLibraryDeferredSurfaces() {
  preloadWorkDetail();
  void preloadRemoteFetchWorkspaceDialog().catch(() => {});
}

const librarySortOptions: { value: LibrarySort; label: string }[] = [
  { value: "recommend", label: "Recommended" },
  { value: "recent", label: "Recently added" },
  { value: "release", label: "Release date" },
  { value: "random", label: "Random" },
  { value: "rating", label: "Rating" },
  { value: "code", label: "Code" },
  { value: "sales", label: "Sales" },
  { value: "title", label: "Title" },
];

function remoteLibrarySort(value: LibrarySort): LibrarySort {
  return value === "code" || value === "release" || value === "rating" || value === "sales" || value === "random"
    ? value
    : "recent";
}

function createRandomSortSeed() {
  return (window.crypto.getRandomValues(new Uint32Array(1))[0] % 2147483646) + 1;
}

const librarySearchDebounceMs = 400;

const remoteSearchDebounceMs = 600;

type RemoteSourceViewState = { page: number; pageSize: number };

const defaultRemoteSourceViewState: RemoteSourceViewState = { page: 1, pageSize: 24 };

type LibraryHistoryState = {
  libraryBrowseScope?: unknown;
  libraryBrowseState?: unknown;
};

function readLibraryHistoryBrowseState(storageScope: string): LibraryBrowseState | null {
  const historyState = window.history.state as LibraryHistoryState | null;
  if (historyState?.libraryBrowseScope !== storageScope) return null;
  const value = historyState?.libraryBrowseState;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return libraryBrowseStateFromValue(
    value as Partial<Record<keyof LibraryBrowseState, unknown>>,
    defaultLibraryBrowseState,
  );
}

function writeLibraryHistoryBrowseState(storageScope: string, state: LibraryBrowseState) {
  window.history.replaceState(
    {
      ...(window.history.state && typeof window.history.state === "object" ? window.history.state : {}),
      libraryBrowseScope: storageScope,
      libraryBrowseState: state,
    },
    "",
  );
}

function initialLibraryPageBrowseState(browseStorageScope: string, sessionDefaultBrowseState: LibraryBrowseState) {
  const tab = tabFromPath(window.location.pathname, []);
  const scope = localScopeFromPath(window.location.pathname);
  const sortPreference = readLibrarySortPreference(libraryBrowseKey(tab, scope, browseStorageScope));
  const state = libraryBrowseStateFromSearch(
    window.location.search,
    readLibraryHistoryBrowseState(browseStorageScope) ?? { ...sessionDefaultBrowseState, ...sortPreference },
  );
  return { tab, scope, state };
}

function activeRemoteSourceViewState(activeTab: LibraryTab, remoteSourceStates: Record<number, RemoteSourceViewState>) {
  return activeTab.kind === "source"
    ? (remoteSourceStates[activeTab.source.id] ?? defaultRemoteSourceViewState)
    : defaultRemoteSourceViewState;
}

function activeLibraryBrowseState({
  activeTab,
  remoteSourceState,
  searchQuery,
  workPage,
  workPageSize,
  statusFilter,
  librarySort,
  sortDirection,
  randomSeed,
  mobileColumns,
  desktopColumns,
}: {
  activeTab: LibraryTab;
  remoteSourceState: RemoteSourceViewState;
  searchQuery: string;
  workPage: number;
  workPageSize: LocalWorkPageSize;
  statusFilter: ListeningStatus | "all";
  librarySort: LibrarySort;
  sortDirection: SortDirection;
  randomSeed: number;
  mobileColumns: LibraryColumnSetting;
  desktopColumns: LibraryColumnSetting;
}): LibraryBrowseState {
  const remoteSelected = activeTab.kind === "source";
  return {
    query: searchQuery,
    page: remoteSelected ? remoteSourceState.page : workPage,
    pageSize: remoteSelected ? remoteSourceState.pageSize : workPageSize,
    status: statusFilter,
    sort: librarySort,
    direction: sortDirection,
    randomSeed,
    mobileColumns,
    desktopColumns,
    scrollY: 0,
  };
}

function libraryBrowseSurfaceState({
  works,
  optimisticSearchClauses,
  workTotal,
  workPage,
  workPageSize,
  statusFilter,
  activeTab,
  remoteSourceState,
  searchQuery,
  searchClauses,
}: {
  works: Work[];
  optimisticSearchClauses: SearchClause[] | null;
  workTotal: number;
  workPage: number;
  workPageSize: LocalWorkPageSize;
  statusFilter: ListeningStatus | "all";
  activeTab: LibraryTab;
  remoteSourceState: RemoteSourceViewState;
  searchQuery: string;
  searchClauses: SearchClause[];
}) {
  const visibleWorks = optimisticSearchClauses
    ? works.filter((work) => workMatchesSearch(work, optimisticSearchClauses))
    : works;
  const totalWorkPages = Math.max(1, Math.ceil(workTotal / workPageSize));
  const remoteSelected = activeTab.kind === "source";
  return {
    visibleWorks,
    totalWorkPages,
    currentWorkPage: Math.min(workPage, totalWorkPages),
    activeFilterCount: statusFilter === "all" ? 0 : 1,
    activePageSize: remoteSelected ? remoteSourceState.pageSize : workPageSize,
    activePageSizeOptions: remoteSelected ? ([12, 24, 48, 96] as const) : localWorkPageSizeOptions,
  };
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
  const recommendationSession = useMemo(
    () => readOrCreateRecommendationSession(browseStorageScope, RECOMMENDATION_ALGORITHM_VERSION),
    [browseStorageScope],
  );
  const sessionDefaultBrowseState = useMemo(
    () => ({ ...defaultLibraryBrowseState, randomSeed: recommendationSession.seed }),
    [recommendationSession.seed],
  );
  const initialBrowse = useRef(initialLibraryPageBrowseState(browseStorageScope, sessionDefaultBrowseState)).current;
  const initialBrowseState = initialBrowse.state;
  const [works, setWorks] = useState<Work[]>([]);
  const worksRef = useRef<Work[]>([]);
  worksRef.current = works;
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const [sourceRoutesReady, setSourceRoutesReady] = useState(false);
  const [browseHydrated, setBrowseHydrated] = useState(false);
  const [activeTab, setActiveTab] = useState<LibraryTab>(initialBrowse.tab);
  const [localScope, setLocalScope] = useState<LocalLibraryScope>(initialBrowse.scope);
  const [remoteResult, setRemoteResult] = useState<RemoteWorksResponse | null>(null);
  const [isRemoteLoading, setIsRemoteLoading] = useState(false);
  const [remoteSourceStates, setRemoteSourceStates] = useState<Record<number, RemoteSourceViewState>>({});
  const [remoteSelectionMode, setRemoteSelectionMode] = useState(false);
  const [settings, setSettings] = useState<{ cacheEnabled: boolean; recommendationThreshold: number } | null>(null);
  const [recommendationDialog, setRecommendationDialog] = useState<{
    work: Work;
    breakdown: RecommendationBreakdown | null;
    loading: boolean;
    error: string;
  } | null>(null);
  const [selectedCode, setSelectedCode] = useState<string | null>(() =>
    workDetailCodeFromLocation(window.location.pathname, window.location.search),
  );
  const [selectedWork, setSelectedWork] = useState<WorkDetail | null>(null);
  const [selectedWorkNotFound, setSelectedWorkNotFound] = useState(false);
  const [selectedWorkPreview, setSelectedWorkPreview] = useState<WorkPreview | null>(() =>
    workPreviewFromHistory(workDetailCodeFromLocation(window.location.pathname, window.location.search)),
  );
  const [isSelectedMediaLoading, setIsSelectedMediaLoading] = useState(false);
  const [selectedMediaError, setSelectedMediaError] = useState("");
  const [selectedRemoteTarget, setSelectedRemoteTarget] = useState<{
    source: LibrarySource;
    code: string;
    preview?: RemoteWorkPreview;
  } | null>(null);
  const [libraryLoadError, setLibraryLoadError] = useState("");
  const [statusFilter, setStatusFilter] = useState<ListeningStatus | "all">(initialBrowseState.status);
  const [searchQuery, setSearchQuery] = useState(initialBrowseState.query);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(() => Boolean(initialBrowseState.query.trim()));
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState(initialBrowseState.query);
  const [debouncedRemoteSearchQuery, setDebouncedRemoteSearchQuery] = useState(initialBrowseState.query);
  const [optimisticLibrarySearchClauses, setOptimisticLibrarySearchClauses] = useState<SearchClause[] | null>(null);
  const [clauseEditor, setClauseEditor] = useState<{
    mode: "add" | "edit";
    index: number | null;
    draft: SearchClauseDraft;
  } | null>(null);
  const { mobileColumns, desktopColumns, setMobileColumns, setDesktopColumns } = useWorkCollectionLayout({
    mobileColumns: initialBrowseState.mobileColumns,
    desktopColumns: initialBrowseState.desktopColumns,
  });
  const [librarySort, setLibrarySort] = useState<LibrarySort>(initialBrowseState.sort);
  const [recommendBadgesEnabled, setRecommendBadgesEnabled] = useState(
    () => window.localStorage.getItem("kikoto:recommend-badges") === "true",
  );
  const [sortDirection, setSortDirection] = useState<SortDirection>(initialBrowseState.direction);
  const [randomSeed, setRandomSeed] = useState(initialBrowseState.randomSeed);
  const [workPage, setWorkPage] = useState(initialBrowseState.page);
  const [workPageSize, setWorkPageSize] = useState<LocalWorkPageSize>(localPageSize(initialBrowseState.pageSize));
  const [workTotal, setWorkTotal] = useState(0);
  const [isLibraryLoading, setIsLibraryLoading] = useState(false);
  const [isUntracking, setIsUntracking] = useState(false);
  const libraryRequestSeq = useRef(0);
  const remoteRequestSeq = useRef(0);
  const loadedLibraryRequestKey = useRef("");
  const loadedRemoteRequestKey = useRef("");
  const recommendationContextRef = useRef<{ id: string; seed: number } | null>(null);
  const skipNextLibraryEffect = useRef(false);
  const skipNextRemoteEffect = useRef(false);
  const resultsAnchorRef = useRef<HTMLDivElement | null>(null);
  const pendingResultsScroll = useRef(false);
  const pendingScrollRestore = useRef<number | null>(null);
  const mobileSearchInputRef = useRef<HTMLInputElement | null>(null);
  const wasActive = useRef(active);
  const browseSurfaceActive = useRef(true);
  browseSurfaceActive.current = selectedCode === null && selectedRemoteTarget === null;
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
  const workScope = localScope;
  const activePrimaryTab: "local" | "tracked" | null = activeTab.kind === "source" ? null : localScope;
  const activeRemoteSourceState = activeRemoteSourceViewState(activeTab, remoteSourceStates);
  const activeBrowseState = activeLibraryBrowseState({
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
  });
  const applyBrowseState = (state: LibraryBrowseState, tab: LibraryTab, restoreScroll = true) => {
    setSearchQuery(state.query);
    setDebouncedSearchQuery(state.query);
    setDebouncedRemoteSearchQuery(state.query);
    setStatusFilter(tab.kind === "source" ? "all" : state.status);
    setLibrarySort(tab.kind === "source" ? remoteLibrarySort(state.sort) : state.sort);
    setSortDirection(state.direction);
    setRandomSeed(state.randomSeed);
    if (restoreScroll) {
      pendingScrollRestore.current = state.scrollY;
      window.requestAnimationFrame(() =>
        window.requestAnimationFrame(() => {
          if (pendingScrollRestore.current !== null)
            window.scrollTo({ top: pendingScrollRestore.current, behavior: "auto" });
        }),
      );
    }
    if (tab.kind === "source") {
      setRemoteSourceStates((states) => ({
        ...states,
        [tab.source.id]: { page: state.page, pageSize: state.pageSize },
      }));
    } else {
      setWorkPage(state.page);
      setWorkPageSize(localPageSize(state.pageSize));
    }
  };
  const completeResultsUpdate = () => {
    if (pendingScrollRestore.current !== null) {
      const scrollY = pendingScrollRestore.current;
      pendingScrollRestore.current = null;
      pendingResultsScroll.current = false;
      window.requestAnimationFrame(() => window.scrollTo({ top: scrollY, behavior: "auto" }));
      return;
    }
    if (!pendingResultsScroll.current) return;
    pendingResultsScroll.current = false;
    window.requestAnimationFrame(() => {
      const behavior: ScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth";
      if (window.matchMedia("(max-width: 1023px)").matches) {
        window.scrollTo({ top: 0, behavior });
        return;
      }
      const anchor = resultsAnchorRef.current;
      if (!anchor) return;
      anchor.scrollIntoView({ behavior, block: "start" });
    });
  };

  useLayoutEffect(() => {
    if (!active || selectedCode !== null || selectedRemoteTarget !== null) return;
    const scrollY = pendingScrollRestore.current;
    if (scrollY === null) return;

    // Position a returned list before the browser paints its first frame.
    const scrollingElement = document.scrollingElement ?? document.documentElement;
    const maxScrollY = Math.max(0, scrollingElement.scrollHeight - window.innerHeight);
    window.scrollTo({ top: scrollY, behavior: "auto" });
    if (scrollY <= maxScrollY + 1) {
      pendingScrollRestore.current = null;
      pendingResultsScroll.current = false;
    }
  });

  const queueResultsScroll = () => {
    pendingScrollRestore.current = null;
    pendingResultsScroll.current = true;
  };
  const recordRecommendationEvents = useCallback(
    (events: RecommendationEventInput[]) => {
      if (!auth.user || auth.demoMode || events.length === 0) return;
      void api.recordRecommendationEvents(events).catch(() => {});
    },
    [auth.demoMode, auth.user],
  );
  const recordWorkRecommendationEvent = (work: Work, eventType: RecommendationEventInput["eventType"]) => {
    const context = recommendationContextRef.current;
    if (!context) return;
    const rank = Math.max(0, worksRef.current.findIndex((candidate) => candidate.id === work.id) + 1);
    recordRecommendationEvents([
      {
        workId: work.id,
        eventType,
        contextId: context.id,
        algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
        seed: context.seed,
        rank,
        score: work.recommendScore,
      },
    ]);
  };

  useEffect(() => {
    if (searchQuery.trim()) setMobileSearchOpen(true);
  }, [searchQuery]);

  useEffect(() => {
    if (!mobileNavigationLayout || !mobileSearchOpen) return;
    const frame = window.requestAnimationFrame(() => mobileSearchInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [mobileNavigationLayout, mobileSearchOpen]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (searchQuery !== debouncedSearchQuery) {
        queueResultsScroll();
        if (activeTab.kind !== "source") setWorkPage(1);
      }
      setDebouncedSearchQuery(searchQuery);
    }, librarySearchDebounceMs);
    return () => window.clearTimeout(timer);
  }, [activeTab.kind, searchQuery, debouncedSearchQuery]);

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
  }, [activeTab, searchQuery, debouncedRemoteSearchQuery]);

  useEffect(() => {
    if (!active || !browseHydrated || activeTab.kind === "source") return;
    if (skipNextLibraryEffect.current) {
      skipNextLibraryEffect.current = false;
      return;
    }
    const requestKey = JSON.stringify([
      workPage,
      workPageSize,
      librarySearchQuery,
      workScope,
      statusFilter,
      librarySort,
      sortDirection,
      randomSeed,
      recommendBadgesEnabled,
      recommendationSession.id,
    ]);
    if (loadedLibraryRequestKey.current === requestKey) return;
    const controller = new AbortController();
    const requestSeq = ++libraryRequestSeq.current;
    setLibraryLoadError("");
    setIsLibraryLoading(true);
    api
      .listWorksPage(
        workPage,
        workPageSize,
        librarySearchQuery,
        workScope,
        statusFilter,
        librarySort,
        sortDirection,
        randomSeed,
        recommendBadgesEnabled && librarySort !== "recommend",
        controller.signal,
        recommendationSession.id,
      )
      .then((page) => {
        if (requestSeq !== libraryRequestSeq.current) return;
        loadedLibraryRequestKey.current = requestKey;
        setWorks(page.works);
        setWorkTotal(page.total);
        if (librarySort === "recommend") {
          const context = { id: createRecommendationContextID(), seed: randomSeed };
          recommendationContextRef.current = context;
          recordRecommendationEvents(
            page.works.map((work, index) => ({
              workId: work.id,
              eventType: "impression",
              contextId: context.id,
              algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
              seed: randomSeed,
              rank: (page.page - 1) * page.pageSize + index + 1,
              score: work.recommendScore,
            })),
          );
        } else {
          recommendationContextRef.current = null;
        }
        setLibraryLoadError("");
        setOptimisticLibrarySearchClauses(null);
        completeResultsUpdate();
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (requestSeq !== libraryRequestSeq.current) return;
        setLibraryLoadError(error instanceof Error ? error.message : t("library.couldNotLoad"));
        setOptimisticLibrarySearchClauses(null);
        pendingResultsScroll.current = false;
      })
      .finally(() => {
        if (!controller.signal.aborted && requestSeq === libraryRequestSeq.current) setIsLibraryLoading(false);
      });
    return () => controller.abort();
  }, [
    active,
    activeTab.kind,
    browseHydrated,
    librarySearchQuery,
    statusFilter,
    librarySort,
    randomSeed,
    recommendBadgesEnabled,
    recordRecommendationEvents,
    sortDirection,
    recommendationSession.id,
    workPage,
    workPageSize,
    workScope,
  ]);

  useEffect(() => {
    if (!active || auth.isLoading || sourceRoutesReady) return;
    const controller = new AbortController();
    let cancelled = false;
    setBrowseHydrated(false);
    setSourceRoutesReady(false);
    api
      .listLibrarySources(controller.signal)
      .then((items) => {
        if (cancelled) return;
        setSources(items);
        setSourceRoutesReady(true);
        if (!knownLibraryRoute(window.location.pathname, window.location.search, items)) return;
        const resolved = resolveTabFromPath(window.location.pathname, items, activeTab);
        const scope = localScopeFromPath(window.location.pathname);
        const stored = readLibraryBrowseState(libraryBrowseKey(resolved, scope, browseStorageScope));
        const sortPreference = readLibrarySortPreference(libraryBrowseKey(resolved, scope, browseStorageScope));
        applyBrowseState(
          libraryBrowseStateFromSearch(
            window.location.search,
            stored ??
              readLibraryHistoryBrowseState(browseStorageScope) ?? { ...sessionDefaultBrowseState, ...sortPreference },
          ),
          resolved,
          workDetailCodeFromLocation(window.location.pathname, window.location.search) === null,
        );
        setActiveTab(resolved);
        const routeRemoteTarget = remoteTargetFromLocation(window.location.pathname, window.location.search, items);
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
  }, [active, auth.isLoading, browseStorageScope, sessionDefaultBrowseState, sourceRoutesReady]);

  useEffect(() => {
    if (!active || settings) return;
    const controller = new AbortController();
    api
      .getRuntimeSettings(controller.signal)
      .then((next) => {
        setSettings(next);
      })
      .catch(() => setSettings(null));
    return () => controller.abort();
  }, [active, settings]);

  useEffect(() => {
    if (!active || !browseHydrated) return;
    if (activeTab.kind !== "source") {
      setRemoteResult(null);
      setIsRemoteLoading(false);
      return;
    }
    if (skipNextRemoteEffect.current) {
      skipNextRemoteEffect.current = false;
      return;
    }
    const controller = new AbortController();
    const sourceState = remoteSourceStates[activeTab.source.id] ?? defaultRemoteSourceViewState;
    const requestKey = JSON.stringify([
      activeTab.source.id,
      sourceState.page,
      sourceState.pageSize,
      remoteSearchQuery,
      librarySort,
      sortDirection,
      randomSeed,
      recommendBadgesEnabled,
    ]);
    // Switching to a local tab clears the remote result. The request key can
    // still match a previous successful load, so only reuse it while that
    // result is still present for the active source.
    if (loadedRemoteRequestKey.current === requestKey && remoteResult?.sourceId === activeTab.source.id) return;
    const requestSeq = ++remoteRequestSeq.current;
    setRemoteResult((current) => (current?.sourceId === activeTab.source.id ? current : null));
    setIsRemoteLoading(true);
    api
      .listRemoteSourceWorks(
        activeTab.source.id,
        sourceState.page,
        sourceState.pageSize,
        remoteSearchQuery,
        remoteLibrarySort(librarySort),
        sortDirection,
        randomSeed,
        recommendBadgesEnabled && librarySort !== "recommend",
        controller.signal,
      )
      .then((result) => {
        if (requestSeq !== remoteRequestSeq.current) return;
        loadedRemoteRequestKey.current = requestKey;
        setRemoteResult(result);
        completeResultsUpdate();
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (requestSeq !== remoteRequestSeq.current) return;
        setRemoteResult({
          sourceId: activeTab.source.id,
          works: [],
          page: sourceState.page,
          pageSize: sourceState.pageSize,
          total: 0,
          status: "unavailable",
          error: {
            code: "unavailable",
            message: "",
            retryable: true,
          },
          sort: remoteLibrarySort(librarySort),
          direction: sortDirection,
          sortApplied: false,
        });
      })
      .finally(() => {
        if (!controller.signal.aborted && requestSeq === remoteRequestSeq.current) setIsRemoteLoading(false);
      });
    return () => controller.abort();
  }, [
    active,
    activeTab,
    browseHydrated,
    librarySort,
    randomSeed,
    recommendBadgesEnabled,
    remoteSearchQuery,
    remoteSourceStates,
    sortDirection,
  ]);

  useEffect(() => {
    setRemoteSelectionMode(false);
  }, [activeTab.kind, activeTab.kind === "source" ? activeTab.source.id : 0]);

  useEffect(() => {
    if (!active) return;
    if (selectedCode === null) {
      setSelectedWork(null);
      setSelectedWorkNotFound(false);
      setIsSelectedMediaLoading(false);
      setSelectedMediaError("");
      return;
    }
    setSelectedWorkNotFound(false);
    setSelectedMediaError("");
    const controller = new AbortController();
    const work = worksRef.current.find((item) => item.primaryCode.toUpperCase() === selectedCode.toUpperCase());
    const historyPreview = workPreviewFromHistory(selectedCode);
    const workID = work?.id ?? historyPreview?.id ?? null;
    setSelectedWorkPreview(work ?? historyPreview);
    if (workID !== null) {
      setIsSelectedMediaLoading(true);
      api
        .getWorkSummary(workID, controller.signal)
        .then((detail) => {
          if (detail.baseCode && detail.baseCode.toUpperCase() !== detail.primaryCode.toUpperCase()) {
            return resolveAndOpenWork(
              selectedCode,
              principalID,
              setSelectedWork,
              setSelectedWorkPreview,
              setSelectedCode,
              setIsSelectedMediaLoading,
              setSelectedWorkNotFound,
              setSelectedMediaError,
              controller.signal,
            );
          }
          const cachedMedia = getCachedWorkMedia(detail.id, principalID);
          setSelectedWork(cachedMedia ? { ...detail, mediaItems: cachedMedia } : detail);
          if (cachedMedia) return;
          return api
            .getWorkMedia(detail.id, controller.signal)
            .then((media) => {
              setCachedWorkMedia(detail.id, principalID, media.mediaItems);
              setSelectedWork((current) =>
                current?.id === detail.id ? { ...current, mediaItems: media.mediaItems } : current,
              );
            })
            .catch((error) => {
              if (!(error instanceof DOMException && error.name === "AbortError")) {
                setSelectedMediaError(directoryLoadErrorMessage(error));
              }
            });
        })
        .catch((error) => {
          if (!(error instanceof DOMException && error.name === "AbortError")) {
            setSelectedWork(null);
            setSelectedWorkNotFound(error instanceof ApiError && error.status === 404);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setIsSelectedMediaLoading(false);
        });
      return () => controller.abort();
    }
    void resolveAndOpenWork(
      selectedCode,
      principalID,
      setSelectedWork,
      setSelectedWorkPreview,
      setSelectedCode,
      setIsSelectedMediaLoading,
      setSelectedWorkNotFound,
      setSelectedMediaError,
      controller.signal,
    );
    return () => controller.abort();
  }, [active, selectedCode, works.length]);

  useEffect(() => {
    if (!active) {
      wasActive.current = false;
      return;
    }
    const syncFromPath = (restoreListScroll = true) => {
      if (!knownLibraryRoute(window.location.pathname, window.location.search, sources)) return;
      const nextTab = resolveTabFromPath(window.location.pathname, sources, activeTab);
      const nextScope = localScopeFromPath(window.location.pathname);
      const stored = readLibraryBrowseState(libraryBrowseKey(nextTab, nextScope, browseStorageScope));
      const sortPreference = readLibrarySortPreference(libraryBrowseKey(nextTab, nextScope, browseStorageScope));
      const nextCode = workDetailCodeFromLocation(window.location.pathname, window.location.search);
      applyBrowseState(
        libraryBrowseStateFromSearch(
          window.location.search,
          stored ??
            readLibraryHistoryBrowseState(browseStorageScope) ?? { ...sessionDefaultBrowseState, ...sortPreference },
        ),
        nextTab,
        restoreListScroll && nextCode === null,
      );
      setSelectedCode(nextCode);
      setSelectedWorkPreview(workPreviewFromHistory(nextCode));
      setSelectedRemoteTarget(remoteTargetFromLocation(window.location.pathname, window.location.search, sources));
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
  }, [active, sources, activeTab, browseStorageScope, sessionDefaultBrowseState]);

  useEffect(() => {
    if (
      !active ||
      !browseHydrated ||
      selectedCode !== null ||
      selectedRemoteTarget !== null ||
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
    activeTab,
    browseHydrated,
    desktopColumns,
    librarySort,
    localScope,
    mobileColumns,
    randomSeed,
    searchQuery,
    selectedCode,
    selectedRemoteTarget,
    sortDirection,
    sourceRoutesReady,
    statusFilter,
    workPage,
    workPageSize,
    remoteSourceStates,
    sources,
  ]);

  useEffect(() => {
    if (activeTab.kind === "source" || isLibraryLoading) return;
    const lastPage = Math.max(1, Math.ceil(workTotal / workPageSize));
    if (workPage > lastPage) setWorkPage(lastPage);
  }, [activeTab.kind, isLibraryLoading, workPage, workPageSize, workTotal]);

  useEffect(() => {
    if (!active || selectedCode !== null || selectedRemoteTarget !== null) return;
    let pendingWrite: number | null = null;
    // Cleanup runs after another workspace has replaced this one in the shared
    // window scroll, so persist the last offset observed while this list was visible.
    let lastScrollY = window.scrollY;
    const flushScroll = () => {
      if (pendingWrite !== null) window.clearTimeout(pendingWrite);
      pendingWrite = null;
      if (workDetailCodeFromLocation(window.location.pathname, window.location.search) !== null) return;
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
    activeTab,
    localScope,
    selectedCode,
    selectedRemoteTarget,
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
    setSelectedWorkPreview(work);
    setSelectedCode(work.primaryCode);
  };

  const openRecommendationExplanation = (work: Work) => {
    setRecommendationDialog({ work, breakdown: null, loading: true, error: "" });
    void api
      .getWorkRecommendation(work.id, recommendationSession.id, randomSeed)
      .then((breakdown) => {
        setRecommendationDialog((current) =>
          current?.work.id === work.id ? { ...current, breakdown, loading: false, error: "" } : current,
        );
      })
      .catch((error) => {
        setRecommendationDialog((current) =>
          current?.work.id === work.id
            ? {
                ...current,
                loading: false,
                error: error instanceof Error ? error.message : t("errors.unavailable"),
              }
            : current,
        );
      });
  };

  const openRemotePreview = (source: LibrarySource, work: RemoteWork) => {
    const code = remoteWorkRouteCode(work);
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
      setSelectedWorkPreview(preview);
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
    navigateToWorkspaceUp({
      mobile: mobileNavigationLayout,
      fallbackLocation,
      fallbackState: { libraryBrowseScope: browseStorageScope, libraryBrowseState: activeBrowseState },
      isWorkspaceListLocation: (location) => normalizeLibraryBrowseLocation(location) !== null,
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
      window.history.pushState({ libraryBrowseScope: browseStorageScope, libraryBrowseState: nextState }, "", path);
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
      window.history.pushState({ libraryBrowseScope: browseStorageScope, libraryBrowseState: nextState }, "", path);
      window.dispatchEvent(new Event("kikoto:navigation"));
    }
  };

  const changePrimaryTab = (tab: "local" | "tracked") => {
    changeLocalScope(tab);
  };

  const updateWorkStatus = async (workID: number, status: ListeningStatus) => {
    try {
      const result = await api.updateWorkUserState(workID, { listeningStatus: status });
      setWorks((items) =>
        items.map((item) =>
          item.id === workID ? { ...item, listeningStatus: result.listeningStatus, favorite: result.favorite } : item,
        ),
      );
      setSelectedWork((item) =>
        item?.id === workID ? { ...item, listeningStatus: result.listeningStatus, favorite: result.favorite } : item,
      );
      const work = worksRef.current.find((item) => item.id === workID);
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
    if (!sourceID || !ownerWorkID) return;
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

  const loadLibraryWorksNow = (query: string, page = 1) => {
    const requestSeq = ++libraryRequestSeq.current;
    setLibraryLoadError("");
    setIsLibraryLoading(true);
    api
      .listWorksPage(
        page,
        workPageSize,
        query,
        workScope,
        statusFilter,
        librarySort,
        sortDirection,
        randomSeed,
        recommendBadgesEnabled && librarySort !== "recommend",
        undefined,
        recommendationSession.id,
      )
      .then((result) => {
        if (requestSeq !== libraryRequestSeq.current) return;
        setWorks(result.works);
        setWorkTotal(result.total);
        setLibraryLoadError("");
        setOptimisticLibrarySearchClauses(null);
        completeResultsUpdate();
      })
      .catch((error) => {
        if (requestSeq !== libraryRequestSeq.current) return;
        setLibraryLoadError(error instanceof Error ? error.message : t("library.couldNotLoad"));
        setOptimisticLibrarySearchClauses(null);
        pendingResultsScroll.current = false;
      })
      .finally(() => {
        if (requestSeq === libraryRequestSeq.current) setIsLibraryLoading(false);
      });
  };

  const loadRemoteWorksNow = (
    source: LibrarySource,
    query: string,
    page = 1,
    options: { clearResult?: boolean } = {},
  ) => {
    const sourceState = remoteSourceStates[source.id] ?? defaultRemoteSourceViewState;
    const requestSeq = ++remoteRequestSeq.current;
    setIsRemoteLoading(true);
    if (options.clearResult !== false && remoteResult?.sourceId !== source.id) setRemoteResult(null);
    api
      .listRemoteSourceWorks(
        source.id,
        page,
        sourceState.pageSize,
        query,
        remoteLibrarySort(librarySort),
        sortDirection,
        randomSeed,
        recommendBadgesEnabled && librarySort !== "recommend",
      )
      .then((result) => {
        if (requestSeq !== remoteRequestSeq.current) return;
        setRemoteResult(result);
        completeResultsUpdate();
      })
      .catch(() => {
        if (requestSeq !== remoteRequestSeq.current) return;
        setRemoteResult({
          sourceId: source.id,
          works: [],
          page,
          pageSize: sourceState.pageSize,
          total: 0,
          status: "unavailable",
          error: {
            code: "unavailable",
            message: "",
            retryable: true,
          },
          sort: remoteLibrarySort(librarySort),
          direction: sortDirection,
          sortApplied: false,
        });
      })
      .finally(() => {
        if (requestSeq === remoteRequestSeq.current) setIsRemoteLoading(false);
      });
  };

  const refreshCurrentWorksPage = async () => {
    if (activeTab.kind === "source") return;
    const page = await api.listWorksPage(
      workPage,
      workPageSize,
      librarySearchQuery,
      workScope,
      statusFilter,
      librarySort,
      sortDirection,
      randomSeed,
      recommendBadgesEnabled && librarySort !== "recommend",
      undefined,
      recommendationSession.id,
    );
    setWorks(page.works);
    setWorkTotal(page.total);
    setLibraryLoadError("");
  };

  useEffect(() => {
    if (!active) return;
    const refreshAfterTrack = (event: Event) => {
      const terminal = (event as CustomEvent<RemoteTrackTerminalDetail>).detail;
      if (!terminal || (terminal.status !== "succeeded" && terminal.status !== "partial")) return;
      if (activeTab.kind === "source") {
        if (activeTab.source.id === terminal.sourceId) {
          loadRemoteWorksNow(activeTab.source, remoteSearchQuery, activeRemoteSourceState.page, { clearResult: false });
        }
        return;
      }
      void refreshCurrentWorksPage();
    };
    window.addEventListener(REMOTE_TRACK_TERMINAL_EVENT, refreshAfterTrack);
    return () => window.removeEventListener(REMOTE_TRACK_TERMINAL_EVENT, refreshAfterTrack);
  }, [active, activeRemoteSourceState.page, activeTab, remoteSearchQuery]);

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
    setSelectedWorkNotFound(false);
  };

  const updateSearchClauses = (clauses: SearchClause[]) => {
    setOptimisticLibrarySearchClauses(null);
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
      skipNextRemoteEffect.current = true;
      updateRemoteSourceState(activeTab.source.id, { page: 1 });
      loadRemoteWorksNow(activeTab.source, nextRemoteQuery, 1, { clearResult: false });
      return;
    }
    setWorkPage(1);
    setOptimisticLibrarySearchClauses(nextClauses);
    skipNextLibraryEffect.current = true;
    loadLibraryWorksNow(nextLibraryQuery, 1);
  };
  const addTagSearchClause = (tag: string) => addNamedTagSearchClause("tag", tag);
  const addUserTagSearchClause = (tag: string) => addNamedTagSearchClause("user_tag", tag);

  const removeSearchClause = (index: number) => {
    updateSearchClauses(searchClauses.filter((_clause, clauseIndex) => clauseIndex !== index));
    setClauseEditor(null);
  };

  const openAddClauseEditor = () => {
    setClauseEditor({ mode: "add", index: null, draft: { kind: "text", value: "" } });
  };

  const closeMobileSearch = () => {
    setMobileSearchOpen(false);
    setClauseEditor(null);
  };

  const openEditClauseEditor = (clause: SearchClause, index: number) => {
    setClauseEditor({ mode: "edit", index, draft: { kind: clause.kind, value: clause.value } });
  };

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
  const openCardRecommendation = useStableCallback(openRecommendationExplanation);
  const changeCardStatus = useStableCallback(updateWorkStatus);
  const saveCardFavorite = useStableCallback((work: Work, favorite: boolean) => {
    setWorks((items) => items.map((item) => (item.id === work.id ? { ...item, favorite } : item)));
    setSelectedWork((item) => (item?.id === work.id ? { ...item, favorite } : item));
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

  if (selectedRemoteTarget !== null) {
    return (
      <Suspense fallback={<WorkDetailLoading />}>
        <RemoteOnlyWorkDetailController
          source={selectedRemoteTarget.source}
          sources={sources}
          code={selectedRemoteTarget.code}
          preview={selectedRemoteTarget.preview ?? null}
          onBack={backToLibrary}
          onWorksChanged={async () => await refreshCurrentWorksPage()}
        />
      </Suspense>
    );
  }

  if (selectedCode !== null) {
    if (selectedWorkNotFound) {
      return (
        <NotFoundPage
          title={t("library.workNotFound")}
          message={t("library.workUnavailableInLibrary", { code: selectedCode })}
          onBack={backToLibrary}
          onOpenLibrary={openLibraryHome}
        />
      );
    }
    return (
      <Suspense fallback={<WorkDetailLoading />}>
        <PersistedWorkDetailController
          code={selectedCode}
          work={selectedWork}
          workPreview={selectedWorkPreview}
          mediaLoading={isSelectedMediaLoading}
          mediaError={selectedMediaError}
          sources={sources}
          initialSourceIntent={detailSourceIntentFromLocation(window.location.search)}
          initialTrackedSourceID={detailTrackedSourceIDFromLocation(window.location.search)}
          initialRemoteCode={detailRemoteCodeFromLocation(window.location.search)}
          principalID={principalID}
          canForgetWork={auth.hasPermission("sources:write")}
          canSyncMetadata={auth.hasPermission("metadata:sync") && !auth.demoMode}
          onBack={backToLibrary}
          onStatusChange={updateWorkStatus}
          onPlay={() => {
            const sourceWork = worksRef.current.find((candidate) => candidate.id === selectedWork?.id);
            if (sourceWork) recordWorkRecommendationEvent(sourceWork, "play");
          }}
          onWorkReload={async (workID, includeMedia = false) => {
            const detail = await api.getWorkSummary(workID);
            let mediaItems =
              getCachedWorkMedia(workID, principalID) ?? (selectedWork?.id === workID ? selectedWork.mediaItems : []);
            if (includeMedia) {
              invalidateCachedWorkMedia(workID, principalID);
              const media = await api.getWorkMedia(workID);
              mediaItems = media.mediaItems;
              setCachedWorkMedia(workID, principalID, mediaItems);
            }
            setSelectedWork({ ...detail, mediaItems });
          }}
          onWorksChanged={async () => await refreshCurrentWorksPage()}
        />
      </Suspense>
    );
  }

  const {
    visibleWorks: pagedWorks,
    totalWorkPages,
    currentWorkPage,
    activeFilterCount,
    activePageSize,
    activePageSizeOptions,
  } = libraryBrowseSurfaceState({
    works,
    optimisticSearchClauses: optimisticLibrarySearchClauses,
    workTotal,
    workPage,
    workPageSize,
    statusFilter,
    activeTab,
    remoteSourceState: activeRemoteSourceState,
    searchQuery,
    searchClauses,
  });
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
  const toggleRecommendBadges = () => {
    setRecommendBadgesEnabled((current) => {
      const next = !current;
      window.localStorage.setItem("kikoto:recommend-badges", String(next));
      return next;
    });
  };
  const reshuffle = () => {
    const context = recommendationContextRef.current;
    if (librarySort === "recommend" && context) {
      recordRecommendationEvents([
        {
          eventType: "reshuffle",
          contextId: context.id,
          algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
          seed: context.seed,
        },
      ]);
    }
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
  const localPaginationProps = {
    page: currentWorkPage,
    pageSize: workPageSize,
    totalItems: workTotal,
    totalPages: totalWorkPages,
    onPageChange: changeWorkPage,
  };
  const localTopPagination = (
    <WorkCollectionPagination {...localPaginationProps} placement="top" compactMobile compactTop />
  );
  const browseRefreshing = activeTab.kind === "source" ? isRemoteLoading && remoteResult !== null : isLibraryLoading;
  const browseLoadingLabel =
    activeTab.kind === "source" ? t("library.refreshingRemoteWorks") : t("library.refreshingLibraryWorks");
  return (
    <div className="relative space-y-5">
      <MetadataOnboardingNotice active={active} />
      <section className="flex flex-wrap items-center gap-2" data-toast-avoid>
        <div className="order-1 min-w-0 max-w-full">
          <LibraryPrimaryTabs
            active={activePrimaryTab}
            activeSourceId={activeTab.kind === "source" ? activeTab.source.id : null}
            sources={sources}
            onChange={changePrimaryTab}
            onSourceChange={(source) => changeTab({ kind: "source", source })}
          />
        </div>
        <div
          className={`search-field order-3 min-h-10 w-full items-center gap-2 rounded-lg border bg-card px-3 text-sm lg:order-2 lg:flex lg:w-auto lg:min-w-[14rem] lg:max-w-2xl lg:flex-1 ${
            mobileSearchOpen ? "flex" : "hidden"
          }`}
        >
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={mobileSearchInputRef}
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
            value={searchQuery}
            onKeyDown={dismissKeyboardOnEnter}
            onChange={(event) => {
              setOptimisticLibrarySearchClauses(null);
              setSearchQuery(event.target.value);
            }}
            placeholder={t("library.searchPlaceholder")}
          />
          {searchQuery.trim() && (
            <button
              className="text-muted-foreground hover:text-foreground"
              onClick={() => {
                setOptimisticLibrarySearchClauses(null);
                setSearchQuery("");
              }}
              aria-label={t("library.clearSearch")}
            >
              <X className="h-4 w-4" />
            </button>
          )}
          <button
            className="rounded-sm text-muted-foreground hover:text-foreground"
            onClick={openAddClauseEditor}
            aria-label={t("library.addSearchCondition")}
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
        <div className="order-2 ml-auto flex flex-wrap justify-end gap-2 lg:order-3">
          {mobileNavigationLayout && (
            <IconButton
              title={mobileSearchOpen ? t("library.hideSearch") : t("library.searchLibrary")}
              onClick={() => {
                if (mobileSearchOpen) {
                  closeMobileSearch();
                  return;
                }
                setMobileSearchOpen(true);
              }}
            >
              <Search className="h-4 w-4" />
            </IconButton>
          )}
          <RecentlyPlayedPicker onOpen={(work) => openWork(work, recentWorkSourceIntent(work))} />
          <LayoutPicker
            mobileColumns={mobileColumns}
            desktopColumns={desktopColumns}
            onMobileColumnsChange={setMobileColumns}
            onDesktopColumnsChange={setDesktopColumns}
          />
          <PageSizePicker
            value={activePageSize}
            options={activePageSizeOptions}
            onChange={(value) => {
              queueResultsScroll();
              if (activeTab.kind === "source") {
                updateRemoteSourceState(activeTab.source.id, { pageSize: value, page: 1 });
                return;
              }
              changeWorkPageSize(value as LocalWorkPageSize);
            }}
          />
          {librarySort === "recommend" ? (
            <IconButton title={t("library.refreshRecommendations")} disabled={isLibraryLoading} onClick={reshuffle}>
              <RefreshCw className={`h-4 w-4 ${isLibraryLoading ? "animate-spin" : ""}`} />
            </IconButton>
          ) : (
            <IconButton
              title={
                recommendBadgesEnabled ? t("library.hideRecommendationBadges") : t("library.showRecommendationBadges")
              }
              onClick={toggleRecommendBadges}
            >
              <Sparkles className={`h-4 w-4 ${recommendBadgesEnabled ? "fill-current text-primary" : ""}`} />
            </IconButton>
          )}
          <SortPicker
            activeTab={activeTab}
            value={librarySort}
            direction={sortDirection}
            onChange={changeLibrarySort}
            onDirectionChange={changeSortDirection}
            onReshuffle={reshuffle}
          />
          {activeTab.kind === "source" ? (
            <IconButton
              title={remoteSelectionMode ? t("library.cancelSelection") : t("library.select")}
              aria-pressed={remoteSelectionMode}
              onClick={() => setRemoteSelectionMode((current) => !current)}
            >
              <ListChecks className={`h-4 w-4 ${remoteSelectionMode ? "text-primary" : ""}`} />
            </IconButton>
          ) : (
            <FilterPicker value={statusFilter} activeCount={activeFilterCount} onChange={changeStatusFilter} />
          )}
        </div>
      </section>
      {activeFilterCount > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline" className="gap-1.5">
            <Filter className="h-4 w-4" />
            {t("library.markFilter")}: {statusFilterLabel(statusFilter, t)}
            <button
              className="rounded-sm text-muted-foreground hover:text-foreground"
              aria-label={t("library.clearMarkFilter")}
              onClick={() => changeStatusFilter("all")}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        </div>
      )}
      {searchClauses.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {searchClauses.map((clause, index) => (
            <Badge
              key={`${clause.kind}-${clause.value}-${index}`}
              variant={clause.kind === "exclude_tag" ? "warning" : "outline"}
              className="gap-1.5"
            >
              <button
                className="inline-flex items-center gap-1 hover:text-foreground"
                onClick={() => openEditClauseEditor(clause, index)}
              >
                <Edit3 className="h-3 w-3" />
                {searchClauseLabel(clause, t)}
              </button>
              <button
                className="rounded-sm text-muted-foreground hover:text-foreground"
                aria-label={t("library.removeSearchClause", { clause: searchClauseLabel(clause, t) })}
                onClick={() => removeSearchClause(index)}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      {clauseEditor && (
        <SearchClauseEditor
          editor={clauseEditor}
          onChange={(draft) => setClauseEditor((current) => (current ? { ...current, draft } : current))}
          onCancel={() => setClauseEditor(null)}
          onSave={saveClauseEditor}
        />
      )}
      <div ref={resultsAnchorRef} className="scroll-mt-24" />

      {activeTab.kind === "source" ? (
        <div className="space-y-3">
          <RemoteSourcePanel
            source={activeTab.source}
            result={remoteResult}
            loading={isRemoteLoading}
            viewState={activeRemoteSourceState}
            selectionMode={remoteSelectionMode}
            onSelectionModeChange={setRemoteSelectionMode}
            searchClauses={searchClauses}
            mobileColumns={mobileColumns}
            desktopColumns={desktopColumns}
            onClearSearch={() => setSearchQuery("")}
            onPageChange={(page) => {
              queueResultsScroll();
              updateRemoteSourceState(activeTab.source.id, { page });
            }}
            onOpenPreview={(work) => openRemotePreview(activeTab.source, work)}
            onTagOpen={addTagSearchClause}
            onWorkStateChanged={(primaryCode, patch) => {
              setRemoteResult((current) =>
                current
                  ? {
                      ...current,
                      works: current.works.map((item) =>
                        item.primaryCode === primaryCode ? { ...item, ...patch } : item,
                      ),
                    }
                  : current,
              );
            }}
            onSynced={async (workId, options) => {
              if (workId <= 0) {
                loadRemoteWorksNow(activeTab.source, remoteSearchQuery, activeRemoteSourceState.page, {
                  clearResult: false,
                });
                return;
              }
              if (!options?.openTracked) return;
              const detail = await api.getWork(workId);
              openWorkCodeRoute(detail.primaryCode, "tracked", activeTab.source.id);
            }}
            onRetry={() => loadRemoteWorksNow(activeTab.source, remoteSearchQuery, activeRemoteSourceState.page)}
          />
        </div>
      ) : (
        <div className="space-y-3">
          {!libraryLoadError && localTopPagination}
          {libraryLoadError ? (
            <LibraryLoadErrorCard
              message={libraryLoadError}
              onRetry={() => loadLibraryWorksNow(librarySearchQuery, currentWorkPage)}
            />
          ) : pagedWorks.length === 0 ? (
            <EmptyLibraryWorksCard
              scope={localScope}
              filtered={searchQuery.trim() !== "" || statusFilter !== "all"}
              onClear={() => {
                setSearchQuery("");
                changeStatusFilter("all");
              }}
            />
          ) : (
            <section className={workCollectionClassName()} style={workCollectionStyle(mobileColumns, desktopColumns)}>
              {pagedWorks.map((work) => (
                <WorkCard
                  key={work.id}
                  work={work}
                  showRecommendationScore={librarySort === "recommend"}
                  onRecommendationOpen={openCardRecommendation}
                  onOpen={openCardWork}
                  onStatusChange={changeCardStatus}
                  onFavoriteSaved={saveCardFavorite}
                  onTagOpen={openCardTag}
                  onUserTagOpen={openCardUserTag}
                  onUntrack={localScope === "tracked" ? untrackCardSource : undefined}
                  isUntracking={isUntracking}
                  onFetch={localScope === "tracked" ? fetchCardSource : undefined}
                  isFetchBusy={trackedFetchWorkspace.isBusy}
                />
              ))}
            </section>
          )}
          {!libraryLoadError && <WorkCollectionPagination {...localPaginationProps} placement="bottom" />}
        </div>
      )}
      {recommendationDialog && (
        <RecommendationExplanationDialog state={recommendationDialog} onClose={() => setRecommendationDialog(null)} />
      )}
      <LazyRemoteFetchWorkspaceDialog workspace={trackedFetchWorkspace} />
      <BrowseLoadingIndicator refreshing={browseRefreshing} label={browseLoadingLabel} />
    </div>
  );
}

type LibraryTab = { kind: "all" } | { kind: "source"; source: LibrarySource };

type LocalLibraryScope = "local" | "tracked";

function LibraryPrimaryTabs({
  active,
  activeSourceId,
  sources,
  onChange,
  onSourceChange,
}: {
  active: "local" | "tracked" | null;
  activeSourceId: number | null;
  sources: LibrarySource[];
  onChange: (tab: "local" | "tracked") => void;
  onSourceChange: (source: LibrarySource) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={segmentedListClassName()}>
      <TabButton active={active === "local"} onClick={() => onChange("local")} icon={<HardDrive className="h-4 w-4" />}>
        {t("library.local")}
      </TabButton>
      <TabButton
        active={active === "tracked"}
        onClick={() => onChange("tracked")}
        icon={<GitBranchPlus className="h-4 w-4" />}
      >
        {t("library.tracked")}
      </TabButton>
      {sources.map((source) => (
        <TabButton
          key={source.id}
          active={activeSourceId === source.id}
          onClick={() => onSourceChange(source)}
          icon={<Cloud className="h-4 w-4" />}
        >
          {source.displayName}
        </TabButton>
      ))}
    </div>
  );
}

function TabButton({
  active,
  disabled,
  icon,
  children,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button className={segmentedItemClassName(active)} aria-pressed={active} disabled={disabled} onClick={onClick}>
      {icon}
      <span className="max-w-40 truncate">{children}</span>
    </button>
  );
}

const emptyRemoteWorks: RemoteWork[] = [];

type RemoteSourceBrowseModel = {
  visibleWorks: RemoteWork[];
  selectableWorks: RemoteWork[];
  totalItems: number;
  totalPages: number;
  currentPage: number;
  remotePaginationProps: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
    onPageChange: (page: number) => void;
  };
  remoteError: NonNullable<RemoteWorksResponse["error"]> | null;
};

type RemoteSourcePanelModel = RemoteSourceBrowseModel & {
  selectedWorks: RemoteWork[];
  selectedSyncable: RemoteWork[];
  selectedSaveable: RemoteWork[];
};

type RemoteSourceBrowseInput = {
  result: RemoteWorksResponse | null;
  viewState: RemoteSourceViewState;
  onPageChange: (page: number) => void;
};

function remoteSourceBrowseModel({
  result,
  viewState,
  onPageChange,
}: RemoteSourceBrowseInput): RemoteSourceBrowseModel {
  const { page, pageSize } = viewState;
  const visibleWorks = result?.works ?? emptyRemoteWorks;
  const selectableWorks = visibleWorks.filter((work) => work.primaryCode);
  const totalItems = result?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const currentPage = Math.min(page, totalPages);
  return {
    visibleWorks,
    selectableWorks,
    totalItems,
    totalPages,
    currentPage,
    remotePaginationProps: { page: currentPage, pageSize, totalItems, totalPages, onPageChange },
    remoteError:
      result?.error ??
      (result?.status === "disabled"
        ? { code: "disabled", message: "", retryable: false }
        : result?.status === "unavailable"
          ? { code: "unavailable", message: "", retryable: true }
          : null),
  };
}

function remoteSourcePanelModel({
  browse,
  bulkCodes,
}: {
  browse: RemoteSourceBrowseModel;
  bulkCodes: Set<string>;
}): RemoteSourcePanelModel {
  const selectedWorks = browse.selectableWorks.filter((work) => bulkCodes.has(work.primaryCode));
  return {
    ...browse,
    selectedWorks,
    selectedSyncable: selectedWorks.filter((work) => work.workId === null),
    selectedSaveable: selectedWorks,
  };
}

function useRemoteSourceSelection({
  selectableWorks,
  visibleWorks,
  selectionMode,
  loading,
  page,
  totalPages,
  onPageChange,
}: {
  selectableWorks: RemoteWork[];
  visibleWorks: RemoteWork[];
  selectionMode: boolean;
  loading: boolean;
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}) {
  const [bulkCodes, setBulkCodes] = useState<Set<string>>(new Set());

  useEffect(() => {
    setBulkCodes((current) => {
      const next = new Set(
        Array.from(current).filter((code) => visibleWorks.some((work) => work.primaryCode === code)),
      );
      if (next.size === current.size && Array.from(next).every((code) => current.has(code))) return current;
      return next;
    });
  }, [visibleWorks]);

  useEffect(() => {
    if (!selectionMode) setBulkCodes(new Set());
  }, [selectionMode]);

  useEffect(() => {
    if (loading || page <= totalPages) return;
    onPageChange(totalPages);
  }, [loading, onPageChange, page, totalPages]);

  const toggleBulkCode = (code: string, checked: boolean) => {
    setBulkCodes((current) => {
      const next = new Set(current);
      if (checked) next.add(code);
      else next.delete(code);
      return next;
    });
  };
  const toggleAllVisible = (checked: boolean) => {
    setBulkCodes(checked ? new Set(selectableWorks.map((work) => work.primaryCode)) : new Set());
  };
  const clearSelection = () => setBulkCodes(new Set());

  return { bulkCodes, toggleBulkCode, toggleAllVisible, clearSelection };
}

function useRemoteSourceActions({
  source,
  selectedSyncable,
  selectedSaveable,
  toast,
  t,
  onWorkStateChanged,
  onSynced,
}: {
  source: LibrarySource;
  selectedSyncable: RemoteWork[];
  selectedSaveable: RemoteWork[];
  toast: ReturnType<typeof useToast>;
  t: TFunction;
  onWorkStateChanged: (
    primaryCode: string,
    patch: Partial<Pick<RemoteWork, "workId" | "favorite" | "listeningStatus">>,
  ) => void;
  onSynced: (workID: number, options?: { openTracked?: boolean }) => Promise<void>;
}) {
  const requireDownloadsManage = usePermissionGate("downloads:manage");
  const [isSyncingCode, setIsSyncingCode] = useState<string | null>(null);
  const [isBulkBusy, setIsBulkBusy] = useState(false);
  const [saveConfirm, setSaveConfirm] = useState<{ codes: string[]; run: () => Promise<void> } | null>(null);
  const fetchWorkspace = useRemoteFetchWorkspace({ onWorksChanged: () => onSynced(0) });

  const trackWork = async (work: RemoteWork, reason: string) => {
    if (!work.primaryCode) {
      toast.warning(t("library.remoteWorkNoCode"));
      return;
    }
    setIsSyncingCode(work.primaryCode);
    try {
      const requestedCode = remoteWorkActionCode(work);
      const result = await api.trackRemoteSourceWork(source.id, requestedCode, reason);
      announceRemoteTrackCreated(source.id, requestedCode, result);
      toast.notify({
        kind: "info",
        message: result.deduplicated
          ? t("workflowPage.trackAlreadyQueued", { runId: result.runId })
          : t("workflowPage.trackQueued", { runId: result.runId }),
      });
      return result.runId;
    } catch (error) {
      toast.notify(toastFromError(error, t("library.trackCouldNotQueue")));
      return null;
    } finally {
      setIsSyncingCode(null);
    }
  };

  const runBulkSaveSelected = async () => {
    if (!requireDownloadsManage()) return;
    setIsBulkBusy(true);
    try {
      const parent = await api.recordRemoteBulkRun({
        action: "fetch",
        sourceId: source.id,
        codes: selectedSaveable.map(remoteWorkActionCode),
      });
      const message = t("library.bulkFetchSummary", {
        runId: parent.runId,
        fetched: parent.fetched,
        failed: parent.failed,
      });
      if (parent.failed > 0) toast.warning(message);
      else toast.success(message);
      await onSynced(0);
    } catch (error) {
      toast.notify(toastFromError(error, t("library.bulkFetchFailed")));
    } finally {
      setIsBulkBusy(false);
      setSaveConfirm(null);
    }
  };

  const bulkSyncSelected = async () => {
    if (selectedSyncable.length === 0) return;
    setIsBulkBusy(true);
    try {
      const parent = await api.recordRemoteBulkRun({
        action: "track",
        sourceId: source.id,
        codes: selectedSyncable.map(remoteWorkActionCode),
      });
      const message = t("library.bulkTrackSummary", {
        runId: parent.runId,
        synced: parent.synced,
        failed: parent.failed,
      });
      if (parent.failed > 0) toast.warning(message);
      else toast.success(message);
      await onSynced(0);
    } catch (error) {
      toast.notify(toastFromError(error, t("library.bulkTrackFailed")));
    } finally {
      setIsBulkBusy(false);
    }
  };

  const bulkSaveSelected = async () => {
    if (selectedSaveable.length === 0 || !requireDownloadsManage()) return;
    setSaveConfirm({ codes: selectedSaveable.map((work) => work.primaryCode), run: runBulkSaveSelected });
  };

  const ensureRemoteWorkForState = async (work: RemoteWork, reason: string) => {
    const result = await api.syncRemoteSourceWork(source.id, remoteWorkActionCode(work), reason);
    onWorkStateChanged(work.primaryCode, { workId: result.workId });
    await onSynced(result.workId);
    return result.workId;
  };

  const markRemoteWork = async (work: RemoteWork, status: ListeningStatus) => {
    if (!work.primaryCode) return;
    setIsSyncingCode(work.primaryCode);
    try {
      const workId = work.workId ?? (await ensureRemoteWorkForState(work, "mark_interest"));
      if (!workId) return;
      await api.updateWorkUserState(workId, { listeningStatus: status });
      onWorkStateChanged(work.primaryCode, { workId, listeningStatus: status });
      toast.success(t("library.savedAndMarked", { code: work.primaryCode }));
      await onSynced(workId);
    } catch (error) {
      toast.notify(toastFromError(error, t("errors.unavailable")));
    } finally {
      setIsSyncingCode(null);
    }
  };

  const ensureRemoteWorkForList = async (work: RemoteWork) => {
    if (work.workId) return work.workId;
    if (!work.primaryCode) return null;
    setIsSyncingCode(work.primaryCode);
    try {
      const result = await api.syncRemoteSourceWork(source.id, remoteWorkActionCode(work), "list_remote");
      toast.success(t("library.savedForList", { code: result.primaryCode }));
      return result.workId;
    } catch (error) {
      toast.notify(toastFromError(error, t("errors.unavailable")));
      return null;
    } finally {
      setIsSyncingCode(null);
    }
  };

  return {
    fetchWorkspace,
    isSyncingCode,
    isBulkBusy,
    saveConfirm,
    clearSaveConfirm: () => setSaveConfirm(null),
    trackWork,
    bulkSyncSelected,
    bulkSaveSelected,
    runBulkSaveSelected,
    markRemoteWork,
    ensureRemoteWorkForList,
  };
}

function RemoteSourceSelectionBar({
  t,
  selectedCount,
  selectedSyncableCount,
  selectedSaveableCount,
  isBulkBusy,
  onSelectAll,
  onCancel,
  onTrack,
  onFetch,
}: {
  t: TFunction;
  selectedCount: number;
  selectedSyncableCount: number;
  selectedSaveableCount: number;
  isBulkBusy: boolean;
  onSelectAll: () => void;
  onCancel: () => void;
  onTrack: () => void;
  onFetch: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2 text-sm">
      <div className="text-muted-foreground">{t("library.selectedCount", { count: selectedCount })}</div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={onSelectAll}>
          {t("library.selectAll")}
        </Button>
        <Button variant="outline" size="sm" onClick={onCancel}>
          {t("library.cancelSelection")}
        </Button>
        <Button variant="outline" size="sm" disabled={isBulkBusy || selectedSyncableCount === 0} onClick={onTrack}>
          <GitBranchPlus className="h-4 w-4" />
          {t("library.trackCount", { count: selectedSyncableCount })}
        </Button>
        <Button variant="outline" size="sm" disabled={isBulkBusy || selectedSaveableCount === 0} onClick={onFetch}>
          <HardDriveDownload className="h-4 w-4" />
          {t("library.fetchCount", { count: selectedSaveableCount })}
        </Button>
      </div>
    </div>
  );
}

function RemoteSourceResults({
  source,
  visibleWorks,
  remoteError,
  isInitialLoading,
  searchClauses,
  mobileColumns,
  desktopColumns,
  selectionMode,
  bulkCodes,
  isSyncingCode,
  actions,
  onToggleBulkCode,
  onClearSearch,
  onOpenPreview,
  onTagOpen,
  onWorkStateChanged,
  onSynced,
  onRetry,
  t,
}: {
  source: LibrarySource;
  visibleWorks: RemoteWork[];
  remoteError: NonNullable<RemoteWorksResponse["error"]> | null;
  isInitialLoading: boolean;
  searchClauses: SearchClause[];
  mobileColumns: LibraryColumnSetting;
  desktopColumns: LibraryColumnSetting;
  selectionMode: boolean;
  bulkCodes: Set<string>;
  isSyncingCode: string | null;
  actions: ReturnType<typeof useRemoteSourceActions>;
  onToggleBulkCode: (code: string, checked: boolean) => void;
  onClearSearch: () => void;
  onOpenPreview: (work: RemoteWork) => void;
  onTagOpen: (tag: string) => void;
  onWorkStateChanged: (
    primaryCode: string,
    patch: Partial<Pick<RemoteWork, "workId" | "favorite" | "listeningStatus">>,
  ) => void;
  onSynced: (workID: number, options?: { openTracked?: boolean }) => Promise<void>;
  onRetry: () => void;
  t: TFunction;
}) {
  if (isInitialLoading) {
    return <RemoteWorkGridSkeleton mobileColumns={mobileColumns} desktopColumns={desktopColumns} />;
  }
  if (remoteError) return <RemoteSourceErrorCard error={remoteError} onRetry={onRetry} />;
  if (visibleWorks.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5 text-sm text-muted-foreground">
          <span>{searchClauses.length > 0 ? t("library.noRemoteSearchMatch") : t("library.noRemoteWorks")}</span>
          {searchClauses.length > 0 && (
            <Button variant="outline" size="sm" onClick={onClearSearch}>
              {t("library.clearSearch")}
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      <section className={workCollectionClassName()} style={workCollectionStyle(mobileColumns, desktopColumns)}>
        {visibleWorks.map((work) => (
          <div key={work.remoteId} className="h-full">
            <RemoteWorkCard
              work={work}
              source={source}
              selected={bulkCodes.has(work.primaryCode)}
              selectable={Boolean(work.primaryCode)}
              selectionActive={selectionMode}
              isBusy={isSyncingCode === work.primaryCode || actions.fetchWorkspace.isBusy}
              onSelectedChange={(checked) => onToggleBulkCode(work.primaryCode, checked)}
              onOpen={() => onOpenPreview(work)}
              onFetch={() => void actions.trackWork(work, "manual_track")}
              onTagOpen={onTagOpen}
              onMark={(status) => void actions.markRemoteWork(work, status)}
              onSave={() =>
                void actions.fetchWorkspace.open({
                  sourceId: source.id,
                  remoteCode: remoteWorkActionCode(work),
                  canonicalCode: work.primaryCode,
                  sourceDisplayName: source.displayName,
                })
              }
              onEnsureWork={() => actions.ensureRemoteWorkForList(work)}
              onListSaved={(workId, favorite) => {
                onWorkStateChanged(work.primaryCode, { workId, favorite });
                void onSynced(0);
              }}
            />
          </div>
        ))}
      </section>
    </div>
  );
}

function RemoteSourcePanel({
  source,
  result,
  loading,
  viewState,
  selectionMode,
  onSelectionModeChange,
  searchClauses,
  mobileColumns,
  desktopColumns,
  onClearSearch,
  onPageChange,
  onOpenPreview,
  onTagOpen,
  onWorkStateChanged,
  onSynced,
  onRetry,
}: {
  source: LibrarySource;
  result: RemoteWorksResponse | null;
  loading: boolean;
  viewState: RemoteSourceViewState;
  selectionMode: boolean;
  onSelectionModeChange: (active: boolean) => void;
  searchClauses: SearchClause[];
  mobileColumns: LibraryColumnSetting;
  desktopColumns: LibraryColumnSetting;
  onClearSearch: () => void;
  onPageChange: (page: number) => void;
  onOpenPreview: (work: RemoteWork) => void;
  onTagOpen: (tag: string) => void;
  onWorkStateChanged: (
    primaryCode: string,
    patch: Partial<Pick<RemoteWork, "workId" | "favorite" | "listeningStatus">>,
  ) => void;
  onSynced: (workID: number, options?: { openTracked?: boolean }) => Promise<void>;
  onRetry: () => void;
}) {
  const toast = useToast();
  const { t } = useTranslation();
  const isInitialLoading = loading && result === null;
  const { page } = viewState;
  const browse = remoteSourceBrowseModel({ result, viewState, onPageChange });
  const selection = useRemoteSourceSelection({
    selectableWorks: browse.selectableWorks,
    visibleWorks: browse.visibleWorks,
    selectionMode,
    loading,
    page,
    totalPages: browse.totalPages,
    onPageChange,
  });
  const model = remoteSourcePanelModel({ browse, bulkCodes: selection.bulkCodes });
  const actions = useRemoteSourceActions({
    source,
    selectedSyncable: model.selectedSyncable,
    selectedSaveable: model.selectedSaveable,
    toast,
    t,
    onWorkStateChanged,
    onSynced,
  });
  const { isSyncingCode, isBulkBusy, saveConfirm, clearSaveConfirm, bulkSyncSelected, bulkSaveSelected } = actions;
  const remotePaginationProps = model.remotePaginationProps;
  const remoteTopPagination = (
    <WorkCollectionPagination {...remotePaginationProps} placement="top" compactMobile compactTop />
  );

  return (
    <section className="space-y-3 pb-4 lg:pb-8">
      {!model.remoteError && remoteTopPagination}
      {selectionMode && (
        <RemoteSourceSelectionBar
          t={t}
          selectedCount={model.selectedWorks.length}
          selectedSyncableCount={model.selectedSyncable.length}
          selectedSaveableCount={model.selectedSaveable.length}
          isBulkBusy={isBulkBusy}
          onSelectAll={() => selection.toggleAllVisible(true)}
          onCancel={() => {
            selection.clearSelection();
            onSelectionModeChange(false);
          }}
          onTrack={() => void bulkSyncSelected()}
          onFetch={() => void bulkSaveSelected()}
        />
      )}
      <RemoteSourceResults
        source={source}
        visibleWorks={model.visibleWorks}
        remoteError={model.remoteError}
        isInitialLoading={isInitialLoading}
        searchClauses={searchClauses}
        mobileColumns={mobileColumns}
        desktopColumns={desktopColumns}
        selectionMode={selectionMode}
        bulkCodes={selection.bulkCodes}
        isSyncingCode={isSyncingCode}
        actions={actions}
        onToggleBulkCode={selection.toggleBulkCode}
        onClearSearch={onClearSearch}
        onOpenPreview={onOpenPreview}
        onTagOpen={onTagOpen}
        onWorkStateChanged={onWorkStateChanged}
        onSynced={onSynced}
        onRetry={onRetry}
        t={t}
      />
      {!model.remoteError && <WorkCollectionPagination {...remotePaginationProps} placement="bottom" />}
      {saveConfirm && (
        <SaveConfirmDialog
          count={saveConfirm.codes.length}
          onClose={clearSaveConfirm}
          onConfirm={() => void saveConfirm.run()}
        />
      )}
      <LazyRemoteFetchWorkspaceDialog workspace={actions.fetchWorkspace} />
    </section>
  );
}

function RemoteSourceErrorCard({
  error,
  onRetry,
}: {
  error: { code: string; message: string; url?: string; retryable: boolean };
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const disabled = error.code === "disabled";
  const url = safeExternalHTTPURL(error.url);
  return (
    <Card className="border-error-border bg-error-surface">
      <CardContent className="flex flex-col gap-4 p-5 text-sm text-error-foreground sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <CloudOff className="mt-0.5 h-5 w-5 shrink-0" />
          <div className="min-w-0 space-y-1">
            <div className="font-semibold">
              {disabled ? t("library.remoteSourceDisabledTitle") : t("library.remoteSourceUnavailableTitle")}
            </div>
            <p className="text-sm/6">
              {disabled
                ? t("library.remoteSourceDisabledDescription")
                : t("library.remoteSourceUnavailableDescription")}
            </p>
            {error.message && <p className="text-xs/5 opacity-80">{error.message}</p>}
            {url && (
              <a
                className="inline-flex max-w-full items-start gap-1 break-all text-xs underline underline-offset-2 hover:no-underline"
                href={url}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{url}</span>
              </a>
            )}
          </div>
        </div>
        {error.retryable && (
          <Button variant="outline" size="sm" className="shrink-0" onClick={onRetry}>
            <RefreshCw className="h-4 w-4" />
            {t("library.retryRemoteSource")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function recentWorkSourceIntent(work: Work): DetailSourceIntent {
  const hasLocal = (work.sourcePresence ?? []).some(
    (item) => item.type === "local" && item.availability === "available",
  );
  const hasTracked = (work.sourcePresence ?? []).some(
    (item) => item.type === "tracked" && item.availability === "available",
  );
  return hasLocal || !hasTracked ? "local" : "tracked";
}

const WorkCard = memo(function WorkCard({
  work,
  showRecommendationScore,
  onRecommendationOpen,
  onOpen,
  onStatusChange,
  onFavoriteSaved,
  onTagOpen,
  onUserTagOpen,
  onUntrack,
  isUntracking = false,
  onFetch,
  isFetchBusy,
}: {
  work: Work;
  showRecommendationScore: boolean;
  onRecommendationOpen: (work: Work) => void;
  onOpen: (work: Work) => void;
  onStatusChange: (workID: number, status: ListeningStatus) => Promise<void>;
  onFavoriteSaved: (work: Work, favorite: boolean) => void;
  onTagOpen: (tag: string) => void;
  onUserTagOpen: (tag: string) => void;
  onUntrack?: (work: Work, source: SourcePresenceItem) => Promise<void>;
  isUntracking?: boolean;
  onFetch?: (work: Work, source: SourcePresenceItem) => void;
  isFetchBusy?: boolean;
}) {
  const { t } = useTranslation();
  const view = libraryWorkCardView(work, onUserTagOpen, showRecommendationScore, useAuth().recommendationThreshold);
  const trackedSources = trackedSourcesForWork(work);
  const trackedSource = trackedSources[0] ?? null;
  const untrackAnchorRef = useRef<HTMLDivElement | null>(null);
  const [untrackOpen, setUntrackOpen] = useState(false);

  return (
    <WorkCardShell
      work={view}
      onOpen={() => onOpen(work)}
      onRecommendationOpen={() => onRecommendationOpen(work)}
      onCircleOpen={(externalId) => openCircleRoute(externalId)}
      onSeriesOpen={
        work.seriesTitleId && work.circleExternalId
          ? () => openCircleSeriesRoute(work.circleExternalId, work.seriesTitleId)
          : undefined
      }
      onTagOpen={onTagOpen}
      footer={
        <WorkCardFooter
          left={<WorkCardDLsiteAction href={work.dlsiteUrl} />}
          right={
            <>
              {onUntrack && trackedSources.length > 0 && (
                <div className="relative" ref={untrackAnchorRef}>
                  <WorkCardActionButton
                    title={i18n.t("detailActions.untrack")}
                    disabled={isUntracking}
                    onClick={(event) => {
                      event.stopPropagation();
                      setUntrackOpen((current) => !current);
                    }}
                  >
                    <Unlink className="h-4 w-4" />
                  </WorkCardActionButton>
                  <AnchoredPopover
                    open={untrackOpen && !isUntracking}
                    anchorRef={untrackAnchorRef}
                    onOpenChange={setUntrackOpen}
                    className="w-[min(18rem,calc(100vw-1.5rem))] p-2 text-sm"
                    bottomCollisionPadding={96}
                    zIndex={70}
                  >
                    <div className="space-y-2">
                      <div className="font-medium">{i18n.t("libraryDetail.untrackSource")}</div>
                      <p className="text-xs text-muted-foreground">{t("libraryDetail.untrackDescription")}</p>
                      <div className="space-y-1">
                        {trackedSources.map((source) => {
                          const sourceName =
                            source.fileSourceName || source.fileSourceCode || t("libraryDetail.sourceInfo");
                          return (
                            <button
                              key={`${source.workId ?? work.id}:${source.fileSourceId ?? 0}`}
                              className="flex min-h-10 w-full items-center gap-2 rounded-md border border-destructive/30 px-2 text-left text-destructive hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
                              disabled={isUntracking}
                              onClick={(event) => {
                                event.stopPropagation();
                                void onUntrack(work, source).finally(() => setUntrackOpen(false));
                              }}
                            >
                              <Unlink className="h-4 w-4 shrink-0" />
                              <span className="min-w-0 flex-1 truncate">
                                {t("libraryDetail.untrackNamedSource", { source: sourceName })}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </AnchoredPopover>
                </div>
              )}
              {onUntrack && (
                <WorkCardActionButton
                  title={i18n.t("detailActions.fetch")}
                  disabled={!trackedSource || isFetchBusy}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (trackedSource) onFetch?.(work, trackedSource);
                  }}
                >
                  <HardDriveDownload className="h-4 w-4" />
                </WorkCardActionButton>
              )}
              <WorkCardListButton
                workId={work.id}
                active={work.favorite}
                onSaved={(favorite) => onFavoriteSaved(work, favorite)}
              />
              <WorkCardQuickMarkButton
                value={work.listeningStatus}
                onChange={(status) => void onStatusChange(work.id, status)}
              />
            </>
          }
        />
      }
    />
  );
});

function RemoteWorkCard({
  work,
  source,
  selected,
  selectable,
  selectionActive,
  isBusy,
  onSelectedChange,
  onOpen,
  onFetch,
  onTagOpen,
  onMark,
  onSave,
  onEnsureWork,
  onListSaved,
}: {
  work: RemoteWork;
  source: LibrarySource;
  selected: boolean;
  selectable: boolean;
  selectionActive: boolean;
  isBusy: boolean;
  onSelectedChange: (checked: boolean) => void;
  onOpen: () => void;
  onFetch: () => void;
  onTagOpen: (tag: string) => void;
  onMark: (status: ListeningStatus) => void;
  onSave: () => void;
  onEnsureWork: () => Promise<number | null>;
  onListSaved: (workId: number, favorite: boolean) => void;
}) {
  const view = remoteWorkCardView(work, source, useAuth().recommendationThreshold);

  return (
    <WorkCardShell
      work={view}
      selection={
        selectionActive ? (
          <WorkCardSelection checked={selected} disabled={!selectable} onChange={onSelectedChange} />
        ) : undefined
      }
      onOpen={onOpen}
      onTagOpen={onTagOpen}
      canOpen={Boolean(work.primaryCode)}
      footer={
        <WorkCardFooter
          left={<WorkCardDLsiteAction href={dlsiteWorkURL(work.primaryCode)} />}
          right={
            <>
              <WorkCardActionButton
                title={i18n.t("detailActions.track")}
                disabled={isBusy || !work.primaryCode}
                onClick={(event) => {
                  event.stopPropagation();
                  onFetch();
                }}
              >
                <GitBranchPlus className="h-4 w-4" />
              </WorkCardActionButton>
              <WorkCardActionButton
                title={i18n.t("detailActions.fetch")}
                disabled={isBusy || !work.primaryCode}
                onClick={(event) => {
                  event.stopPropagation();
                  onSave();
                }}
              >
                <HardDriveDownload className="h-4 w-4" />
              </WorkCardActionButton>
              <WorkCardListButton
                workId={work.workId}
                active={work.favorite}
                disabled={isBusy || !work.primaryCode}
                ensureWorkId={onEnsureWork}
                onSaved={(favorite, workId) => onListSaved(workId, favorite)}
              />
              <WorkCardQuickMarkButton
                value={work.listeningStatus}
                disabled={isBusy || !work.primaryCode}
                onChange={onMark}
              />
            </>
          }
        />
      }
    />
  );
}

function RemoteWorkGridSkeleton({
  mobileColumns,
  desktopColumns,
}: {
  mobileColumns: LibraryColumnSetting;
  desktopColumns: LibraryColumnSetting;
}) {
  return (
    <section className={workCollectionClassName()} style={workCollectionStyle(mobileColumns, desktopColumns)}>
      {Array.from({ length: 12 }, (_, index) => (
        <div key={index} className="overflow-hidden rounded-lg border bg-card">
          <div className="aspect-[4/5] animate-pulse bg-muted" />
          <div className="space-y-2 p-3">
            <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
            <div className="flex gap-2 pt-2">
              <div className="h-6 w-16 animate-pulse rounded bg-muted" />
              <div className="h-6 w-20 animate-pulse rounded bg-muted" />
            </div>
          </div>
        </div>
      ))}
    </section>
  );
}

function createRecommendationContextID() {
  const random = window.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `library:${Date.now().toString(36)}:${random}`.slice(0, 64);
}

function libraryWorkCardView(
  work: Work,
  onUserTagOpen?: (tag: string) => void,
  showRecommendationScore = false,
  threshold = 50,
): WorkCardViewModel {
  return {
    code: work.primaryCode,
    title: work.title,
    circle: work.circle || i18n.t("workCard.unknownCircle"),
    circleExternalId: work.circleExternalId,
    ageRating: work.ageRating,
    voiceActors: work.voiceActors,
    voiceCredits: work.voiceCredits,
    coverUrl: work.coverUrl,
    rating: work.rating,
    ratingCount: work.ratingCount,
    sales: work.sales,
    regularPrice: work.regularPrice,
    price: work.price,
    priceCurrency: work.priceCurrency,
    series: work.series || null,
    hasAvailableNonOriginEdition: work.hasAvailableNonOriginEdition,
    hasPlaybackHistory: hasPlaybackHistory(work.progress),
    dlsiteTags: dlsiteTagBadges(work.tags),
    userTags: userTagBadges(work.userTags ?? [], onUserTagOpen),
    sourceBadges: sourcePresenceBadges(work.sourcePresence, work.availability),
    recommended: showRecommendationScore || recommendationBadgeVisible(work.recommendScore, threshold),
    recommendationScore: work.recommendScore,
  };
}

function trackedSourcesForWork(work: Work) {
  return (work.sourcePresence ?? []).filter(
    (item) => item.type === "tracked" && item.availability === "available" && item.fileSourceId,
  );
}

function remoteWorkCardView(work: RemoteWork, source: LibrarySource, threshold: number): WorkCardViewModel {
  const sourceLabel = source.displayName || source.code || i18n.t("workCard.remoteSource");
  return {
    code: work.primaryCode || work.remoteId,
    title: work.title,
    circle: work.circle || sourceLabel || i18n.t("workCard.unknownCircle"),
    ageRating: work.ageRating,
    voiceActors: work.voiceActors,
    coverUrl: work.coverUrl,
    rating: work.rating,
    ratingCount: work.ratingCount,
    sales: work.sales,
    price: work.price,
    priceCurrency: "JPY",
    series: null,
    hasAvailableNonOriginEdition: work.hasAvailableNonOriginEdition,
    dlsiteTags: dlsiteTagBadges(work.tags),
    userTags: [],
    recommended: recommendationBadgeVisible(work.recommendScore, threshold),
    recommendationScore: work.recommendScore,
    sourceBadges: work.remotePlayable
      ? [{ key: `source:remote:${source.id}`, label: sourceLabel, variant: "outline" }]
      : [
          {
            key: `source:remote:${source.id}:unavailable`,
            label: i18n.t("workCard.namedSourceUnavailable", { name: sourceLabel }),
            variant: "warning",
          },
        ],
  };
}

function SortPicker({
  activeTab,
  value,
  direction,
  onChange,
  onDirectionChange,
  onReshuffle,
}: {
  activeTab: LibraryTab;
  value: LibrarySort;
  direction: SortDirection;
  onChange: (value: LibrarySort) => void;
  onDirectionChange: (value: SortDirection) => void;
  onReshuffle: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const options =
    activeTab.kind === "source"
      ? librarySortOptions.filter((option) =>
          ["recent", "release", "code", "rating", "sales", "random"].includes(option.value),
        )
      : librarySortOptions;
  const label = options.find((option) => option.value === value)?.label ?? t("library.sort");
  const localizedLabel = t(`library.sortOptions.${value}`, { defaultValue: label });
  useDismissiblePopover(open, popoverRef, () => setOpen(false));
  const nextDirection = direction === "asc" ? "desc" : "asc";
  return (
    <div className="relative" ref={popoverRef}>
      <div className="inline-flex rounded-md border bg-background">
        <button
          className="relative inline-flex h-8 w-8 items-center justify-center rounded-l-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          title={t("library.sortLabel", { label: localizedLabel })}
          aria-label={t("library.sortLabel", { label: localizedLabel })}
          onClick={() => setOpen((current) => !current)}
        >
          <ArrowUpDown className="h-4 w-4" />
        </button>
        <button
          className="relative inline-flex h-8 w-8 items-center justify-center rounded-r-md border-l text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          title={
            value === "random"
              ? t("library.reshuffle")
              : direction === "asc"
                ? t("library.ascending")
                : t("library.descending")
          }
          aria-label={
            value === "random"
              ? t("library.reshuffle")
              : direction === "asc"
                ? t("library.ascending")
                : t("library.descending")
          }
          onClick={() => (value === "random" ? onReshuffle() : onDirectionChange(nextDirection))}
        >
          {value === "random" ? (
            <RefreshCw className="h-4 w-4" />
          ) : direction === "asc" ? (
            <ArrowDownAZ className="h-4 w-4" />
          ) : (
            <ArrowDownZA className="h-4 w-4" />
          )}
        </button>
      </div>
      <AnchoredPopover
        open={open}
        anchorRef={popoverRef}
        onOpenChange={setOpen}
        className="w-[min(11rem,calc(100vw-1.5rem))] p-1 text-sm"
      >
        {options.map((option) => (
          <button
            key={option.value}
            className={`flex min-h-10 w-full items-center rounded-md px-3 py-2 text-left hover:bg-muted ${value === option.value ? "bg-primary/10 font-medium text-primary ring-1 ring-inset ring-primary/15" : "text-muted-foreground"}`}
            aria-pressed={value === option.value}
            onClick={() => {
              onChange(option.value);
              setOpen(false);
            }}
          >
            {t(`library.sortOptions.${option.value}`, { defaultValue: option.label })}
          </button>
        ))}
      </AnchoredPopover>
    </div>
  );
}

function FilterPicker({
  value,
  activeCount,
  disabled = false,
  onChange,
}: {
  value: ListeningStatus | "all";
  activeCount: number;
  disabled?: boolean;
  onChange: (value: ListeningStatus | "all") => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  useDismissiblePopover(open, popoverRef, () => setOpen(false));
  return (
    <div className="relative" ref={popoverRef}>
      <IconButton
        title={
          disabled
            ? t("library.markFiltersUnavailable")
            : activeCount > 0
              ? t("library.activeFilters", { count: activeCount })
              : t("library.filters")
        }
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <Filter className="h-4 w-4" />
        {activeCount > 0 && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-primary" />}
      </IconButton>
      <AnchoredPopover
        open={open && !disabled}
        anchorRef={popoverRef}
        className="flex w-10 flex-col gap-1 rounded-lg border bg-card p-1 text-sm shadow-lg"
      >
        <button
          className={`flex h-8 items-center justify-center rounded-md hover:bg-muted ${value === "all" ? "bg-primary/10 text-primary ring-1 ring-inset ring-primary/15" : "text-muted-foreground"}`}
          aria-pressed={value === "all"}
          title={t("library.allMarks")}
          aria-label={t("library.allMarks")}
          onClick={() => {
            onChange("all");
            setOpen(false);
          }}
        >
          <X className="h-4 w-4" />
        </button>
        {listeningStatusOptions.map((option) => {
          const meta = quickMarkFilterMeta(option.value);
          return (
            <button
              key={option.value}
              className={`flex h-8 items-center justify-center rounded-md hover:bg-muted ${value === option.value ? "bg-primary/10 text-primary ring-1 ring-inset ring-primary/15" : "text-muted-foreground"}`}
              aria-pressed={value === option.value}
              title={t(`library.status.${option.value}`, { defaultValue: option.label })}
              aria-label={t(`library.status.${option.value}`, { defaultValue: option.label })}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <meta.icon className={`h-4 w-4 ${value === option.value ? "" : meta.className}`} />
            </button>
          );
        })}
      </AnchoredPopover>
    </div>
  );
}

function quickMarkFilterMeta(value: ListeningStatus) {
  switch (value) {
    case "want_to_listen":
      return { icon: BookmarkPlus, className: "text-primary" };
    case "listening":
      return { icon: Headphones, className: "text-primary" };
    case "finished":
      return { icon: CheckCircle2, className: "text-success" };
    case "relisten":
      return { icon: Repeat2, className: "text-primary" };
    case "paused":
      return { icon: PauseCircle, className: "text-warning" };
    default:
      return { icon: Circle, className: "" };
  }
}

function statusFilterLabel(value: ListeningStatus | "all", t: TFunction) {
  if (value === "all") return t("library.allMarks");
  const fallback = listeningStatusOptions.find((option) => option.value === value)?.label ?? value;
  return t(`library.status.${value}`, { defaultValue: fallback });
}

function EmptyLibraryWorksCard({
  scope,
  filtered,
  onClear,
}: {
  scope: LocalLibraryScope;
  filtered: boolean;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5 text-sm text-muted-foreground">
        <span>{scope === "tracked" ? t("library.noTrackedWorks") : t("library.noLocalWorks")}</span>
        {filtered && (
          <Button variant="outline" size="sm" onClick={onClear}>
            {t("library.clearSearchAndFilters")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function SearchClauseEditor({
  editor,
  onChange,
  onCancel,
  onSave,
}: {
  editor: { mode: "add" | "edit"; index: number | null; draft: SearchClauseDraft };
  onChange: (draft: SearchClauseDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  const value = editor.draft.value;
  return (
    <div className="grid gap-2 rounded-lg border bg-card p-2 text-sm shadow-sm sm:flex sm:items-center">
      <div className="grid min-w-0 grid-cols-[minmax(8rem,auto)_minmax(0,1fr)] items-center gap-2 sm:contents">
        <FloatingSelect
          value={editor.draft.kind}
          onValueChange={(nextValue) => {
            const kind = nextValue as SearchClauseKind;
            onChange({
              kind,
              value: kind === "shelf" ? "true" : editor.draft.kind === "shelf" ? "" : editor.draft.value,
            });
          }}
          ariaLabel={t("library.searchClauseType")}
          className="w-full sm:w-40"
          options={editableSearchClauseKinds.map((kind) => ({
            value: kind.value,
            label: t(`library.searchClauseKinds.${kind.value}`, { defaultValue: kind.label }),
          }))}
        />
        {editor.draft.kind === "shelf" ? (
          <FloatingSelect
            value={value === "false" ? "false" : "true"}
            onValueChange={(nextValue) => onChange({ ...editor.draft, value: nextValue })}
            ariaLabel={t("library.shelfMembership")}
            className="w-full min-w-0 sm:flex-1"
            options={[
              { value: "true", label: t("library.included") },
              { value: "false", label: t("library.notIncluded") },
            ]}
          />
        ) : (
          <Input
            className="w-full min-w-0 sm:flex-1"
            value={value}
            onChange={(event) => onChange({ ...editor.draft, value: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") onSave();
              if (event.key === "Escape") onCancel();
            }}
            placeholder={t("library.value")}
          />
        )}
      </div>
      <div className="flex justify-end gap-2 sm:shrink-0">
        <Button size="sm" disabled={!value.trim()} onClick={onSave}>
          <Check className="h-4 w-4" />
          {editor.mode === "add" ? t("library.add") : t("common.save")}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel}>
          <X className="h-4 w-4" />
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}

function recommendationBadgeVisible(score: number | undefined, threshold: number) {
  if (window.localStorage.getItem("kikoto:recommend-badges") !== "true") return false;
  return Number.isFinite(score) && (score ?? 0) >= threshold;
}

function detailSourceIntentFromLocation(search: string): DetailSourceIntent {
  const params = new URLSearchParams(search);
  if (params.get("view") === "tracked") return "tracked";
  if (params.get("view") === "remote") {
    const sourceID = Number(params.get("source"));
    if (Number.isInteger(sourceID) && sourceID > 0) return remoteSourceTabKey(sourceID);
  }
  return "local";
}

function detailTrackedSourceIDFromLocation(search: string) {
  const value = Number(new URLSearchParams(search).get("trackedSource"));
  return Number.isInteger(value) && value > 0 ? value : null;
}

function detailRemoteCodeFromLocation(search: string) {
  const params = new URLSearchParams(search);
  return params.get("view") === "remote" ? (params.get("remoteCode") ?? "").trim() : "";
}

async function resolveAndOpenWork(
  code: string,
  principalID: ClientPrincipalID,
  setSelectedWork: (work: WorkDetail | null) => void,
  setSelectedWorkPreview: (work: WorkPreview | null) => void,
  setSelectedCode: (code: string | null) => void,
  setMediaLoading: (loading: boolean) => void,
  setNotFound: (notFound: boolean) => void,
  setMediaError: (message: string) => void,
  signal?: AbortSignal,
) {
  try {
    setMediaLoading(true);
    setNotFound(false);
    setMediaError("");
    const resolved = await api.resolveWorkCode(code, signal);
    setSelectedWorkPreview(workPreviewFromResolve(resolved));
    const work = await api.getWorkSummary(resolved.workId, signal);
    const cachedMedia = getCachedWorkMedia(resolved.workId, principalID);
    if (cachedMedia) {
      setSelectedWork({ ...work, mediaItems: cachedMedia });
    } else {
      setSelectedWork(work);
      try {
        const media = await api.getWorkMedia(resolved.workId, signal);
        setCachedWorkMedia(resolved.workId, principalID, media.mediaItems);
        setSelectedWork({ ...work, mediaItems: media.mediaItems });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setMediaError(directoryLoadErrorMessage(error));
      }
    }
    if (
      resolved.resolvedCode &&
      resolved.resolvedCode.toUpperCase() !== code.toUpperCase() &&
      workDetailCodeFromLocation(window.location.pathname, window.location.search)?.toUpperCase() === code.toUpperCase()
    ) {
      window.history.replaceState(window.history.state ?? {}, "", `/${resolved.resolvedCode}${window.location.search}`);
      setSelectedCode(resolved.resolvedCode);
      window.dispatchEvent(new Event("kikoto:navigation"));
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    setSelectedWork(null);
    setNotFound(error instanceof ApiError && error.status === 404);
  } finally {
    if (!signal?.aborted) setMediaLoading(false);
  }
}

function knownLibraryRoute(path: string, search: string, sources: LibrarySource[]) {
  const normalizedPath = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (
    [
      "/",
      "/library",
      "/tracked",
      "/library/tracked",
      "/no-source",
      "/library/no-source",
      "/library/all",
      "/library/remote",
    ].includes(normalizedPath)
  )
    return true;
  if (WORK_CODE_PATH_PATTERN.test(normalizedPath)) return true;

  const sourceID = Number(new URLSearchParams(search).get("source"));
  if (Number.isInteger(sourceID) && sourceID > 0) {
    return REMOTE_SOURCE_WORK_PATTERN.test(normalizedPath) && sources.some((source) => source.id === sourceID);
  }

  const encodedKey = normalizedPath.startsWith("/library/source/")
    ? normalizedPath.slice("/library/source/".length)
    : (normalizedPath.match(/^\/[^/]+$/)?.[0].slice(1) ?? "");
  if (!encodedKey) return false;
  const key = safeDecodePathSegment(encodedKey).toLowerCase();
  return sources.some(
    (source) => sourceRouteKey(source).toLowerCase() === key || source.displayName.toLowerCase() === key,
  );
}

function historyPreviewValue() {
  return (window.history.state as { workPreview?: unknown } | null)?.workPreview;
}

function historyPreviewObject<T extends object>(code: string | null, field: keyof T) {
  const value = historyPreviewValue();
  if (!code || !value || typeof value !== "object") return null;
  const preview = value as Partial<T>;
  const candidate = preview[field];
  if (typeof candidate !== "string" || candidate.toUpperCase() !== code.toUpperCase()) return null;
  return preview;
}

function historyPreviewID(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function historyPreviewString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function historyPreviewNumber(value: unknown) {
  return typeof value === "number" ? value : null;
}

function historyPreviewNullableString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function historyPreviewStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function workPreviewFieldsFromHistory(preview: Partial<WorkPreview>): WorkPreview {
  const primaryCode = historyPreviewString(preview.primaryCode);
  return {
    primaryCode,
    title: historyPreviewString(preview.title, primaryCode),
    coverUrl: historyPreviewString(preview.coverUrl),
    circle: historyPreviewString(preview.circle),
    circleExternalId: historyPreviewString(preview.circleExternalId),
    rating: historyPreviewNumber(preview.rating),
    sales: historyPreviewNumber(preview.sales),
    releaseDate: historyPreviewNullableString(preview.releaseDate),
    tags: historyPreviewStringArray(preview.tags),
    voiceActors: historyPreviewStringArray(preview.voiceActors),
  };
}

function workPreviewFromHistory(code: string | null): WorkPreview | null {
  const preview = historyPreviewObject<WorkPreview>(code, "primaryCode");
  if (!preview) return null;
  return { id: historyPreviewID(preview.id), ...workPreviewFieldsFromHistory(preview) };
}

function workPreviewFromResolve(resolved: Awaited<ReturnType<typeof api.resolveWorkCode>>): WorkPreview {
  return {
    id: resolved.workId,
    primaryCode: resolved.resolvedCode,
    title: resolved.title || resolved.resolvedCode,
    coverUrl: resolved.coverUrl,
    circle: resolved.circle,
    circleExternalId: resolved.circleExternalId,
    rating: resolved.rating,
    sales: resolved.sales,
    releaseDate: resolved.releaseDate,
    tags: resolved.tags,
    voiceActors: resolved.voiceActors,
  };
}

function remoteWorkPreview(work: RemoteWork): WorkPreview {
  return {
    id: work.workId ?? undefined,
    primaryCode: work.primaryCode,
    title: work.title || work.primaryCode,
    coverUrl: work.coverUrl,
    circle: work.circle,
    circleExternalId: work.circleRef?.externalId ?? "",
    rating: work.rating,
    sales: work.sales,
    releaseDate: work.releaseDate || null,
    tags: work.tags,
    voiceActors: work.voiceActors,
  };
}

function remoteOnlyWorkPreview(work: RemoteWork): RemoteWorkPreview {
  return {
    ...remoteWorkPreview(work),
    remoteId: work.remoteId,
    remoteCode: work.remoteCode,
    ageRating: work.ageRating,
  };
}

function remoteWorkPreviewFromHistory(code: string | null): RemoteWorkPreview | null {
  const preview = historyPreviewValue();
  if (!code || !preview || typeof preview !== "object") return null;
  const value = preview as Partial<RemoteWorkPreview>;
  const routeCode = remoteHistoryRouteCode(value);
  if (!routeCode || routeCode.toUpperCase() !== code.toUpperCase()) return null;
  if (typeof value.primaryCode !== "string" || typeof value.remoteCode !== "string") return null;
  return {
    ...workPreviewFieldsFromHistory(value),
    id: historyPreviewID(value.id),
    remoteId: historyPreviewString(value.remoteId) || undefined,
    remoteCode: value.remoteCode,
    ageRating: historyPreviewString(value.ageRating),
  };
}

function remoteHistoryRouteCode(preview: Partial<RemoteWorkPreview>) {
  return (
    historyPreviewString(preview.remoteCode) ||
    historyPreviewString(preview.primaryCode) ||
    historyPreviewString(preview.remoteId)
  );
}

function LibraryLoadErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <Card className="border-destructive/35">
      <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-semibold text-destructive">{t("library.couldNotLoad")}</div>
          <div className="mt-1 text-xs text-muted-foreground">{message}</div>
        </div>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="h-4 w-4" />
          {t("common.retry")}
        </Button>
      </CardContent>
    </Card>
  );
}

function workMatchesSearch(work: Work, clauses: SearchClause[]) {
  if (clauses.length === 0) return true;
  return clauses.every((clause) => workMatchesClause(work, clause));
}

type WorkClauseMatcher = (work: Work, value: string, clause: SearchClause) => boolean;

const workClauseMatchers: Record<SearchClauseKind, WorkClauseMatcher> = {
  code: (work, value) => work.primaryCode.toLowerCase().includes(value),
  circle: (work, value) =>
    work.circle.toLowerCase().includes(value) || work.circleExternalId.toLowerCase().includes(value),
  voice_actor: (work, value) => work.voiceActors.some((actor) => actor.toLowerCase().includes(value)),
  tag: (work, value) => work.tags.some((tag) => tag.toLowerCase().includes(value)),
  exclude_tag: (work, value) => !work.tags.some((tag) => tag.toLowerCase().includes(value)),
  user_tag: (work, value) => (work.userTags ?? []).some((tag) => tag.name.toLowerCase().includes(value)),
  exclude_user_tag: (work, value) => !(work.userTags ?? []).some((tag) => tag.name.toLowerCase().includes(value)),
  rating_min: (work, value) => work.rating !== null && work.rating >= numericClauseValue(value),
  sales_min: (work, value) => work.sales !== null && work.sales >= numericClauseValue(value),
  duration_min: () => true,
  duration_max: () => true,
  age: (work, value) => workMatchesText([work.primaryCode, work.title, ...work.tags], value),
  language: (work, value) => workMatchesText([work.title, ...work.tags], value),
  shelf: (work, _value, clause) => workMatchesShelf(work, clause.value),
  text: (work, value) =>
    workMatchesText(
      [
        work.primaryCode,
        work.title,
        work.circle,
        work.circleExternalId,
        work.releaseDate ?? "",
        ...work.tags,
        ...(work.userTags ?? []).map((tag) => tag.name),
        ...work.voiceActors,
      ],
      value,
    ),
};

function workMatchesClause(work: Work, clause: SearchClause) {
  const value = clause.value.trim().toLowerCase();
  if (!value) return true;
  return workClauseMatchers[clause.kind](work, value, clause);
}

function workMatchesShelf(work: Work, value: string) {
  return value === "false"
    ? !work.favorite && work.listeningStatus === "none" && !work.progress.mediaItemId
    : work.favorite || work.listeningStatus !== "none" || Boolean(work.progress.mediaItemId);
}

function workMatchesText(values: string[], needle: string) {
  return values.some((item) => item.toLowerCase().includes(needle));
}

function numericClauseValue(value: string) {
  const number = Number(value.replace(/[^\d.]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function searchClauseLabel(clause: SearchClause, t?: TFunction) {
  const translate = (key: string, fallback: string) =>
    t?.(key, { value: clause.value, defaultValue: fallback }) ?? fallback;
  switch (clause.kind) {
    case "code":
      return translate("library.searchClauseLabels.code", `Code: ${clause.value}`);
    case "circle":
      return translate("library.searchClauseLabels.circle", `Circle: ${clause.value}`);
    case "voice_actor":
      return translate("library.searchClauseLabels.voiceActor", `VA: ${clause.value}`);
    case "tag":
      return translate("library.searchClauseLabels.tag", `Tag: ${clause.value}`);
    case "exclude_tag":
      return translate("library.searchClauseLabels.excludeTag", `Exclude tag: ${clause.value}`);
    case "user_tag":
      return translate("library.searchClauseLabels.userTag", `My tag: ${clause.value}`);
    case "exclude_user_tag":
      return translate("library.searchClauseLabels.excludeUserTag", `Exclude my tag: ${clause.value}`);
    case "rating_min":
      return translate("library.searchClauseLabels.ratingMin", `Rating >= ${clause.value}`);
    case "sales_min":
      return translate("library.searchClauseLabels.salesMin", `Sales >= ${clause.value}`);
    case "duration_min":
      return translate("library.searchClauseLabels.durationMin", `Duration >= ${clause.value}`);
    case "duration_max":
      return translate("library.searchClauseLabels.durationMax", `Duration <= ${clause.value}`);
    case "age":
      return translate("library.searchClauseLabels.age", `Age: ${clause.value}`);
    case "language":
      return translate("library.searchClauseLabels.language", `Language: ${clause.value}`);
    case "shelf":
      return t
        ? t(
            clause.value === "false"
              ? "library.searchClauseLabels.shelfExcluded"
              : "library.searchClauseLabels.shelfIncluded",
          )
        : clause.value === "false"
          ? "Shelf: Not included"
          : "Shelf: Included";
    case "text":
    default:
      return translate("library.searchClauseLabels.text", `Text: ${clause.value}`);
  }
}

function remoteTargetFromLocation(path: string, search: string, sources: LibrarySource[]) {
  const code = workDetailCodeFromLocation(path, search);
  if (!code) return null;
  const params = new URLSearchParams(search);
  if (params.get("view") === "remote") return null;
  const sourceID = Number(params.get("source"));
  if (!Number.isFinite(sourceID) || sourceID <= 0) return null;
  const source = sources.find((candidate) => candidate.id === sourceID);
  const preview = remoteWorkPreviewFromHistory(code);
  return source ? { source, code, ...(preview ? { preview } : {}) } : null;
}

function tabFromPath(path: string, sources: LibrarySource[], fallback: LibraryTab = { kind: "all" }): LibraryTab {
  if (path === "/tracked" || path === "/library/tracked") {
    return { kind: "all" };
  }
  if (path === "/no-source" || path === "/library/no-source") {
    return { kind: "all" };
  }
  if (path === "/" || path === "/library") {
    return { kind: "all" };
  }
  if (path === "/library/all" || path === "/library/remote") {
    return { kind: "all" };
  }
  const encodedKey = path.startsWith("/library/source/")
    ? path.slice("/library/source/".length).replace(/\/$/, "")
    : path.replace(/^\//, "").replace(/\/$/, "");
  if (encodedKey === "") {
    return fallback;
  }
  if (WORK_CODE_PATH_PATTERN.test(`/${encodedKey}`)) {
    return fallback;
  }
  const key = safeDecodePathSegment(encodedKey).toLowerCase();
  const source = sources.find(
    (item) => sourceRouteKey(item).toLowerCase() === key || item.displayName.toLowerCase() === key,
  );
  return source ? { kind: "source", source } : fallback;
}

function resolveTabFromPath(path: string, sources: LibrarySource[], fallback: LibraryTab): LibraryTab {
  return tabFromPath(path, sources, fallback);
}

function pathForLibraryTab(tab: LibraryTab) {
  switch (tab.kind) {
    case "source":
      return `/${encodeURIComponent(sourceRouteKey(tab.source))}`;
    default:
      return "/";
  }
}

function pathForLocalScope(scope: LocalLibraryScope) {
  switch (scope) {
    case "tracked":
      return "/tracked";
    case "local":
      return "/";
    default:
      return null;
  }
}

function pathForActiveLibrary(tab: LibraryTab, scope: LocalLibraryScope) {
  return tab.kind === "source" ? pathForLibraryTab(tab) : (pathForLocalScope(scope) ?? "/");
}

function libraryBrowseKey(tab: LibraryTab, scope: LocalLibraryScope, storageScope: string) {
  return tab.kind === "source" ? `${storageScope}:source:${tab.source.id}` : `${storageScope}:scope:${scope}`;
}

function localScopeFromPath(path: string): LocalLibraryScope {
  if (path === "/tracked" || path === "/library/tracked") return "tracked";
  return "local";
}

function sourceRouteKey(source: LibrarySource) {
  return source.code || source.displayName;
}

function remoteWorkRouteCode(work: RemoteWork) {
  return remoteWorkActionCode(work);
}

function remoteWorkActionCode(work: RemoteWork) {
  return work.remoteCode || work.primaryCode || work.remoteId;
}

function openRemoteSourceWorkRoute(
  sourceID: number,
  code: string,
  returnTo: string,
  returnLabel: string,
  workPreview?: RemoteWorkPreview,
) {
  const cleanCode = code.trim();
  if (!cleanCode) return;
  openWorkDetail(
    { kind: "remote-only", sourceId: sourceID, remoteCode: cleanCode },
    { returnTo, returnLabel, ...(workPreview ? { workPreview } : {}) },
  );
}

function openPersistedRemoteSourceWorkRoute(
  sourceID: number,
  canonicalCode: string,
  remoteCode: string,
  returnTo: string,
  returnLabel: string,
  workPreview: WorkPreview,
) {
  openWorkDetail(
    {
      kind: "known",
      canonicalCode,
      source: { sourceId: sourceID, remoteCode },
    },
    { returnTo, returnLabel, workPreview },
  );
}

function safeDecodePathSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function WorkDetailLoading() {
  const { t } = useTranslation();
  return (
    <div className="space-y-5" role="status" aria-label={t("app.loadingPage")}>
      <div className="h-9 w-24 animate-pulse rounded-md bg-muted" />
      <div className="flex flex-col gap-5 lg:flex-row">
        <div className="aspect-[4/3] w-full animate-pulse rounded-lg bg-muted lg:w-80" />
        <div className="flex-1 space-y-3">
          <div className="h-4 w-28 animate-pulse rounded bg-muted" />
          <div className="h-8 w-3/4 animate-pulse rounded bg-muted" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
        </div>
      </div>
      <div className="min-h-[22rem] animate-pulse rounded-lg bg-muted" />
    </div>
  );
}
