import {
  ArrowDownAZ,
  ArrowDownZA,
  ArrowUpDown,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Check,
  CheckCircle2,
  BookmarkPlus,
  Captions,
  Circle,
  CircleUserRound,
  Clock3,
  GitBranchPlus,
  CloudOff,
  Edit3,
  Trash2,
  FileAudio,
  FileVideo,
  FileText,
  Filter,
  Folder,
  FolderTree,
  HardDrive,
  HardDriveDownload,
  Heart,
  Headphones,
  ImageIcon,
  ExternalLink,
  Cloud,
  Languages,
  ListChecks,
  MoreHorizontal,
  Pause,
  PauseCircle,
  Play,
  Plus,
  RefreshCw,
  Repeat2,
  Search,
  ShieldAlert,
  Sparkles,
  Tags,
  Unlink,
  X,
  UserRound,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { Badge, badgeVariants } from "@/components/ui/badge";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { BrowseLoadingIndicator } from "@/components/collection/BrowseLoadingIndicator";
import { PageSizePicker } from "@/components/collection/PageSizePicker";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { FloatingSelect } from "@/components/ui/floating-select";
import { toastFromError, useToast } from "@/components/ui/toast";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import { isActiveWorkflowStatus, useWorkflowRunWatcher } from "@/hooks/useWorkflowRunWatcher";
import { UserTagRow } from "@/components/UserTagRow";
import { openCircleRoute, openCircleSeriesRoute } from "@/pages/CirclesPage";
import { openVoiceRoute } from "@/pages/CreatorWorksPage";
import { playbackURL } from "@/player/mediaPlayback";
import {
  api,
  ApiError,
  assetURL,
  mediaDownloadURL,
  type LibrarySource,
  type LibrarySort,
  type SortDirection,
  type CircleSuggestion,
  type FavoriteList,
  type DirectoryRoutingRule,
  type ListeningStatus,
  type MediaItem,
  type ManualOverridePerson,
  type ManualOverrideSeries,
  type RemoteTrack,
  type RemoteWorksResponse,
  type RemoteWork,
  type RemoteWorkDetail,
  type RecommendationBreakdown,
  type RecommendationEventInput,
  type SourceAvailabilitySource,
  type SourcePresenceItem,
  type SeriesSuggestion,
  type VoiceSuggestion,
  type VoiceCredit,
  type Work,
  type WorkCoverCandidate,
  type WorkDetail,
  type WorkMetadataPresentation,
  type WorkMetadataSyncStatus,
} from "@/lib/api";
import { ageRatingPresentation } from "@/lib/ageRating";
import { currentClientStorageScope, type ClientPrincipalID } from "@/lib/clientStorageScope";
import { NAVIGATION_EVENT, historyStateWithReturn, navigateToWorkspaceUp } from "@/lib/browserHistory";
import { dismissKeyboardOnEnter } from "@/lib/keyboard";
import { DLSITE_ENDPOINTS } from "@/lib/official-links";
import { hasPlaybackHistory } from "@/lib/playbackHistory";
import { readOrCreateRecommendationSession } from "@/lib/recommendationSession";
import { WORK_CODE_PATH_PATTERN } from "@/lib/workCode";
import {
  defaultLibraryBrowseState,
  libraryBrowseSearch,
  libraryBrowseStateFromSearch,
  libraryBrowseStateFromValue,
  libraryLocation,
  localPageSize,
  localWorkPageSizeOptions,
  normalizeLibraryBrowseLocation,
  readLastLibraryLocation,
  readLibraryBrowseState,
  readLibrarySortPreference,
  writeLastLibraryLocation,
  withSharedLibraryQuery,
  writeLibraryBrowseState,
  writeLibrarySortPreference,
  type LibraryBrowseState,
  type LibraryColumnSetting,
  type LocalWorkPageSize,
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
import {
  WorkCardActionButton,
  WorkCardDLsiteAction,
  WorkCardFooter,
  WorkCardListButton,
  WorkCardQuickMarkButton,
  WorkCardSelection,
  WorkCardShell,
  dlsiteTagBadges,
  userTagBadges,
  type WorkCardViewModel,
} from "@/components/work-card/WorkCardShell";
import { sourcePresenceBadges } from "@/components/work-card/sourceBadges";
import i18n from "@/i18n";
import {
  WorkCollectionLayoutPicker as LayoutPicker,
  workCollectionClassName,
  workCollectionStyle,
  useWorkCollectionLayout,
} from "@/components/work-collection/WorkCollectionLayout";
import { WorkCollectionPagination } from "@/components/work-collection/WorkCollectionPagination";
import { preferredLyricsMediaItemID, useLibraryPlayer, usePlayer } from "@/player/PlayerProvider";
import { lyricsChoiceDisplayLabel, type LyricsChoice } from "@/player/lyricsMatching";
import { getCachedWorkMedia, invalidateCachedWorkMedia, setCachedWorkMedia } from "@/pages/workMediaCache";
import {
  availableForkSources,
  buildSourceTabs,
  remoteAvailabilityRouteCode,
  remoteSourceCanBrowse,
  remoteSourceTabKey,
  remoteSourceTabStatus,
  sourceTabStatusClass,
  type DetailSourceIntent,
  type ReforkTarget,
  type RemoteSourceAvailability,
  type SourceTabInfo,
  type TrackedPresenceOption,
} from "@/features/work-detail/source/sourceContextModel";
import { useWorkSourceContext } from "@/features/work-detail/source/useWorkSourceContext";
import { useMediaTree } from "@/features/work-detail/media/useMediaTree";
import { useWorkPlaybackCursor } from "@/features/work-detail/media/useWorkPlaybackCursor";
import {
  groupWorkVersions,
  mergeRemoteWorkVersions,
  preferredWorkVersion,
  workVersionAvailableForScope,
  workVersionKindLabel,
  workVersionMediaState,
  type WorkVersionAvailabilityScope,
  type WorkVersionGroup,
} from "@/features/work-detail/workVersionModel";
import { orderedMetadataVariants, resolveMetadataVariant } from "@/features/work-detail/metadataPresentationModel";
import {
  buildRemoteTree,
  buildTree,
  buildWorkResumeQueue,
  countTreeFiles,
  directoryLyricsAttachments,
  emptyTree,
  flattenTracks,
  flattenTreeFiles,
  folderPlaybackTracks,
  formatBytes,
  formatDuration,
  formatTrackDuration,
  formatTreeStats,
  playableFiles,
  remoteSelectablePaths,
  sortedTreeChildren,
  sortedTreeFiles,
  toPlayerTrack,
  toRemotePreviewPlayerTrack,
  treeStats,
  type TreeNode,
  type TreeStats,
  type TreeTrack,
} from "@/features/work-detail/media/mediaTreeModel";
import {
  useMediaCleanupWorkflow,
  type MediaCleanupCompletion,
  type MediaCleanupMode,
  type MediaDeleteTarget,
} from "@/features/work-detail/workflows/useMediaCleanupWorkflow";
import { RemoteFetchWorkspaceDialog } from "@/features/work-detail/workflows/RemoteFetchWorkspaceDialog";
import { useRemoteFetchWorkspace } from "@/features/work-detail/workflows/useRemoteFetchWorkspace";
import { usePermissionGate } from "@/auth/usePermissionGate";
import { useAuth } from "@/auth/AuthProvider";
import { NotFoundPage } from "@/app/NotFoundPage";
import { openWorkDetail } from "@/app/workDetailNavigation";
import {
  announceRemoteTrackCreated,
  isMatchingRemoteTrack,
  REMOTE_TRACK_TERMINAL_EVENT,
  type RemoteTrackTerminalDetail,
} from "@/app/remoteTrackWorkflows";
import {
  MediaContextActionBar,
  WorkIdentityActionBar,
  type DetailActionMode,
} from "@/features/work-detail/WorkDetailActionBars";

type WorkPreview = Pick<
  Work,
  | "primaryCode"
  | "title"
  | "coverUrl"
  | "circle"
  | "circleExternalId"
  | "rating"
  | "sales"
  | "releaseDate"
  | "tags"
  | "voiceActors"
> & {
  id?: number;
};

type RemoteWorkPreview = WorkPreview &
  Pick<RemoteWork, "remoteCode" | "ageRating"> & {
    remoteId?: string;
  };

const emptyRemoteWorkPreview: RemoteWorkPreview = {
  primaryCode: "",
  remoteCode: "",
  title: "",
  coverUrl: "",
  circle: "",
  circleExternalId: "",
  rating: null,
  sales: null,
  releaseDate: "",
  tags: [],
  voiceActors: [],
  ageRating: "",
};

type ActiveSourceInfoModel = {
  label: string;
  kind: SourceTabInfo["kind"];
  status: SourceTabInfo["status"];
  statusLabel: string;
  stats: TreeStats;
  loading: boolean;
  metadataDurationSeconds: number | null;
};

const REMOTE_SOURCE_WORK_PATTERN = /^\/([^/?#]+)\/?$/;
const listeningStatusOptions: { value: ListeningStatus; label: string }[] = [
  { value: "none", label: "Unmarked" },
  { value: "want_to_listen", label: "Want" },
  { value: "listening", label: "Listening" },
  { value: "finished", label: "Finished" },
  { value: "relisten", label: "Relisten" },
  { value: "paused", label: "Shelved" },
];
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

const RECOMMENDATION_ALGORITHM_VERSION = "heuristic-v4";

function remoteLibrarySort(value: LibrarySort): LibrarySort {
  return value === "code" || value === "release" || value === "rating" || value === "sales" || value === "random"
    ? value
    : "recent";
}

function createRandomSortSeed() {
  return (window.crypto.getRandomValues(new Uint32Array(1))[0] % 2147483646) + 1;
}

function openActivityRun(runId: number) {
  window.history.pushState({}, "", `/activity?run=${runId}`);
  window.dispatchEvent(new Event("kikoto:navigation"));
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
  recentWorks,
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
  recentWorks: Work[];
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
    showRecentlyPlayed:
      recentWorks.length > 0 && searchQuery.trim() === "" && statusFilter === "all" && searchClauses.length === 0,
  };
}

export function LibraryPage({ active = true }: { active?: boolean }) {
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
  const [recentWorks, setRecentWorks] = useState<Work[]>([]);
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
    codeFromLocation(window.location.pathname, window.location.search),
  );
  const [selectedWork, setSelectedWork] = useState<WorkDetail | null>(null);
  const [selectedWorkNotFound, setSelectedWorkNotFound] = useState(false);
  const [selectedWorkPreview, setSelectedWorkPreview] = useState<WorkPreview | null>(() =>
    workPreviewFromHistory(codeFromLocation(window.location.pathname, window.location.search)),
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
    if (!browseHydrated || activeTab.kind === "source") return;
    if (skipNextLibraryEffect.current) {
      skipNextLibraryEffect.current = false;
      return;
    }
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
        setLibraryLoadError(error instanceof Error ? error.message : "Library request failed.");
        setOptimisticLibrarySearchClauses(null);
        pendingResultsScroll.current = false;
      })
      .finally(() => {
        if (!controller.signal.aborted && requestSeq === libraryRequestSeq.current) setIsLibraryLoading(false);
      });
    return () => controller.abort();
  }, [
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
    if (auth.isLoading) return;
    let cancelled = false;
    setBrowseHydrated(false);
    setSourceRoutesReady(false);
    api
      .listLibrarySources()
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
          codeFromLocation(window.location.pathname, window.location.search) === null,
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
    };
  }, [auth.isLoading, browseStorageScope, sessionDefaultBrowseState]);

  useEffect(() => {
    api
      .getRuntimeSettings()
      .then((next) => {
        setSettings(next);
        window.localStorage.setItem("kikoto:recommend-threshold", String(next.recommendationThreshold));
      })
      .catch(() => setSettings(null));
  }, []);

  useEffect(() => {
    if (selectedCode !== null) return;
    let cancelled = false;
    api
      .listRecentlyPlayedWorks(10)
      .then((result) => {
        if (!cancelled) setRecentWorks(result.works);
      })
      .catch(() => {
        if (!cancelled) setRecentWorks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedCode]);

  useEffect(() => {
    if (!browseHydrated) return;
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
  }, [selectedCode, works.length]);

  useEffect(() => {
    if (!active) {
      wasActive.current = false;
      return;
    }
    const syncFromPath = () => {
      if (!knownLibraryRoute(window.location.pathname, window.location.search, sources)) return;
      const nextTab = resolveTabFromPath(window.location.pathname, sources, activeTab);
      const nextScope = localScopeFromPath(window.location.pathname);
      const stored = readLibraryBrowseState(libraryBrowseKey(nextTab, nextScope, browseStorageScope));
      const sortPreference = readLibrarySortPreference(libraryBrowseKey(nextTab, nextScope, browseStorageScope));
      const nextCode = codeFromLocation(window.location.pathname, window.location.search);
      applyBrowseState(
        libraryBrowseStateFromSearch(
          window.location.search,
          stored ??
            readLibraryHistoryBrowseState(browseStorageScope) ?? { ...sessionDefaultBrowseState, ...sortPreference },
        ),
        nextTab,
        nextCode === null,
      );
      setSelectedCode(nextCode);
      setSelectedWorkPreview(workPreviewFromHistory(nextCode));
      setSelectedRemoteTarget(remoteTargetFromLocation(window.location.pathname, window.location.search, sources));
      setActiveTab(nextTab);
      setLocalScope(nextScope);
    };
    const becameActive = !wasActive.current;
    wasActive.current = true;
    if (becameActive) syncFromPath();
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
    if (selectedCode !== null || selectedRemoteTarget !== null) return;
    let pendingWrite: number | null = null;
    const flushScroll = () => {
      if (pendingWrite !== null) window.clearTimeout(pendingWrite);
      pendingWrite = null;
      const browseState = { ...activeBrowseState, scrollY: window.scrollY };
      writeLibraryBrowseState(libraryBrowseKey(activeTab, localScope, browseStorageScope), browseState);
      writeLibraryHistoryBrowseState(browseStorageScope, browseState);
    };
    const rememberScroll = () => {
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
      if (browseSurfaceActive.current) flushScroll();
    };
  }, [
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
        returnLabel: "Back to library",
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
                error: error instanceof Error ? error.message : "Recommendation explanation failed.",
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
        "Back to library",
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
      "Back to library",
      preview,
    );
    setSelectedCode(codeFromLocation(window.location.pathname, window.location.search));
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
    setSelectedCode(null);
    setSelectedRemoteTarget(null);
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
      toast.notify(toastFromError(error, "Mark update failed."));
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
        `Untracked ${work.primaryCode} from ${source.fileSourceName || source.fileSourceCode || "the source"}.`,
      );
      await refreshCurrentWorksPage();
    } catch (error) {
      toast.notify(toastFromError(error, "Untrack failed."));
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
        setLibraryLoadError(error instanceof Error ? error.message : "Library request failed.");
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
  }, [activeRemoteSourceState.page, activeTab, remoteSearchQuery]);

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

  if (sourceRoutesReady && !knownLibraryRoute(window.location.pathname, window.location.search, sources)) {
    return (
      <NotFoundPage
        onBack={() => (window.history.length > 1 ? window.history.back() : openLibraryHome())}
        onOpenLibrary={openLibraryHome}
      />
    );
  }

  if (selectedRemoteTarget !== null) {
    return (
      <RemoteOnlyWorkDetailController
        source={selectedRemoteTarget.source}
        sources={sources}
        code={selectedRemoteTarget.code}
        preview={selectedRemoteTarget.preview ?? null}
        onBack={backToLibrary}
        onWorksChanged={async () => await refreshCurrentWorksPage()}
      />
    );
  }

  if (selectedCode !== null) {
    if (selectedWorkNotFound) {
      return (
        <NotFoundPage
          title={t("library.workNotFound")}
          message={`${selectedCode} is not available in the current library or configured sources.`}
          onBack={backToLibrary}
          onOpenLibrary={openLibraryHome}
        />
      );
    }
    return (
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
    );
  }

  const {
    visibleWorks: pagedWorks,
    totalWorkPages,
    currentWorkPage,
    activeFilterCount,
    activePageSize,
    activePageSizeOptions,
    showRecentlyPlayed,
  } = libraryBrowseSurfaceState({
    works,
    optimisticSearchClauses: optimisticLibrarySearchClauses,
    workTotal,
    workPage,
    workPageSize,
    statusFilter,
    activeTab,
    remoteSourceState: activeRemoteSourceState,
    recentWorks,
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
  const browseLoadingLabel = activeTab.kind === "source" ? "Refreshing remote works" : "Refreshing library works";
  return (
    <div className="relative space-y-5">
      <section className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between" data-toast-avoid>
        <div
          className={`order-2 min-h-10 w-full items-center gap-2 rounded-lg border bg-card px-3 text-sm lg:order-1 lg:flex lg:max-w-xl ${
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
        <div className="order-1 flex w-full flex-wrap justify-end gap-2 lg:order-2 lg:w-auto">
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
      {showRecentlyPlayed && (
        <RecentlyPlayedStrip works={recentWorks} onOpen={(work) => openWork(work, recentWorkSourceIntent(work))} />
      )}

      <LibraryPrimaryTabs
        active={activePrimaryTab}
        activeSourceId={activeTab.kind === "source" ? activeTab.source.id : null}
        sources={sources}
        onChange={changePrimaryTab}
        onSourceChange={(source) => changeTab({ kind: "source", source })}
      />
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
                  onRecommendationOpen={() => openRecommendationExplanation(work)}
                  onOpen={() => openWork(work)}
                  onStatusChange={updateWorkStatus}
                  onFavoriteSaved={(workID, favorite) => {
                    setWorks((items) => items.map((item) => (item.id === workID ? { ...item, favorite } : item)));
                    setSelectedWork((item) => (item?.id === workID ? { ...item, favorite } : item));
                    if (favorite) recordWorkRecommendationEvent(work, "positive_mark");
                  }}
                  onTagOpen={addTagSearchClause}
                  onUserTagOpen={addUserTagSearchClause}
                  onUntrack={localScope === "tracked" ? (source) => untrackWorkSource(work, source) : undefined}
                  isUntracking={isUntracking}
                  onFetch={
                    localScope === "tracked" ? (source) => void openTrackedFetchSelection(work, source) : undefined
                  }
                  isFetchBusy={trackedFetchWorkspace.isBusy}
                />
              ))}
            </section>
          )}
          {!libraryLoadError && <WorkCollectionPagination {...localPaginationProps} placement="bottom" />}
        </div>
      )}
      {recommendationDialog && (
        <RecommendationExplanationModal state={recommendationDialog} onClose={() => setRecommendationDialog(null)} />
      )}
      <RemoteFetchWorkspaceDialog workspace={trackedFetchWorkspace} />
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
    <div className="flex gap-2 overflow-x-auto rounded-lg border bg-card p-1">
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
    <button
      className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors ${
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
      } disabled:pointer-events-none disabled:opacity-50`}
      disabled={disabled}
      onClick={onClick}
    >
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
          ? `Track workflow #${result.runId} is already queued.`
          : `Track workflow #${result.runId} queued.`,
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
      const message = `Bulk workflow #${parent.runId}: queued ${parent.fetched} Fetch jobs, failed ${parent.failed}.`;
      if (parent.failed > 0) toast.warning(message);
      else toast.success(message);
      await onSynced(0);
    } catch (error) {
      toast.notify(toastFromError(error, "Bulk fetch failed."));
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
      const message = `Bulk workflow #${parent.runId}: tracked ${parent.synced}, failed ${parent.failed}.`;
      if (parent.failed > 0) toast.warning(message);
      else toast.success(message);
      await onSynced(0);
    } catch (error) {
      toast.notify(toastFromError(error, "Bulk track failed."));
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
      toast.success(`Saved and marked ${work.primaryCode}.`);
      await onSynced(workId);
    } catch (error) {
      toast.notify(toastFromError(error, "Mark update failed."));
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
      toast.success(`Saved ${result.primaryCode} for list selection.`);
      return result.workId;
    } catch (error) {
      toast.notify(toastFromError(error, "Remote sync failed."));
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
        <SaveConfirmModal
          count={saveConfirm.codes.length}
          onClose={clearSaveConfirm}
          onConfirm={() => void saveConfirm.run()}
        />
      )}
      <RemoteFetchWorkspaceDialog workspace={actions.fetchWorkspace} />
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

function RecentlyPlayedStrip({ works, onOpen }: { works: Work[]; onOpen: (work: Work) => void }) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(
    () => window.localStorage.getItem("kikoto:recently-played-collapsed") === "true",
  );
  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem("kikoto:recently-played-collapsed", String(next));
      return next;
    });
  };

  return (
    <section className={collapsed ? "" : "space-y-2"} aria-labelledby="recently-played-heading">
      <h2 id="recently-played-heading">
        <button
          type="button"
          className="flex min-h-8 w-full items-center justify-between gap-2 rounded-md px-1 text-sm font-semibold transition-colors hover:bg-muted"
          onClick={toggleCollapsed}
          aria-label={collapsed ? t("library.expandRecentlyPlayed") : t("library.collapseRecentlyPlayed")}
          aria-expanded={!collapsed}
          aria-controls="recently-played-list"
          title={collapsed ? t("library.expandRecentlyPlayed") : t("library.collapseRecentlyPlayed")}
        >
          <span className="flex items-center gap-2">
            <Clock3 className="h-4 w-4 text-primary" />
            {t("library.recentlyPlayed")}
          </span>
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${collapsed ? "-rotate-90" : ""}`}
          />
        </button>
      </h2>
      {!collapsed && (
        <div id="recently-played-list" className="app-scroll flex snap-x gap-3 overflow-x-auto pb-2">
          {works.map((work) => (
            <button
              key={work.id}
              className="group flex h-[194px] w-[138px] shrink-0 snap-start flex-col text-left sm:h-[208px] sm:w-[154px] lg:h-[222px] lg:w-[168px]"
              onClick={() => onOpen(work)}
              aria-label={t("library.openWorkTitle", { title: work.title })}
            >
              <span className="relative block aspect-[4/3] w-full shrink-0 overflow-hidden rounded-md border bg-muted transition-colors group-hover:border-primary/50">
                {work.coverUrl ? (
                  <img
                    src={assetURL(work.coverUrl)}
                    alt=""
                    className="h-full w-full object-contain transition-transform group-hover:scale-[1.03]"
                    loading="lazy"
                  />
                ) : (
                  <span className="grid h-full place-items-center text-xl font-bold text-muted-foreground">
                    {work.primaryCode.slice(0, 2)}
                  </span>
                )}
                <span className="absolute left-2 top-2 max-w-[calc(100%-1rem)] truncate rounded bg-background/90 px-1.5 py-0.5 text-[10px] font-semibold">
                  {work.primaryCode}
                </span>
              </span>
              <span className="mt-2 block h-9 w-full line-clamp-2 text-xs font-semibold leading-snug">
                {work.title}
              </span>
              <span className="mt-0.5 block h-4 w-full truncate text-[11px] text-muted-foreground">
                {work.circle || t("common.unknown")}
              </span>
              <span className="mt-auto block h-1 w-full shrink-0 overflow-hidden rounded-full bg-muted">
                <span
                  className="block h-full rounded-full bg-primary"
                  style={{ width: `${progressPercent(work.progress)}%` }}
                />
              </span>
              <span
                className="mt-1 block w-full shrink-0 truncate text-[10px] text-muted-foreground"
                title={recentProgressLabel(work.progress)}
              >
                {recentProgressLabel(work.progress)}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function recentProgressLabel(progress: Work["progress"]) {
  if (progress.completed) return `Finished · ${progress.title || "Track"}`;
  const duration =
    progress.durationSeconds && progress.durationSeconds > 0 ? ` / ${formatTime(progress.durationSeconds)}` : "";
  return `${progress.title || "Track"} · ${formatTime(progress.positionSeconds)}${duration}`;
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

function WorkCard({
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
  onRecommendationOpen: () => void;
  onOpen: () => void;
  onStatusChange: (workID: number, status: ListeningStatus) => Promise<void>;
  onFavoriteSaved: (workID: number, favorite: boolean) => void;
  onTagOpen: (tag: string) => void;
  onUserTagOpen: (tag: string) => void;
  onUntrack?: (source: SourcePresenceItem) => Promise<void>;
  isUntracking?: boolean;
  onFetch?: (source: SourcePresenceItem) => void;
  isFetchBusy?: boolean;
}) {
  const view = libraryWorkCardView(work, onUserTagOpen, showRecommendationScore);
  const trackedSources = trackedSourcesForWork(work);
  const trackedSource = trackedSources[0] ?? null;
  const untrackAnchorRef = useRef<HTMLDivElement | null>(null);
  const [untrackOpen, setUntrackOpen] = useState(false);

  return (
    <WorkCardShell
      work={view}
      onOpen={onOpen}
      onRecommendationOpen={onRecommendationOpen}
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
                    title="Untrack source"
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
                      <div className="font-medium">Untrack source?</div>
                      <p className="text-xs text-muted-foreground">
                        Work information, marks, lists, metadata, and local files will be kept. Cached files for this
                        source will be deleted.
                      </p>
                      <div className="space-y-1">
                        {trackedSources.map((source) => {
                          const sourceName = source.fileSourceName || source.fileSourceCode || "this source";
                          return (
                            <button
                              key={`${source.workId ?? work.id}:${source.fileSourceId ?? 0}`}
                              className="flex min-h-10 w-full items-center gap-2 rounded-md border border-destructive/30 px-2 text-left text-destructive hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
                              disabled={isUntracking}
                              onClick={(event) => {
                                event.stopPropagation();
                                void onUntrack(source).finally(() => setUntrackOpen(false));
                              }}
                            >
                              <Unlink className="h-4 w-4 shrink-0" />
                              <span className="min-w-0 flex-1 truncate">Untrack {sourceName}</span>
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
                  title="Fetch"
                  disabled={!trackedSource || isFetchBusy}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (trackedSource) onFetch?.(trackedSource);
                  }}
                >
                  <HardDriveDownload className="h-4 w-4" />
                </WorkCardActionButton>
              )}
              <WorkCardListButton
                workId={work.id}
                active={work.favorite}
                onSaved={(favorite) => onFavoriteSaved(work.id, favorite)}
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
}

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
  const view = remoteWorkCardView(work, source);

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
                title="Track"
                disabled={isBusy || !work.primaryCode}
                onClick={(event) => {
                  event.stopPropagation();
                  onFetch();
                }}
              >
                <GitBranchPlus className="h-4 w-4" />
              </WorkCardActionButton>
              <WorkCardActionButton
                title="Fetch"
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

function SaveConfirmModal({
  count,
  onClose,
  onConfirm,
}: {
  count: number;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/50 p-4" onMouseDown={onClose}>
      <div
        className="w-full max-w-sm rounded-lg border bg-card p-4 shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h3 className="text-base font-semibold">Fetch remote directory</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          This will download the full remote directory for {count} selected work{count === 1 ? "" : "s"}.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={onConfirm}>
            Fetch
          </Button>
        </div>
      </div>
    </div>
  );
}

function createRecommendationContextID() {
  const random = window.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `library:${Date.now().toString(36)}:${random}`.slice(0, 64);
}

function RecommendationExplanationModal({
  state,
  onClose,
}: {
  state: { work: Work; breakdown: RecommendationBreakdown | null; loading: boolean; error: string };
  onClose: () => void;
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);
  const components =
    state.breakdown?.components.filter((component) => component.matchCount > 0 || component.contribution !== 0) ?? [];
  return (
    <div
      className="fixed inset-0 z-[80] grid place-items-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-lg border bg-background shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex min-h-12 items-center justify-between gap-3 border-b px-4">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{state.work.title}</div>
            <div className="text-xs text-muted-foreground">{state.work.primaryCode}</div>
          </div>
          <IconButton title="Close recommendation explanation" onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="space-y-4 p-4">
          {state.loading ? (
            <div className="flex min-h-36 items-center justify-center text-sm text-muted-foreground">
              <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> Loading score
            </div>
          ) : state.error ? (
            <div className="text-sm text-destructive">{state.error}</div>
          ) : state.breakdown ? (
            <>
              <div className="flex items-end justify-between gap-4 border-b pb-3">
                <div>
                  <div className="text-xs text-muted-foreground">Affinity score</div>
                  <div className="text-3xl font-semibold">{state.breakdown.score}</div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Badge variant="secondary">{recommendationLaneLabel(state.breakdown.lane)}</Badge>
                  <Badge variant="outline">{state.breakdown.algorithmVersion}</Badge>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Listening state controls placement in the recommendation mix. Within each state, affinity is adjusted by
                the current seeded discovery boost and result variation.
              </p>
              {state.breakdown.ordering && (
                <div className="space-y-2 border-t pt-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Current shuffle adjustment</span>
                    <span className="font-semibold tabular-nums">
                      {formatRecommendationAdjustment(state.breakdown.ordering.totalAdjustment)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Discovery boost</span>
                    <span className="font-medium tabular-nums">
                      {formatRecommendationAdjustment(state.breakdown.ordering.explorationBoost)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Result variation</span>
                    <span className="font-medium tabular-nums">
                      {formatRecommendationAdjustment(state.breakdown.ordering.jitter)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3 border-t pt-2">
                    <span className="font-medium">Ranking score</span>
                    <span className="font-semibold tabular-nums">
                      {state.breakdown.ordering.rankingScore.toFixed(1)}
                    </span>
                  </div>
                </div>
              )}
              <div className="space-y-2">
                {components.map((component) => (
                  <div key={component.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-sm">
                    <div className="min-w-0">
                      <div className="font-medium">{component.label}</div>
                      {component.matchCount > 0 && component.key !== "state" && (
                        <div className="text-xs text-muted-foreground">
                          {component.matchCount} matched signal{component.matchCount === 1 ? "" : "s"}
                        </div>
                      )}
                    </div>
                    <span
                      className={
                        component.contribution < 0 ? "font-semibold text-destructive" : "font-semibold text-primary"
                      }
                    >
                      {component.contribution > 0 ? "+" : ""}
                      {component.contribution}
                    </span>
                  </div>
                ))}
              </div>
              {state.breakdown.rawScore !== state.breakdown.score && (
                <div className="border-t pt-3 text-xs text-muted-foreground">
                  Raw {state.breakdown.rawScore}, bounded to {state.breakdown.score}
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function formatRecommendationAdjustment(value: number) {
  const rounded = Math.abs(value) < 0.05 ? 0 : value;
  return `${rounded >= 0 ? "+" : ""}${rounded.toFixed(1)}`;
}

function recommendationLaneLabel(lane: RecommendationBreakdown["lane"]) {
  switch (lane) {
    case "listening":
      return "Listening priority";
    case "want":
      return "Want priority";
    case "relisten":
      return "Relisten mix";
    case "finished":
      return "Finished mix";
    case "shelved":
      return "Shelved fallback";
    default:
      return "Unmarked discovery";
  }
}

function libraryWorkCardView(
  work: Work,
  onUserTagOpen?: (tag: string) => void,
  showRecommendationScore = false,
): WorkCardViewModel {
  return {
    code: work.primaryCode,
    title: work.title,
    circle: work.circle || "Unknown circle",
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
    recommended: showRecommendationScore || recommendationBadgeVisible(work.recommendScore),
    recommendationScore: work.recommendScore,
  };
}

function trackedSourcesForWork(work: Work) {
  return (work.sourcePresence ?? []).filter(
    (item) => item.type === "tracked" && item.availability === "available" && item.fileSourceId,
  );
}

function trackedPresenceForRemoteSource(work: WorkDetail | null, sourceID: number, remoteCode: string) {
  const candidates = (work?.sourcePresence ?? []).filter(
    (item) => item.type === "tracked" && item.availability === "available" && item.fileSourceId === sourceID,
  );
  if (candidates.length === 0) return null;
  return (
    candidates.find((item) => item.remoteCode?.toUpperCase() === remoteCode.toUpperCase()) ??
    candidates.find((item) => item.workId === work?.id) ??
    candidates[0]
  );
}

function remoteWorkCardView(work: RemoteWork, source: LibrarySource): WorkCardViewModel {
  const sourceLabel = source.displayName || source.code || i18n.t("workCard.remoteSource");
  return {
    code: work.primaryCode || work.remoteId,
    title: work.title,
    circle: work.circle || sourceLabel || "Unknown circle",
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
    recommended: recommendationBadgeVisible(work.recommendScore),
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

function workHasNoSource(work: {
  sourcePresence?: SourcePresenceItem[] | null;
  availability?: string[];
  mediaItems?: MediaItem[];
}) {
  const sourcePresence = work.sourcePresence ?? [];
  const hasPresence = sourcePresence.some((item) => item.type && item.type !== "location" && item.type !== "remote");
  if (hasPresence) return false;
  if (
    work.availability &&
    work.availability.some((item) => ["local", "cache", "cached", "remote"].includes(item.toLowerCase()))
  )
    return false;
  if ((work.mediaItems ?? []).some((item) => item.locations.some((location) => location.availability === "available")))
    return false;
  return true;
}

function WorkProgress({ progress }: { progress: Work["progress"] }) {
  const { t } = useTranslation();
  if (!progress.mediaItemId || !progress.lastPlayedAt) {
    return <div className="h-8 text-xs text-muted-foreground">{t("library.noPlaybackYet")}</div>;
  }
  return (
    <div className="space-y-1">
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${progressPercent(progress)}%` }} />
      </div>
      <div className="truncate text-xs text-muted-foreground">
        {progress.completed
          ? t("library.finished")
          : t("library.resumeAt", {
              title: progress.title || t("library.track"),
              time: formatTime(progress.positionSeconds),
            })}
      </div>
    </div>
  );
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

function useDismissiblePopover(open: boolean, ref: RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && ref.current?.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, ref, onClose]);
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
          <input
            className="h-[var(--control-height)] min-w-0 w-full rounded-md border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring sm:flex-1"
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

function dlsiteWorkURL(code: string) {
  const site = code.toUpperCase().startsWith("RJ") ? "maniax" : "home";
  return DLSITE_ENDPOINTS.workURL(site, code);
}

function formatTime(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function progressPercent(progress: Work["progress"]) {
  if (!progress.durationSeconds || progress.durationSeconds <= 0) return 0;
  return Math.min(100, Math.max(0, (progress.positionSeconds / progress.durationSeconds) * 100));
}

function IconButton({
  title,
  disabled,
  children,
  onClick,
}: {
  title: string;
  disabled?: boolean;
  children: ReactNode;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      className="relative inline-flex h-8 w-8 items-center justify-center rounded-md border bg-background text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function MarkMenu({ value, onChange }: { value: ListeningStatus; onChange: (status: ListeningStatus) => void }) {
  const { t } = useTranslation();
  return (
    <div className="absolute bottom-10 left-0 z-20 w-44 overflow-hidden rounded-md border bg-card p-1 shadow-lg">
      {listeningStatusOptions.map((option) => (
        <button
          key={option.value}
          className={`flex h-8 w-full items-center gap-2 rounded px-2 text-left text-xs hover:bg-muted ${
            value === option.value ? "font-semibold text-primary" : "text-foreground"
          }`}
          onClick={(event) => {
            event.stopPropagation();
            onChange(option.value);
          }}
        >
          <ListChecks
            className={value === option.value && value !== "none" ? "h-3.5 w-3.5 text-primary" : "h-3.5 w-3.5"}
          />
          {t(`library.status.${option.value}`, { defaultValue: option.label })}
        </button>
      ))}
    </div>
  );
}

type RemoteOnlyDetailActionsProps = {
  detail: RemoteWorkDetail | null;
  source: LibrarySource;
  busy: boolean;
  primaryRemoteSelected: boolean;
  availabilityLoading: boolean;
  hasTrackedSource: boolean;
  materializedWorkID: number | null;
  onEnsureListWork: () => Promise<number | null>;
  onListSaved: () => Promise<void>;
  onMark: (status: ListeningStatus) => void;
  onTrack: () => void;
  onUntrack: () => void;
  onFetch: () => void;
};

function RemoteOnlyDetailActions({
  detail,
  source,
  busy,
  primaryRemoteSelected,
  availabilityLoading,
  hasTrackedSource,
  materializedWorkID,
  onEnsureListWork,
  onListSaved,
  onMark,
  onTrack,
  onUntrack,
  onFetch,
}: RemoteOnlyDetailActionsProps) {
  const identityActions = detail ? (
    <WorkIdentityActionBar
      busy={busy}
      listeningStatus="none"
      favorite={false}
      listWorkId={detail.workId}
      onEnsureListWork={onEnsureListWork}
      onListSaved={onListSaved}
      onMark={onMark}
    />
  ) : (
    <DetailSkeletonActions />
  );
  const mediaActions =
    detail && primaryRemoteSelected ? (
      <MediaContextActionBar
        busy={busy}
        mode="remote_source"
        contextKey={`${remoteSourceTabKey(source.id)}:${hasTrackedSource ? "tracked" : "available"}`}
        onTrack={onTrack}
        trackDisabled={availabilityLoading || hasTrackedSource}
        trackDisabledReason={availabilityLoading ? "Loading tracking state" : "Already tracked"}
        onUntrack={hasTrackedSource && materializedWorkID ? onUntrack : undefined}
        onFetch={onFetch}
        remoteSourceWorkUrl={safeExternalHTTPURL(detail.publicWorkUrl)}
        remoteSourceName={detail.sourceName}
        sourceLabel={detail.sourceName}
        sourceStatus="Available"
      />
    ) : undefined;
  return (
    <>
      {identityActions}
      {mediaActions}
    </>
  );
}

type RemoteOnlyDirectoryPanelProps = {
  detail: RemoteWorkDetail | null;
  displaySourceName: string;
  displayRemoteCode: string;
  tabs: SourceTabInfo[];
  activeKey: string;
  activeTab: SourceTabInfo | null;
  activeTrackedPresence: SourcePresenceItem | null;
  activeTrackedForked: boolean;
  activeRemoteAvailability: RemoteSourceAvailability | null;
  primaryRemoteSelected: boolean;
  message: string;
  treeError: string;
  isDetailLoading: boolean;
  treeLoading: boolean;
  directoryMode: DirectoryMode;
  root: TreeNode;
  directoryStats: TreeStats;
  directoryRoutingRules: DirectoryRoutingRule[];
  currentLocationId: number | null;
  currentPlaybackKey: string | null;
  remoteAvailability: RemoteSourceAvailability[];
  hasMaterializedWork: boolean;
  selectionModal: ReactNode;
  onActiveKeyChange: (key: string) => void;
  onDirectoryModeChange: (mode: DirectoryMode) => void;
  onRetry: () => void;
  onSelectRemote: (remote: RemoteSourceAvailability) => void;
  onPlayRemote: (tracks: TreeTrack[], locationId: number) => void;
  onPlayMaterialized: (tracks: TreeTrack[], locationId: number) => void;
  onQueueRemote: (track: TreeTrack, next: boolean) => void;
  onQueueMaterialized: (track: TreeTrack, next: boolean) => void;
  onPreview: (preview: FilePreviewState) => void;
};

function remoteOnlyDirectoryDescription(props: RemoteOnlyDirectoryPanelProps) {
  if (props.primaryRemoteSelected) {
    return primaryRemoteOnlyDirectoryDescription(props);
  }
  return alternateRemoteOnlyDirectoryDescription(props);
}

function primaryRemoteOnlyDirectoryDescription(props: RemoteOnlyDirectoryPanelProps) {
  if (props.detail && !props.message && !props.treeError) {
    return `Previewing remote files from ${props.detail.sourceName}; temporary playback does not save progress.`;
  }
  return props.message || props.treeError || `Loading remote files from ${props.displaySourceName}...`;
}

function alternateRemoteOnlyDirectoryDescription(props: RemoteOnlyDirectoryPanelProps) {
  if (props.activeTab?.kind === "tracked" && props.activeTrackedForked) {
    const sourceName =
      props.activeTrackedPresence?.fileSourceName ||
      props.activeTrackedPresence?.fileSourceCode ||
      "the selected source";
    return `Browsing the tracked directory forked from ${sourceName}.`;
  }
  if (props.activeTab?.kind === "local" && props.activeTab.status === "available") {
    return "Browsing local files.";
  }
  return (
    props.activeRemoteAvailability?.summary.error ||
    `${props.activeTab?.label ?? "Source"} is not selected for this preview.`
  );
}

function remoteOnlyPrimaryDirectoryEmptyState(props: RemoteOnlyDirectoryPanelProps) {
  const error = props.message || props.treeError;
  if (error) {
    return <DirectoryLoadErrorPanel message={error} onRetry={props.onRetry} />;
  }
  if (props.isDetailLoading || props.treeLoading) {
    return <DirectorySkeleton />;
  }
  return null;
}

function remoteOnlyDirectoryEmptyState(props: RemoteOnlyDirectoryPanelProps) {
  if (props.primaryRemoteSelected) {
    return remoteOnlyPrimaryDirectoryEmptyState(props);
  }
  if (props.activeTab?.kind === "local" && props.activeTab.status !== "available") {
    return (
      <LocalSourceStatePanel
        status={props.activeTab.status}
        remoteSources={props.remoteAvailability}
        onSelectRemote={props.onSelectRemote}
      />
    );
  }
  if (props.activeTab?.kind === "tracked" && !props.activeTrackedForked) {
    return <TrackedUnforkedPanel presence={props.activeTrackedPresence} remoteSources={props.remoteAvailability} />;
  }
  if (props.activeRemoteAvailability) {
    return <RemoteSourceStatePanel remote={props.activeRemoteAvailability} />;
  }
  return null;
}

function remoteOnlyDirectoryPlayback(props: RemoteOnlyDirectoryPanelProps) {
  if (props.primaryRemoteSelected) {
    return {
      onPlayFolder: props.onPlayRemote,
      onPlayNext: (track: TreeTrack) => props.onQueueRemote(track, true),
      onAppendQueue: (track: TreeTrack) => props.onQueueRemote(track, false),
    };
  }
  if (props.hasMaterializedWork) {
    return {
      onPlayFolder: props.onPlayMaterialized,
      onPlayNext: (track: TreeTrack) => props.onQueueMaterialized(track, true),
      onAppendQueue: (track: TreeTrack) => props.onQueueMaterialized(track, false),
    };
  }
  return {};
}

function RemoteOnlyDirectoryPanel(props: RemoteOnlyDirectoryPanelProps) {
  const error = props.message || props.treeError;
  const loading = remoteOnlyDirectoryLoading(props);
  const playback = remoteOnlyDirectoryPlayback(props);
  const emptyState = remoteOnlyDirectoryEmptyState(props);
  return (
    <SourceDirectoryPanel
      title="Directory"
      description={remoteOnlyDirectoryDescription(props)}
      statsLabel={formatTreeStats(props.directoryStats)}
      tabs={props.tabs}
      activeKey={props.activeKey}
      onActiveKeyChange={props.onActiveKeyChange}
      directoryMode={props.directoryMode}
      onDirectoryModeChange={props.onDirectoryModeChange}
      root={props.root}
      directoryRoutingRules={props.directoryRoutingRules}
      currentLocationId={props.currentLocationId}
      currentPlaybackKey={props.currentPlaybackKey}
      emptyLabel={props.primaryRemoteSelected ? "No remote files detected." : "This source has no preview loaded."}
      toolbar={error ? <DirectoryMessage message={error} /> : undefined}
      emptyState={emptyState}
      loadingMessage={loading ? `Loading ${props.displayRemoteCode}...` : undefined}
      selectionModal={props.selectionModal}
      onPreview={props.onPreview}
      {...playback}
    />
  );
}

type RemoteOnlyDirectoryLoadingState = Pick<
  RemoteOnlyDirectoryPanelProps,
  "primaryRemoteSelected" | "message" | "treeError" | "isDetailLoading" | "treeLoading"
>;

function remoteOnlyDirectoryLoading(props: RemoteOnlyDirectoryLoadingState) {
  return (
    props.primaryRemoteSelected && !props.message && !props.treeError && (props.isDetailLoading || props.treeLoading)
  );
}

function remoteOnlySourceInfo(
  displaySourceName: string,
  tabs: SourceTabInfo[],
  activeKey: string,
  stats: TreeStats,
  primaryRemoteSelected: boolean,
  message: string,
  treeError: string,
  isDetailLoading: boolean,
  treeLoading: boolean,
  detail: RemoteWorkDetail | null,
): ActiveSourceInfoModel {
  const activeTab = tabs.find((tab) => tab.key === activeKey);
  const activeSource = activeTab
    ? { kind: activeTab.kind, status: activeTab.status, statusLabel: activeTab.statusLabel }
    : { kind: "remote" as const, status: "degraded" as const, statusLabel: "Loading source" };
  return {
    label: displaySourceName,
    ...activeSource,
    stats,
    loading: remoteOnlyDirectoryLoading({
      primaryRemoteSelected,
      message,
      treeError,
      isDetailLoading,
      treeLoading,
    }),
    metadataDurationSeconds: detail ? detail.durationSeconds : null,
  };
}

function remoteOnlyTranslations(editions: RemoteWorkDetail["languageEditions"]): WorkDetail["translations"] {
  return editions.map((edition) => ({
    workId: null,
    primaryCode: edition.remoteCode,
    title: edition.label,
    metadataLanguage: edition.language,
    editionLabel: edition.label,
    origin: edition.origin,
    official: !edition.origin,
    translationKind: edition.origin ? "origin" : "official",
    current: edition.current,
    hasMedia: true,
    mediaState: "indexed_available",
    localAvailable: false,
  }));
}

type RemoteOnlyPresentationIdentity = {
  coverUrl: string;
  title: string;
  circle: string;
  circleExternalId: string;
  rating: number | null;
  ratingCount: number | null;
  sales: number | null;
  releaseDate: string;
  ageRating: string;
  voiceActors: string[];
  tags: string[];
};

function remoteOnlyPreviewIdentity(preview: RemoteWorkPreview | null, code: string): RemoteOnlyPresentationIdentity {
  const fallback = preview ?? emptyRemoteWorkPreview;
  return {
    coverUrl: fallback.coverUrl,
    title: preview ? fallback.title : code,
    circle: fallback.circle,
    circleExternalId: fallback.circleExternalId,
    rating: fallback.rating,
    ratingCount: null,
    sales: fallback.sales,
    releaseDate: fallback.releaseDate || "Unknown",
    ageRating: fallback.ageRating,
    voiceActors: fallback.voiceActors,
    tags: fallback.tags,
  };
}

function remoteOnlyPresentationIdentity(
  remoteIdentity: RemoteWorkDetail | null,
  preview: RemoteWorkPreview | null,
  code: string,
): RemoteOnlyPresentationIdentity {
  const fallback = remoteOnlyPreviewIdentity(preview, code);
  if (!remoteIdentity) return fallback;
  return {
    coverUrl: remoteIdentity.coverUrl,
    title: remoteIdentity.title,
    circle: remoteIdentity.circle,
    circleExternalId: remoteIdentity.circleRef?.externalId ?? fallback.circleExternalId,
    rating: remoteIdentity.rating ?? fallback.rating,
    ratingCount: remoteIdentity.ratingCount ?? null,
    sales: remoteIdentity.sales ?? fallback.sales,
    releaseDate: remoteIdentity.releaseDate || fallback.releaseDate,
    ageRating: remoteIdentity.ageRating,
    voiceActors: remoteIdentity.voiceActors,
    tags: remoteIdentity.tags,
  };
}

function remoteOnlyPresentationMetadata(
  remoteIdentity: RemoteWorkDetail | null,
  activeMetadataVariant: ReturnType<typeof resolveMetadataVariant>,
  identity: RemoteOnlyPresentationIdentity,
) {
  const editions = remoteIdentity ? remoteIdentity.languageEditions : [];
  const origin = editions.find((edition) => edition.origin);
  const current = editions.find((edition) => edition.current);
  return {
    title: activeMetadataVariant ? activeMetadataVariant.title : identity.title,
    tags: activeMetadataVariant ? activeMetadataVariant.tags : identity.tags,
    baseCode: origin ? origin.remoteCode : "",
    language: activeMetadataVariant ? activeMetadataVariant.language : current ? current.language : "",
    presentation: remoteIdentity ? remoteIdentity.metadataPresentation : undefined,
    activeVariantKey: activeMetadataVariant ? activeMetadataVariant.key : "",
    translations: remoteOnlyTranslations(editions),
  };
}

function remoteOnlyPresentationCode(
  displayPrimaryCode: string,
  remoteIdentity: RemoteWorkDetail | null,
  preview: RemoteWorkPreview | null,
  code: string,
) {
  const fallback = preview ?? emptyRemoteWorkPreview;
  return displayPrimaryCode || remoteIdentity?.remoteId || fallback.remoteId || code;
}

function remoteOnlyWorkDetailPresentation({
  remoteIdentity,
  detail,
  preview,
  code,
  displayPrimaryCode,
  displayRemoteCode,
  activeMetadataVariant,
  sourceInfo,
  loading,
  onMetadataVariantSelect,
  onVersionSelect,
}: {
  remoteIdentity: RemoteWorkDetail | null;
  detail: RemoteWorkDetail | null;
  preview: RemoteWorkPreview | null;
  code: string;
  displayPrimaryCode: string;
  displayRemoteCode: string;
  activeMetadataVariant: ReturnType<typeof resolveMetadataVariant>;
  sourceInfo: ActiveSourceInfoModel;
  loading: boolean;
  onMetadataVariantSelect: (key: string) => void;
  onVersionSelect: (code: string) => void;
}): UnifiedWorkDetailPresentation {
  const identity = remoteOnlyPresentationIdentity(remoteIdentity, preview, code);
  const metadata = remoteOnlyPresentationMetadata(remoteIdentity, activeMetadataVariant, identity);
  const presentationCode = remoteOnlyPresentationCode(displayPrimaryCode, remoteIdentity, preview, code);
  return {
    coverUrl: identity.coverUrl,
    fallbackCode: presentationCode,
    code: presentationCode,
    dlsiteUrl: detail ? dlsiteWorkURL(detail.primaryCode) : "",
    title: metadata.title,
    circle: identity.circle,
    circleExternalId: identity.circleExternalId,
    series: "",
    seriesTitleId: "",
    seriesCircleExternalId: "",
    ratingLabel: "Rating",
    rating: identity.rating,
    ratingCount: identity.ratingCount,
    sales: identity.sales,
    baseCode: metadata.baseCode,
    metadataLanguage: metadata.language,
    metadataPresentation: metadata.presentation,
    activeMetadataVariantKey: metadata.activeVariantKey,
    onMetadataVariantSelect,
    translations: metadata.translations,
    activeVersionCode: displayRemoteCode,
    onVersionSelect: (translation) => onVersionSelect(translation.primaryCode),
    remoteVersions: true,
    dlsiteFetchedAt: "",
    releaseDate: identity.releaseDate,
    ageRating: identity.ageRating,
    sourceInfo,
    voiceActors: identity.voiceActors,
    voiceCredits: [],
    tags: metadata.tags,
    loading,
  };
}

function remoteOnlyDisplayState(
  identityDetail: RemoteWorkDetail | null,
  detail: RemoteWorkDetail | null,
  preview: RemoteWorkPreview | null,
  source: LibrarySource,
  code: string,
  selectedMetadataVariantKey: string,
) {
  const remoteIdentity = identityDetail ?? detail;
  return {
    remoteIdentity,
    activeMetadataVariant: resolveMetadataVariant(remoteIdentity?.metadataPresentation, selectedMetadataVariantKey),
    displaySourceName: remoteIdentity?.sourceName ?? source.displayName,
    displayPrimaryCode: remoteIdentity?.primaryCode || preview?.primaryCode || code,
    displayRemoteCode: detail ? remoteDetailActionCode(detail) : preview?.remoteCode || preview?.primaryCode || code,
  };
}

function remoteOnlyActiveSourceState(
  sourceID: number,
  activeKey: string,
  tabs: SourceTabInfo[],
  availability: RemoteSourceAvailability[],
) {
  const primaryRemoteSelected = activeKey === remoteSourceTabKey(sourceID);
  const activeTab = tabs.find((tab) => tab.key === activeKey) ?? null;
  const activeTrackedPresence = activeTab?.kind === "tracked" ? (activeTab.presence ?? null) : null;
  return {
    primaryRemoteSelected,
    activeTab,
    activeTrackedPresence,
    activeTrackedForked: Boolean(activeTrackedPresence && activeTab?.status === "available"),
    activeRemoteAvailability: availability.find((item) => remoteSourceTabKey(item.source.id) === activeKey) ?? null,
    primaryRemoteAvailability: availability.find((item) => item.source.id === sourceID) ?? null,
  };
}

function remoteOnlyMaterializedState({
  trackedWork,
  sourceID,
  displayRemoteCode,
  primaryRemoteAvailability,
  detail,
  primaryRemoteSelected,
  remoteTree,
  materializedTree,
  remoteStats,
}: {
  trackedWork: WorkDetail | null;
  sourceID: number;
  displayRemoteCode: string;
  primaryRemoteAvailability: RemoteSourceAvailability | null;
  detail: RemoteWorkDetail | null;
  primaryRemoteSelected: boolean;
  remoteTree: TreeNode;
  materializedTree: TreeNode;
  remoteStats: TreeStats;
}) {
  const trackedSourcePresence = trackedPresenceForRemoteSource(trackedWork, sourceID, displayRemoteCode);
  const visibleTree = primaryRemoteSelected ? remoteTree : materializedTree;
  return {
    hasTrackedSource: Boolean(trackedSourcePresence || primaryRemoteAvailability?.summary.hasTracked),
    materializedWorkID: trackedWork?.id ?? primaryRemoteAvailability?.summary.workId ?? detail?.workId ?? null,
    visibleTree,
    visibleDirectoryStats: primaryRemoteSelected ? remoteStats : treeStats(visibleTree),
  };
}

function RemoteOnlyDetailOverlays({
  manageOpen,
  tree,
  filePreview,
  onManageClose,
  onPreviewClose,
}: {
  manageOpen: boolean;
  tree: TreeNode;
  filePreview: FilePreviewState | null;
  onManageClose: () => void;
  onPreviewClose: () => void;
}) {
  return (
    <>
      {manageOpen && (
        <DirectoryManagerModal root={tree} emptyLabel="No remote files detected." onClose={onManageClose} />
      )}
      {filePreview && <FilePreviewModal preview={filePreview} onClose={onPreviewClose} />}
    </>
  );
}

function RemoteOnlyWorkDetailController({
  source,
  sources,
  code,
  preview,
  onBack,
  onWorksChanged,
}: {
  source: LibrarySource;
  sources: LibrarySource[];
  code: string;
  preview: RemoteWorkPreview | null;
  onBack: () => void;
  onWorksChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const { t } = useTranslation();
  const [detail, setDetail] = useState<RemoteWorkDetail | null>(null);
  const [identityDetail, setIdentityDetail] = useState<RemoteWorkDetail | null>(null);
  const [selectedMetadataVariantKey, setSelectedMetadataVariantKey] = useState("");
  const [trackedWork, setTrackedWork] = useState<WorkDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [message, setMessage] = useState("");
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState("");
  const [remoteRetryToken, setRemoteRetryToken] = useState(0);
  const [filePreview, setFilePreview] = useState<FilePreviewState | null>(null);
  const [activeRemoteTab, setActiveRemoteTab] = useState<string>(remoteSourceTabKey(source.id));
  const [remoteAvailability, setRemoteAvailability] = useState<RemoteSourceAvailability[]>(() =>
    sources
      .filter((candidate) => candidate.sourceType.startsWith("kikoeru"))
      .map((candidate) => ({
        source: candidate,
        summary: {
          sourceId: candidate.id,
          sourceCode: candidate.code,
          displayName: candidate.displayName,
          status: "unknown" as const,
          remoteId: "",
          primaryCode: code,
          title: preview?.title ?? "",
          coverUrl: preview?.coverUrl ?? "",
          workId: null,
          hasRemote: false,
          hasTracked: false,
          hasCache: false,
          hasLocal: false,
          error: "",
          elapsedMs: 0,
        },
      })),
  );
  const [availabilityLoading, setAvailabilityLoading] = useState(true);
  const [isFetching, setIsFetching] = useState(false);
  const [directoryMode, setDirectoryMode] = useState<DirectoryMode>("browse");
  const [isManageOpen, setIsManageOpen] = useState(false);
  const [mobileDetailTab, setMobileDetailTab] = useState<"info" | "directory">("directory");
  const isCompactDetailLayout = useCompactDetailLayout();
  const [directoryRoutingRules, setDirectoryRoutingRules] =
    useState<DirectoryRoutingRule[]>(defaultDirectoryRoutingRules);
  const { remoteIdentity, activeMetadataVariant, displaySourceName, displayPrimaryCode, displayRemoteCode } =
    remoteOnlyDisplayState(identityDetail, detail, preview, source, code, selectedMetadataVariantKey);
  const isDetailLoading = !detail;
  const tree = useMemo(
    () =>
      detail
        ? buildRemoteTree(detail.tracks, { sourceId: detail.sourceId, workCode: remoteDetailActionCode(detail) })
        : emptyTree(),
    [detail],
  );
  const fetchWorkspace = useRemoteFetchWorkspace({ onWorksChanged });
  const directoryStats = useMemo(() => treeStats(tree), [tree]);
  const trackCount = useMemo(() => countTreeFiles(tree), [tree]);
  const remotePlayableTracks = useMemo(() => flattenTracks(tree), [tree]);
  const remoteFiles = useMemo(() => flattenTreeFiles(tree), [tree]);
  const remoteTabs = useMemo<SourceTabInfo[]>(
    () =>
      buildSourceTabs(
        trackedWork?.mediaItems ?? [],
        remoteAvailability.map((item) =>
          item.source.id === source.id
            ? {
                ...item,
                detail: detail ?? undefined,
                error: message,
                treeError,
                treeLoading,
                summary: {
                  ...item.summary,
                  status: detail && !treeError ? "available" : message || treeError ? "error" : item.summary.status,
                  primaryCode: detail?.primaryCode || item.summary.primaryCode,
                  title: detail?.title || item.summary.title,
                  coverUrl: detail?.coverUrl || item.summary.coverUrl,
                },
              }
            : item,
        ),
        trackedWork?.sourcePresence ?? [],
        undefined,
      ),
    [detail, message, remoteAvailability, source.id, trackedWork, treeError, treeLoading],
  );
  const player = useLibraryPlayer();
  const {
    primaryRemoteSelected,
    activeTab: activeRemoteTabInfo,
    activeTrackedPresence,
    activeTrackedForked,
    activeRemoteAvailability,
    primaryRemoteAvailability,
  } = remoteOnlyActiveSourceState(source.id, activeRemoteTab, remoteTabs, remoteAvailability);
  const materializedTree = useMemo(() => {
    if (!trackedWork) return emptyTree();
    if (activeRemoteTabInfo?.kind === "tracked" && activeTrackedForked) {
      return buildTree(trackedWork.mediaItems, activeTrackedPresence?.fileSourceId ?? null, trackedWork.primaryCode);
    }
    if (
      activeRemoteTabInfo?.kind === "local" &&
      activeRemoteTabInfo.status === "available" &&
      activeRemoteTabInfo.fileSourceId
    ) {
      return buildTree(trackedWork.mediaItems, activeRemoteTabInfo.fileSourceId, trackedWork.primaryCode);
    }
    return emptyTree();
  }, [activeRemoteTabInfo, activeTrackedForked, activeTrackedPresence?.fileSourceId, trackedWork]);
  const { hasTrackedSource, materializedWorkID, visibleTree, visibleDirectoryStats } = remoteOnlyMaterializedState({
    trackedWork,
    sourceID: source.id,
    displayRemoteCode,
    primaryRemoteAvailability,
    detail,
    primaryRemoteSelected,
    remoteTree: tree,
    materializedTree,
    remoteStats: directoryStats,
  });

  useEffect(() => {
    let cancelled = false;
    api
      .getRuntimeSettings()
      .then((settings) => {
        if (!cancelled) setDirectoryRoutingRules(settings.directoryRoutingRules ?? defaultDirectoryRoutingRules);
      })
      .catch(() => {
        if (!cancelled) setDirectoryRoutingRules(defaultDirectoryRoutingRules);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setAvailabilityLoading(true);
    api
      .getSourceAvailability(code)
      .then(async (result) => {
        if (cancelled) return;
        setRemoteAvailability((current) =>
          current.map((item) => {
            const summary = result.sources.find((candidate) => candidate.sourceId === item.source.id);
            return summary ? { ...item, summary } : item;
          }),
        );
        const summary = result.sources.find((candidate) => candidate.sourceId === source.id);
        if (!summary?.workId) {
          setTrackedWork(null);
          return;
        }
        try {
          const nextWork = await api.getWork(summary.workId);
          if (!cancelled) setTrackedWork(nextWork);
        } catch {
          // Availability still controls Track state when materialized detail cannot be loaded.
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setAvailabilityLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [code, remoteRetryToken, source.id]);

  useEffect(() => {
    setDetail(null);
    setIdentityDetail(null);
    setSelectedMetadataVariantKey("");
    setTrackedWork(null);
    setNotFound(false);
    setMessage("");
    setTreeLoading(false);
    setTreeError("");
    fetchWorkspace.close();
  }, [source.id, code]);

  useEffect(() => {
    setNotFound(false);
    setMessage("");
    setTreeError("");
    setTreeLoading(true);
    const controller = new AbortController();
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 20_000);
    void loadRemoteOnlyDetail({
      sourceID: source.id,
      code,
      signal: controller.signal,
      didTimeOut: () => timedOut,
      onMetadata: (next) => {
        setDetail((current) => ({ ...next, tracks: current?.tracks ?? [] }));
        setIdentityDetail(next);
        setRemoteAvailability((items) =>
          items.map((item) =>
            item.source.id === source.id
              ? {
                  ...item,
                  summary: {
                    ...item.summary,
                    status: "available",
                    remoteId: next.remoteId,
                    primaryCode: next.primaryCode,
                    title: next.title,
                    coverUrl: next.coverUrl,
                    workId: next.workId,
                    hasRemote: true,
                  },
                }
              : item,
          ),
        );
      },
      onTracks: (tracks) => {
        setDetail((current) => (current ? { ...current, tracks } : current));
        setTreeError("");
      },
      onTreeError: setTreeError,
    })
      .then((outcome) => {
        if (outcome.kind === "not_found") {
          setNotFound(true);
          return;
        }
        if (outcome.kind === "failed") {
          setMessage(outcome.message);
          toast.notify({ kind: "error", message: outcome.message });
        }
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (!controller.signal.aborted || timedOut) setTreeLoading(false);
      });
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [source.id, code, remoteRetryToken]);

  const fetchWork = async (reason: string) => {
    if (!detail?.primaryCode) return;
    setIsFetching(true);
    setMessage("");
    try {
      const requestedCode = remoteDetailActionCode(detail);
      const result = await api.trackRemoteSourceWork(source.id, requestedCode, reason);
      announceRemoteTrackCreated(source.id, requestedCode, result);
      toast.notify({
        kind: "info",
        message: result.deduplicated
          ? `Track workflow #${result.runId} is already queued.`
          : `Track workflow #${result.runId} queued.`,
      });
    } catch (error) {
      toast.notify(toastFromError(error, "Track could not be queued."));
    } finally {
      setIsFetching(false);
    }
  };

  const syncForUserState = async (reason: string) => {
    if (!detail?.primaryCode) return null;
    setIsFetching(true);
    setMessage("");
    try {
      const result = await api.syncRemoteSourceWork(source.id, remoteDetailActionCode(detail), reason);
      await onWorksChanged();
      setDetail((current) => (current ? { ...current, workId: result.workId, importStatus: "synced" } : current));
      return result.workId;
    } catch (error) {
      toast.notify(toastFromError(error, "Remote sync failed."));
      return null;
    } finally {
      setIsFetching(false);
    }
  };

  const updateRemoteMark = async (status: ListeningStatus) => {
    if (!detail?.primaryCode) return;
    const workID = detail.workId ?? (await syncForUserState("detail_mark_interest"));
    if (!workID) return;
    try {
      const result = await api.updateWorkUserState(workID, { listeningStatus: status });
      toast.success(
        t("library.markedAs", {
          code: detail.primaryCode,
          status: listeningStatusLabel(result.listeningStatus, t),
        }),
      );
      await onWorksChanged();
    } catch (error) {
      toast.notify(toastFromError(error, "Mark update failed."));
    }
  };

  const openSaveWorkspace = () => {
    if (!detail) return;
    void fetchWorkspace.open({
      sourceId: source.id,
      remoteCode: remoteDetailActionCode(detail),
      canonicalCode: detail.primaryCode,
      sourceDisplayName: source.displayName,
      detail,
    });
  };

  const untrackRemoteSource = async () => {
    if (!materializedWorkID || !detail) return;
    setIsFetching(true);
    setMessage("");
    try {
      const currentWork = trackedWork ?? (await api.getWork(materializedWorkID));
      const presence = trackedPresenceForRemoteSource(currentWork, source.id, remoteDetailActionCode(detail));
      if (!presence?.fileSourceId) throw new Error("Tracked source could not be resolved.");
      const ownerWorkID = presence.workId || currentWork.id;
      const sourceName = presence.fileSourceName || presence.fileSourceCode || detail.sourceName;
      await api.untrackWorkSource(ownerWorkID, presence.fileSourceId);
      const [nextWork, availability] = await Promise.all([
        api.getWork(currentWork.id),
        api.getSourceAvailability(detail.primaryCode || code),
        onWorksChanged(),
      ]);
      setTrackedWork(nextWork);
      setRemoteAvailability((current) =>
        current.map((item) => {
          const summary = availability.sources.find((candidate) => candidate.sourceId === item.source.id);
          return summary ? { ...item, summary } : item;
        }),
      );
      toast.success(`Untracked ${detail.primaryCode} from ${sourceName}.`);
    } catch (error) {
      toast.notify(toastFromError(error, "Untrack failed."));
    } finally {
      setIsFetching(false);
    }
  };

  useEffect(() => {
    const reconcileTrack = (event: Event) => {
      const terminal = (event as CustomEvent<RemoteTrackTerminalDetail>).detail;
      if (
        !terminal ||
        (terminal.status !== "succeeded" && terminal.status !== "partial") ||
        !terminal.workId ||
        !isMatchingRemoteTrack(terminal, source.id, code, detail?.primaryCode, detail?.remoteCode)
      )
        return;
      void (async () => {
        const [nextWork, availability] = await Promise.all([
          api.getWork(terminal.workId as number),
          api.getSourceAvailability(terminal.primaryCode || detail?.primaryCode || code).catch(() => null),
          onWorksChanged(),
        ]);
        setTrackedWork(nextWork);
        setDetail((current) => (current ? { ...current, workId: terminal.workId, importStatus: "synced" } : current));
        setIdentityDetail((current) =>
          current ? { ...current, workId: terminal.workId, importStatus: "synced" } : current,
        );
        if (availability) {
          setRemoteAvailability((current) =>
            current.map((item) => {
              const summary = availability.sources.find((candidate) => candidate.sourceId === item.source.id);
              return summary ? { ...item, summary } : item;
            }),
          );
        }
      })().catch((error) => {
        toast.notify(toastFromError(error, "Track completed, but this detail could not be refreshed."));
      });
    };
    window.addEventListener(REMOTE_TRACK_TERMINAL_EVENT, reconcileTrack);
    return () => window.removeEventListener(REMOTE_TRACK_TERMINAL_EVENT, reconcileTrack);
  }, [code, detail?.primaryCode, detail?.remoteCode, onWorksChanged, source.id, toast]);

  const playRemoteTracks = (tracks: TreeTrack[], locationId: number) => {
    if (!detail || tracks.length === 0) return;
    player.playQueue(
      tracks.map((track) => toRemotePreviewPlayerTrack(track, detail, remoteFiles)),
      locationId,
    );
  };

  const queueRemoteTrack = (track: TreeTrack, next: boolean) => {
    if (!detail) return;
    const queuedTrack = toRemotePreviewPlayerTrack(track, detail, remoteFiles);
    if (next) player.playNext(queuedTrack);
    else player.appendQueue([queuedTrack]);
    toast.info(next ? `Playing ${track.title} next.` : `Added ${track.title} to the queue.`);
  };

  const playMaterializedTracks = (tracks: TreeTrack[], locationId: number) => {
    if (!trackedWork || tracks.length === 0) return;
    player.playQueue(
      tracks.map((track) => toPlayerTrack(track, trackedWork)),
      locationId,
    );
  };

  const queueMaterializedTrack = (track: TreeTrack, next: boolean) => {
    if (!trackedWork) return;
    const queuedTrack = toPlayerTrack(track, trackedWork);
    if (next) player.playNext(queuedTrack);
    else player.appendQueue([queuedTrack]);
    toast.info(next ? `Playing ${track.title} next.` : `Added ${track.title} to the queue.`);
  };

  if (notFound) {
    return (
      <NotFoundPage
        title="Remote work not found"
        message={`${code} is not available from ${source.displayName}.`}
        onBack={onBack}
        onOpenLibrary={() => {
          window.history.pushState({}, "", "/");
          window.dispatchEvent(new Event("kikoto:navigation"));
        }}
      />
    );
  }

  const sourceInfo = remoteOnlySourceInfo(
    displaySourceName,
    remoteTabs,
    activeRemoteTab,
    visibleDirectoryStats,
    primaryRemoteSelected,
    message,
    treeError,
    isDetailLoading,
    treeLoading,
    detail,
  );
  const heroActions = (
    <RemoteOnlyDetailActions
      detail={detail}
      source={source}
      busy={isFetching || fetchWorkspace.isBusy}
      primaryRemoteSelected={primaryRemoteSelected}
      availabilityLoading={availabilityLoading}
      hasTrackedSource={hasTrackedSource}
      materializedWorkID={materializedWorkID}
      onEnsureListWork={() => syncForUserState("detail_list_remote")}
      onListSaved={onWorksChanged}
      onMark={(status) => void updateRemoteMark(status)}
      onTrack={() => void fetchWork("manual_track")}
      onUntrack={() => void untrackRemoteSource()}
      onFetch={openSaveWorkspace}
    />
  );
  const directoryPanel = (
    <RemoteOnlyDirectoryPanel
      detail={detail}
      displaySourceName={displaySourceName}
      displayRemoteCode={displayRemoteCode}
      tabs={remoteTabs}
      activeKey={activeRemoteTab}
      activeTab={activeRemoteTabInfo}
      activeTrackedPresence={activeTrackedPresence}
      activeTrackedForked={activeTrackedForked}
      activeRemoteAvailability={activeRemoteAvailability}
      primaryRemoteSelected={primaryRemoteSelected}
      message={message}
      treeError={treeError}
      isDetailLoading={isDetailLoading}
      treeLoading={treeLoading}
      directoryMode={directoryMode}
      root={visibleTree}
      directoryStats={visibleDirectoryStats}
      directoryRoutingRules={directoryRoutingRules}
      currentLocationId={player.currentLocationId}
      currentPlaybackKey={player.currentPlaybackKey}
      remoteAvailability={remoteAvailability}
      hasMaterializedWork={Boolean(trackedWork)}
      selectionModal={<RemoteFetchWorkspaceDialog workspace={fetchWorkspace} />}
      onActiveKeyChange={setActiveRemoteTab}
      onDirectoryModeChange={setDirectoryMode}
      onRetry={() => setRemoteRetryToken((value) => value + 1)}
      onSelectRemote={(next) => setActiveRemoteTab(remoteSourceTabKey(next.source.id))}
      onPlayRemote={playRemoteTracks}
      onPlayMaterialized={playMaterializedTracks}
      onQueueRemote={queueRemoteTrack}
      onQueueMaterialized={queueMaterializedTrack}
      onPreview={setFilePreview}
    />
  );
  const presentation = remoteOnlyWorkDetailPresentation({
    remoteIdentity,
    detail,
    preview,
    code,
    displayPrimaryCode,
    displayRemoteCode,
    activeMetadataVariant,
    sourceInfo,
    loading: isDetailLoading,
    onMetadataVariantSelect: setSelectedMetadataVariantKey,
    onVersionSelect: (editionCode) => void selectRemoteLanguageEdition(editionCode),
  });

  const selectRemoteLanguageEdition = async (editionCode: string) => {
    if (!detail || editionCode.toUpperCase() === remoteDetailActionCode(detail).toUpperCase()) return;
    setIsFetching(true);
    setTreeLoading(true);
    setTreeError("");
    try {
      const metadata = await api.getRemoteSourceWorkMetadata(source.id, editionCode);
      const nextDetail: RemoteWorkDetail = { ...metadata, tracks: [] };
      setDetail(nextDetail);
      fetchWorkspace.close();
      const tracks = await api.getRemoteSourceWorkTracks(source.id, metadata.remoteCode || editionCode);
      setDetail((current) => (current ? { ...current, tracks: tracks.tracks } : current));
    } catch (error) {
      setTreeError(error instanceof Error ? error.message : "Remote directory failed.");
      toast.notify(toastFromError(error, `The ${editionCode} edition is not available from ${source.displayName}.`));
    } finally {
      setIsFetching(false);
      setTreeLoading(false);
    }
  };

  return (
    <UnifiedWorkDetailPage
      presentation={presentation}
      compact={isCompactDetailLayout}
      mobileTab={mobileDetailTab}
      onMobileTabChange={setMobileDetailTab}
      actions={heroActions}
      directory={directoryPanel}
      onBack={onBack}
    >
      <RemoteOnlyDetailOverlays
        manageOpen={isManageOpen}
        tree={tree}
        filePreview={filePreview}
        onManageClose={() => setIsManageOpen(false)}
        onPreviewClose={() => setFilePreview(null)}
      />
    </UnifiedWorkDetailPage>
  );
}

function persistedFetchTarget(
  selectedRemoteSource: RemoteSourceAvailability | null | undefined,
  selectedTrackedRemoteSource: RemoteSourceAvailability | null | undefined,
  selectedRemoteWorkCode: string,
  selectedTrackedPresence: SourcePresenceItem | null,
  work: WorkDetail | null,
  code: string,
) {
  const remote = selectedRemoteSource ?? selectedTrackedRemoteSource ?? undefined;
  if (selectedRemoteSource) return { remote, code: selectedRemoteWorkCode };
  if (selectedTrackedPresence) {
    return { remote, code: sourcePresenceActionCode(selectedTrackedPresence, work?.primaryCode ?? code) };
  }
  return { remote, code: work?.primaryCode ?? code };
}

function hasResumablePlaybackCursor(cursor: ReturnType<typeof useWorkPlaybackCursor>["cursor"]) {
  return Boolean(cursor && !cursor.completed && Number.isFinite(cursor.positionSeconds) && cursor.positionSeconds > 0);
}

function persistedMediaTreeInput({
  mediaLoading,
  localDirectoryWork,
  work,
  selectedTrackedForked,
  selectedTrackedSourceID,
  selectedSource,
  selectedRemoteSource,
  selectedRemoteSourceID,
  selectedRemoteDetail,
  selectedTrackedPresence,
}: {
  mediaLoading: boolean;
  localDirectoryWork: WorkDetail | null;
  work: WorkDetail | null;
  selectedTrackedForked: boolean;
  selectedTrackedSourceID: number | null;
  selectedSource: SourceTabInfo | null | undefined;
  selectedRemoteSource: RemoteSourceAvailability | null | undefined;
  selectedRemoteSourceID: number | null;
  selectedRemoteDetail: RemoteWorkDetail | null;
  selectedTrackedPresence: SourcePresenceItem | null;
}) {
  return {
    mediaLoading,
    localItems: localDirectoryWork?.mediaItems ?? [],
    localCode: localDirectoryWork?.primaryCode ?? work?.primaryCode ?? "",
    fileSourceId: selectedTrackedForked ? selectedTrackedSourceID : (selectedSource?.fileSourceId ?? null),
    selectionKey: `${selectedSource?.key ?? ""}:${selectedTrackedSourceID ?? selectedRemoteSourceID ?? 0}`,
    remoteSelected: Boolean(selectedRemoteSource),
    remoteDetail: selectedRemoteDetail,
    trackedUnavailable: Boolean(selectedTrackedPresence && !selectedTrackedForked),
    emptyTree,
    buildLocalTree: buildTree,
    buildRemoteTree,
  };
}

async function resolvePersistedResumeContext(
  cursor: NonNullable<ReturnType<typeof useWorkPlaybackCursor>["cursor"]>,
  localDirectoryWork: WorkDetail | null,
  playbackTree: TreeNode,
) {
  const resumeWork =
    cursor.mediaWorkId && cursor.mediaWorkId !== localDirectoryWork?.id
      ? await api.getWork(cursor.mediaWorkId)
      : localDirectoryWork;
  if (!resumeWork) throw new Error("The saved playback edition is unavailable.");
  return {
    resumeWork,
    resumeTree:
      resumeWork.id === localDirectoryWork?.id
        ? playbackTree
        : buildTree(resumeWork.mediaItems, null, resumeWork.primaryCode),
  };
}

async function resolvePersistedTrackedPresence({
  activePresence,
  selectedRemoteSource,
  selectedRemoteWorkCode,
  work,
}: {
  activePresence: SourcePresenceItem | null;
  selectedRemoteSource: RemoteSourceAvailability | null | undefined;
  selectedRemoteWorkCode: string;
  work: WorkDetail;
}) {
  if (activePresence || !selectedRemoteSource?.summary.hasTracked) return activePresence;
  const currentWork = await api.getWork(work.id);
  return trackedPresenceForRemoteSource(currentWork, selectedRemoteSource.source.id, selectedRemoteWorkCode);
}

function persistedDirectoryDescription({
  selectedTrackedPresence,
  selectedTrackedForked,
  selectedSource,
  selectedRemoteSource,
  workHasNoLinkedSource,
}: {
  selectedTrackedPresence: SourcePresenceItem | null;
  selectedTrackedForked: boolean;
  selectedSource: SourceTabInfo | null | undefined;
  selectedRemoteSource: RemoteSourceAvailability | null | undefined;
  workHasNoLinkedSource: boolean;
}) {
  if (selectedTrackedPresence) {
    if (selectedTrackedForked) {
      const sourceName =
        selectedTrackedPresence.fileSourceName || selectedTrackedPresence.fileSourceCode || "the selected source";
      return `Browsing the tracked directory forked from ${sourceName}.`;
    }
    const sourceName =
      selectedTrackedPresence.fileSourceName || selectedTrackedPresence.fileSourceCode || "The selected source";
    return `${sourceName} is tracked, but its directory has not been forked.`;
  }
  if (selectedSource?.kind === "tracked") {
    return "This work is not tracked yet. Track a remote source to keep a browsable source relationship.";
  }
  if (selectedRemoteSource) {
    return `Previewing remote files from ${selectedRemoteSource.source.displayName}.`;
  }
  if (workHasNoLinkedSource) {
    return "No local, cached, tracked, or remote source is currently linked to this work.";
  }
  return "File locations are grouped by local, cache, and remote source.";
}

function persistedDetailActionMode(
  selectedRemoteSource: RemoteSourceAvailability | null | undefined,
  selectedTrackedPresence: SourcePresenceItem | null,
  selectedTrackedForked: boolean,
  selectedSource: SourceTabInfo | null | undefined,
): DetailActionMode {
  if (selectedRemoteSource) return "remote_source";
  if (selectedTrackedPresence) return selectedTrackedForked ? "tracked_forked" : "tracked_unforked";
  return selectedSource?.kind === "tracked" ? "tracked_unforked" : "local";
}

function persistedTrackingActionState({
  work,
  selectedRemoteSource,
  selectedRemoteWorkCode,
  selectedTrackedPresence,
}: {
  work: WorkDetail | null;
  selectedRemoteSource: RemoteSourceAvailability | null | undefined;
  selectedRemoteWorkCode: string;
  selectedTrackedPresence: SourcePresenceItem | null;
}) {
  const selectedRemoteTrackedPresence = selectedRemoteSource
    ? trackedPresenceForRemoteSource(work, selectedRemoteSource.source.id, selectedRemoteWorkCode)
    : null;
  const activeTrackedPresence = selectedTrackedPresence ?? selectedRemoteTrackedPresence;
  const selectedRemoteHasTracked = Boolean(selectedRemoteTrackedPresence || selectedRemoteSource?.summary.hasTracked);
  return {
    activeTrackedPresence,
    selectedRemoteHasTracked,
    hasTrackedSource: Boolean(activeTrackedPresence || selectedRemoteHasTracked),
    canTrackRemote: Boolean(selectedRemoteSource?.detail?.primaryCode && !selectedRemoteHasTracked),
  };
}

function persistedDirectoryLoadState({
  work,
  selectedRemoteSource,
  selectedRemoteDetail,
  selectedRemoteTreeError,
  selectedRemoteTreeLoading,
  mediaError,
  isDirectoryLoading,
}: {
  work: WorkDetail | null;
  selectedRemoteSource: RemoteSourceAvailability | null | undefined;
  selectedRemoteDetail: RemoteWorkDetail | null;
  selectedRemoteTreeError: string;
  selectedRemoteTreeLoading: boolean;
  mediaError: string;
  isDirectoryLoading: boolean;
}) {
  const sourceDetailsLoading = Boolean(
    selectedRemoteSource &&
    !selectedRemoteDetail &&
    !selectedRemoteSource.error &&
    remoteSourceCanBrowse(selectedRemoteSource.summary),
  );
  const mediaLoadError = selectedRemoteSource ? selectedRemoteTreeError : mediaError;
  return {
    sourceDetailsLoading,
    mediaLoadError,
    showSkeleton: !mediaLoadError && (!work || isDirectoryLoading || sourceDetailsLoading || selectedRemoteTreeLoading),
  };
}

type PersistedDetailActionsProps = {
  work: WorkDetail | null;
  favoriteLists: FavoriteList[];
  favoriteSelected: boolean;
  playbackCursorLoading: boolean;
  hasResumableCursor: boolean;
  activeMetadataRunId: number | null;
  isSyncingDetail: boolean;
  canSyncMetadata: boolean;
  fetchBusy: boolean;
  isRefreshingLocalFiles: boolean;
  cleanupBusy: boolean;
  isResuming: boolean;
  actionMode: DetailActionMode;
  sourceContextKey: string;
  selectedRemoteSource: RemoteSourceAvailability | null | undefined;
  canTrackRemote: boolean;
  selectedSourceDetailsLoading: boolean;
  selectedRemoteHasTracked: boolean;
  hasTrackedSourceForAction: boolean;
  forkSources: RemoteSourceAvailability[];
  currentForkSource: RemoteSourceAvailability | null;
  fetchRemote: RemoteSourceAvailability | undefined;
  selectedRemoteDetail: RemoteWorkDetail | null;
  activeSourceLabel: string;
  sourceStatus: string;
  selectedTrackedPresence: SourcePresenceItem | null;
  trackedCacheAvailable: boolean;
  selectedSource: SourceTabInfo | null | undefined;
  onEnsureListWork: () => Promise<number | null>;
  onListSaved: (favorite: boolean, workID: number) => void;
  onResume: () => void;
  onMark: (status: ListeningStatus) => void;
  onSyncMetadata: () => void;
  onEditMetadata: () => void;
  onTrack: () => void;
  onUntrack: () => void;
  onFork: (remote: RemoteSourceAvailability) => void;
  onFetch: () => void;
  onManage: () => void;
  onRefreshLocalFiles: () => void;
};

function PersistedIdentityActions(props: PersistedDetailActionsProps) {
  if (!props.work) return <DetailSkeletonActions />;
  const busy =
    props.isSyncingDetail || props.fetchBusy || props.isRefreshingLocalFiles || props.cleanupBusy || props.isResuming;
  return (
    <WorkIdentityActionBar
      busy={busy}
      listeningStatus={props.work.listeningStatus}
      favorite={props.favoriteLists.length > 0 ? props.favoriteSelected : props.work.favorite}
      listWorkId={props.work.id}
      onEnsureListWork={props.onEnsureListWork}
      onListSaved={props.onListSaved}
      onResume={!props.playbackCursorLoading && props.hasResumableCursor ? props.onResume : undefined}
      onMark={props.onMark}
      onSync={props.canSyncMetadata ? props.onSyncMetadata : undefined}
      onEditMetadata={props.onEditMetadata}
      metadataSyncBusy={props.isSyncingDetail || Boolean(props.activeMetadataRunId)}
      syncLabel="Refresh metadata"
    />
  );
}

function persistedTrackDisabledReason(props: PersistedDetailActionsProps) {
  if (props.selectedSourceDetailsLoading) return "Loading source details";
  if (props.selectedRemoteSource?.error) return "Source details unavailable";
  if (props.selectedRemoteHasTracked) return "Already tracked";
  return "Source unavailable";
}

function persistedMediaActionBindings(props: PersistedDetailActionsProps) {
  const canFetch = Boolean(props.fetchRemote && remoteSourceCanBrowse(props.fetchRemote.summary));
  return {
    onTrack: props.selectedRemoteSource ? props.onTrack : undefined,
    trackDisabled: props.selectedRemoteSource ? !props.canTrackRemote : undefined,
    onUntrack: props.hasTrackedSourceForAction ? props.onUntrack : undefined,
    onFetch: canFetch ? props.onFetch : undefined,
    onManageCache: props.selectedTrackedPresence ? props.onManage : undefined,
    manageCacheDisabled: Boolean(props.selectedTrackedPresence) && !props.trackedCacheAvailable,
    onManageFiles: props.actionMode === "local" ? props.onManage : undefined,
    onRefreshLocalFiles:
      props.actionMode === "local" && props.selectedSource?.kind === "local" ? props.onRefreshLocalFiles : undefined,
  };
}

function PersistedMediaActions(props: PersistedDetailActionsProps) {
  if (!props.work) return null;
  const busy = props.isSyncingDetail || props.fetchBusy || props.isRefreshingLocalFiles || props.cleanupBusy;
  const actions = persistedMediaActionBindings(props);
  return (
    <MediaContextActionBar
      busy={busy}
      mode={props.actionMode}
      contextKey={props.sourceContextKey}
      trackDisabledReason={persistedTrackDisabledReason(props)}
      untrackDisabled={props.isSyncingDetail}
      forkSources={props.forkSources}
      currentForkSource={props.currentForkSource}
      onFork={props.onFork}
      remoteSourceWorkUrl={safeExternalHTTPURL(props.selectedRemoteDetail?.publicWorkUrl)}
      remoteSourceName={props.selectedRemoteSource?.source.displayName ?? props.selectedRemoteDetail?.sourceName}
      sourceLabel={props.activeSourceLabel}
      sourceStatus={props.sourceStatus}
      sourceDetailsLoading={props.selectedSourceDetailsLoading}
      {...actions}
    />
  );
}

function PersistedDetailActions(props: PersistedDetailActionsProps) {
  return (
    <>
      <PersistedIdentityActions {...props} />
      <PersistedMediaActions {...props} />
    </>
  );
}

type PersistedDirectoryPanelProps = {
  activeEdition: WorkDetail | null;
  description: string;
  tabs: SourceTabInfo[];
  activeKey: string;
  trackedPresenceOptions: TrackedPresenceOption[];
  selectedTrackedPresenceKey: string;
  checkingSources: boolean;
  checkedAt: string;
  directoryMode: DirectoryMode;
  root: TreeNode;
  directoryStats: TreeStats;
  directoryRoutingRules: DirectoryRoutingRule[];
  currentLocationId: number | null;
  currentPlaybackKey: string | null;
  showNoSourceDirectory: boolean;
  selectedRemoteSource: RemoteSourceAvailability | null | undefined;
  selectedSource: SourceTabInfo | null | undefined;
  selectedTrackedForked: boolean;
  selectedTrackedPresence: SourcePresenceItem | null;
  remoteSources: RemoteSourceAvailability[];
  showDirectorySkeleton: boolean;
  directoryMediaError: string;
  cleanupRunId: number | null;
  cleanupRunStatus: string;
  message: string;
  selectedRemoteDetail: RemoteWorkDetail | null;
  selectionModal: ReactNode;
  onActiveKeyChange: (key: string) => void;
  onTrackedPresenceChange: (key: string) => void;
  onCheckSources: () => void;
  onDirectoryModeChange: (mode: DirectoryMode) => void;
  onRetry: () => void;
  onSelectRemote: (remote: RemoteSourceAvailability) => void;
  onOpenCleanupRun: () => void;
  onPlayLocal: (tracks: TreeTrack[], locationId: number) => void;
  onPlayRemote: (tracks: TreeTrack[], locationId: number) => void;
  onQueue: (track: TreeTrack, next: boolean) => void;
  onPreview: (preview: FilePreviewState) => void;
};

function persistedDirectoryEmptyLabel(props: PersistedDirectoryPanelProps) {
  if (props.showNoSourceDirectory) return "No source linked.";
  if (props.selectedRemoteSource) return "No remote files detected.";
  return "No local files detected.";
}

function persistedDirectoryToolbar(props: PersistedDirectoryPanelProps) {
  if (props.cleanupRunId) {
    return (
      <DirectoryOperationBanner
        runId={props.cleanupRunId}
        status={props.cleanupRunStatus}
        onOpen={props.onOpenCleanupRun}
      />
    );
  }
  if (props.message) return <DirectoryMessage message={props.message} />;
  return null;
}

function persistedDirectorySourceState(props: PersistedDirectoryPanelProps) {
  if (props.selectedSource?.kind === "local" && props.selectedSource.status !== "available") {
    return (
      <LocalSourceStatePanel
        status={props.selectedSource.status}
        remoteSources={props.remoteSources}
        onSelectRemote={props.onSelectRemote}
      />
    );
  }
  if (props.selectedRemoteSource && !remoteSourceCanBrowse(props.selectedRemoteSource.summary)) {
    return <RemoteSourceStatePanel remote={props.selectedRemoteSource} />;
  }
  if (props.selectedSource?.kind === "tracked" && !props.selectedTrackedForked) {
    return <TrackedUnforkedPanel presence={props.selectedTrackedPresence} remoteSources={props.remoteSources} />;
  }
  if (props.showNoSourceDirectory) {
    return (
      <NoSourceDirectoryPanel
        checking={props.checkingSources}
        checkedAt={props.checkedAt}
        remoteSources={props.remoteSources}
        onRefresh={props.onCheckSources}
      />
    );
  }
  return null;
}

function persistedDirectoryEmptyState(props: PersistedDirectoryPanelProps) {
  if (props.showDirectorySkeleton) return <DirectorySkeleton />;
  if (props.directoryMediaError) {
    return <DirectoryLoadErrorPanel message={props.directoryMediaError} onRetry={props.onRetry} />;
  }
  return persistedDirectorySourceState(props);
}

function persistedDirectoryLoadingMessage(props: PersistedDirectoryPanelProps) {
  if (!props.selectedRemoteSource || props.selectedRemoteDetail || props.selectedRemoteSource.loading) return "";
  return props.selectedRemoteSource.error || "Remote directory is not loaded yet.";
}

function PersistedDirectoryPanel(props: PersistedDirectoryPanelProps) {
  const description = props.activeEdition
    ? `Showing files from ${props.activeEdition.primaryCode} ${languageLabel(props.activeEdition.metadataLanguage)}.`
    : props.description;
  const emptyState = persistedDirectoryEmptyState(props);
  return (
    <SourceDirectoryPanel
      title="Directory"
      description={description}
      statsLabel={formatTreeStats(props.directoryStats)}
      tabs={props.tabs}
      activeKey={props.activeKey}
      onActiveKeyChange={props.onActiveKeyChange}
      trackedPresenceOptions={props.trackedPresenceOptions}
      selectedTrackedPresenceKey={props.selectedTrackedPresenceKey}
      onTrackedPresenceChange={props.onTrackedPresenceChange}
      checkingSources={props.checkingSources}
      checkedAt={props.checkedAt}
      onCheckSources={props.onCheckSources}
      directoryMode={props.directoryMode}
      onDirectoryModeChange={props.onDirectoryModeChange}
      root={props.root}
      directoryRoutingRules={props.directoryRoutingRules}
      currentLocationId={props.currentLocationId}
      currentPlaybackKey={props.currentPlaybackKey}
      emptyLabel={persistedDirectoryEmptyLabel(props)}
      toolbar={persistedDirectoryToolbar(props)}
      selectionModal={props.selectionModal}
      emptyState={emptyState}
      loadingMessage={persistedDirectoryLoadingMessage(props)}
      onPlayFolder={props.selectedRemoteDetail ? props.onPlayRemote : props.onPlayLocal}
      onPlayNext={(track) => props.onQueue(track, true)}
      onAppendQueue={(track) => props.onQueue(track, false)}
      onPreview={props.onPreview}
    />
  );
}

function persistedPersonalTags(work: WorkDetail | null, onSave: (tags: string[]) => Promise<void>) {
  if (!work) return undefined;
  return (
    <div className="space-y-2 rounded-lg border bg-card p-3">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Tags className="h-4 w-4" />
        My tags
      </div>
      <UserTagRow tags={work.userTags ?? []} onSave={onSave} />
    </div>
  );
}

function persistedActiveSourceLabel(
  selectedTrackedPresence: SourcePresenceItem | null,
  selectedSource: SourceTabInfo | null | undefined,
) {
  return (
    selectedTrackedPresence?.fileSourceName ||
    selectedTrackedPresence?.fileSourceCode ||
    selectedSource?.sourceName ||
    selectedSource?.label ||
    "Source"
  );
}

function persistedSourceInfo({
  label,
  selectedSource,
  directoryStats,
  isDirectoryLoading,
  selectedSourceDetailsLoading,
  selectedRemoteDetail,
  fallbackDurationSeconds,
}: {
  label: string;
  selectedSource: SourceTabInfo | null | undefined;
  directoryStats: TreeStats;
  isDirectoryLoading: boolean;
  selectedSourceDetailsLoading: boolean;
  selectedRemoteDetail: RemoteWorkDetail | null;
  fallbackDurationSeconds: number | null;
}): ActiveSourceInfoModel {
  const source = selectedSource
    ? { kind: selectedSource.kind, status: selectedSource.status, statusLabel: selectedSource.statusLabel }
    : { kind: "no_source" as const, status: "degraded" as const, statusLabel: "Loading source" };
  return {
    label,
    ...source,
    stats: directoryStats,
    loading: isDirectoryLoading || selectedSourceDetailsLoading,
    metadataDurationSeconds: selectedRemoteDetail?.durationSeconds ?? fallbackDurationSeconds,
  };
}

function persistedDisplayTranslations(
  localDirectoryWork: WorkDetail | null,
  selectedRemoteDetail: RemoteWorkDetail | null,
) {
  const localTranslations = localDirectoryWork?.translations ?? [];
  return selectedRemoteDetail
    ? mergeRemoteWorkVersions(localTranslations, selectedRemoteDetail.languageEditions ?? [])
    : localTranslations;
}

type PersistedPresentationWorkFields = {
  dlsiteUrl: string;
  title: string;
  seriesTitleId: string;
  seriesCircleExternalId: string;
  baseCode: string | undefined;
  metadataLanguage: string | undefined;
  metadataPresentation: WorkMetadataPresentation | undefined;
  activeMetadataVariantKey: string;
  voiceCredits: VoiceCredit[];
  tags: string[];
};

function persistedPresentationWorkFields(
  work: WorkDetail | null,
  activeMetadataVariant: ReturnType<typeof resolveMetadataVariant>,
  hero: ReturnType<typeof detailHeroModel>,
): PersistedPresentationWorkFields {
  if (!work) {
    return {
      dlsiteUrl: "",
      title: hero.title,
      seriesTitleId: "",
      seriesCircleExternalId: "",
      baseCode: undefined,
      metadataLanguage: undefined,
      metadataPresentation: undefined,
      activeMetadataVariantKey: "",
      voiceCredits: [],
      tags: hero.tags,
    };
  }
  return {
    dlsiteUrl: work.dlsiteUrl ?? "",
    title: work.manualOverrides?.title ?? activeMetadataVariant?.title ?? hero.title,
    seriesTitleId: work.seriesTitleId ?? "",
    seriesCircleExternalId: work.seriesCircleExternalId ?? work.circleExternalId ?? "",
    baseCode: work.baseCode,
    metadataLanguage: activeMetadataVariant?.language ?? work.metadataLanguage,
    metadataPresentation: work.metadataPresentation,
    activeMetadataVariantKey: activeMetadataVariant?.key ?? "",
    voiceCredits: work.voiceCredits ?? [],
    tags: activeMetadataVariant?.tags ?? hero.tags,
  };
}

function persistedWorkDetailPresentation({
  hero,
  work,
  activeMetadataVariant,
  sourceInfo,
  displayTranslations,
  activeEditionCode,
  selectedRemoteDetail,
  personalTags,
  loading,
  metadataSync,
  canSyncMetadata,
  metadataSyncBusy,
  onSyncMetadata,
  onMetadataVariantSelect,
  onVersionSelect,
}: {
  hero: ReturnType<typeof detailHeroModel>;
  work: WorkDetail | null;
  activeMetadataVariant: ReturnType<typeof resolveMetadataVariant>;
  sourceInfo: ActiveSourceInfoModel;
  displayTranslations: WorkDetail["translations"];
  activeEditionCode: string;
  selectedRemoteDetail: RemoteWorkDetail | null;
  personalTags: ReactNode;
  loading: boolean;
  metadataSync?: WorkMetadataSyncStatus;
  canSyncMetadata: boolean;
  metadataSyncBusy: boolean;
  onSyncMetadata: () => void;
  onMetadataVariantSelect: (key: string) => void;
  onVersionSelect: (translation: WorkDetail["translations"][number]) => void;
}): UnifiedWorkDetailPresentation {
  const fields = persistedPresentationWorkFields(work, activeMetadataVariant, hero);
  return {
    coverUrl: hero.coverUrl,
    fallbackCode: hero.primaryCode,
    code: hero.primaryCode,
    dlsiteUrl: fields.dlsiteUrl,
    title: fields.title,
    circle: hero.circle,
    circleExternalId: hero.circleExternalId,
    series: hero.series,
    seriesTitleId: fields.seriesTitleId,
    seriesCircleExternalId: fields.seriesCircleExternalId,
    ratingLabel: "DL rating",
    rating: hero.rating,
    ratingCount: hero.ratingCount,
    sales: hero.sales,
    baseCode: fields.baseCode,
    metadataLanguage: fields.metadataLanguage,
    metadataPresentation: fields.metadataPresentation,
    metadataSync,
    canSyncMetadata,
    metadataSyncBusy,
    onSyncMetadata,
    activeMetadataVariantKey: fields.activeMetadataVariantKey,
    onMetadataVariantSelect,
    translations: displayTranslations,
    activeVersionCode: activeEditionCode || selectedRemoteDetail?.remoteCode || hero.primaryCode,
    onVersionSelect,
    remoteVersions: Boolean(selectedRemoteDetail),
    dlsiteFetchedAt: hero.dlsiteFetchedAt,
    releaseDate: hero.releaseDate ?? "Unknown",
    ageRating: hero.ageRating,
    sourceInfo,
    voiceActors: hero.voiceActors,
    voiceCredits: fields.voiceCredits,
    tags: fields.tags,
    personalTags,
    loading,
  };
}

function PersistedFilePreviewOverlay({
  preview,
  work,
  toast,
  onClose,
  onMetadataSaved,
}: {
  preview: FilePreviewState | null;
  work: WorkDetail | null;
  toast: ReturnType<typeof useToast>;
  onClose: () => void;
  onMetadataSaved: () => Promise<void>;
}) {
  if (!preview) return null;
  const onSetCover = work
    ? async (locationId: number) => {
        try {
          await api.setWorkCoverOverride(work.id, locationId);
          toast.success("Cover override saved.");
          onClose();
          await onMetadataSaved();
        } catch (error) {
          toast.notify(toastFromError(error, "Cover override could not be saved."));
        }
      }
    : undefined;
  return <FilePreviewModal preview={preview} onClose={onClose} onSetCover={onSetCover} />;
}

function PersistedDirectoryManagerOverlay({
  open,
  root,
  selectedTrackedPresence,
  showNoSourceDirectory,
  selectedRemoteSource,
  deleting,
  onDeleteTargets,
  workID,
  canForgetWork,
  localRoot,
  onClose,
}: {
  open: boolean;
  root: TreeNode;
  selectedTrackedPresence: SourcePresenceItem | null;
  showNoSourceDirectory: boolean;
  selectedRemoteSource: RemoteSourceAvailability | null | undefined;
  deleting: boolean;
  onDeleteTargets: (targets: MediaDeleteTarget[], mode: MediaCleanupMode) => void;
  workID: number;
  canForgetWork: boolean;
  localRoot: { folderId: number; path: string } | null;
  onClose: () => void;
}) {
  if (!open) return null;
  const title = selectedTrackedPresence ? "Manage cache" : "Manage files";
  const description = selectedTrackedPresence
    ? "Review cached files for this tracked source."
    : "Review file operations in the same folder structure as the directory tree.";
  const emptyLabel = selectedTrackedPresence
    ? "No cached files detected."
    : showNoSourceDirectory
      ? "No source linked."
      : selectedRemoteSource
        ? "No remote files detected."
        : "No local files detected.";
  return (
    <DirectoryManagerModal
      root={root}
      title={title}
      description={description}
      emptyLabel={emptyLabel}
      onClose={onClose}
      deleting={deleting}
      onDeleteTargets={onDeleteTargets}
      workId={workID}
      canForgetWork={canForgetWork}
      allowCacheDelete={!selectedRemoteSource}
      allowLocalDelete={!selectedRemoteSource && !selectedTrackedPresence}
      localRoot={localRoot}
      showCachedFilter={Boolean(selectedTrackedPresence)}
    />
  );
}

function PersistedMetadataEditorOverlay({
  open,
  work,
  onClose,
  onSaved,
}: {
  open: boolean;
  work: WorkDetail | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  if (!open || !work) return null;
  return <WorkMetadataEditorModal work={work} onClose={onClose} onSaved={onSaved} />;
}

function PersistedReforkOverlay({
  target,
  busy,
  onClose,
  onConfirm,
}: {
  target: ReforkTarget | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: (remote: RemoteSourceAvailability) => void;
}) {
  if (!target) return null;
  return (
    <ReforkConfirmModal
      currentName={target.current?.source.displayName ?? "the current fork"}
      nextName={target.next.source.displayName}
      busy={busy}
      onClose={onClose}
      onConfirm={() => onConfirm(target.next)}
    />
  );
}

type RemoteOnlyDetailLoadOutcome =
  { kind: "loaded" } | { kind: "not_found" } | { kind: "failed"; message: string } | { kind: "cancelled" };

function remoteOnlyLoadCancelled(error: unknown, timedOut: boolean) {
  return error instanceof DOMException && error.name === "AbortError" && !timedOut;
}

function remoteOnlyTreeErrorMessage(error: unknown, timedOut: boolean) {
  if (timedOut) return "Remote directory timed out. Retry to try again.";
  return error instanceof Error ? error.message : "Remote directory failed.";
}

function remoteOnlyDetailErrorOutcome(error: unknown, timedOut: boolean): RemoteOnlyDetailLoadOutcome {
  if (remoteOnlyLoadCancelled(error, timedOut)) return { kind: "cancelled" };
  if (error instanceof ApiError && error.status === 404) return { kind: "not_found" };
  return {
    kind: "failed",
    message: timedOut
      ? "Remote preview timed out. Retry to try again."
      : error instanceof Error
        ? error.message
        : "Remote preview failed.",
  };
}

async function loadRemoteOnlyDetail({
  sourceID,
  code,
  signal,
  didTimeOut,
  onMetadata,
  onTracks,
  onTreeError,
}: {
  sourceID: number;
  code: string;
  signal: AbortSignal;
  didTimeOut: () => boolean;
  onMetadata: (detail: RemoteWorkDetail) => void;
  onTracks: (tracks: RemoteTrack[]) => void;
  onTreeError: (message: string) => void;
}): Promise<RemoteOnlyDetailLoadOutcome> {
  try {
    const metadata = await api.getRemoteSourceWorkMetadata(sourceID, code, signal);
    if (signal.aborted) return { kind: "cancelled" };
    onMetadata({ ...metadata, tracks: [] });
    try {
      const tracks = await api.getRemoteSourceWorkTracks(sourceID, metadata.remoteCode || code, signal);
      if (!signal.aborted) onTracks(tracks.tracks);
    } catch (error) {
      const timedOut = didTimeOut();
      if (remoteOnlyLoadCancelled(error, timedOut)) return { kind: "cancelled" };
      onTreeError(remoteOnlyTreeErrorMessage(error, timedOut));
    }
    return { kind: "loaded" };
  } catch (error) {
    return remoteOnlyDetailErrorOutcome(error, didTimeOut());
  }
}

function PersistedWorkDetailController({
  code,
  work,
  workPreview,
  mediaLoading,
  mediaError,
  sources,
  initialSourceIntent,
  initialTrackedSourceID,
  initialRemoteCode,
  principalID,
  canForgetWork,
  canSyncMetadata,
  onBack,
  onStatusChange,
  onPlay,
  onWorkReload,
  onWorksChanged,
}: {
  code: string;
  work: WorkDetail | null;
  workPreview: WorkPreview | null;
  mediaLoading: boolean;
  mediaError: string;
  sources: LibrarySource[];
  initialSourceIntent: DetailSourceIntent;
  initialTrackedSourceID: number | null;
  initialRemoteCode: string;
  principalID: ClientPrincipalID;
  canForgetWork: boolean;
  canSyncMetadata: boolean;
  onBack: () => void;
  onStatusChange: (workID: number, status: ListeningStatus) => Promise<void>;
  onPlay: () => void;
  onWorkReload: (workID: number, includeMedia?: boolean) => Promise<void>;
  onWorksChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const sourceContext = useWorkSourceContext({
    code,
    work,
    sources,
    initialSourceIntent,
    initialTrackedSourceID,
    initialRemoteCode,
  });
  const {
    remoteSources,
    sourceTabs,
    activeSourceKey,
    setActiveSourceKey,
    selectSource,
    selectTrackedPresence,
    selectRemoteEdition,
    trackedPresenceOptions,
    selectedTrackedPresenceKey,
    selectedSource,
    resolvedActiveSourceKey,
    selectedRemoteSource,
    selectedTrackedPresence,
    selectedTrackedForked,
    selectedTrackedSourceID,
    selectedTrackedRemoteSource,
    selectedRemoteDetail,
    selectedRemoteTreeLoading,
    selectedRemoteTreeError,
    selectedRemoteSourceID,
    selectedRemoteWorkCode,
    isCheckingSources,
    sourceCheckedAt,
    refreshAvailability,
  } = sourceContext;
  const [directoryMode, setDirectoryMode] = useState<DirectoryMode>("browse");
  const [isManageOpen, setIsManageOpen] = useState(false);
  const [isMetadataEditorOpen, setIsMetadataEditorOpen] = useState(false);
  const [preview, setPreview] = useState<FilePreviewState | null>(null);
  const [isRefreshingLocalFiles, setIsRefreshingLocalFiles] = useState(false);
  const [message, setMessage] = useState("");
  const [isSyncingDetail, setIsSyncingDetail] = useState(false);
  const [activeMetadataRunId, setActiveMetadataRunId] = useState<number | null>(null);
  const metadataRun = useWorkflowRunWatcher(activeMetadataRunId);
  const [favoriteLists, setFavoriteLists] = useState<FavoriteList[]>([]);
  const [activeEdition, setActiveEdition] = useState<WorkDetail | null>(null);
  const [activeEditionCode, setActiveEditionCode] = useState("");
  const [selectedMetadataVariantKey, setSelectedMetadataVariantKey] = useState("");
  const [isResuming, setIsResuming] = useState(false);
  const [reforkTarget, setReforkTarget] = useState<ReforkTarget | null>(null);
  const [directoryRoutingRules, setDirectoryRoutingRules] =
    useState<DirectoryRoutingRule[]>(defaultDirectoryRoutingRules);
  const [mobileDetailTab, setMobileDetailTab] = useState<"info" | "directory">("directory");
  const isCompactDetailLayout = useCompactDetailLayout();
  const localDirectoryWork = activeEdition ?? work;
  const localRoot = useMemo(() => {
    const sourceID = selectedSource?.fileSourceId;
    if (!localDirectoryWork || !sourceID) return null;
    const folders = (localDirectoryWork.localFolders ?? []).filter(
      (folder) =>
        folder.workId === localDirectoryWork.id &&
        folder.fileSourceId === sourceID &&
        folder.state === "active" &&
        folder.rootPath.trim() !== "",
    );
    if (folders.length !== 1) return null;
    return { folderId: folders[0].id, path: folders[0].rootPath };
  }, [localDirectoryWork, selectedSource?.fileSourceId]);
  const { tree, isDirectoryLoading } = useMediaTree(
    persistedMediaTreeInput({
      mediaLoading,
      localDirectoryWork,
      work,
      selectedTrackedForked,
      selectedTrackedSourceID,
      selectedSource,
      selectedRemoteSource,
      selectedRemoteSourceID,
      selectedRemoteDetail,
      selectedTrackedPresence,
    }),
  );
  const allTracks = useMemo(() => flattenTracks(tree), [tree]);
  const directoryStats = useMemo(() => treeStats(tree), [tree]);
  const playbackTree = useMemo(
    () =>
      localDirectoryWork ? buildTree(localDirectoryWork.mediaItems, null, localDirectoryWork.primaryCode) : emptyTree(),
    [localDirectoryWork],
  );
  const { cursor: playbackCursor, isLoading: playbackCursorLoading } = useWorkPlaybackCursor(work?.id ?? null);
  const hasResumableCursor = hasResumablePlaybackCursor(playbackCursor);
  const { remote: fetchRemote, code: fetchRemoteCode } = persistedFetchTarget(
    selectedRemoteSource,
    selectedTrackedRemoteSource,
    selectedRemoteWorkCode,
    selectedTrackedPresence,
    work,
    code,
  );
  const trackedCacheAvailable = useMemo(
    () =>
      Boolean(
        selectedTrackedSourceID &&
        localDirectoryWork?.mediaItems.some((item) =>
          item.locations.some(
            (location) =>
              location.fileSourceId === selectedTrackedSourceID &&
              location.locationType === "cache" &&
              location.availability === "available",
          ),
        ),
      ),
    [localDirectoryWork?.mediaItems, selectedTrackedSourceID],
  );
  const managementTree = useMemo(
    () =>
      !isManageOpen
        ? emptyTree()
        : selectedTrackedPresence && localDirectoryWork && selectedTrackedSourceID
          ? buildTree(localDirectoryWork.mediaItems, selectedTrackedSourceID, localDirectoryWork.primaryCode)
          : tree,
    [isManageOpen, localDirectoryWork, selectedTrackedPresence, selectedTrackedSourceID, tree],
  );
  const player = useLibraryPlayer();
  const fetchWorkspace = useRemoteFetchWorkspace({ onWorksChanged });
  const openFetchWorkspace = () => {
    if (!fetchRemote) return;
    void fetchWorkspace.open({
      sourceId: fetchRemote.source.id,
      remoteCode: fetchRemoteCode,
      canonicalCode: work?.primaryCode ?? code,
      sourceDisplayName: fetchRemote.source.displayName,
      detail: fetchRemote.detail,
    });
  };
  const mediaCleanup = useMediaCleanupWorkflow({
    onAccepted: () => setIsManageOpen(false),
    onCompleted: async ({ workForgotten, partial }: MediaCleanupCompletion) => {
      await onWorksChanged();
      if (workForgotten && !partial) {
        onBack();
        return;
      }
      if (activeEdition) {
        setActiveEdition(await api.getWork(activeEdition.id));
      } else if (work) {
        await onWorkReload(work.id, true);
      }
    },
  });
  const workHasNoLinkedSource = Boolean(work && workHasNoSource(work));
  const showNoSourceDirectory = workHasNoLinkedSource && !selectedRemoteSource && !selectedTrackedPresence;
  const directoryDescription = persistedDirectoryDescription({
    selectedTrackedPresence,
    selectedTrackedForked,
    selectedSource,
    selectedRemoteSource,
    workHasNoLinkedSource,
  });
  const favoriteSelected = favoriteLists.some((list) => list.kind === "user" && list.selected);
  const isDetailLoading = !work;
  const actionMode = persistedDetailActionMode(
    selectedRemoteSource,
    selectedTrackedPresence,
    selectedTrackedForked,
    selectedSource,
  );
  const forkSources = availableForkSources(remoteSources);
  const currentForkSource = selectedTrackedRemoteSource ?? selectedRemoteSource ?? null;
  const {
    activeTrackedPresence: activeTrackedPresenceForAction,
    selectedRemoteHasTracked,
    hasTrackedSource: hasTrackedSourceForAction,
    canTrackRemote,
  } = persistedTrackingActionState({ work, selectedRemoteSource, selectedRemoteWorkCode, selectedTrackedPresence });
  const {
    sourceDetailsLoading: selectedSourceDetailsLoading,
    mediaLoadError: directoryMediaError,
    showSkeleton: showDirectorySkeleton,
  } = persistedDirectoryLoadState({
    work,
    selectedRemoteSource,
    selectedRemoteDetail,
    selectedRemoteTreeError,
    selectedRemoteTreeLoading,
    mediaError,
    isDirectoryLoading,
  });

  const saveWorkUserTags = async (tags: string[]) => {
    if (!work) return;
    try {
      await api.setWorkUserTags(work.id, tags);
      await Promise.all([onWorkReload(work.id), onWorksChanged()]);
      toast.success("My tags updated.");
    } catch (error) {
      toast.notify(toastFromError(error, "My tags could not be updated."));
      throw error;
    }
  };

  useEffect(() => {
    setActiveEdition(null);
    setActiveEditionCode("");
    setSelectedMetadataVariantKey("");
  }, [work?.id]);

  useEffect(() => {
    if (!work || activeEditionCode) return;
    const translations = work.translations ?? [];
    const currentVersion = translations.find(
      (translation) => translation.primaryCode.toUpperCase() === work.primaryCode.toUpperCase(),
    );
    if (currentVersion && workVersionAvailableForScope(currentVersion, "local")) return;
    const firstPlayableVersion = translations.find(
      (translation) => translation.workId && workVersionAvailableForScope(translation, "local"),
    );
    if (firstPlayableVersion) {
      void selectEdition(firstPlayableVersion);
    }
  }, [activeEditionCode, work]);

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

  useEffect(() => {
    let cancelled = false;
    api
      .getRuntimeSettings()
      .then((settings) => {
        if (!cancelled) setDirectoryRoutingRules(settings.directoryRoutingRules ?? defaultDirectoryRoutingRules);
      })
      .catch(() => {
        if (!cancelled) setDirectoryRoutingRules(defaultDirectoryRoutingRules);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const playTracks = (tracks: TreeTrack[], locationId: number) => {
    if (!localDirectoryWork || tracks.length === 0) return;
    onPlay();
    player.playQueue(
      tracks.map((track) => toPlayerTrack(track, localDirectoryWork)),
      locationId,
    );
  };

  const resumePlayback = async () => {
    if (!work || !playbackCursor || !hasResumableCursor) return;
    setIsResuming(true);
    try {
      const { resumeWork, resumeTree } = await resolvePersistedResumeContext(
        playbackCursor,
        localDirectoryWork,
        playbackTree,
      );
      const resumeQueue = buildWorkResumeQueue(flattenTracks(resumeTree), resumeWork, playbackCursor);
      if (!resumeQueue) throw new Error("The saved track or source is no longer available.");
      if (resumeWork.id !== localDirectoryWork?.id) {
        setActiveEdition(resumeWork);
        setActiveEditionCode(resumeWork.primaryCode);
      }
      onPlay();
      player.playQueue(resumeQueue.tracks, resumeQueue.locationId, resumeQueue.positionSeconds);
    } catch (error) {
      toast.notify(toastFromError(error, "Saved playback could not be resumed."));
    } finally {
      setIsResuming(false);
    }
  };

  const playRemoteTracks = (tracks: TreeTrack[], locationId: number) => {
    if (!selectedRemoteDetail || tracks.length === 0) return;
    player.playQueue(
      tracks.map((track) => toRemotePreviewPlayerTrack(track, selectedRemoteDetail, flattenTreeFiles(tree))),
      locationId,
    );
  };

  const queueTrack = (track: TreeTrack, next: boolean) => {
    const queuedTrack = selectedRemoteDetail
      ? toRemotePreviewPlayerTrack(track, selectedRemoteDetail, flattenTreeFiles(tree))
      : localDirectoryWork
        ? toPlayerTrack(track, localDirectoryWork)
        : null;
    if (!queuedTrack) return;
    if (next) player.playNext(queuedTrack);
    else player.appendQueue([queuedTrack]);
    toast.info(next ? `Playing ${track.title} next.` : `Added ${track.title} to the queue.`);
  };

  const refreshLocalFiles = async () => {
    const target = localDirectoryWork ?? work;
    if (!target || selectedSource?.kind !== "local") return;
    setIsRefreshingLocalFiles(true);
    setMessage("");
    try {
      const result = await api.refreshWorkLocalFiles(target.id, selectedSource.fileSourceId);
      invalidateCachedWorkMedia(target.id, principalID);
      if (result.workId !== target.id) invalidateCachedWorkMedia(result.workId, principalID);
      const refreshed = await api.getWork(result.workId);
      if (activeEdition || result.workId !== work?.id) {
        setCachedWorkMedia(refreshed.id, principalID, refreshed.mediaItems);
        setActiveEdition(refreshed);
        setActiveEditionCode(refreshed.primaryCode);
      } else {
        await onWorkReload(result.workId, true);
      }
      await onWorksChanged();
      toast.success(`Refreshed ${result.indexedFiles} local files.`);
    } catch (error) {
      toast.notify(toastFromError(error, "Local files could not be refreshed."));
    } finally {
      setIsRefreshingLocalFiles(false);
    }
  };

  const syncDetailMetadata = async () => {
    if (!work?.primaryCode || activeMetadataRunId || isSyncingDetail) return;
    setIsSyncingDetail(true);
    setMessage("");
    try {
      const result = await api.syncWorkMetadata(work.id);
      if (result.runId <= 0 || result.status === "unavailable") {
        await onWorkReload(work.id, true);
        await onWorksChanged();
        toast.notify({
          kind: "warning",
          message: "Metadata source has no record for this work.",
        });
        return;
      }
      setActiveMetadataRunId(result.runId);
      toast.notify({
        kind: "success",
        message: result.deduplicated
          ? `Metadata refresh is already running as workflow #${result.runId}.`
          : `Metadata refresh queued for ${result.primaryCode} as workflow #${result.runId}.`,
        actionLabel: "Activity",
        onAction: () => openActivityRun(result.runId),
      });
    } catch (error) {
      toast.notify(toastFromError(error, "Metadata refresh could not be queued."));
    } finally {
      setIsSyncingDetail(false);
    }
  };

  useEffect(() => {
    const run = metadataRun.run;
    if (!run || !activeMetadataRunId || isActiveWorkflowStatus(run.status)) return;
    setActiveMetadataRunId(null);
    if (run.status === "succeeded" || run.status === "partial") {
      void (async () => {
        try {
          if (work) await onWorkReload(work.id, true);
          await onWorksChanged();
          toast.notify({
            kind: run.status === "succeeded" ? "success" : "warning",
            message: `Metadata workflow #${run.id} ${run.status}.`,
            actionLabel: "Activity",
            onAction: () => openActivityRun(run.id),
          });
        } catch (error) {
          toast.notify(toastFromError(error, "Metadata refreshed, but work detail could not be reloaded."));
        }
      })();
      return;
    }
    toast.notify({
      kind: "error",
      message: `Metadata workflow #${run.id} ${run.status}.`,
      actionLabel: "Activity",
      onAction: () => openActivityRun(run.id),
    });
  }, [activeMetadataRunId, metadataRun.run, onWorkReload, onWorksChanged, toast, work]);

  useEffect(() => {
    const reconcileTrack = (event: Event) => {
      const terminal = (event as CustomEvent<RemoteTrackTerminalDetail>).detail;
      if (
        !terminal ||
        (terminal.status !== "succeeded" && terminal.status !== "partial") ||
        !terminal.workId ||
        !work ||
        !remoteSources.some((remote) =>
          isMatchingRemoteTrack(
            terminal,
            remote.source.id,
            remote.summary.primaryCode,
            remote.detail?.primaryCode,
            remote.detail?.remoteCode,
            work.primaryCode,
          ),
        )
      )
        return;
      void Promise.all([onWorkReload(terminal.workId, true), onWorksChanged(), refreshAvailability()]).catch(
        (error) => {
          toast.notify(toastFromError(error, "Track completed, but this detail could not be refreshed."));
        },
      );
    };
    window.addEventListener(REMOTE_TRACK_TERMINAL_EVENT, reconcileTrack);
    return () => window.removeEventListener(REMOTE_TRACK_TERMINAL_EVENT, reconcileTrack);
  }, [onWorkReload, onWorksChanged, refreshAvailability, remoteSources, toast, work]);

  const trackSelectedRemoteSource = async () => {
    if (!selectedRemoteSource?.detail?.primaryCode) return;
    setIsSyncingDetail(true);
    setMessage("");
    try {
      const requestedCode = remoteDetailActionCode(selectedRemoteSource.detail);
      const result = await api.trackRemoteSourceWork(selectedRemoteSource.source.id, requestedCode, "manual_track");
      announceRemoteTrackCreated(selectedRemoteSource.source.id, requestedCode, result);
      toast.notify({
        kind: "info",
        message: result.deduplicated
          ? `Track workflow #${result.runId} is already queued.`
          : `Track workflow #${result.runId} queued.`,
      });
    } catch (error) {
      toast.notify(toastFromError(error, "Track could not be queued."));
    } finally {
      setIsSyncingDetail(false);
    }
  };

  const markDetailWork = async (status: ListeningStatus) => {
    if (!work) return;
    await onStatusChange(work.id, status);
  };

  const ensureDetailListWork = async () => {
    if (!work) return null;
    return work.id;
  };

  const favoriteSaved = async (_favorite: boolean, savedWorkID: number) => {
    if (work && savedWorkID === work.id) {
      const lists = await api.getWorkFavoriteLists(work.id);
      setFavoriteLists(lists);
    }
    await onWorksChanged();
  };

  const metadataSaved = async () => {
    if (!work) return;
    await onWorkReload(work.id);
    await onWorksChanged();
  };

  const refreshSourceAvailability = async () => {
    if (!work?.primaryCode) return;
    setMessage("");
    try {
      const result = await refreshAvailability();
      if (!result) return;
      toast.success("Source availability updated.");
    } catch (error) {
      toast.notify(toastFromError(error, "Source check failed."));
    }
  };

  const untrackSelectedSource = async () => {
    if (!work) return;
    setIsSyncingDetail(true);
    setMessage("");
    try {
      const presence = await resolvePersistedTrackedPresence({
        activePresence: activeTrackedPresenceForAction,
        selectedRemoteSource,
        selectedRemoteWorkCode,
        work,
      });
      if (!presence?.fileSourceId) throw new Error("Tracked source could not be resolved.");
      const sourceID = presence.fileSourceId;
      const ownerWorkID = presence.workId || work.id;
      const sourceName = presence.fileSourceName || presence.fileSourceCode || "the source";
      await api.untrackWorkSource(ownerWorkID, sourceID);
      toast.success(`Untracked ${work.primaryCode} from ${sourceName}.`);
      const remoteToKeep = selectedRemoteSource ?? selectedTrackedRemoteSource;
      if (remoteToKeep) setActiveSourceKey(remoteSourceTabKey(remoteToKeep.source.id));
      await onWorkReload(work.id, true);
      await onWorksChanged();
      try {
        await refreshAvailability();
      } catch {
        // The work detail reload is authoritative; availability can be checked again from Source.
      }
    } catch (error) {
      toast.notify(toastFromError(error, "Untrack failed."));
    } finally {
      setIsSyncingDetail(false);
    }
  };

  const forkTrackedSource = async (remote: RemoteSourceAvailability) => {
    if (!work?.primaryCode) return;
    setIsSyncingDetail(true);
    setMessage("");
    try {
      const requestedCode = remoteAvailabilityRouteCode(remote.summary, work.primaryCode);
      const result = await api.trackRemoteSourceWork(remote.source.id, requestedCode, "manual_fork");
      announceRemoteTrackCreated(remote.source.id, requestedCode, result);
      toast.notify({
        kind: "info",
        message: result.deduplicated
          ? `Fork workflow #${result.runId} is already queued.`
          : `Fork workflow #${result.runId} queued.`,
      });
    } catch (error) {
      toast.notify(toastFromError(error, "Fork could not be queued."));
    } finally {
      setIsSyncingDetail(false);
    }
  };

  const requestForkSource = (remote: RemoteSourceAvailability) => {
    if (selectedTrackedForked || selectedRemoteSource?.summary.hasRemote) {
      setReforkTarget({ current: currentForkSource, next: remote });
      return;
    }
    void forkTrackedSource(remote);
  };

  const selectEdition = async (translation: WorkDetail["translations"][number]) => {
    if (!translation.workId || !work) return;
    setActiveEditionCode(translation.primaryCode);
    if (translation.workId === work.id) {
      setActiveEdition(null);
      setActiveSourceKey("local");
      return;
    }
    const detail = await api.getWork(translation.workId);
    setActiveEdition(detail);
    setActiveSourceKey("local");
  };

  const selectDisplayedEdition = async (translation: WorkDetail["translations"][number]) => {
    if (!selectedRemoteDetail) {
      await selectEdition(translation);
      return;
    }
    const availableFromSelectedRemote = (selectedRemoteDetail.languageEditions ?? []).some(
      (edition) => edition.remoteCode.toUpperCase() === translation.primaryCode.toUpperCase(),
    );
    if (!availableFromSelectedRemote) {
      await selectEdition(translation);
      return;
    }
    setActiveEditionCode(translation.primaryCode);
    const selected = await selectRemoteEdition(translation.primaryCode);
    if (!selected) {
      setActiveEditionCode(selectedRemoteDetail.remoteCode);
      toast.error(`The ${translation.primaryCode} edition is not available from this source.`);
    }
  };

  const changeSourceKey = (key: string) => {
    selectSource(key);
    const nextSource = sourceTabs.find((source) => source.key === key);
    if (nextSource?.kind !== "local") {
      setActiveEdition(null);
      setActiveEditionCode(work?.primaryCode ?? "");
    }
  };

  const changeTrackedPresence = (key: string) => {
    const option = trackedPresenceOptions.find((candidate) => candidate.key === key);
    if (!option) return;
    selectTrackedPresence(key);
    setActiveEdition(null);
    setActiveEditionCode(work?.primaryCode ?? "");
    const search = new URLSearchParams(window.location.search);
    search.set("view", "tracked");
    if (option.presence.fileSourceId) search.set("trackedSource", String(option.presence.fileSourceId));
    else search.delete("trackedSource");
    window.history.replaceState(window.history.state ?? {}, "", `${window.location.pathname}?${search.toString()}`);
  };

  if (!work && !workPreview) {
    return (
      <div className="space-y-4">
        <Button variant="outline" size="sm" onClick={onBack}>
          <ChevronLeft className="h-4 w-4" />
          Back
        </Button>
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">Loading {code}...</CardContent>
        </Card>
      </div>
    );
  }

  const hero = detailHeroModel(code, work, workPreview);
  const activeMetadataVariant = resolveMetadataVariant(work?.metadataPresentation, selectedMetadataVariantKey);
  const personalTags = persistedPersonalTags(work, saveWorkUserTags);
  const fetchSelectionModal = <RemoteFetchWorkspaceDialog workspace={fetchWorkspace} />;
  const activeSourceLabel = persistedActiveSourceLabel(selectedTrackedPresence, selectedSource);
  const sourceInfo = persistedSourceInfo({
    label: activeSourceLabel,
    selectedSource,
    directoryStats,
    isDirectoryLoading,
    selectedSourceDetailsLoading,
    selectedRemoteDetail,
    fallbackDurationSeconds: hero.durationSeconds,
  });
  const heroActions = (
    <PersistedDetailActions
      work={work}
      favoriteLists={favoriteLists}
      favoriteSelected={favoriteSelected}
      playbackCursorLoading={playbackCursorLoading}
      hasResumableCursor={hasResumableCursor}
      activeMetadataRunId={activeMetadataRunId}
      isSyncingDetail={isSyncingDetail}
      canSyncMetadata={canSyncMetadata}
      fetchBusy={fetchWorkspace.isBusy}
      isRefreshingLocalFiles={isRefreshingLocalFiles}
      cleanupBusy={mediaCleanup.isBusy}
      isResuming={isResuming}
      actionMode={actionMode}
      sourceContextKey={`${resolvedActiveSourceKey}:${selectedTrackedPresenceKey}`}
      selectedRemoteSource={selectedRemoteSource}
      canTrackRemote={canTrackRemote}
      selectedSourceDetailsLoading={selectedSourceDetailsLoading}
      selectedRemoteHasTracked={selectedRemoteHasTracked}
      hasTrackedSourceForAction={hasTrackedSourceForAction}
      forkSources={forkSources}
      currentForkSource={currentForkSource}
      fetchRemote={fetchRemote}
      selectedRemoteDetail={selectedRemoteDetail}
      activeSourceLabel={activeSourceLabel}
      sourceStatus={sourceInfo.statusLabel}
      selectedTrackedPresence={selectedTrackedPresence}
      trackedCacheAvailable={trackedCacheAvailable}
      selectedSource={selectedSource}
      onEnsureListWork={ensureDetailListWork}
      onListSaved={favoriteSaved}
      onResume={() => void resumePlayback()}
      onMark={(status) => void markDetailWork(status)}
      onSyncMetadata={() => void syncDetailMetadata()}
      onEditMetadata={() => setIsMetadataEditorOpen(true)}
      onTrack={() => void trackSelectedRemoteSource()}
      onUntrack={() => void untrackSelectedSource()}
      onFork={requestForkSource}
      onFetch={openFetchWorkspace}
      onManage={() => setIsManageOpen(true)}
      onRefreshLocalFiles={() => void refreshLocalFiles()}
    />
  );
  const directoryPanel = (
    <PersistedDirectoryPanel
      activeEdition={activeEdition}
      description={directoryDescription}
      tabs={sourceTabs}
      activeKey={resolvedActiveSourceKey}
      trackedPresenceOptions={trackedPresenceOptions}
      selectedTrackedPresenceKey={selectedTrackedPresenceKey}
      checkingSources={isCheckingSources}
      checkedAt={sourceCheckedAt}
      directoryMode={directoryMode}
      root={tree}
      directoryStats={directoryStats}
      directoryRoutingRules={directoryRoutingRules}
      currentLocationId={player.currentLocationId}
      currentPlaybackKey={player.currentPlaybackKey}
      showNoSourceDirectory={showNoSourceDirectory}
      selectedRemoteSource={selectedRemoteSource}
      selectedSource={selectedSource}
      selectedTrackedForked={selectedTrackedForked}
      selectedTrackedPresence={selectedTrackedPresence}
      remoteSources={remoteSources}
      showDirectorySkeleton={showDirectorySkeleton}
      directoryMediaError={directoryMediaError}
      cleanupRunId={mediaCleanup.activeRunId}
      cleanupRunStatus={mediaCleanup.runStatus}
      message={message}
      selectedRemoteDetail={selectedRemoteDetail}
      selectionModal={fetchSelectionModal}
      onActiveKeyChange={changeSourceKey}
      onTrackedPresenceChange={changeTrackedPresence}
      onCheckSources={() => void refreshSourceAvailability()}
      onDirectoryModeChange={setDirectoryMode}
      onRetry={() => {
        if (selectedRemoteSource) {
          void refreshAvailability();
          selectSource(remoteSourceTabKey(selectedRemoteSource.source.id));
        } else if (work) {
          void onWorkReload(work.id, true);
        }
      }}
      onSelectRemote={(remote) => changeSourceKey(remoteSourceTabKey(remote.source.id))}
      onOpenCleanupRun={() => {
        if (mediaCleanup.activeRunId) openActivityRun(mediaCleanup.activeRunId);
      }}
      onPlayLocal={playTracks}
      onPlayRemote={playRemoteTracks}
      onQueue={queueTrack}
      onPreview={setPreview}
    />
  );
  const displayTranslations = persistedDisplayTranslations(localDirectoryWork, selectedRemoteDetail);
  const presentation = persistedWorkDetailPresentation({
    hero,
    work,
    activeMetadataVariant,
    sourceInfo,
    displayTranslations,
    activeEditionCode,
    selectedRemoteDetail,
    personalTags,
    loading: isDetailLoading,
    metadataSync: work?.metadataSync,
    canSyncMetadata,
    metadataSyncBusy: isSyncingDetail || Boolean(activeMetadataRunId),
    onSyncMetadata: () => void syncDetailMetadata(),
    onMetadataVariantSelect: setSelectedMetadataVariantKey,
    onVersionSelect: (translation) => void selectDisplayedEdition(translation),
  });

  return (
    <UnifiedWorkDetailPage
      presentation={presentation}
      compact={isCompactDetailLayout}
      mobileTab={mobileDetailTab}
      onMobileTabChange={setMobileDetailTab}
      actions={heroActions}
      directory={directoryPanel}
      onBack={onBack}
    >
      <PersistedFilePreviewOverlay
        preview={preview}
        work={work}
        toast={toast}
        onClose={() => setPreview(null)}
        onMetadataSaved={metadataSaved}
      />
      <PersistedDirectoryManagerOverlay
        open={isManageOpen}
        root={managementTree}
        selectedTrackedPresence={selectedTrackedPresence}
        showNoSourceDirectory={showNoSourceDirectory}
        selectedRemoteSource={selectedRemoteSource}
        deleting={mediaCleanup.isSubmitting}
        onDeleteTargets={mediaCleanup.submit}
        workID={localDirectoryWork?.id ?? work?.id ?? 0}
        canForgetWork={canForgetWork}
        localRoot={localRoot}
        onClose={() => setIsManageOpen(false)}
      />
      <PersistedMetadataEditorOverlay
        open={isMetadataEditorOpen}
        work={work}
        onClose={() => setIsMetadataEditorOpen(false)}
        onSaved={() => void metadataSaved()}
      />
      <PersistedReforkOverlay
        target={reforkTarget}
        busy={isSyncingDetail}
        onClose={() => setReforkTarget(null)}
        onConfirm={(remote) => {
          setReforkTarget(null);
          void forkTrackedSource(remote);
        }}
      />
    </UnifiedWorkDetailPage>
  );
}

type UnifiedWorkDetailPresentation = {
  coverUrl: string;
  fallbackCode: string;
  code: string;
  dlsiteUrl: string;
  title: string;
  circle: string;
  circleExternalId: string;
  series: string;
  seriesTitleId: string;
  seriesCircleExternalId: string;
  ratingLabel: string;
  rating: number | null;
  ratingCount: number | null;
  sales: number | null;
  baseCode?: string;
  metadataLanguage?: string;
  metadataPresentation?: WorkMetadataPresentation;
  metadataSync?: WorkMetadataSyncStatus;
  canSyncMetadata?: boolean;
  metadataSyncBusy?: boolean;
  onSyncMetadata?: () => void;
  activeMetadataVariantKey?: string;
  onMetadataVariantSelect?: (key: string) => void;
  translations?: WorkDetail["translations"];
  activeVersionCode?: string;
  onVersionSelect?: (translation: WorkDetail["translations"][number]) => void;
  remoteVersions?: boolean;
  dlsiteFetchedAt: string;
  releaseDate: string;
  ageRating: string;
  sourceInfo: ActiveSourceInfoModel;
  voiceActors: string[];
  voiceCredits: VoiceCredit[];
  tags: string[];
  personalTags?: ReactNode;
  loading?: boolean;
};

function UnifiedWorkDetailPage({
  presentation,
  compact,
  mobileTab,
  onMobileTabChange,
  actions,
  directory,
  onBack,
  children,
}: {
  presentation: UnifiedWorkDetailPresentation;
  compact: boolean;
  mobileTab: "info" | "directory";
  onMobileTabChange: (tab: "info" | "directory") => void;
  actions: ReactNode;
  directory: ReactNode;
  onBack: () => void;
  children?: ReactNode;
}) {
  const mobileNavigationLayout = useMobileNavigationLayout();

  return (
    <div className="space-y-5">
      <Button variant="outline" size="sm" onClick={onBack}>
        <ChevronLeft className="h-4 w-4" />
        {mobileNavigationLayout ? "Back to library" : detailReturnTarget("library").label}
      </Button>

      {compact ? (
        <MobileWorkDetailLayout
          {...presentation}
          activeTab={mobileTab}
          onActiveTabChange={onMobileTabChange}
          actions={actions}
          directory={directory}
        />
      ) : (
        <>
          <DetailHero {...presentation} actions={actions} />
          {directory}
        </>
      )}
      {children}
    </div>
  );
}

function DetailHero({
  coverUrl,
  fallbackCode,
  code,
  dlsiteUrl,
  title,
  circle,
  circleExternalId,
  ratingLabel,
  rating,
  ratingCount,
  sales,
  series,
  seriesTitleId,
  seriesCircleExternalId,
  baseCode,
  metadataLanguage,
  metadataPresentation,
  metadataSync,
  canSyncMetadata = false,
  metadataSyncBusy = false,
  onSyncMetadata,
  activeMetadataVariantKey,
  onMetadataVariantSelect,
  translations,
  activeVersionCode,
  onVersionSelect,
  remoteVersions,
  dlsiteFetchedAt,
  releaseDate,
  ageRating,
  sourceInfo,
  voiceActors,
  voiceCredits,
  tags,
  personalTags,
  loading = false,
  actions,
}: {
  coverUrl: string;
  fallbackCode: string;
  code: string;
  dlsiteUrl: string;
  title: string;
  circle: string;
  circleExternalId: string;
  ratingLabel: string;
  rating: number | null;
  ratingCount: number | null;
  sales: number | null;
  series: string;
  seriesTitleId: string;
  seriesCircleExternalId: string;
  baseCode?: string;
  metadataLanguage?: string;
  metadataPresentation?: WorkMetadataPresentation;
  metadataSync?: WorkMetadataSyncStatus;
  canSyncMetadata?: boolean;
  metadataSyncBusy?: boolean;
  onSyncMetadata?: () => void;
  activeMetadataVariantKey?: string;
  onMetadataVariantSelect?: (key: string) => void;
  translations?: WorkDetail["translations"];
  activeVersionCode?: string;
  onVersionSelect?: (translation: WorkDetail["translations"][number]) => void;
  remoteVersions?: boolean;
  dlsiteFetchedAt: string;
  releaseDate: string;
  ageRating: string;
  sourceInfo: ActiveSourceInfoModel;
  voiceActors: string[];
  voiceCredits: VoiceCredit[];
  tags: string[];
  personalTags?: ReactNode;
  loading?: boolean;
  actions?: ReactNode;
}) {
  const entityResolver = useDetailEntityResolver(code);

  return (
    <section className="grid items-start gap-5 lg:grid-cols-[minmax(340px,520px)_minmax(0,1fr)]">
      <div className="overflow-hidden rounded-lg border bg-muted">
        <div className="aspect-[4/3]">
          {coverUrl ? (
            <img src={assetURL(coverUrl)} alt="" className="h-full w-full object-contain" />
          ) : (
            <div className="grid h-full place-items-center text-4xl font-bold">{fallbackCode.slice(0, 2)}</div>
          )}
        </div>
      </div>

      <div className="min-w-0 space-y-4 lg:py-1">
        <DetailTitleBlock
          fallbackCode={fallbackCode}
          code={code}
          dlsiteUrl={dlsiteUrl}
          title={title}
          circle={circle}
          circleExternalId={circleExternalId}
          series={series}
          seriesTitleId={seriesTitleId}
          seriesCircleExternalId={seriesCircleExternalId}
          loading={loading}
          entityResolver={entityResolver}
        />
        <DetailMetadataContent
          layout="matrix"
          ratingLabel={ratingLabel}
          rating={rating}
          ratingCount={ratingCount}
          sales={sales}
          releaseDate={releaseDate}
          dlsiteFetchedAt={dlsiteFetchedAt}
          ageRating={ageRating}
          metadataLanguage={metadataLanguage}
          metadataPresentation={metadataPresentation}
          metadataSync={metadataSync}
          canSyncMetadata={canSyncMetadata}
          metadataSyncBusy={metadataSyncBusy}
          onSyncMetadata={onSyncMetadata}
          activeMetadataVariantKey={activeMetadataVariantKey}
          onMetadataVariantSelect={onMetadataVariantSelect}
          baseCode={baseCode}
          translations={translations}
          activeVersionCode={activeVersionCode}
          onVersionSelect={onVersionSelect}
          remoteVersions={remoteVersions}
          sourceInfo={sourceInfo}
          voiceActors={voiceActors}
          voiceCredits={voiceCredits}
          tags={tags}
          code={code}
          entityResolver={entityResolver}
          supplementary={personalTags}
        />
        {actions && (
          <div data-testid="hero-actions" className="flex flex-wrap gap-2 rounded-lg border bg-card p-3">
            {actions}
          </div>
        )}
      </div>
    </section>
  );
}

function MobileWorkDetailLayout({
  coverUrl,
  fallbackCode,
  code,
  dlsiteUrl,
  title,
  circle,
  circleExternalId,
  series,
  seriesTitleId,
  seriesCircleExternalId,
  ratingLabel,
  rating,
  ratingCount,
  sales,
  baseCode,
  metadataLanguage,
  metadataPresentation,
  metadataSync,
  canSyncMetadata = false,
  metadataSyncBusy = false,
  onSyncMetadata,
  activeMetadataVariantKey,
  onMetadataVariantSelect,
  translations,
  activeVersionCode,
  onVersionSelect,
  remoteVersions,
  dlsiteFetchedAt,
  releaseDate,
  ageRating,
  sourceInfo,
  voiceActors,
  voiceCredits,
  tags,
  personalTags,
  loading,
  activeTab,
  onActiveTabChange,
  actions,
  directory,
}: {
  coverUrl: string;
  fallbackCode: string;
  code: string;
  dlsiteUrl: string;
  title: string;
  circle: string;
  circleExternalId: string;
  series: string;
  seriesTitleId: string;
  seriesCircleExternalId: string;
  ratingLabel: string;
  rating: number | null;
  ratingCount: number | null;
  sales: number | null;
  baseCode?: string;
  metadataLanguage?: string;
  metadataPresentation?: WorkMetadataPresentation;
  metadataSync?: WorkMetadataSyncStatus;
  canSyncMetadata?: boolean;
  metadataSyncBusy?: boolean;
  onSyncMetadata?: () => void;
  activeMetadataVariantKey?: string;
  onMetadataVariantSelect?: (key: string) => void;
  translations?: WorkDetail["translations"];
  activeVersionCode?: string;
  onVersionSelect?: (translation: WorkDetail["translations"][number]) => void;
  remoteVersions?: boolean;
  dlsiteFetchedAt: string;
  releaseDate: string;
  ageRating: string;
  sourceInfo: ActiveSourceInfoModel;
  voiceActors: string[];
  voiceCredits: VoiceCredit[];
  tags: string[];
  personalTags?: ReactNode;
  loading?: boolean;
  activeTab: "info" | "directory";
  onActiveTabChange: (tab: "info" | "directory") => void;
  actions: ReactNode;
  directory: ReactNode;
}) {
  const entityResolver = useDetailEntityResolver(code);
  return (
    <section className="space-y-4">
      <div className="overflow-hidden rounded-lg border bg-muted">
        <div className="aspect-[4/3] max-h-[58vh]">
          {coverUrl ? (
            <img src={assetURL(coverUrl)} alt="" className="h-full w-full object-contain" />
          ) : (
            <div className="grid h-full place-items-center text-4xl font-bold">{fallbackCode.slice(0, 2)}</div>
          )}
        </div>
      </div>

      <DetailTitleBlock
        fallbackCode={fallbackCode}
        code={code}
        dlsiteUrl={dlsiteUrl}
        title={title}
        circle={circle}
        circleExternalId={circleExternalId}
        series={series}
        seriesTitleId={seriesTitleId}
        seriesCircleExternalId={seriesCircleExternalId}
        loading={loading}
        entityResolver={entityResolver}
      />

      <MobileVoiceSummary
        voiceActors={voiceActors}
        voiceCredits={voiceCredits}
        entityResolver={entityResolver}
        onShowAll={() => onActiveTabChange("info")}
      />

      <div data-testid="hero-actions" className="flex flex-wrap gap-2 rounded-lg border bg-card p-3">
        {actions}
      </div>

      <div className="grid grid-cols-2 rounded-lg border bg-card p-1 text-sm">
        <button
          className={`min-h-10 rounded-md px-3 font-medium ${activeTab === "info" ? "bg-muted text-foreground" : "text-muted-foreground"}`}
          onClick={() => onActiveTabChange("info")}
        >
          Info
        </button>
        <button
          className={`min-h-10 rounded-md px-3 font-medium ${activeTab === "directory" ? "bg-muted text-foreground" : "text-muted-foreground"}`}
          onClick={() => onActiveTabChange("directory")}
        >
          Directory
        </button>
      </div>

      {activeTab === "info" ? (
        <div className="space-y-4">
          <DetailMetadataContent
            ratingLabel={ratingLabel}
            rating={rating}
            ratingCount={ratingCount}
            sales={sales}
            releaseDate={releaseDate}
            dlsiteFetchedAt={dlsiteFetchedAt}
            ageRating={ageRating}
            metadataLanguage={metadataLanguage}
            metadataPresentation={metadataPresentation}
            metadataSync={metadataSync}
            canSyncMetadata={canSyncMetadata}
            metadataSyncBusy={metadataSyncBusy}
            onSyncMetadata={onSyncMetadata}
            activeMetadataVariantKey={activeMetadataVariantKey}
            onMetadataVariantSelect={onMetadataVariantSelect}
            baseCode={baseCode}
            translations={translations}
            activeVersionCode={activeVersionCode}
            onVersionSelect={onVersionSelect}
            remoteVersions={remoteVersions}
            sourceInfo={sourceInfo}
            voiceActors={voiceActors}
            voiceCredits={voiceCredits}
            tags={tags}
            code={code}
            entityResolver={entityResolver}
            supplementary={personalTags}
          />
        </div>
      ) : (
        directory
      )}
    </section>
  );
}

function MobileVoiceSummary({
  voiceActors,
  voiceCredits,
  entityResolver,
  onShowAll,
}: {
  voiceActors: string[];
  voiceCredits: VoiceCredit[];
  entityResolver: DetailEntityResolver;
  onShowAll: () => void;
}) {
  const credits =
    voiceCredits.length > 0 ? voiceCredits : voiceActors.map((displayName) => ({ personId: 0, displayName }));
  if (credits.length === 0) return null;
  return (
    <div className="flex min-w-0 items-center gap-2" aria-label="Voice actors">
      <UserRound className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {credits.slice(0, 2).map((credit) => (
          <button
            key={`${credit.personId}:${credit.displayName}`}
            className="min-w-0 truncate rounded-md border bg-card px-2 py-1 text-xs text-muted-foreground hover:border-primary hover:text-primary"
            onClick={() =>
              credit.personId > 0
                ? openVoiceRoute(credit.personId)
                : entityResolver.resolveEntity("voice", credit.displayName)
            }
          >
            {credit.displayName}
          </button>
        ))}
        {credits.length > 2 && (
          <button className="shrink-0 text-xs font-medium text-muted-foreground hover:text-primary" onClick={onShowAll}>
            +{credits.length - 2}
          </button>
        )}
      </div>
    </div>
  );
}

type DetailEntityKind = "circle" | "series" | "voice";

type DetailEntityResolver = {
  resolvingEntity: DetailEntityKind | null;
  resolveEntity: (kind: DetailEntityKind, name: string) => void;
};

function useDetailEntityResolver(code: string): DetailEntityResolver {
  const toast = useToast();
  const [resolvingEntity, setResolvingEntity] = useState<DetailEntityKind | null>(null);
  const resolveEntity = async (kind: DetailEntityKind, name: string) => {
    if (resolvingEntity || !code) return;
    setResolvingEntity(kind);
    toast.info(kind === "series" ? "Loading series information..." : `Loading ${kind} information...`);
    try {
      const result = await api.resolveWorkEntityLink(code, kind, name);
      if (result.route) openResolvedEntityRoute(result.route);
    } catch (error) {
      toast.notify(toastFromError(error, `Could not open this ${kind}.`));
    } finally {
      setResolvingEntity(null);
    }
  };
  return { resolvingEntity, resolveEntity };
}

function DetailTitleBlock({
  fallbackCode,
  code,
  dlsiteUrl,
  title,
  circle,
  circleExternalId,
  series,
  seriesTitleId,
  seriesCircleExternalId,
  loading,
  entityResolver,
}: {
  fallbackCode: string;
  code: string;
  dlsiteUrl: string;
  title: string;
  circle: string;
  circleExternalId: string;
  series: string;
  seriesTitleId: string;
  seriesCircleExternalId: string;
  loading?: boolean;
  entityResolver: DetailEntityResolver;
}) {
  const toast = useToast();
  const codeLabel = code || fallbackCode || "Remote";
  const copyWorkCode = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(codeLabel);
      toast.success(`Copied ${codeLabel}.`);
    } catch {
      toast.error("Could not copy the work code.");
    }
  };

  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Work code actions">
          <button
            type="button"
            className={badgeVariants({ variant: "secondary", className: "w-fit cursor-copy" })}
            aria-label={`Copy work code ${codeLabel}`}
            title="Copy work code"
            onClick={() => void copyWorkCode()}
          >
            {codeLabel}
          </button>
          {dlsiteUrl && (
            <Button
              variant="outline"
              size="icon"
              className="h-[22px] w-[22px] shrink-0 p-0"
              asChild
              title="Open DLsite"
            >
              <a href={dlsiteUrl} target="_blank" rel="noreferrer" aria-label={`Open DLsite for ${codeLabel}`}>
                <ExternalLink className="h-3 w-3" />
              </a>
            </Button>
          )}
        </div>
        <h2 className="min-w-0 text-2xl font-semibold leading-tight lg:text-3xl">{title}</h2>
        {loading && <div className="h-2 w-40 animate-pulse rounded bg-muted" />}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        {circle ? (
          <button
            className="inline-flex max-w-full items-center gap-1 truncate hover:text-primary"
            onClick={() =>
              circleExternalId ? openCircleRoute(circleExternalId) : entityResolver.resolveEntity("circle", circle)
            }
          >
            <CircleUserRound className="h-4 w-4 shrink-0" />
            <span className="truncate">{circle || "Unknown circle"}</span>
          </button>
        ) : (
          <span className="inline-flex max-w-full items-center gap-1 truncate">
            <CircleUserRound className="h-4 w-4 shrink-0" />
            <span className="truncate">{circle || "Unknown circle"}</span>
          </span>
        )}
        {series && (
          <span className="inline-flex max-w-full items-center gap-1 truncate">
            <span className="text-border">/</span>
            <button
              className="truncate hover:text-primary"
              onClick={() =>
                seriesTitleId && seriesCircleExternalId
                  ? openCircleSeriesRoute(seriesCircleExternalId, seriesTitleId)
                  : entityResolver.resolveEntity("series", series)
              }
            >
              {series}
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

function DetailMetadataContent({
  layout = "stacked",
  ratingLabel,
  rating,
  ratingCount,
  sales,
  releaseDate,
  dlsiteFetchedAt,
  ageRating,
  metadataLanguage,
  metadataPresentation,
  metadataSync,
  canSyncMetadata,
  metadataSyncBusy,
  onSyncMetadata,
  activeMetadataVariantKey,
  onMetadataVariantSelect,
  baseCode,
  translations = [],
  activeVersionCode,
  onVersionSelect,
  remoteVersions,
  sourceInfo,
  voiceActors,
  voiceCredits,
  tags,
  code,
  entityResolver,
  supplementary,
}: {
  layout?: "stacked" | "matrix";
  ratingLabel: string;
  rating: number | null;
  ratingCount: number | null;
  sales: number | null;
  releaseDate: string;
  dlsiteFetchedAt: string;
  ageRating: string;
  metadataLanguage?: string;
  metadataPresentation?: WorkMetadataPresentation;
  metadataSync?: WorkMetadataSyncStatus;
  canSyncMetadata?: boolean;
  metadataSyncBusy?: boolean;
  onSyncMetadata?: () => void;
  activeMetadataVariantKey?: string;
  onMetadataVariantSelect?: (key: string) => void;
  baseCode?: string;
  translations?: WorkDetail["translations"];
  activeVersionCode?: string;
  onVersionSelect?: (translation: WorkDetail["translations"][number]) => void;
  remoteVersions?: boolean;
  sourceInfo: ActiveSourceInfoModel;
  voiceActors: string[];
  voiceCredits: VoiceCredit[];
  tags: string[];
  code: string;
  entityResolver: DetailEntityResolver;
  supplementary?: ReactNode;
}) {
  const displayVoiceCredits =
    voiceCredits.length > 0 ? voiceCredits : voiceActors.map((name) => ({ personId: 0, displayName: name }));
  const baseTranslation = translations.find(
    (translation) => translation.primaryCode.toUpperCase() === (baseCode ?? "").toUpperCase(),
  );
  const availabilityScope: WorkVersionAvailabilityScope = remoteVersions ? "source" : "local";
  const versionSelector =
    metadataLanguage || (metadataPresentation?.variants.length ?? 0) > 0 || baseCode || translations.length > 0 ? (
      <WorkVersionSelector
        metadataLanguage={metadataLanguage ?? ""}
        metadataPresentation={metadataPresentation}
        activeMetadataVariantKey={activeMetadataVariantKey ?? ""}
        onMetadataVariantSelect={onMetadataVariantSelect}
        baseCode={baseCode ?? ""}
        baseAvailable={Boolean(baseTranslation && workVersionAvailableForScope(baseTranslation, availabilityScope))}
        translations={translations}
        activeVersionCode={activeVersionCode ?? code}
        onVersionSelect={onVersionSelect}
        remoteVersions={remoteVersions}
      />
    ) : null;
  const metadataNotice = (
    <MetadataSyncNotice
      status={metadataSync?.status}
      checkedAt={metadataSync?.checkedAt ?? ""}
      canSync={Boolean(canSyncMetadata && onSyncMetadata)}
      busy={metadataSyncBusy ?? false}
      onSync={onSyncMetadata}
    />
  );
  const voiceCard = (
    <div className="rounded-lg border bg-card p-3">
      <DetailChipRow
        icon={<UserRound className="h-4 w-4" />}
        label="Voices"
        emptyLabel="No voice actor metadata"
        items={displayVoiceCredits.map((credit) => ({
          key: `${credit.personId}:${credit.displayName}`,
          label: credit.displayName,
          onClick:
            credit.personId > 0
              ? () => openVoiceRoute(credit.personId)
              : () => entityResolver.resolveEntity("voice", credit.displayName),
        }))}
      />
    </div>
  );
  const tagsCard = (
    <div className="rounded-lg border bg-card p-3">
      <DetailChipRow
        icon={<Tags className="h-4 w-4" />}
        label="Tags"
        emptyLabel="No tag metadata"
        items={tags.map((tag) => ({ key: tag, label: tag, onClick: () => openDetailTagSearch(tag) }))}
      />
    </div>
  );
  const dlsiteCard = (
    <DlsiteMetrics
      ratingLabel={ratingLabel}
      rating={rating}
      ratingCount={ratingCount}
      sales={sales}
      releaseDate={releaseDate}
      dlsiteFetchedAt={dlsiteFetchedAt}
      ageRating={ageRating}
    />
  );
  if (layout === "matrix") {
    return (
      <div className="grid items-start gap-3 sm:grid-cols-2">
        <div className="min-w-0 space-y-3">
          {voiceCard}
          {tagsCard}
          {supplementary}
        </div>
        <div className="min-w-0 space-y-3">
          {dlsiteCard}
          <ActiveSourceInfo info={sourceInfo} />
        </div>
        {metadataNotice}
        {versionSelector && <div className="sm:col-span-2">{versionSelector}</div>}
      </div>
    );
  }
  return (
    <>
      <div className="space-y-3">
        {voiceCard}
        {tagsCard}
      </div>
      {supplementary}
      {metadataNotice}
      {versionSelector}
      {dlsiteCard}
      <ActiveSourceInfo info={sourceInfo} />
    </>
  );
}

function MetadataSyncNotice({
  status,
  checkedAt,
  canSync,
  busy,
  onSync,
}: {
  status?: string;
  checkedAt: string;
  canSync: boolean;
  busy: boolean;
  onSync?: () => void;
}) {
  if (status !== "not_synced" && status !== "not_found") return null;
  const unavailable = status === "not_found";
  return (
    <div
      className={`rounded-lg border p-3 text-sm sm:col-span-2 ${
        unavailable
          ? "border-warning-border bg-warning-surface text-warning-foreground"
          : "border-info-border bg-info-surface text-info-foreground"
      }`}
      data-testid="metadata-sync-notice"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium">
            {unavailable ? "Metadata source has no record" : "Metadata has not been synchronized"}
          </div>
          <p className="mt-1 text-xs opacity-80">
            {unavailable
              ? "The metadata provider reported that this work is unavailable."
              : "Synchronize metadata to show language editions, tags, and provider details."}
          </p>
          {checkedAt && <div className="mt-1 text-xs opacity-70">Checked {formatDateTime(checkedAt)}</div>}
        </div>
        {!unavailable && canSync && onSync && (
          <Button variant="outline" size="sm" onClick={onSync} disabled={busy}>
            <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
            {busy ? "Syncing metadata" : "Sync metadata"}
          </Button>
        )}
      </div>
    </div>
  );
}

function DetailSkeletonActions() {
  return (
    <div className="flex flex-wrap gap-2">
      <div className="h-9 w-24 animate-pulse rounded-md bg-muted" />
      <div className="h-9 w-28 animate-pulse rounded-md bg-muted" />
      <div className="h-9 w-20 animate-pulse rounded-md bg-muted" />
    </div>
  );
}

function DirectorySkeleton() {
  return (
    <div className="min-h-[22rem] space-y-3" data-testid="directory-skeleton" aria-hidden="true">
      <div className="flex h-9 items-center gap-2 rounded-md border bg-background px-3">
        <div className="h-3 w-10 animate-pulse rounded bg-muted" />
        <div className="h-3 w-3 animate-pulse rounded-full bg-muted" />
        <div className="h-3 w-32 animate-pulse rounded bg-muted" />
      </div>
      <div className="space-y-2">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="flex min-h-12 items-center gap-3 rounded-md border bg-background px-3 py-2">
            <div className="h-7 w-7 shrink-0 animate-pulse rounded-md bg-muted" />
            <div className="min-w-0 flex-1 space-y-2">
              <div
                className={`h-3 animate-pulse rounded bg-muted ${index % 3 === 0 ? "w-2/3" : index % 3 === 1 ? "w-1/2" : "w-3/4"}`}
              />
              <div className="h-2.5 w-24 animate-pulse rounded bg-muted/80" />
            </div>
            <div className="h-8 w-8 shrink-0 animate-pulse rounded-md bg-muted" />
          </div>
        ))}
      </div>
    </div>
  );
}

function DirectoryLoadErrorPanel({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      className="min-h-[22rem] rounded-md border border-warning-border bg-warning-surface p-4 text-sm text-warning-foreground"
      data-testid="directory-load-error"
    >
      <div className="font-medium">Directory unavailable</div>
      <p className="mt-1 text-warning-foreground/80">{message}</p>
      {onRetry && (
        <Button className="mt-3" variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="h-4 w-4" /> Retry
        </Button>
      )}
    </div>
  );
}

function detailHeroValue<T>(workValue: T | null | undefined, previewValue: T | null | undefined, fallback: T): T {
  return workValue ?? previewValue ?? fallback;
}

function detailHeroModel(code: string, work: WorkDetail | null, preview: WorkPreview | null) {
  const persisted: Partial<WorkDetail> = work || {};
  const optimistic: Partial<WorkPreview> = preview || {};
  return {
    primaryCode: detailHeroValue(persisted.primaryCode, optimistic.primaryCode, code),
    title: detailHeroValue(persisted.title, optimistic.title, code),
    coverUrl: detailHeroValue(persisted.coverUrl, optimistic.coverUrl, ""),
    circle: detailHeroValue(persisted.circle, optimistic.circle, ""),
    circleExternalId: detailHeroValue(persisted.circleExternalId, optimistic.circleExternalId, ""),
    rating: detailHeroValue(persisted.rating, optimistic.rating, null),
    ratingCount: detailHeroValue(persisted.ratingCount, undefined, null),
    sales: detailHeroValue(persisted.sales, optimistic.sales, null),
    series: detailHeroValue(persisted.series, undefined, ""),
    dlsiteFetchedAt: detailHeroValue(persisted.dlsiteFetchedAt, undefined, ""),
    releaseDate: detailHeroValue(persisted.releaseDate, optimistic.releaseDate, null),
    ageRating: detailHeroValue(persisted.ageRating, undefined, ""),
    durationSeconds: detailHeroValue(persisted.durationSeconds, undefined, null),
    voiceActors: detailHeroValue(persisted.voiceActors, optimistic.voiceActors, []),
    tags: detailHeroValue(persisted.tags, optimistic.tags, []),
  };
}

function recommendationBadgeVisible(score: number | undefined) {
  if (window.localStorage.getItem("kikoto:recommend-badges") !== "true") return false;
  const threshold = Number(window.localStorage.getItem("kikoto:recommend-threshold") ?? "50");
  return Number.isFinite(score) && (score ?? 0) >= threshold;
}

function useCompactDetailLayout() {
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 767px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return compact;
}

function TrackedUnforkedPanel({
  presence,
  remoteSources,
}: {
  presence?: NonNullable<WorkDetail["sourcePresence"]>[number] | null;
  remoteSources: RemoteSourceAvailability[];
}) {
  const candidates = remoteSources.filter((remote) => remoteSourceCanBrowse(remote.summary));
  return (
    <div className="rounded-md border border-warning-border bg-warning-surface p-4 text-sm text-warning-foreground">
      <div className="font-medium">{presence ? "Tracked directory not forked" : "No tracked source linked"}</div>
      <p className="mt-1 text-warning-foreground/80">
        {presence
          ? "Choose a fork source from Source to create the browsable tracked directory."
          : "Track a remote source from its source tab to create a browsable tracked directory."}
      </p>
      {candidates.length === 0 && (
        <Badge variant="warning" className="mt-3">
          No browsable remote source
        </Badge>
      )}
    </div>
  );
}

function LocalSourceStatePanel({
  status,
  remoteSources,
  onSelectRemote,
}: {
  status: SourceTabInfo["status"];
  remoteSources: RemoteSourceAvailability[];
  onSelectRemote: (remote: RemoteSourceAvailability) => void;
}) {
  const availableSources = remoteSources.filter((remote) => remoteSourceCanBrowse(remote.summary));
  return (
    <div
      className={`rounded-md border p-4 text-sm ${status === "unavailable" ? "border-error-border bg-error-surface text-error-foreground" : "border-warning-border bg-warning-surface text-warning-foreground"}`}
    >
      <div className="font-medium">Local files unavailable</div>
      <div className="mt-3 flex flex-wrap gap-2">
        {availableSources.length > 0 ? (
          availableSources.map((remote) => (
            <Button key={remote.source.id} variant="outline" size="sm" onClick={() => onSelectRemote(remote)}>
              Fetch from {remote.source.displayName}
            </Button>
          ))
        ) : (
          <Badge variant={status === "unavailable" ? "error" : "warning"}>
            {status === "unavailable" ? "No remote source available" : "Check remote sources"}
          </Badge>
        )}
      </div>
    </div>
  );
}

function RemoteSourceStatePanel({ remote }: { remote: RemoteSourceAvailability }) {
  const status = remoteSourceTabStatus(remote.summary);
  return (
    <div
      className={`rounded-md border p-4 text-sm ${status.status === "unavailable" ? "border-error-border bg-error-surface text-error-foreground" : "border-warning-border bg-warning-surface text-warning-foreground"}`}
    >
      <div className="font-medium">
        {remote.source.displayName} · {status.statusLabel}
      </div>
      {remote.summary.error && <div className="mt-1 text-xs opacity-80">{remote.summary.error}</div>}
    </div>
  );
}

function NoSourceDirectoryPanel({
  checking,
  checkedAt,
  remoteSources,
  onRefresh,
}: {
  checking: boolean;
  checkedAt: string;
  remoteSources: RemoteSourceAvailability[];
  onRefresh: () => void;
}) {
  const availableSources = remoteSources.filter((remote) => remoteSourceCanBrowse(remote.summary));
  return (
    <div className="rounded-md border border-warning-border bg-warning-surface p-4 text-sm text-warning-foreground">
      <div className="font-medium">No source linked</div>
      <p className="mt-1 text-warning-foreground/80">
        This work exists in the local database, but Kikoto has no local files, cache, tracked source, or known source
        presence for it yet.
      </p>
      {availableSources.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {availableSources.map((remote) => (
            <Badge key={remote.source.id} variant="outline">
              {remote.source.displayName} available
            </Badge>
          ))}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={checking}>
          <RefreshCw className={`h-4 w-4 ${checking ? "animate-spin" : ""}`} />
          Refresh sources
        </Button>
        {!checking && checkedAt && (
          <span className="text-xs text-warning-foreground/80">Checked {formatDateTime(checkedAt)}</span>
        )}
      </div>
    </div>
  );
}

type DirectoryMode = "browse" | "tree";

function SourceDirectoryContent({
  emptyState,
  directoryMode,
  root,
  directoryRoutingRules,
  requestedRoutePath,
  currentLocationId,
  currentPlaybackKey,
  emptyLabel,
  onPlayFolder,
  onPlayNext,
  onAppendQueue,
  onPreview,
}: {
  emptyState?: ReactNode;
  directoryMode: DirectoryMode;
  root: TreeNode;
  directoryRoutingRules: DirectoryRoutingRule[];
  requestedRoutePath: string[] | null;
  currentLocationId: number | null;
  currentPlaybackKey: string | null;
  emptyLabel: string;
  onPlayFolder?: (tracks: TreeTrack[], locationId: number) => void;
  onPlayNext?: (track: TreeTrack) => void;
  onAppendQueue?: (track: TreeTrack) => void;
  onPreview?: (preview: FilePreviewState) => void;
}) {
  if (emptyState) return emptyState;
  const sharedProps = {
    root,
    directoryRoutingRules,
    currentLocationId,
    currentPlaybackKey,
    emptyLabel,
    onPlayFolder,
    onPlayNext,
    onAppendQueue,
    onPreview,
  };
  return directoryMode === "browse" ? (
    <DirectoryBrowser {...sharedProps} routePath={requestedRoutePath ?? undefined} />
  ) : (
    <DirectoryTree {...sharedProps} focusPath={requestedRoutePath ?? undefined} />
  );
}

function SourceDirectoryPanel({
  title,
  description,
  statsLabel,
  tabs,
  activeKey,
  onActiveKeyChange,
  trackedPresenceOptions = [],
  selectedTrackedPresenceKey = "",
  onTrackedPresenceChange,
  checkingSources = false,
  checkedAt,
  onCheckSources,
  directoryMode,
  onDirectoryModeChange,
  root,
  directoryRoutingRules,
  currentLocationId,
  currentPlaybackKey,
  emptyLabel,
  toolbar,
  selectionPanel,
  selectionModal,
  loadingMessage,
  emptyState,
  onPlayFolder,
  onPlayNext,
  onAppendQueue,
  onPreview,
}: {
  title: string;
  description: string;
  statsLabel?: string;
  tabs: SourceTabInfo[];
  activeKey: string;
  onActiveKeyChange: (key: string) => void;
  trackedPresenceOptions?: TrackedPresenceOption[];
  selectedTrackedPresenceKey?: string;
  onTrackedPresenceChange?: (key: string) => void;
  checkingSources?: boolean;
  checkedAt?: string;
  onCheckSources?: () => void;
  directoryMode: DirectoryMode;
  onDirectoryModeChange: (mode: DirectoryMode) => void;
  root: TreeNode;
  directoryRoutingRules: DirectoryRoutingRule[];
  currentLocationId: number | null;
  currentPlaybackKey: string | null;
  emptyLabel: string;
  toolbar?: ReactNode;
  selectionPanel?: ReactNode;
  selectionModal?: ReactNode;
  loadingMessage?: string;
  emptyState?: ReactNode;
  onPlayFolder?: (tracks: TreeTrack[], locationId: number) => void;
  onPlayNext?: (track: TreeTrack) => void;
  onAppendQueue?: (track: TreeTrack) => void;
  onPreview?: (preview: FilePreviewState) => void;
}) {
  const [trackedMenuOpen, setTrackedMenuOpen] = useState(false);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const [requestedRoutePath, setRequestedRoutePath] = useState<string[] | null>(null);
  const trackedMenuRef = useRef<HTMLDivElement | null>(null);
  const mobileActionsRef = useRef<HTMLButtonElement | null>(null);
  const mobileNavigationLayout = useMobileNavigationLayout();
  useEffect(() => {
    setTrackedMenuOpen(false);
    setMobileActionsOpen(false);
  }, [activeKey, selectedTrackedPresenceKey]);
  const content = (
    <SourceDirectoryContent
      emptyState={emptyState}
      directoryMode={directoryMode}
      root={root}
      directoryRoutingRules={directoryRoutingRules}
      requestedRoutePath={requestedRoutePath}
      currentLocationId={currentLocationId}
      currentPlaybackKey={currentPlaybackKey}
      emptyLabel={emptyLabel}
      onPlayFolder={onPlayFolder}
      onPlayNext={onPlayNext}
      onAppendQueue={onAppendQueue}
      onPreview={onPreview}
    />
  );
  const routeSummary = useMemo(() => directoryRouteSummary(root, directoryRoutingRules), [root, directoryRoutingRules]);
  return (
    <section className="space-y-3 pb-4 lg:pb-8">
      <div className="space-y-3">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,auto)] lg:items-end">
          <div>
            <h3 className="text-lg font-semibold">
              <span className="sr-only lg:not-sr-only">{title}</span>
            </h3>
            {statsLabel && <p className="mt-1 text-xs text-muted-foreground">{statsLabel}</p>}
          </div>
          <p className="text-sm text-muted-foreground lg:text-right">
            <span className="sr-only lg:not-sr-only">{description}</span>
          </p>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <div className="hidden shrink-0 lg:block">
            <DirectoryModeSwitch mode={directoryMode} onChange={onDirectoryModeChange} />
          </div>
          <div className="flex min-w-0 flex-1 items-center overflow-hidden rounded-md border bg-card p-1">
            <div className="app-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
              {tabs.map((source) =>
                source.kind === "tracked" && trackedPresenceOptions.length > 1 ? (
                  <div
                    key={source.key}
                    ref={trackedMenuRef}
                    className={`relative flex h-7 shrink-0 overflow-hidden rounded ${source.key === activeKey ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
                  >
                    <button
                      className="inline-flex min-w-0 items-center gap-2 px-2.5 text-xs font-medium"
                      onClick={() => onActiveKeyChange(source.key)}
                      title={`${source.label}: ${source.statusLabel}`}
                    >
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${sourceTabStatusClass(source.status)}`}
                        aria-hidden="true"
                      />
                      <span>{source.label}</span>
                      <span className="sr-only">{source.statusLabel}</span>
                    </button>
                    <button
                      className={`grid w-7 place-items-center border-l ${source.key === activeKey ? "border-primary-foreground/25 hover:bg-primary-foreground/10" : "border-border hover:bg-muted"}`}
                      aria-label="Choose tracked source"
                      aria-haspopup="menu"
                      aria-expanded={trackedMenuOpen}
                      title="Choose tracked source"
                      onClick={() => setTrackedMenuOpen((open) => !open)}
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                    <AnchoredPopover
                      open={trackedMenuOpen}
                      anchorRef={trackedMenuRef}
                      onOpenChange={setTrackedMenuOpen}
                      className="w-56 p-1 text-sm"
                      zIndex={70}
                    >
                      <div role="menu" aria-label="Tracked sources">
                        {trackedPresenceOptions.map((option) => (
                          <button
                            key={option.key}
                            role="menuitemradio"
                            aria-checked={option.key === selectedTrackedPresenceKey}
                            className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-muted focus:bg-muted focus:outline-none"
                            onClick={() => {
                              onTrackedPresenceChange?.(option.key);
                              setTrackedMenuOpen(false);
                            }}
                          >
                            <span
                              className={`h-2 w-2 shrink-0 rounded-full ${sourceTabStatusClass(option.status)}`}
                              aria-hidden="true"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate">{option.label}</span>
                              <span className="block text-[11px] text-muted-foreground">
                                {option.forked ? "Forked" : "Unforked"}
                              </span>
                            </span>
                            {option.key === selectedTrackedPresenceKey && (
                              <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                            )}
                          </button>
                        ))}
                      </div>
                    </AnchoredPopover>
                  </div>
                ) : (
                  <button
                    key={source.key}
                    className={`inline-flex h-7 shrink-0 items-center gap-2 rounded px-2.5 text-xs font-medium ${
                      source.key === activeKey
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted"
                    }`}
                    onClick={() => onActiveKeyChange(source.key)}
                    title={`${source.label}: ${source.statusLabel}`}
                  >
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${sourceTabStatusClass(source.status)}`}
                      aria-hidden="true"
                    />
                    <span>{source.label}</span>
                    <span className="sr-only">{source.statusLabel}</span>
                  </button>
                ),
              )}
            </div>
            {onCheckSources && !mobileNavigationLayout && (
              <IconButton
                title={
                  checkingSources
                    ? "Checking sources"
                    : checkedAt
                      ? `Check sources · Last checked ${formatDateTime(checkedAt)}`
                      : "Check sources"
                }
                onClick={onCheckSources}
                disabled={checkingSources}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${checkingSources ? "animate-spin" : ""}`} />
              </IconButton>
            )}
            {mobileNavigationLayout && (
              <>
                <button
                  ref={mobileActionsRef}
                  type="button"
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label="More directory actions"
                  aria-haspopup="menu"
                  aria-expanded={mobileActionsOpen}
                  title="More directory actions"
                  onClick={() => setMobileActionsOpen((open) => !open)}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
                <AnchoredPopover
                  open={mobileActionsOpen}
                  anchorRef={mobileActionsRef}
                  onOpenChange={setMobileActionsOpen}
                  className="w-52 p-1 text-sm"
                  bottomCollisionPadding={96}
                  zIndex={70}
                >
                  <div role="menu" aria-label="Directory actions">
                    {onCheckSources && (
                      <button
                        role="menuitem"
                        className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-muted focus:bg-muted focus:outline-none"
                        disabled={checkingSources}
                        onClick={() => {
                          setMobileActionsOpen(false);
                          onCheckSources();
                        }}
                      >
                        <RefreshCw className={`h-4 w-4 shrink-0 ${checkingSources ? "animate-spin" : ""}`} />
                        <span>{checkingSources ? "Checking sources" : "Check sources"}</span>
                      </button>
                    )}
                    <div className="my-1 border-t" />
                    <div className="px-2 py-1 text-[11px] font-semibold uppercase text-muted-foreground">View</div>
                    {(["browse", "tree"] as DirectoryMode[]).map((mode) => (
                      <button
                        key={mode}
                        role="menuitemradio"
                        aria-checked={directoryMode === mode}
                        className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-muted focus:bg-muted focus:outline-none"
                        onClick={() => {
                          onDirectoryModeChange(mode);
                          setMobileActionsOpen(false);
                        }}
                      >
                        {mode === "browse" ? <Folder className="h-4 w-4" /> : <FolderTree className="h-4 w-4" />}
                        <span className="flex-1">{mode === "browse" ? "Browse" : "Tree"}</span>
                        {directoryMode === mode && <Check className="h-4 w-4 text-primary" />}
                      </button>
                    ))}
                  </div>
                </AnchoredPopover>
              </>
            )}
          </div>
        </div>
        {routeSummary && (
          <DirectoryRouteSummary
            summary={routeSummary}
            onSelect={() => setRequestedRoutePath([...routeSummary.path])}
          />
        )}
      </div>
      <Card>
        <CardContent className="p-4">
          {toolbar}
          {loadingMessage && (
            <div className="mb-4 rounded-md border bg-background p-3 text-sm text-muted-foreground">
              {loadingMessage}
            </div>
          )}
          {selectionPanel}
          {content}
        </CardContent>
      </Card>
      {selectionModal}
    </section>
  );
}

function DirectoryModeSwitch({ mode, onChange }: { mode: DirectoryMode; onChange: (mode: DirectoryMode) => void }) {
  return (
    <div className="flex rounded-md border bg-card p-0.5">
      <button
        className={`inline-flex h-7 items-center gap-1 rounded px-2 text-xs font-medium ${
          mode === "browse" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
        }`}
        title="Browse directory"
        onClick={() => onChange("browse")}
      >
        <Folder className="h-3.5 w-3.5" />
        Browse
      </button>
      <button
        className={`inline-flex h-7 items-center gap-1 rounded px-2 text-xs font-medium ${
          mode === "tree" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
        }`}
        title="Tree view"
        onClick={() => onChange("tree")}
      >
        <FolderTree className="h-3.5 w-3.5" />
        Tree
      </button>
    </div>
  );
}

function DirectoryRouteSummary({ summary, onSelect }: { summary: DirectoryRouteMatch; onSelect: () => void }) {
  const hasMatch = summary.positiveMatches.length > 0;

  return (
    <>
      <div className="flex min-w-0 items-center rounded-md border bg-card px-3 py-2 text-xs lg:hidden">
        {hasMatch ? (
          <>
            <span className="shrink-0 font-medium text-muted-foreground">Matched</span>
            <button
              type="button"
              className="ml-2 min-w-0 max-w-full truncate rounded-md border bg-secondary px-2 py-0.5 text-left font-medium text-secondary-foreground hover:bg-secondary/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title={`Open ${summary.pathLabel}`}
              aria-label={`Matched ${summary.pathLabel}`}
              onClick={onSelect}
            >
              {summary.pathLabel}
            </button>
          </>
        ) : (
          <span className="truncate font-medium text-muted-foreground">No matching folder</span>
        )}
      </div>
      <div className="hidden flex-wrap items-center gap-2 rounded-md border bg-card px-3 py-2 text-xs lg:flex">
        <span className="font-medium text-muted-foreground">Default folder</span>
        <button
          type="button"
          className="max-w-full truncate rounded-md border bg-secondary px-2 py-0.5 font-medium text-secondary-foreground hover:bg-secondary/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title={`Open ${summary.pathLabel}`}
          onClick={onSelect}
        >
          {summary.pathLabel}
        </button>
        {hasMatch ? (
          <span className="min-w-0 text-muted-foreground">matched {summary.positiveMatches.join(" + ")}</span>
        ) : (
          <span className="text-muted-foreground">fallback: most playable media</span>
        )}
        {summary.negativeMatches.length > 0 && (
          <span className="text-muted-foreground">excluded {summary.negativeMatches.join(" + ")}</span>
        )}
      </div>
    </>
  );
}

function SourceDirectoryToolbar({
  label,
  description,
  message,
  busy,
  onPlay,
  onOpenLocal,
  onSelectSaveFiles,
  selectedCount,
}: {
  label: string;
  description: string;
  message?: string;
  busy: boolean;
  onPlay?: () => void;
  onOpenLocal?: () => void;
  onSelectSaveFiles?: () => void;
  selectedCount?: number;
}) {
  return (
    <div className="mb-4 space-y-3 rounded-md border bg-background p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold">{label}</div>
          <div className="text-xs text-muted-foreground">{description}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          {onPlay && (
            <Button size="sm" onClick={onPlay}>
              <Play className="h-4 w-4" />
              Play
            </Button>
          )}
          {onOpenLocal && (
            <Button size="sm" onClick={onOpenLocal}>
              <MoreHorizontal className="h-4 w-4" />
              Open local detail
            </Button>
          )}
          {onSelectSaveFiles && (
            <Button size="sm" disabled={busy} onClick={onSelectSaveFiles}>
              <HardDriveDownload className="h-4 w-4" />
              Fetch{selectedCount !== undefined ? ` (${selectedCount})` : ""}
            </Button>
          )}
        </div>
      </div>
      {message && <div className="rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">{message}</div>}
    </div>
  );
}

type SuggestionResult<T> = {
  items: T[];
  truncated: boolean;
};

type DebouncedSuggestionResult<T> = SuggestionResult<T> & {
  clear: () => void;
};

function emptySuggestionResult<T>(): SuggestionResult<T> {
  return { items: [], truncated: false };
}

function useDebouncedSuggestion<T>(
  query: string,
  requestKey: string,
  request: () => Promise<SuggestionResult<T>>,
): DebouncedSuggestionResult<T> {
  const [state, setState] = useState<{ key: string; result: SuggestionResult<T> }>(() => ({
    key: requestKey,
    result: emptySuggestionResult<T>(),
  }));

  useEffect(() => {
    if ([...query].length < 2) {
      setState({ key: requestKey, result: emptySuggestionResult<T>() });
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      request()
        .then((next) => {
          if (!cancelled) setState({ key: requestKey, result: next });
        })
        .catch(() => {
          if (!cancelled) setState({ key: requestKey, result: emptySuggestionResult<T>() });
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, requestKey]);

  const result = state.key === requestKey ? state.result : emptySuggestionResult<T>();
  return {
    ...result,
    clear: () => setState({ key: requestKey, result: emptySuggestionResult<T>() }),
  };
}

function useWorkCoverCandidates(workId: number, toast: ReturnType<typeof useToast>) {
  const [coverCandidates, setCoverCandidates] = useState<WorkCoverCandidate[]>([]);
  const [selectedCoverId, setSelectedCoverId] = useState<number | null>(null);
  const [loadingCovers, setLoadingCovers] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadingCovers(true);
    api
      .listWorkCoverCandidates(workId)
      .then((result) => {
        if (cancelled) return;
        setCoverCandidates(result.candidates);
        setSelectedCoverId(result.candidates.find((candidate) => candidate.selected)?.locationId ?? null);
      })
      .catch((error) => {
        if (!cancelled) toast.notify(toastFromError(error, "Cover candidates could not be loaded."));
      })
      .finally(() => {
        if (!cancelled) setLoadingCovers(false);
      });
    return () => {
      cancelled = true;
    };
  }, [toast, workId]);

  return { coverCandidates, selectedCoverId, setSelectedCoverId, loadingCovers };
}

function MetadataEditorCoverSection({
  manualCover,
  coverCandidates,
  selectedCoverId,
  loadingCovers,
  saving,
  onSelectCover,
  onReset,
}: {
  manualCover?: WorkDetail["manualOverrides"]["cover"];
  coverCandidates: WorkCoverCandidate[];
  selectedCoverId: number | null;
  loadingCovers: boolean;
  saving: boolean;
  onSelectCover: (locationId: number) => void;
  onReset: () => void;
}) {
  return (
    <>
      {manualCover?.url && (
        <div className="flex items-center gap-3 rounded-md border bg-background p-2">
          <img src={assetURL(manualCover.url)} alt="" className="h-16 w-16 rounded object-contain" />
          <div className="min-w-0 text-xs text-muted-foreground">
            <div className="truncate text-foreground">{manualCover.assetPath}</div>
            {manualCover.originalPath && <div className="truncate">{manualCover.originalPath}</div>}
          </div>
        </div>
      )}
      {loadingCovers ? (
        <div className="rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">
          Loading cover candidates...
        </div>
      ) : coverCandidates.length === 0 ? (
        <div className="rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">
          No indexed local images found for this work.
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {coverCandidates.map((candidate) => (
            <button
              key={candidate.locationId}
              className={`flex items-center gap-3 rounded-md border bg-background p-2 text-left hover:border-primary ${selectedCoverId === candidate.locationId ? "border-primary ring-1 ring-primary" : ""}`}
              onClick={() => onSelectCover(candidate.locationId)}
            >
              <img
                src={assetURL(candidate.previewUrl)}
                alt=""
                className="h-16 w-16 shrink-0 rounded object-contain"
                loading="lazy"
              />
              <span className="min-w-0 flex-1 text-xs">
                <span className="block truncate font-medium">{candidate.fileName}</span>
                <span className="block truncate text-muted-foreground">{candidate.path}</span>
                <span className="block text-muted-foreground">{formatBytes(candidate.sizeBytes)}</span>
              </span>
              {selectedCoverId === candidate.locationId && <Check className="h-4 w-4 text-primary" />}
            </button>
          ))}
        </div>
      )}
      <div className="flex justify-end">
        <Button variant="outline" size="sm" disabled={saving || !manualCover} onClick={onReset}>
          Reset cover
        </Button>
      </div>
    </>
  );
}

function MetadataEditorCircleSection({
  name,
  externalId,
  suggestions,
  saving,
  hasManualValue,
  onNameChange,
  onExternalIdChange,
  onSuggestionSelect,
  onReset,
}: {
  name: string;
  externalId: string;
  suggestions: DebouncedSuggestionResult<CircleSuggestion>;
  saving: boolean;
  hasManualValue: boolean;
  onNameChange: (value: string) => void;
  onExternalIdChange: (value: string) => void;
  onSuggestionSelect: (item: CircleSuggestion) => void;
  onReset: () => void;
}) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
        <LabeledInput label="Name" value={name} onChange={onNameChange} />
        <LabeledInput label="External ID" value={externalId} onChange={onExternalIdChange} />
      </div>
      <SuggestionList
        truncated={suggestions.truncated}
        emptyLabel="Type at least two characters to search circles."
        items={suggestions.items.map((item) => ({
          key: String(item.partyId),
          label: item.name,
          detail: item.externalId,
          onSelect: () => onSuggestionSelect(item),
        }))}
      />
      <div className="flex justify-end">
        <Button variant="outline" size="sm" disabled={saving || !hasManualValue} onClick={onReset}>
          Reset circle
        </Button>
      </div>
    </>
  );
}

function MetadataEditorSeriesSection({
  name,
  titleId,
  circleExternalId,
  suggestions,
  saving,
  hasManualValue,
  onNameChange,
  onTitleIdChange,
  onCircleExternalIdChange,
  onSuggestionSelect,
  onReset,
}: {
  name: string;
  titleId: string;
  circleExternalId: string;
  suggestions: DebouncedSuggestionResult<SeriesSuggestion>;
  saving: boolean;
  hasManualValue: boolean;
  onNameChange: (value: string) => void;
  onTitleIdChange: (value: string) => void;
  onCircleExternalIdChange: (value: string) => void;
  onSuggestionSelect: (item: SeriesSuggestion) => void;
  onReset: () => void;
}) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-[1fr_160px_180px]">
        <LabeledInput label="Name" value={name} onChange={onNameChange} />
        <LabeledInput label="Title ID" value={titleId} onChange={onTitleIdChange} />
        <LabeledInput label="Circle ID" value={circleExternalId} onChange={onCircleExternalIdChange} />
      </div>
      <SuggestionList
        truncated={suggestions.truncated}
        emptyLabel="Type at least two characters to search series."
        items={suggestions.items.map((item) => ({
          key: String(item.seriesId),
          label: item.name,
          detail: [item.titleId, item.circleName, item.circleExternalId].filter(Boolean).join(" · "),
          onSelect: () => onSuggestionSelect(item),
        }))}
      />
      <div className="flex justify-end">
        <Button variant="outline" size="sm" disabled={saving || !hasManualValue} onClick={onReset}>
          Reset series
        </Button>
      </div>
    </>
  );
}

function MetadataEditorVoiceActorsSection({
  voiceActors,
  suggestions,
  focusedVoiceIndex,
  saving,
  hasManualValue,
  onFocus,
  onUpdate,
  onRemove,
  onAdd,
  onSuggestionSelect,
  onReset,
}: {
  voiceActors: ManualOverridePerson[];
  suggestions: DebouncedSuggestionResult<VoiceSuggestion>;
  focusedVoiceIndex: number;
  saving: boolean;
  hasManualValue: boolean;
  onFocus: (index: number) => void;
  onUpdate: (index: number, patch: Partial<ManualOverridePerson>) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
  onSuggestionSelect: (item: VoiceSuggestion) => void;
  onReset: () => void;
}) {
  return (
    <>
      <div className="space-y-2">
        {voiceActors.map((actor, index) => (
          <div key={`${index}:${actor.personId}`} className="grid gap-2 sm:grid-cols-[1fr_120px_auto]">
            <LabeledInput
              label="Name"
              value={actor.name}
              onFocus={() => onFocus(index)}
              onChange={(value) => onUpdate(index, { name: value, personId: 0 })}
            />
            <LabeledInput
              label="Person ID"
              value={actor.personId ? String(actor.personId) : ""}
              onChange={(value) => onUpdate(index, { personId: Number(value) || 0 })}
            />
            <Button
              variant="outline"
              size="icon"
              className="mt-5 h-9 w-9"
              onClick={() => onRemove(index)}
              aria-label="Remove voice actor"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ))}
        {focusedVoiceIndex >= 0 && (
          <SuggestionList
            truncated={suggestions.truncated}
            emptyLabel="Type at least two characters to search voices."
            items={suggestions.items.map((item) => ({
              key: String(item.personId),
              label: item.name,
              detail: `Person #${item.personId}`,
              onSelect: () => onSuggestionSelect(item),
            }))}
          />
        )}
      </div>
      <div className="flex flex-wrap justify-between gap-2">
        <Button variant="outline" size="sm" onClick={onAdd}>
          <Plus className="h-4 w-4" />
          Add voice
        </Button>
        <Button variant="outline" size="sm" disabled={saving || !hasManualValue} onClick={onReset}>
          Reset voices
        </Button>
      </div>
    </>
  );
}

function workMetadataOverridePayload({
  title,
  circleName,
  circleExternalId,
  seriesName,
  seriesTitleId,
  seriesCircleExternalId,
  voiceActors,
}: {
  title: string;
  circleName: string;
  circleExternalId: string;
  seriesName: string;
  seriesTitleId: string;
  seriesCircleExternalId: string;
  voiceActors: ManualOverridePerson[];
}) {
  return {
    title: nullableTrimmed(title),
    circle: nullableEntity(circleName, circleExternalId),
    series: nullableSeries(seriesName, seriesTitleId, seriesCircleExternalId),
    voiceActors: voiceActors
      .map((actor) => ({ name: actor.name.trim(), personId: Number(actor.personId) || 0 }))
      .filter((actor) => actor.name),
  };
}

function metadataEditorInitialState(work: WorkDetail) {
  const manual = work.manualOverrides ?? {};
  return {
    manual,
    title: manual.title ?? work.title,
    circleName: manual.circle?.name ?? work.circle,
    circleExternalId: manual.circle?.externalId ?? work.circleExternalId,
    seriesName: manual.series?.name ?? work.series,
    seriesTitleId: manual.series?.titleId ?? work.seriesTitleId ?? "",
    seriesCircleExternalId:
      manual.series?.circleExternalId ?? work.seriesCircleExternalId ?? work.circleExternalId ?? "",
    voiceActors: initialManualVoiceActors(work),
  };
}

function useMetadataEditorActions({
  work,
  toast,
  title,
  circleName,
  circleExternalId,
  seriesName,
  seriesTitleId,
  seriesCircleExternalId,
  voiceActors,
  selectedCoverId,
  onSaved,
  onClose,
}: {
  work: WorkDetail;
  toast: ReturnType<typeof useToast>;
  title: string;
  circleName: string;
  circleExternalId: string;
  seriesName: string;
  seriesTitleId: string;
  seriesCircleExternalId: string;
  voiceActors: ManualOverridePerson[];
  selectedCoverId: number | null;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.updateWorkManualOverrides(
        work.id,
        workMetadataOverridePayload({
          title,
          circleName,
          circleExternalId,
          seriesName,
          seriesTitleId,
          seriesCircleExternalId,
          voiceActors,
        }),
      );
      if (selectedCoverId !== null) await api.setWorkCoverOverride(work.id, selectedCoverId);
      toast.success("Metadata overrides saved.");
      onSaved();
      onClose();
    } catch (error) {
      toast.notify(toastFromError(error, "Metadata overrides could not be saved."));
    } finally {
      setSaving(false);
    }
  };

  const resetField = async (field: string) => {
    setSaving(true);
    try {
      await api.deleteWorkManualOverride(work.id, field);
      toast.success("Override reset.");
      onSaved();
      onClose();
    } catch (error) {
      toast.notify(toastFromError(error, "Override could not be reset."));
    } finally {
      setSaving(false);
    }
  };

  return { saving, save, resetField };
}

function WorkMetadataEditorModal({
  work,
  onClose,
  onSaved,
}: {
  work: WorkDetail;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const initialState = metadataEditorInitialState(work);
  const manual = initialState.manual;
  const [title, setTitle] = useState(initialState.title);
  const [circleName, setCircleName] = useState(initialState.circleName);
  const [circleExternalId, setCircleExternalId] = useState(initialState.circleExternalId);
  const [seriesName, setSeriesName] = useState(initialState.seriesName);
  const [seriesTitleId, setSeriesTitleId] = useState(initialState.seriesTitleId);
  const [seriesCircleExternalId, setSeriesCircleExternalId] = useState(initialState.seriesCircleExternalId);
  const [voiceActors, setVoiceActors] = useState<ManualOverridePerson[]>(() => initialState.voiceActors);
  const [focusedVoiceIndex, setFocusedVoiceIndex] = useState(-1);
  const coverState = useWorkCoverCandidates(work.id, toast);
  const circleQuery = circleName.trim();
  const circleSuggestions = useDebouncedSuggestion(circleQuery, circleName, () => api.suggestCircles(circleQuery));
  const seriesQuery = seriesName.trim();
  const seriesSuggestions = useDebouncedSuggestion(seriesQuery, `${seriesName}:${seriesCircleExternalId}`, () =>
    api.suggestSeries(seriesQuery, seriesCircleExternalId),
  );
  const focusedVoice = focusedVoiceIndex >= 0 ? voiceActors[focusedVoiceIndex] : null;
  const voiceQuery = focusedVoice?.name.trim() ?? "";
  const voiceSuggestions = useDebouncedSuggestion(voiceQuery, `${focusedVoiceIndex}:${focusedVoice?.name ?? ""}`, () =>
    api.suggestVoices(voiceQuery),
  );
  const { saving, save, resetField } = useMetadataEditorActions({
    work,
    toast,
    title,
    circleName,
    circleExternalId,
    seriesName,
    seriesTitleId,
    seriesCircleExternalId,
    voiceActors,
    selectedCoverId: coverState.selectedCoverId,
    onSaved,
    onClose,
  });

  const addVoiceActor = () => setVoiceActors((items) => [...items, { name: "", personId: 0 }]);
  const updateVoiceActor = (index: number, patch: Partial<ManualOverridePerson>) => {
    setVoiceActors((items) => items.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)));
  };
  const removeVoiceActor = (index: number) => {
    setVoiceActors((items) => items.filter((_, itemIndex) => itemIndex !== index));
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border bg-card shadow-lg">
        <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
          <div>
            <h3 className="text-base font-semibold">Edit metadata</h3>
            <p className="mt-1 text-xs text-muted-foreground">{work.primaryCode}</p>
          </div>
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="app-scroll min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          <EditorSection title="Work">
            <LabeledInput label="Title" value={title} onChange={setTitle} />
            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                disabled={saving || !manual.title}
                onClick={() => void resetField("title")}
              >
                Reset title
              </Button>
            </div>
          </EditorSection>

          <EditorSection title="Cover">
            <MetadataEditorCoverSection
              manualCover={manual.cover}
              coverCandidates={coverState.coverCandidates}
              selectedCoverId={coverState.selectedCoverId}
              loadingCovers={coverState.loadingCovers}
              saving={saving}
              onSelectCover={coverState.setSelectedCoverId}
              onReset={() => void resetField("cover")}
            />
          </EditorSection>

          <EditorSection title="Circle">
            <MetadataEditorCircleSection
              name={circleName}
              externalId={circleExternalId}
              suggestions={circleSuggestions}
              saving={saving}
              hasManualValue={Boolean(manual.circle)}
              onNameChange={setCircleName}
              onExternalIdChange={setCircleExternalId}
              onSuggestionSelect={(item) => {
                setCircleName(item.name);
                setCircleExternalId(item.externalId);
                setSeriesCircleExternalId(item.externalId);
                circleSuggestions.clear();
              }}
              onReset={() => void resetField("circle")}
            />
          </EditorSection>

          <EditorSection title="Series">
            <MetadataEditorSeriesSection
              name={seriesName}
              titleId={seriesTitleId}
              circleExternalId={seriesCircleExternalId}
              suggestions={seriesSuggestions}
              saving={saving}
              hasManualValue={Boolean(manual.series)}
              onNameChange={setSeriesName}
              onTitleIdChange={setSeriesTitleId}
              onCircleExternalIdChange={setSeriesCircleExternalId}
              onSuggestionSelect={(item) => {
                setSeriesName(item.name);
                setSeriesTitleId(item.titleId);
                setSeriesCircleExternalId(item.circleExternalId);
                seriesSuggestions.clear();
              }}
              onReset={() => void resetField("series")}
            />
          </EditorSection>

          <EditorSection title="Voice actors">
            <MetadataEditorVoiceActorsSection
              voiceActors={voiceActors}
              suggestions={voiceSuggestions}
              focusedVoiceIndex={focusedVoiceIndex}
              saving={saving}
              hasManualValue={Boolean(manual.voiceActors?.length)}
              onFocus={setFocusedVoiceIndex}
              onUpdate={updateVoiceActor}
              onRemove={removeVoiceActor}
              onAdd={addVoiceActor}
              onSuggestionSelect={(item) => {
                updateVoiceActor(focusedVoiceIndex, { name: item.name, personId: item.personId });
                voiceSuggestions.clear();
              }}
              onReset={() => void resetField("voice_actors")}
            />
          </EditorSection>
        </div>
        <div className="flex justify-end gap-2 border-t px-4 py-3">
          <Button variant="outline" size="sm" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function EditorSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h4 className="text-sm font-semibold">{title}</h4>
      {children}
    </section>
  );
}

function SuggestionList({
  items,
  truncated,
  emptyLabel,
}: {
  items: { key: string; label: string; detail: string; onSelect: () => void }[];
  truncated: boolean;
  emptyLabel: string;
}) {
  if (items.length === 0 && !truncated) {
    return <div className="text-xs text-muted-foreground">{emptyLabel}</div>;
  }
  return (
    <div className="space-y-1 rounded-md border bg-background p-1">
      {items.map((item) => (
        <button
          key={item.key}
          className="flex min-h-8 w-full items-center justify-between gap-3 rounded px-2 text-left text-xs hover:bg-muted"
          onClick={item.onSelect}
        >
          <span className="min-w-0 flex-1 truncate font-medium">{item.label}</span>
          {item.detail && <span className="shrink-0 truncate text-muted-foreground">{item.detail}</span>}
        </button>
      ))}
      {truncated && (
        <div className="px-2 py-1 text-xs text-muted-foreground">Too many matches. Keep typing to narrow results.</div>
      )}
    </div>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  onFocus,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onFocus?: () => void;
}) {
  return (
    <label className="block min-w-0 text-xs font-medium text-muted-foreground">
      {label}
      <input
        className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm text-foreground outline-none focus:border-primary"
        value={value}
        onFocus={onFocus}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function initialManualVoiceActors(work: WorkDetail): ManualOverridePerson[] {
  const manual = work.manualOverrides?.voiceActors;
  if (manual && manual.length > 0) return manual;
  if (work.voiceCredits.length > 0) {
    return work.voiceCredits.map((credit) => ({ name: credit.displayName, personId: credit.personId }));
  }
  return work.voiceActors.map((name) => ({ name, personId: 0 }));
}

function nullableTrimmed(value: string) {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function nullableEntity(name: string, externalId: string) {
  const nextName = name.trim();
  const nextExternalId = externalId.trim();
  return nextName || nextExternalId ? { name: nextName, externalId: nextExternalId } : null;
}

function nullableSeries(name: string, titleId: string, circleExternalId: string): ManualOverrideSeries | null {
  const nextName = name.trim();
  const nextTitleId = titleId.trim();
  const nextCircleExternalId = circleExternalId.trim();
  return nextName || nextTitleId || nextCircleExternalId
    ? { name: nextName, titleId: nextTitleId, circleExternalId: nextCircleExternalId }
    : null;
}

function DirectoryMessage({ message }: { message: string }) {
  return <div className="mb-4 rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">{message}</div>;
}

function DirectoryOperationBanner({ runId, status, onOpen }: { runId: number; status: string; onOpen: () => void }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border bg-background px-3 py-2 text-sm">
      <div>
        <div className="font-medium">File operation in progress</div>
        <div className="text-xs text-muted-foreground">
          Workflow #{runId} · {status}
        </div>
      </div>
      <Button size="sm" variant="outline" onClick={onOpen}>
        View Activity
      </Button>
    </div>
  );
}

function WorkVersionSelector({
  metadataLanguage,
  metadataPresentation,
  activeMetadataVariantKey,
  onMetadataVariantSelect,
  baseCode,
  baseAvailable,
  translations,
  activeVersionCode,
  onVersionSelect,
  remoteVersions = false,
}: {
  metadataLanguage: string;
  metadataPresentation?: WorkMetadataPresentation;
  activeMetadataVariantKey: string;
  onMetadataVariantSelect?: (key: string) => void;
  baseCode: string;
  baseAvailable: boolean;
  translations: WorkDetail["translations"];
  activeVersionCode: string;
  onVersionSelect?: (translation: WorkDetail["translations"][number]) => void;
  remoteVersions?: boolean;
}) {
  const availabilityScope: WorkVersionAvailabilityScope = remoteVersions ? "source" : "local";
  const [showAllEditions, setShowAllEditions] = useState(false);
  const collapsedGroups = groupWorkVersions(translations, {
    activeCode: activeVersionCode,
    remoteVersions,
    includeMetadataOnly: false,
    availabilityScope,
  });
  const expandedGroups = groupWorkVersions(translations, {
    activeCode: activeVersionCode,
    remoteVersions,
    includeMetadataOnly: true,
    availabilityScope,
  });
  const collapsedCodes = new Set(
    collapsedGroups.flatMap((group) => group.versions.map((version) => version.primaryCode.toUpperCase())),
  );
  const hiddenEditionCount = translations.filter(
    (version) => !collapsedCodes.has(version.primaryCode.toUpperCase()),
  ).length;
  const groups = showAllEditions ? expandedGroups : collapsedGroups;
  const metadataVariants = orderedMetadataVariants(metadataPresentation?.variants ?? []);
  const activeMetadataVariant = resolveMetadataVariant(metadataPresentation, activeMetadataVariantKey);
  const hasEditionControls = Boolean(baseCode || translations.length > 0);

  return (
    <div className="rounded-lg border bg-card text-xs">
      {(activeMetadataVariant || metadataLanguage) && (
        <div className="flex min-h-11 flex-wrap items-center gap-2 px-3 py-2">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Languages className="h-3.5 w-3.5" />
            <span className="font-medium text-foreground">Metadata language</span>
          </div>
          {metadataVariants.length > 1 ? (
            <FloatingSelect
              value={activeMetadataVariant?.key ?? ""}
              onValueChange={(value) => onMetadataVariantSelect?.(value)}
              ariaLabel="Metadata language"
              className="w-auto min-w-40 max-w-full px-2 text-xs font-medium"
              options={metadataVariants.map((variant) => ({
                value: variant.key,
                label: metadataVariantLabel(variant, metadataVariants),
              }))}
            />
          ) : (
            <span className="font-semibold text-foreground">
              {activeMetadataVariant
                ? metadataVariantLabel(activeMetadataVariant, metadataVariants)
                : languageLabel(metadataLanguage)}
            </span>
          )}
        </div>
      )}
      {hasEditionControls && (
        <div className="space-y-2 border-t px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
              <FolderTree className="h-3.5 w-3.5" />
              <span className="font-medium text-foreground">Directory edition</span>
              {baseCode &&
                (baseAvailable ? (
                  <button
                    className="font-semibold text-primary hover:underline"
                    onClick={() => openWorkCodeRoute(baseCode)}
                  >
                    Base {baseCode}
                  </button>
                ) : (
                  <span className="font-semibold text-foreground">Base {baseCode}</span>
                ))}
            </div>
            {hiddenEditionCount > 0 && (
              <button
                type="button"
                className="font-medium text-primary hover:underline"
                aria-expanded={showAllEditions}
                onClick={() => setShowAllEditions((shown) => !shown)}
              >
                {showAllEditions
                  ? "Hide all editions"
                  : `Show all ${hiddenEditionCount} ${hiddenEditionCount === 1 ? "edition" : "editions"}`}
              </button>
            )}
          </div>
          {groups.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {groups.map((group) => (
                <WorkLanguageVersionPicker
                  key={group.key}
                  group={group}
                  activeVersionCode={activeVersionCode}
                  onVersionSelect={onVersionSelect}
                  availabilityScope={availabilityScope}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function metadataVariantLabel(
  variant: WorkMetadataPresentation["variants"][number],
  variants: WorkMetadataPresentation["variants"],
) {
  const language = languageLabel(variant.language);
  const sameLanguageCount = variants.filter(
    (candidate) => candidate.language.trim().toLowerCase() === variant.language.trim().toLowerCase(),
  ).length;
  const prefix = variant.origin ? `Original · ${language}` : language;
  return sameLanguageCount > 1 ? `${prefix} · ${variant.key}` : prefix;
}

function WorkLanguageVersionPicker({
  group,
  activeVersionCode,
  onVersionSelect,
  availabilityScope,
}: {
  group: WorkVersionGroup;
  activeVersionCode: string;
  onVersionSelect?: (translation: WorkDetail["translations"][number]) => void;
  availabilityScope: WorkVersionAvailabilityScope;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const language = group.language ? languageLabel(group.language) : "Unknown language";
  const preferred = preferredWorkVersion(group.versions, activeVersionCode, availabilityScope);
  const activeCode = activeVersionCode.trim().toUpperCase();
  const groupActive = group.versions.some((version) => version.primaryCode.trim().toUpperCase() === activeCode);
  const preferredActive = preferred?.primaryCode.trim().toUpperCase() === activeCode;
  const preferredAvailable = Boolean(preferred && workVersionAvailableForScope(preferred, availabilityScope));
  const selectVersion = (translation: WorkDetail["translations"][number]) => {
    const active = translation.primaryCode.trim().toUpperCase() === activeCode;
    if (active || !workVersionAvailableForScope(translation, availabilityScope)) return;
    setOpen(false);
    if (onVersionSelect) {
      onVersionSelect(translation);
    } else {
      openWorkCodeRoute(translation.primaryCode);
    }
  };

  return (
    <div ref={anchorRef} role="group" aria-label={`${language} versions`}>
      <div
        className={`inline-flex overflow-hidden rounded-md border ${
          groupActive
            ? "border-primary bg-primary text-primary-foreground"
            : preferredAvailable
              ? "border-primary/30 text-primary"
              : "border-muted bg-muted text-muted-foreground"
        }`}
      >
        <button
          type="button"
          className={`px-2.5 py-1 font-semibold ${!groupActive && preferredAvailable ? "hover:bg-primary/10" : ""}`}
          disabled={!preferredAvailable || preferredActive}
          onClick={() => {
            if (preferred) selectVersion(preferred);
          }}
        >
          {language}
        </button>
        <button
          type="button"
          className={`border-l px-1.5 ${groupActive ? "border-primary-foreground/30" : "border-current/20"} hover:bg-black/10`}
          aria-label={`Choose ${language} DLsite code`}
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </div>
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        onOpenChange={setOpen}
        align="start"
        className="w-[min(19rem,calc(100vw-1.5rem))] p-1 text-sm"
      >
        <div role="menu" aria-label={`${language} DLsite codes`} className="space-y-1">
          {group.versions.map((translation) => {
            const available = workVersionAvailableForScope(translation, availabilityScope);
            const active = translation.primaryCode.trim().toUpperCase() === activeCode;
            const stateLabel = workVersionStateLabel(translation, availabilityScope);
            return (
              <button
                key={translation.primaryCode}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                aria-label={`${translation.primaryCode} ${workVersionKindLabel(translation)} ${stateLabel}`}
                disabled={active || !available}
                className={`flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left ${
                  active
                    ? "bg-primary text-primary-foreground"
                    : available
                      ? "hover:bg-accent hover:text-accent-foreground"
                      : "text-muted-foreground"
                }`}
                onClick={() => selectVersion(translation)}
              >
                <span>
                  <span className="font-semibold">{translation.primaryCode}</span>
                  <span className="ml-2 text-xs">{workVersionKindLabel(translation)}</span>
                </span>
                <span className="shrink-0 text-xs opacity-80">{stateLabel}</span>
              </button>
            );
          })}
        </div>
      </AnchoredPopover>
    </div>
  );
}

function workVersionStateLabel(version: WorkDetail["translations"][number], scope: WorkVersionAvailabilityScope) {
  const mediaState = workVersionMediaState(version);
  if (scope === "local" && !version.localAvailable) {
    return mediaState === "indexed_available" ? "Remote only" : "Unavailable";
  }
  switch (mediaState) {
    case "indexed_available":
      return scope === "local" ? "Ready" : "Available";
    case "present_unindexed":
      return "Index on open";
    case "metadata_only":
      return "Metadata only";
    default:
      return "Unavailable";
  }
}

function DlsiteMetrics({
  ratingLabel,
  rating,
  ratingCount,
  sales,
  releaseDate,
  dlsiteFetchedAt,
  ageRating,
}: {
  ratingLabel: string;
  rating: number | null;
  ratingCount: number | null;
  sales: number | null;
  releaseDate: string;
  dlsiteFetchedAt: string;
  ageRating: string;
}) {
  const normalizedRatingLabel = ratingLabel.toLowerCase().includes("dl") ? "Rate" : ratingLabel;
  const rateValue =
    rating === null ? "—" : `${rating.toFixed(2)}${ratingCount ? ` (${ratingCount.toLocaleString()})` : ""}`;
  const age = ageRatingPresentation(ageRating);
  const ageValue = age.label === "Unknown" ? "—" : age.label;
  const dateValue = dlsiteFetchedAt ? `${releaseDate} / ${dlsiteFetchedAt}` : releaseDate;
  return (
    <div data-testid="dlsite-info" className="w-full rounded-lg border bg-card p-3 text-sm">
      <div className="mb-2 text-xs font-medium text-muted-foreground">DLsite info</div>
      <div className="space-y-2">
        <div
          data-testid="dlsite-primary-metrics"
          className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[11px] leading-4"
        >
          <InlineDlsiteMetric label={normalizedRatingLabel} value={rateValue} />
          <InlineDlsiteMetric label="Age" value={ageValue} valueClassName={age.textClassName} />
          <InlineDlsiteMetric label="Sales" value={sales === null ? "—" : sales.toLocaleString()} />
        </div>
        <MetricLine
          icon={<Clock3 className="h-3.5 w-3.5" />}
          label={dlsiteFetchedAt ? "Released / Updated" : "Released"}
          value={dateValue}
        />
      </div>
    </div>
  );
}

function ActiveSourceInfo({ info }: { info: ActiveSourceInfoModel }) {
  const SourceIcon =
    info.kind === "local"
      ? HardDrive
      : info.kind === "tracked"
        ? GitBranchPlus
        : info.kind === "remote"
          ? Cloud
          : CloudOff;
  const noFilesValue = info.loading ? "..." : "—";
  const sizeValue = info.stats.knownSizeFiles > 0 ? formatBytes(info.stats.sizeBytes) : noFilesValue;
  const sizeDetail =
    info.stats.knownSizeFiles > 0 && info.stats.knownSizeFiles < info.stats.files
      ? `${info.stats.knownSizeFiles}/${info.stats.files} files measured`
      : info.stats.knownSizeFiles > 0
        ? "All file sizes measured"
        : "No measured file size";
  const hasMeasuredDuration = info.stats.knownDurationMedia > 0;
  const durationValue = hasMeasuredDuration
    ? formatDuration(info.stats.durationSeconds)
    : info.metadataDurationSeconds
      ? formatDuration(info.metadataDurationSeconds)
      : noFilesValue;
  const durationLabel = hasMeasuredDuration ? "Playable duration" : "Metadata duration";
  const durationDetail = hasMeasuredDuration
    ? info.stats.knownDurationMedia < info.stats.playable
      ? `${info.stats.knownDurationMedia}/${info.stats.playable} playable files measured`
      : "All playable durations measured"
    : info.metadataDurationSeconds
      ? "No measured source duration"
      : "No known duration";

  return (
    <div data-testid="active-source-info" className="w-full rounded-lg border bg-card p-3 text-sm">
      <div className="mb-3 min-w-0">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <SourceIcon className="h-4 w-4 shrink-0" />
          <span>Source info</span>
        </div>
        <div className="mt-1 truncate font-semibold" title={info.label}>
          {info.label}
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className={`h-2 w-2 rounded-full ${sourceTabStatusClass(info.status)}`} aria-hidden="true" />
          <span>{info.statusLabel}</span>
        </div>
      </div>
      <div className="space-y-2.5">
        <SourceInfoRow
          testId="source-info-audio-row"
          firstLabel="Playable"
          firstValue={info.loading && info.stats.files === 0 ? "..." : info.stats.playable.toLocaleString()}
          secondLabel={durationLabel}
          secondValue={durationValue}
          detail={durationDetail}
        />
        <SourceInfoRow
          testId="source-info-files-row"
          firstLabel="Files"
          firstValue={info.loading && info.stats.files === 0 ? "..." : info.stats.files.toLocaleString()}
          secondLabel="Size"
          secondValue={sizeValue}
          detail={sizeDetail}
        />
      </div>
    </div>
  );
}

function SourceInfoRow({
  testId,
  firstLabel,
  firstValue,
  secondLabel,
  secondValue,
  detail,
}: {
  testId: string;
  firstLabel: string;
  firstValue: string;
  secondLabel: string;
  secondValue: string;
  detail: string;
}) {
  return (
    <div data-testid={testId} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-[11px] leading-4">
      <span className="inline-flex shrink-0 items-baseline gap-1.5" data-source-primary-metrics>
        <InlineSourceMetric label={firstLabel} value={firstValue} />
        <span className="h-3 self-center border-l border-border" aria-hidden="true" />
        <InlineSourceMetric label={secondLabel} value={secondValue} />
      </span>
      <span className="min-w-0 flex-1 basis-32 leading-4 text-muted-foreground">({detail})</span>
    </div>
  );
}

function InlineSourceMetric({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex shrink-0 items-baseline gap-1">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold text-foreground">{value}</span>
    </span>
  );
}

function InlineDlsiteMetric({
  label,
  value,
  valueClassName = "",
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <span className="inline-flex shrink-0 items-baseline gap-1">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-semibold ${valueClassName || "text-foreground"}`}>{value}</span>
    </span>
  );
}

function MetricLine({
  icon,
  label,
  value,
  valueClassName = "",
}: {
  icon: ReactNode;
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="text-muted-foreground">{icon}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className={`min-w-0 truncate text-xs font-semibold ${valueClassName || "text-foreground"}`}>{value}</span>
    </div>
  );
}

function DetailChipRow({
  icon,
  label,
  emptyLabel,
  items,
}: {
  icon: ReactNode;
  label: string;
  emptyLabel: string;
  items: { key: string; label: string; onClick?: () => void }[];
}) {
  return (
    <div className="flex gap-2 text-sm">
      <div className="mt-1 text-muted-foreground">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="font-medium">{label}</div>
        {items.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {items.map((item) =>
              item.onClick ? (
                <button
                  key={item.key}
                  className="rounded-md border bg-background px-2 py-1 text-xs text-muted-foreground hover:border-primary hover:text-primary"
                  onClick={item.onClick}
                >
                  {item.label}
                </button>
              ) : (
                <span
                  key={item.key}
                  className="rounded-md border bg-background px-2 py-1 text-xs text-muted-foreground"
                >
                  {item.label}
                </span>
              ),
            )}
          </div>
        ) : (
          <div className="mt-1 text-muted-foreground">{emptyLabel}</div>
        )}
      </div>
    </div>
  );
}

function InfoRow({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex gap-2 text-sm">
      <div className="mt-0.5 text-muted-foreground">{icon}</div>
      <div className="min-w-0">
        <div className="font-medium">{label}</div>
        <div className="break-words text-muted-foreground">{value}</div>
      </div>
    </div>
  );
}

type FilePreviewState =
  | { kind: "image"; title: string; url: string; locationId: number; canSetCover: boolean }
  | { kind: "video"; title: string; url: string; locationId: number; canTranscode: boolean }
  | { kind: "text"; title: string; locationId: number; url?: string };

function useDirectoryLyricsAttachmentVisibility(root: TreeNode) {
  const attachments = useMemo(() => directoryLyricsAttachments(root), [root]);
  const [showingAll, setShowingAll] = useState(false);
  const [revealedLocationIDs, setRevealedLocationIDs] = useState<Set<number>>(new Set());
  useEffect(() => {
    setShowingAll(false);
    setRevealedLocationIDs(new Set());
  }, [root]);
  const contains = useCallback((locationID: number) => attachments.hiddenLocationIds.has(locationID), [attachments]);
  const isHidden = useCallback(
    (locationID: number) => contains(locationID) && !showingAll && !revealedLocationIDs.has(locationID),
    [contains, revealedLocationIDs, showingAll],
  );
  const reveal = useCallback(
    (locationID: number) => {
      if (!attachments.hiddenLocationIds.has(locationID)) return;
      setRevealedLocationIDs((current) => new Set(current).add(locationID));
    },
    [attachments],
  );
  const toggleAll = useCallback(() => {
    if (showingAll) setRevealedLocationIDs(new Set());
    setShowingAll(!showingAll);
  }, [showingAll]);
  return {
    contains,
    isHidden,
    reveal,
    showingAll,
    toggleAll,
    total: attachments.hiddenLocationIds.size,
  };
}

function LyricsAttachmentsToggle({
  count,
  showingAll,
  onToggle,
}: {
  count: number;
  showingAll: boolean;
  onToggle: () => void;
}) {
  if (count === 0) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-11 w-full justify-center text-xs sm:h-8 sm:w-auto"
      onClick={onToggle}
      aria-pressed={showingAll}
    >
      <Captions className="h-4 w-4" />
      {showingAll ? "Hide attached lyrics" : `Show attached lyrics (${count})`}
    </Button>
  );
}

function DirectoryTree({
  root,
  directoryRoutingRules,
  focusPath,
  currentLocationId,
  currentPlaybackKey,
  onPlayFolder,
  onPlayNext,
  onAppendQueue,
  onPreview,
  emptyLabel = "No local files detected.",
}: {
  root: TreeNode;
  directoryRoutingRules: DirectoryRoutingRule[];
  focusPath?: string[];
  currentLocationId: number | null;
  currentPlaybackKey: string | null;
  onPlayFolder?: (tracks: TreeTrack[], locationId: number) => void;
  onPlayNext?: (track: TreeTrack) => void;
  onAppendQueue?: (track: TreeTrack) => void;
  onPreview?: (preview: FilePreviewState) => void;
  emptyLabel?: string;
}) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() =>
    initialExpandedTreePaths(root, directoryRoutingRules),
  );
  const [visibleLimit, setVisibleLimit] = useState(160);
  const lyricsAttachments = useDirectoryLyricsAttachmentVisibility(root);
  useEffect(() => {
    setExpandedPaths(initialExpandedTreePaths(root, directoryRoutingRules));
    setVisibleLimit(160);
  }, [root, directoryRoutingRules]);
  useEffect(() => {
    if (!focusPath || !nodeAtPath(root, focusPath)) return;
    setExpandedPaths((current) => {
      const next = new Set(current);
      let cursor: TreeNode | null = root;
      for (const part of focusPath) {
        cursor = cursor?.children.get(part) ?? null;
        if (!cursor) break;
        next.add(cursor.path);
      }
      return next;
    });
  }, [focusPath, root]);
  const rows = useMemo(
    () =>
      flattenVisibleTreeRows(root, expandedPaths).filter(
        (row) => row.type === "folder" || !lyricsAttachments.isHidden(row.file.locationId),
      ),
    [root, expandedPaths, lyricsAttachments.isHidden],
  );
  const visibleRows = rows.slice(0, visibleLimit);
  const toggleFolder = (path: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  if (rows.length === 0) {
    return <div className="text-sm text-muted-foreground">{emptyLabel}</div>;
  }
  return (
    <div className="space-y-2">
      <LyricsAttachmentsToggle
        count={lyricsAttachments.total}
        showingAll={lyricsAttachments.showingAll}
        onToggle={lyricsAttachments.toggleAll}
      />
      <div className="space-y-1">
        {visibleRows.map((row) =>
          row.type === "folder" ? (
            <TreeFolderRow
              key={`folder:${row.node.path}`}
              node={row.node}
              depth={row.depth}
              expanded={expandedPaths.has(row.node.path)}
              onToggle={() => toggleFolder(row.node.path)}
            />
          ) : (
            <TreeFile
              key={`file:${row.file.playbackKey ?? row.file.locationId}`}
              file={row.file}
              files={folderPlaybackTracks(row.parent)}
              depth={row.depth}
              isActive={
                row.file.playbackKey === currentPlaybackKey ||
                (!row.file.playbackKey && row.file.locationId === currentLocationId)
              }
              onPlayFolder={onPlayFolder}
              onPlayNext={onPlayNext}
              onAppendQueue={onAppendQueue}
              onPreview={onPreview}
              isLyricsAttachmentHidden={lyricsAttachments.isHidden}
              onRevealLyricsAttachment={lyricsAttachments.reveal}
            />
          ),
        )}
      </div>
      {visibleRows.length < rows.length && (
        <Button variant="outline" size="sm" className="w-full" onClick={() => setVisibleLimit((value) => value + 160)}>
          Show more files ({rows.length - visibleRows.length} remaining)
        </Button>
      )}
    </div>
  );
}

function openDetailTagSearch(tag: string) {
  const value = tag.trim();
  if (!value) return;
  const state = window.history.state as { returnTo?: unknown } | null;
  const returnTo = typeof state?.returnTo === "string" && isInternalReturnPath(state.returnTo) ? state.returnTo : "/";
  const target = new URL(returnTo, window.location.origin);
  const browseState = libraryBrowseStateFromSearch(target.search, defaultLibraryBrowseState);
  const clauses = parseSearchClauses(browseState.query).filter(
    (clause) => !(clause.kind === "tag" && clause.value.toLowerCase() === value.toLowerCase()),
  );
  const query = [...clauses, { kind: "tag" as const, value }].map(formatSearchClause).join(" ");
  target.search = libraryBrowseSearch({ ...browseState, query, page: 1, scrollY: 0 });
  window.history.pushState({}, "", `${target.pathname}${target.search}`);
  window.dispatchEvent(new Event("kikoto:navigation"));
}

function openResolvedEntityRoute(route: string) {
  if (!route.startsWith("/")) return;
  const returnTo = `${window.location.pathname}${window.location.search}`;
  window.history.pushState(historyStateWithReturn(returnTo, "Back"), "", route);
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

function ConfirmMediaDeleteModal({
  target,
  deleting,
  onCancel,
  onConfirm,
}: {
  target: MediaDeleteTarget;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const isLocal = target.kind === "local";
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4" onMouseDown={onCancel}>
      <div
        className="w-full max-w-lg rounded-lg border bg-background shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b p-4">
          <div>
            <h3 className="text-base font-semibold">{isLocal ? "Delete local file" : "Delete cached file"}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {isLocal
                ? "This removes only this local file location."
                : "The remote source and saved local files will not be deleted."}
            </p>
          </div>
          <IconButton title="Close" onClick={onCancel}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="space-y-3 p-4 text-sm">
          <div>
            <div className="font-medium">{target.title}</div>
            <div className="mt-1 break-all rounded-md border bg-muted px-3 py-2 text-xs text-muted-foreground">
              {target.path}
            </div>
          </div>
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive">
            {isLocal
              ? "This removes the local file from disk and marks only this location unavailable. Work progress and marks are preserved."
              : "This removes the cached file from disk and marks the cache location unavailable."}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t p-4">
          <Button variant="outline" onClick={onCancel} disabled={deleting}>
            Cancel
          </Button>
          <Button
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={onConfirm}
            disabled={deleting}
          >
            <Trash2 className="h-4 w-4" />
            {deleting ? "Deleting" : isLocal ? "Delete local" : "Delete cache"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ReforkConfirmModal({
  currentName,
  nextName,
  busy,
  onClose,
  onConfirm,
}: {
  currentName: string;
  nextName: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4">
      <div
        className="w-full max-w-lg rounded-lg border bg-background shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b p-4">
          <div>
            <h3 className="text-base font-semibold">Switch fork source</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Choose a different remote source for this tracked directory.
            </p>
          </div>
          <IconButton title="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="space-y-3 p-4 text-sm">
          <div className="rounded-md border bg-muted px-3 py-2 text-muted-foreground">
            {currentName} will be replaced by {nextName}. Cached files for the current fork should be cleaned when
            backend reFork cleanup is added.
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t p-4">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={busy}>
            <GitBranchPlus className="h-4 w-4" />
            Switch fork
          </Button>
        </div>
      </div>
    </div>
  );
}

function DirectoryBrowser({
  root,
  directoryRoutingRules,
  routePath,
  currentLocationId,
  currentPlaybackKey,
  onPlayFolder,
  onPlayNext,
  onAppendQueue,
  onPreview,
  emptyLabel = "No local files detected.",
}: {
  root: TreeNode;
  directoryRoutingRules: DirectoryRoutingRule[];
  routePath?: string[];
  currentLocationId: number | null;
  currentPlaybackKey: string | null;
  onPlayFolder?: (tracks: TreeTrack[], locationId: number) => void;
  onPlayNext?: (track: TreeTrack) => void;
  onAppendQueue?: (track: TreeTrack) => void;
  onPreview?: (preview: FilePreviewState) => void;
  emptyLabel?: string;
}) {
  const [path, setPath] = useState<string[]>(() => recommendedDirectoryPath(root, directoryRoutingRules));
  const lyricsAttachments = useDirectoryLyricsAttachmentVisibility(root);
  const current = useMemo(() => nodeAtPath(root, path) ?? root, [root, path]);
  const folders = sortedFolders(current);
  const allFiles = sortedFiles(current);
  const files = allFiles.filter((file) => !lyricsAttachments.isHidden(file.locationId));
  const currentLyricsAttachmentCount = allFiles.filter((file) => lyricsAttachments.contains(file.locationId)).length;
  useEffect(() => {
    if (!nodeAtPath(root, path)) {
      setPath(recommendedDirectoryPath(root, directoryRoutingRules));
    }
  }, [root, path, directoryRoutingRules]);

  useEffect(() => {
    setPath(recommendedDirectoryPath(root, directoryRoutingRules));
  }, [root, directoryRoutingRules]);
  useEffect(() => {
    if (routePath && nodeAtPath(root, routePath)) setPath(routePath);
  }, [routePath, root]);

  if (folders.length === 0 && files.length === 0) {
    return <div className="text-sm text-muted-foreground">{emptyLabel}</div>;
  }

  return (
    <div className="space-y-3">
      <DirectoryBreadcrumb path={path} onChange={setPath} />
      <LyricsAttachmentsToggle
        count={currentLyricsAttachmentCount}
        showingAll={lyricsAttachments.showingAll}
        onToggle={lyricsAttachments.toggleAll}
      />
      <div className="space-y-1">
        {path.length > 0 && (
          <button
            className="flex min-h-11 w-full items-start gap-2 rounded-md border bg-background px-3 py-2 text-left text-sm hover:bg-muted"
            onClick={() => setPath(path.slice(0, -1))}
          >
            <ChevronLeft className="h-4 w-4 text-muted-foreground" />
            <span>Parent folder</span>
          </button>
        )}
        {folders.map((folder) => (
          <button
            key={folder.path || folder.name}
            className="flex min-h-11 w-full items-start gap-2 rounded-md border bg-background px-3 py-2 text-left text-sm hover:bg-muted"
            onClick={() => setPath([...path, folder.name])}
          >
            <Folder className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 whitespace-normal break-words [overflow-wrap:anywhere]">{folder.name}</span>
            <span className="shrink-0 pt-0.5 text-xs text-muted-foreground">{folderSummary(folder)}</span>
          </button>
        ))}
        {files.map((file) => (
          <TreeFile
            key={file.playbackKey ?? file.locationId}
            file={file}
            files={folderPlaybackTracks(current)}
            depth={0}
            isActive={
              file.playbackKey === currentPlaybackKey || (!file.playbackKey && file.locationId === currentLocationId)
            }
            onPlayFolder={onPlayFolder}
            onPlayNext={onPlayNext}
            onAppendQueue={onAppendQueue}
            onPreview={onPreview}
            isLyricsAttachmentHidden={lyricsAttachments.isHidden}
            onRevealLyricsAttachment={lyricsAttachments.reveal}
          />
        ))}
      </div>
    </div>
  );
}

function DirectoryBreadcrumb({ path, onChange }: { path: string[]; onChange: (path: string[]) => void }) {
  const [ancestorMenuOpen, setAncestorMenuOpen] = useState(false);
  const ancestorMenuRef = useRef<HTMLButtonElement | null>(null);
  const current = path[path.length - 1] ?? "";
  const ancestors = path.slice(0, -1);

  useEffect(() => setAncestorMenuOpen(false), [path]);

  return (
    <nav
      data-testid="directory-breadcrumb"
      className="min-h-9 min-w-0 rounded-md border bg-background px-2 text-sm"
      aria-label="Directory path"
    >
      <div className="flex min-h-9 min-w-0 items-center gap-1 overflow-hidden lg:hidden">
        <button className="shrink-0 rounded px-2 py-1 font-medium hover:bg-muted" onClick={() => onChange([])}>
          root
        </button>
        {path.length > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        {ancestors.length > 0 && (
          <>
            <button
              ref={ancestorMenuRef}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => setAncestorMenuOpen((open) => !open)}
              aria-label={`Show ${ancestors.length} parent folder${ancestors.length === 1 ? "" : "s"}`}
              aria-haspopup="menu"
              aria-expanded={ancestorMenuOpen}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <AnchoredPopover
              open={ancestorMenuOpen}
              anchorRef={ancestorMenuRef}
              onOpenChange={setAncestorMenuOpen}
              className="w-[min(20rem,calc(100vw-1.5rem))] p-1"
              bottomCollisionPadding={96}
            >
              <div role="menu" aria-label="Parent folders">
                {ancestors.map((part, index) => (
                  <button
                    key={`${part}:${index}`}
                    role="menuitem"
                    className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-none"
                    title={part}
                    onClick={() => onChange(path.slice(0, index + 1))}
                  >
                    <Folder className="h-4 w-4 shrink-0 text-primary" />
                    <span className="min-w-0 flex-1 truncate">{part}</span>
                  </button>
                ))}
              </div>
            </AnchoredPopover>
          </>
        )}
        {current && (
          <span
            data-testid="directory-breadcrumb-current"
            className="min-w-0 max-w-[55vw] truncate rounded px-2 py-1 font-medium sm:max-w-[20rem]"
            title={current}
            aria-current="page"
          >
            {current}
          </span>
        )}
      </div>

      <div className="app-scrollbar hidden min-h-9 min-w-0 items-center gap-1 overflow-x-auto whitespace-nowrap lg:flex">
        <button className="shrink-0 rounded px-2 py-1 font-medium hover:bg-muted" onClick={() => onChange([])}>
          root
        </button>
        {path.map((part, index) => {
          const isCurrent = index === path.length - 1;
          return (
            <span key={`${part}:${index}`} className="inline-flex min-w-0 shrink-0 items-center gap-1">
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              {isCurrent ? (
                <span
                  className="block max-w-[20rem] truncate rounded px-2 py-1 font-medium"
                  title={part}
                  aria-current="page"
                >
                  {part}
                </span>
              ) : (
                <button
                  className="block max-w-[18rem] truncate rounded px-2 py-1 text-left font-medium hover:bg-muted"
                  title={part}
                  onClick={() => onChange(path.slice(0, index + 1))}
                >
                  {part}
                </button>
              )}
            </span>
          );
        })}
      </div>
    </nav>
  );
}

function TreeFolderRow({
  node,
  depth,
  expanded,
  onToggle,
}: {
  node: TreeNode;
  depth: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const playable = playableFiles(node.files);
  const stats = treeStats(node);
  const filesLabel = formatFolderStats(stats, playable.length);
  return (
    <button
      className="flex min-h-11 w-full items-start gap-2 rounded-md px-2 py-2 text-left text-sm font-medium hover:bg-muted"
      style={{ paddingLeft: Math.min(depth, 8) * 14 + 8 }}
      onClick={onToggle}
    >
      {expanded ? (
        <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      )}
      <Folder className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 whitespace-normal break-words [overflow-wrap:anywhere]">{node.name}</span>
      {filesLabel && <span className="ml-auto shrink-0 pt-0.5 text-xs text-muted-foreground">{filesLabel}</span>}
    </button>
  );
}

type TreeFileActionState = {
  preview: FilePreviewState | null;
  canPlay: boolean;
  canPreview: boolean;
  canDownload: boolean;
  canOpen: boolean;
  lyricsChoices: LyricsChoice[];
  hasQueueActions: boolean;
  hasMoreActions: boolean;
  preferredLyricsMediaItemId: number | null;
  automaticLyrics: boolean;
  selectedLyricsChoice: LyricsChoice | null;
  fileMeta: string;
};

function treeFileDownloadable(file: TreeTrack) {
  return (
    file.locationId > 0 &&
    file.availability === "available" &&
    (file.locationType === "local" || file.locationType === "cache")
  );
}

function treeFileLyricsState(file: TreeTrack, lyricsPreferenceOverrides: Record<string, number | null>) {
  const lyricsChoices = file.kind === "audio" ? (file.lyricsChoices ?? []) : [];
  const preferredLyricsMediaItemId = preferredLyricsMediaItemID(file, lyricsPreferenceOverrides);
  const selectedLyricsChoice =
    lyricsChoices.find((choice) => choice.mediaItemId === preferredLyricsMediaItemId) ??
    lyricsChoices.find((choice) => choice.locationId === file.autoLyricsLocationId) ??
    lyricsChoices[0] ??
    null;
  return {
    lyricsChoices,
    preferredLyricsMediaItemId,
    automaticLyrics: preferredLyricsMediaItemId === null,
    selectedLyricsChoice,
  };
}

function treeFileMeta(file: TreeTrack) {
  return [
    fileKindLabel(file.kind),
    file.kind === "audio" || file.kind === "video" ? formatTrackDuration(file.durationSeconds) : "",
    file.sizeBytes === null ? "Unknown size" : formatBytes(file.sizeBytes),
  ]
    .filter(Boolean)
    .join(" · ");
}

function treeFileActionState({
  file,
  onPlayFolder,
  onPlayNext,
  onAppendQueue,
  onPreview,
  lyricsPreferenceOverrides,
}: {
  file: TreeTrack;
  onPlayFolder?: (tracks: TreeTrack[], locationId: number) => void;
  onPlayNext?: (track: TreeTrack) => void;
  onAppendQueue?: (track: TreeTrack) => void;
  onPreview?: (preview: FilePreviewState) => void;
  lyricsPreferenceOverrides: Record<string, number | null>;
}): TreeFileActionState {
  const preview = previewForFile(file);
  const canPlay = Boolean(onPlayFolder && playableFiles([file]).length > 0);
  const canPreview = Boolean(preview && onPreview);
  const canDownload = treeFileDownloadable(file);
  const lyrics = treeFileLyricsState(file, lyricsPreferenceOverrides);
  const hasQueueActions = canPlay && (file.kind === "video" || Boolean(onPlayNext) || Boolean(onAppendQueue));
  return {
    preview,
    canPlay,
    canPreview,
    canDownload,
    canOpen: canPlay || canPreview || canDownload,
    lyricsChoices: lyrics.lyricsChoices,
    hasQueueActions,
    hasMoreActions: lyrics.lyricsChoices.length > 0 || hasQueueActions,
    preferredLyricsMediaItemId: lyrics.preferredLyricsMediaItemId,
    automaticLyrics: lyrics.automaticLyrics,
    selectedLyricsChoice: lyrics.selectedLyricsChoice,
    fileMeta: treeFileMeta(file),
  };
}

function openTreeFile({
  file,
  files,
  preview,
  canPlay,
  canDownload,
  onPlayFolder,
  onPreview,
}: {
  file: TreeTrack;
  files: TreeTrack[];
  preview: FilePreviewState | null;
  canPlay: boolean;
  canDownload: boolean;
  onPlayFolder?: (tracks: TreeTrack[], locationId: number) => void;
  onPreview?: (preview: FilePreviewState) => void;
}) {
  if (preview && file.kind === "video") {
    onPreview?.(preview);
    return;
  }
  if (canPlay) {
    onPlayFolder?.(files, file.locationId);
    return;
  }
  if (preview) {
    onPreview?.(preview);
    return;
  }
  if (canDownload) window.open(mediaDownloadURL(file.locationId), "_blank", "noopener,noreferrer");
}

function TreeFileLyricsActions({
  file,
  choices,
  preferredLyricsMediaItemId,
  automaticLyrics,
  selectedLyricsChoice,
  open,
  anchorRef,
  onOpenChange,
  onCloseMore,
  onPreview,
  isLyricsAttachmentHidden,
  onRevealLyricsAttachment,
}: {
  file: TreeTrack;
  choices: LyricsChoice[];
  preferredLyricsMediaItemId: number | null;
  automaticLyrics: boolean;
  selectedLyricsChoice: LyricsChoice | null;
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onOpenChange: (open: boolean) => void;
  onCloseMore: () => void;
  onPreview?: (preview: FilePreviewState) => void;
  isLyricsAttachmentHidden?: (locationId: number) => boolean;
  onRevealLyricsAttachment?: (locationId: number) => void;
}) {
  const player = useLibraryPlayer();
  return (
    <div className="hidden lg:block" onClick={(event) => event.stopPropagation()}>
      <button
        className="grid h-9 w-9 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
        onClick={() => {
          onCloseMore();
          onOpenChange(!open);
        }}
        aria-label={`Lyrics for ${file.title}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Lyrics"
      >
        <Captions className="h-4 w-4" />
      </button>
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        onOpenChange={onOpenChange}
        className="w-[min(22rem,calc(100vw-1.5rem))] rounded-lg border bg-card p-2 text-card-foreground shadow-xl"
        bottomCollisionPadding={96}
      >
        <div role="dialog" aria-label={`Lyrics for ${file.title}`} className="space-y-2">
          <div className="px-1 py-0.5">
            <div className="text-sm font-semibold">Lyrics</div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground" title={file.title}>
              {file.title}
            </div>
          </div>
          <div role="radiogroup" aria-label="Lyrics source" className="space-y-1">
            <button
              role="radio"
              aria-checked={automaticLyrics}
              className={`flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm ${automaticLyrics ? "bg-secondary text-secondary-foreground" : "hover:bg-muted"}`}
              onClick={() => void player.changeLyricsChoice(file, null)}
            >
              <span className="min-w-0 flex-1">
                <span className="block font-medium">Auto</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {selectedLyricsChoice
                    ? `Matches ${lyricsChoiceDisplayLabel(selectedLyricsChoice, choices)}`
                    : "No available match"}
                </span>
              </span>
              {automaticLyrics && <Check className="h-4 w-4 shrink-0 text-primary" />}
            </button>
            {choices.map((choice) => {
              const selected = !automaticLyrics && choice.mediaItemId === preferredLyricsMediaItemId;
              return (
                <button
                  key={choice.locationId}
                  role="radio"
                  aria-checked={selected}
                  className={`flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm ${selected ? "bg-secondary text-secondary-foreground" : "hover:bg-muted"}`}
                  onClick={() => void player.changeLyricsChoice(file, choice)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium" title={choice.displayPath || choice.title}>
                      {lyricsChoiceDisplayLabel(choice, choices)}
                    </span>
                    <span className="block text-xs text-muted-foreground">{lyricsMatchReasonLabel(choice.reason)}</span>
                  </span>
                  {selected && <Check className="h-4 w-4 shrink-0 text-primary" />}
                </button>
              );
            })}
          </div>
          <div className="grid grid-cols-2 gap-1 border-t pt-2">
            <button
              className="flex min-h-11 items-center justify-center gap-2 rounded-md px-2 text-sm hover:bg-muted sm:min-h-9"
              disabled={!selectedLyricsChoice || !onPreview}
              onClick={() => {
                if (!selectedLyricsChoice) return;
                onPreview?.(lyricsChoicePreview(selectedLyricsChoice));
                onOpenChange(false);
              }}
            >
              <FileText className="h-4 w-4" />
              Preview
            </button>
            {selectedLyricsChoice && isLyricsAttachmentHidden?.(selectedLyricsChoice.locationId) && (
              <button
                className="flex min-h-11 items-center justify-center gap-2 rounded-md px-2 text-sm hover:bg-muted sm:min-h-9"
                onClick={() => {
                  onRevealLyricsAttachment?.(selectedLyricsChoice.locationId);
                  onOpenChange(false);
                }}
              >
                <Folder className="h-4 w-4" />
                Show in directory
              </button>
            )}
          </div>
          {file.lyricsPreferencePersistable === false && (
            <div className="rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground">
              This remote preview selection is temporary.
            </div>
          )}
        </div>
      </AnchoredPopover>
    </div>
  );
}

function TreeFileMoreActions({
  file,
  files,
  choices,
  canPlay,
  hasQueueActions,
  open,
  anchorRef,
  onOpenChange,
  onOpenLyrics,
  onCloseLyrics,
  onPlayFolder,
  onPlayNext,
  onAppendQueue,
}: {
  file: TreeTrack;
  files: TreeTrack[];
  choices: LyricsChoice[];
  canPlay: boolean;
  hasQueueActions: boolean;
  open: boolean;
  anchorRef: RefObject<HTMLDivElement>;
  onOpenChange: (open: boolean) => void;
  onOpenLyrics: () => void;
  onCloseLyrics: () => void;
  onPlayFolder?: (tracks: TreeTrack[], locationId: number) => void;
  onPlayNext?: (track: TreeTrack) => void;
  onAppendQueue?: (track: TreeTrack) => void;
}) {
  return (
    <div ref={anchorRef} className={hasQueueActions ? "" : "lg:hidden"} onClick={(event) => event.stopPropagation()}>
      <button
        className={`grid h-11 w-11 place-items-center rounded-md hover:bg-secondary hover:text-foreground sm:h-9 sm:w-9 ${hasQueueActions ? "" : "lg:hidden"}`}
        onClick={() => {
          onCloseLyrics();
          onOpenChange(!open);
        }}
        aria-label={`More actions for ${file.title}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        className={`w-52 rounded-lg border bg-card p-1 text-sm text-card-foreground shadow-xl ${hasQueueActions ? "" : "lg:hidden"}`}
      >
        <div role="menu" aria-label={`More actions for ${file.title}`}>
          {choices.length > 0 && (
            <button
              role="menuitem"
              className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-muted lg:hidden"
              onClick={() => {
                onOpenChange(false);
                onOpenLyrics();
              }}
              aria-haspopup="dialog"
            >
              <Captions className="h-4 w-4" />
              Lyrics
            </button>
          )}
          {canPlay && file.kind === "video" && (
            <button
              role="menuitem"
              className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-muted sm:h-9 sm:min-h-0"
              onClick={() => {
                onPlayFolder?.(files, file.locationId);
                onOpenChange(false);
              }}
            >
              <Headphones className="h-4 w-4" />
              Play as audio
            </button>
          )}
          {canPlay && onPlayNext && (
            <button
              role="menuitem"
              className="flex min-h-11 w-full items-center rounded-md px-2 text-left hover:bg-muted sm:h-9 sm:min-h-0"
              onClick={() => {
                onPlayNext(file);
                onOpenChange(false);
              }}
            >
              Play next
            </button>
          )}
          {canPlay && onAppendQueue && (
            <button
              role="menuitem"
              className="flex min-h-11 w-full items-center rounded-md px-2 text-left hover:bg-muted sm:h-9 sm:min-h-0"
              onClick={() => {
                onAppendQueue(file);
                onOpenChange(false);
              }}
            >
              Add to queue
            </button>
          )}
        </div>
      </AnchoredPopover>
    </div>
  );
}

function TreeFile({
  file,
  files,
  depth,
  isActive,
  onPlayFolder,
  onPlayNext,
  onAppendQueue,
  onPreview,
  isLyricsAttachmentHidden,
  onRevealLyricsAttachment,
}: {
  file: TreeTrack;
  files: TreeTrack[];
  depth: number;
  isActive: boolean;
  onPlayFolder?: (tracks: TreeTrack[], locationId: number) => void;
  onPlayNext?: (track: TreeTrack) => void;
  onAppendQueue?: (track: TreeTrack) => void;
  onPreview?: (preview: FilePreviewState) => void;
  isLyricsAttachmentHidden?: (locationId: number) => boolean;
  onRevealLyricsAttachment?: (locationId: number) => void;
}) {
  const player = useLibraryPlayer();
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [lyricsMenuOpen, setLyricsMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const actionAreaRef = useRef<HTMLSpanElement | null>(null);
  useDismissiblePopover(moreMenuOpen, moreMenuRef, () => setMoreMenuOpen(false));
  useDismissiblePopover(lyricsMenuOpen, actionAreaRef, () => setLyricsMenuOpen(false));
  const actionState = treeFileActionState({
    file,
    onPlayFolder,
    onPlayNext,
    onAppendQueue,
    onPreview,
    lyricsPreferenceOverrides: player.lyricsPreferenceOverrides,
  });
  const openFile = () =>
    openTreeFile({
      file,
      files,
      preview: actionState.preview,
      canPlay: actionState.canPlay,
      canDownload: actionState.canDownload,
      onPlayFolder,
      onPreview,
    });
  return (
    <div
      data-testid="directory-file-row"
      data-file-kind={file.kind}
      role={actionState.canOpen ? "button" : undefined}
      tabIndex={actionState.canOpen ? 0 : undefined}
      className={`flex min-h-14 items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm ${
        isActive ? "border-primary bg-secondary" : "bg-background hover:bg-muted"
      } ${actionState.canOpen ? "cursor-pointer" : "cursor-default"}`}
      style={{ marginLeft: Math.min(depth, 8) * 14, width: `calc(100% - ${Math.min(depth, 8) * 14}px)` }}
      onClick={() => {
        if (actionState.canOpen) openFile();
      }}
      onKeyDown={(event) => {
        if (!actionState.canOpen || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        openFile();
      }}
    >
      <span className="flex min-w-0 flex-1 items-start gap-2">
        <span className="mt-0.5 shrink-0">
          {isActive ? <Pause className="h-4 w-4 text-primary" /> : fileIcon(file)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block whitespace-normal break-words [overflow-wrap:anywhere]">{file.title}</span>
          <span className="mt-0.5 block break-words text-xs text-muted-foreground">{actionState.fileMeta}</span>
        </span>
      </span>
      <span ref={actionAreaRef} className="flex shrink-0 items-start gap-2 pt-0.5 text-xs text-muted-foreground">
        {file.kind === "file" && actionState.canDownload && (
          <ExternalLink className="h-3.5 w-3.5 text-primary" aria-label="Downloads in new tab" />
        )}
        {actionState.lyricsChoices.length > 0 && (
          <TreeFileLyricsActions
            file={file}
            choices={actionState.lyricsChoices}
            preferredLyricsMediaItemId={actionState.preferredLyricsMediaItemId}
            automaticLyrics={actionState.automaticLyrics}
            selectedLyricsChoice={actionState.selectedLyricsChoice}
            open={lyricsMenuOpen}
            anchorRef={actionAreaRef}
            onOpenChange={setLyricsMenuOpen}
            onCloseMore={() => setMoreMenuOpen(false)}
            onPreview={onPreview}
            isLyricsAttachmentHidden={isLyricsAttachmentHidden}
            onRevealLyricsAttachment={onRevealLyricsAttachment}
          />
        )}
        {actionState.hasMoreActions && (
          <TreeFileMoreActions
            file={file}
            files={files}
            choices={actionState.lyricsChoices}
            canPlay={actionState.canPlay}
            hasQueueActions={actionState.hasQueueActions}
            open={moreMenuOpen}
            anchorRef={moreMenuRef}
            onOpenChange={setMoreMenuOpen}
            onOpenLyrics={() => setLyricsMenuOpen(true)}
            onCloseLyrics={() => setLyricsMenuOpen(false)}
            onPlayFolder={onPlayFolder}
            onPlayNext={onPlayNext}
            onAppendQueue={onAppendQueue}
          />
        )}
      </span>
    </div>
  );
}

function lyricsMatchReasonLabel(reason: LyricsChoice["reason"]) {
  if (reason === "exact_sidecar") return "Exact sidecar";
  if (reason === "same_stem") return "Matching file name";
  if (reason === "normalized_name") return "Normalized file name";
  return "Shared in this folder";
}

function lyricsChoicePreview(choice: LyricsChoice): FilePreviewState {
  return {
    kind: "text",
    title: choice.title,
    locationId: choice.locationId,
    url: choice.url,
  };
}

function directoryManagerRootTarget({
  fileTargets,
  allowLocalDelete,
  localRoot,
  workId,
}: {
  fileTargets: MediaDeleteTarget[];
  allowLocalDelete?: boolean;
  localRoot: { folderId: number; path: string } | null;
  workId: number;
}): MediaDeleteTarget | null {
  const representative = fileTargets.find(
    (target) => target.kind === "local" && localRoot && isMediaPathWithinRoot(localRoot.path, target.path),
  );
  if (!allowLocalDelete || !localRoot || !representative) return null;
  return {
    kind: "local_root",
    locationId: representative.locationId,
    folderId: localRoot.folderId,
    expectedPath: localRoot.path,
    title: "Work root",
    path: localRoot.path,
    sizeBytes: null,
    workId,
  };
}

function directoryManagerExtensionState(targets: MediaDeleteTarget[], selectedKeys: Set<string>, extension: string) {
  const matching = targets.filter((target) => target.path.toLowerCase().endsWith(`.${extension}`));
  const selected = matching.filter((target) => selectedKeys.has(mediaDeleteTargetKey(target))).length;
  return {
    count: matching.length,
    checked: matching.length > 0 && selected === matching.length,
    indeterminate: selected > 0 && selected < matching.length,
  };
}

function directoryManagerSelectionModel({
  targets,
  fileTargets,
  selectedKeys,
  canForgetWork,
}: {
  targets: MediaDeleteTarget[];
  fileTargets: MediaDeleteTarget[];
  selectedKeys: Set<string>;
  canForgetWork: boolean;
}) {
  const selectedTargets = targets.filter((target) => selectedKeys.has(mediaDeleteTargetKey(target)));
  const selectedRootTarget = selectedTargets.find((target) => target.kind === "local_root") ?? null;
  const allFileTargetsSelected =
    fileTargets.length > 0 && fileTargets.every((target) => selectedKeys.has(mediaDeleteTargetKey(target)));
  const selectedWorkIDs = new Set(selectedTargets.map((target) => target.workId).filter((id) => id > 0));
  return {
    selectedTargets,
    selectedSignature: selectedTargets.map(mediaDeleteTargetKey).sort().join("|"),
    allSelected: targets.length > 0 && selectedTargets.length === targets.length,
    canReviewForget: Boolean(
      canForgetWork &&
      selectedRootTarget &&
      allFileTargetsSelected &&
      selectedWorkIDs.size === 1 &&
      selectedRootTarget.workId > 0,
    ),
  };
}

function useDirectoryManagerPreview(selectedTargets: MediaDeleteTarget[], selectedSignature: string) {
  const [previewTargets, setPreviewTargets] = useState<MediaDeleteTarget[]>([]);
  const previewSignature = previewTargets.map(mediaDeleteTargetKey).sort().join("|");
  const previewRefreshing = selectedTargets.length > 0 && selectedSignature !== previewSignature;

  useEffect(() => {
    const timer = window.setTimeout(() => setPreviewTargets(selectedTargets), selectedTargets.length === 0 ? 0 : 600);
    return () => window.clearTimeout(timer);
  }, [selectedSignature, selectedTargets]);

  return { previewTargets, previewRefreshing };
}

function DirectoryManagerSelectionToolbar({
  targets,
  selectedKeys,
  deleting,
  showCachedFilter,
  showOnlyDeletable,
  onSelectAll,
  onClear,
  onSetExtensionIncluded,
  onShowOnlyDeletableChange,
}: {
  targets: MediaDeleteTarget[];
  selectedKeys: Set<string>;
  deleting: boolean;
  showCachedFilter: boolean;
  showOnlyDeletable: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  onSetExtensionIncluded: (extension: string, included: boolean) => void;
  onShowOnlyDeletableChange: (checked: boolean) => void;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" disabled={targets.length === 0 || deleting} onClick={onSelectAll}>
        All
      </Button>
      {(["mp3", "wav", "flac"] as const).map((extension) => {
        const state = directoryManagerExtensionState(targets, selectedKeys, extension);
        return (
          <label
            key={extension}
            className="inline-flex h-8 items-center gap-2 rounded-md border bg-background px-2 text-xs"
          >
            <Checkbox
              checked={state.checked}
              indeterminate={state.indeterminate}
              disabled={deleting || state.count === 0}
              onCheckedChange={() => onSetExtensionIncluded(extension, !state.checked)}
              aria-label={`Include ${extension.toUpperCase()}`}
            />
            <span>{extension.toUpperCase()}</span>
          </label>
        );
      })}
      <Button variant="outline" size="sm" disabled={deleting} onClick={onClear}>
        None
      </Button>
      {showCachedFilter && (
        <label className="ml-auto inline-flex h-8 items-center gap-2 rounded-md border bg-background px-2 text-xs">
          <Checkbox
            checked={showOnlyDeletable}
            onCheckedChange={onShowOnlyDeletableChange}
            aria-label="Show cached files only"
          />
          <span>Cached only</span>
        </label>
      )}
    </div>
  );
}

function DirectoryManagerPreview({
  previewTargets,
  previewRefreshing,
}: {
  previewTargets: MediaDeleteTarget[];
  previewRefreshing: boolean;
}) {
  return (
    <div className="app-scroll min-h-0 overflow-auto p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">Delete preview</div>
        </div>
        <Badge variant={previewRefreshing ? "outline" : "secondary"}>
          {previewRefreshing ? "Refreshing" : `${previewTargets.length} items`}
        </Badge>
      </div>
      {previewRefreshing && (
        <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Updating after your selection changes
        </div>
      )}
      {previewTargets.length === 0 ? (
        <div className="text-sm text-muted-foreground">Select deletable files to build the preview.</div>
      ) : (
        <div className="space-y-1">
          {previewTargets.map((target) => (
            <div
              key={mediaDeleteTargetKey(target)}
              className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 border-b py-2 text-xs last:border-b-0"
            >
              <Badge variant="outline" className="row-span-2 h-fit">
                {target.kind}
              </Badge>
              <span className="truncate font-medium" title={target.path}>
                {target.path}
              </span>
              <span className="text-muted-foreground">
                {target.title}
                {target.sizeBytes !== null ? ` · ${formatBytes(target.sizeBytes)}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DirectoryManagerFooter({
  targets,
  selectedCount,
  allSelected,
  canReviewForget,
  previewRefreshing,
  deleting,
  onToggleAll,
  onStartConfirmation,
}: {
  targets: MediaDeleteTarget[];
  selectedCount: number;
  allSelected: boolean;
  canReviewForget: boolean;
  previewRefreshing: boolean;
  deleting: boolean;
  onToggleAll: () => void;
  onStartConfirmation: (mode: MediaCleanupMode) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={targets.length === 0 || deleting} onClick={onToggleAll}>
          {allSelected ? "Clear all" : "Select all"}
        </Button>
        <span className="text-xs text-muted-foreground">
          {selectedCount} selected / {targets.length} deletable
        </span>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={selectedCount === 0 || previewRefreshing || deleting}
          onClick={() => onStartConfirmation("files_only")}
        >
          <Trash2 className="h-4 w-4" />
          {deleting ? "Deleting" : previewRefreshing ? "Refreshing preview" : "Review file deletion"}
        </Button>
        <Button
          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          size="sm"
          disabled={!canReviewForget || previewRefreshing || deleting}
          title={
            canReviewForget
              ? "Delete the selected files, then forget the work if no source remains."
              : "Select the complete local work root and every deletable file from one work."
          }
          onClick={() => onStartConfirmation("files_and_forget_work")}
        >
          <ShieldAlert className="h-4 w-4" />
          {deleting ? "Deleting" : "Review deletion and forget work"}
        </Button>
      </div>
    </div>
  );
}

function DirectoryManagerModal({
  root,
  title = "Manage files",
  description = "Review file operations in the same folder structure as the directory tree.",
  emptyLabel,
  onClose,
  deleting = false,
  onDeleteTargets,
  allowCacheDelete,
  allowLocalDelete,
  localRoot = null,
  showCachedFilter = false,
  workId = 0,
  canForgetWork = false,
}: {
  root: TreeNode;
  title?: string;
  description?: string;
  emptyLabel: string;
  onClose: () => void;
  deleting?: boolean;
  onDeleteTargets?: (targets: MediaDeleteTarget[], mode: MediaCleanupMode) => void;
  allowCacheDelete?: boolean;
  allowLocalDelete?: boolean;
  localRoot?: { folderId: number; path: string } | null;
  showCachedFilter?: boolean;
  workId?: number;
  canForgetWork?: boolean;
}) {
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [confirmStep, setConfirmStep] = useState<0 | 1 | 2>(0);
  const [confirmMode, setConfirmMode] = useState<MediaCleanupMode | null>(null);
  const [showOnlyDeletable, setShowOnlyDeletable] = useState(showCachedFilter);
  const fileTargets = useMemo(
    () => directoryManageTargets(root, { allowCacheDelete, allowLocalDelete }).map((target) => ({ ...target, workId })),
    [root, allowCacheDelete, allowLocalDelete, workId],
  );
  const rootTarget = useMemo<MediaDeleteTarget | null>(() => {
    return directoryManagerRootTarget({ fileTargets, allowLocalDelete, localRoot, workId });
  }, [allowLocalDelete, fileTargets, localRoot, workId]);
  const targets = useMemo(() => (rootTarget ? [...fileTargets, rootTarget] : fileTargets), [fileTargets, rootTarget]);
  const selection = useMemo(
    () => directoryManagerSelectionModel({ targets, fileTargets, selectedKeys, canForgetWork }),
    [targets, fileTargets, selectedKeys, canForgetWork],
  );
  const { previewTargets, previewRefreshing } = useDirectoryManagerPreview(
    selection.selectedTargets,
    selection.selectedSignature,
  );
  const toggleAll = () =>
    setSelectedKeys(selection.allSelected ? new Set() : new Set(targets.map(mediaDeleteTargetKey)));
  const setExtensionIncluded = (extension: string, included: boolean) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      for (const target of targets) {
        if (!target.path.toLowerCase().endsWith(`.${extension}`)) continue;
        const key = mediaDeleteTargetKey(target);
        if (included) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  };
  const toggleTarget = (target: MediaDeleteTarget, selected: boolean) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      const key = mediaDeleteTargetKey(target);
      if (selected) next.add(key);
      else next.delete(key);
      return next;
    });
  };
  const startConfirmation = (mode: MediaCleanupMode) => {
    setConfirmMode(mode);
    setConfirmStep(1);
  };
  const confirmDelete = (mode: MediaCleanupMode) => {
    onDeleteTargets?.(previewTargets, mode);
    setConfirmStep(0);
    setConfirmMode(null);
    setSelectedKeys(new Set());
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4" onMouseDown={onClose}>
      <div
        className="flex max-h-[86vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex min-h-12 items-center justify-between gap-3 border-b px-4">
          <div>
            <h3 className="text-base font-semibold">{title}</h3>
            <p className="text-xs text-muted-foreground">{description}</p>
          </div>
          <IconButton title="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden bg-card md:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.75fr)]">
          <div className="app-scroll min-h-0 overflow-auto border-b p-3 md:border-b-0 md:border-r">
            <DirectoryManagerSelectionToolbar
              targets={targets}
              selectedKeys={selectedKeys}
              deleting={deleting}
              showCachedFilter={showCachedFilter}
              showOnlyDeletable={showOnlyDeletable}
              onSelectAll={() => setSelectedKeys(new Set(targets.map(mediaDeleteTargetKey)))}
              onClear={() => setSelectedKeys(new Set())}
              onSetExtensionIncluded={setExtensionIncluded}
              onShowOnlyDeletableChange={(checked) => setShowOnlyDeletable(checked)}
            />
            <DirectoryManager
              root={root}
              emptyLabel={emptyLabel}
              selectedKeys={selectedKeys}
              allowCacheDelete={allowCacheDelete}
              allowLocalDelete={allowLocalDelete}
              showOnlyDeletable={showOnlyDeletable}
              onToggleTarget={toggleTarget}
              rootTarget={rootTarget}
            />
          </div>
          <DirectoryManagerPreview previewTargets={previewTargets} previewRefreshing={previewRefreshing} />
        </div>
        <DirectoryManagerFooter
          targets={targets}
          selectedCount={selection.selectedTargets.length}
          allSelected={selection.allSelected}
          canReviewForget={selection.canReviewForget}
          previewRefreshing={previewRefreshing}
          deleting={deleting}
          onToggleAll={toggleAll}
          onStartConfirmation={startConfirmation}
        />
      </div>
      {confirmStep > 0 && (
        <ConfirmMediaBatchDeleteModal
          targets={previewTargets}
          mode={confirmMode ?? "files_only"}
          step={confirmStep === 2 ? 2 : 1}
          deleting={deleting}
          onCancel={() => {
            setConfirmStep(0);
            setConfirmMode(null);
          }}
          onContinue={() => setConfirmStep(2)}
          onConfirm={() => confirmDelete(confirmMode ?? "files_only")}
        />
      )}
    </div>
  );
}

function DirectoryManager({
  root,
  emptyLabel,
  selectedKeys,
  allowCacheDelete,
  allowLocalDelete,
  showOnlyDeletable,
  onToggleTarget,
  rootTarget,
}: {
  root: TreeNode;
  emptyLabel: string;
  selectedKeys: Set<string>;
  allowCacheDelete?: boolean;
  allowLocalDelete?: boolean;
  showOnlyDeletable?: boolean;
  onToggleTarget: (target: MediaDeleteTarget, selected: boolean) => void;
  rootTarget?: MediaDeleteTarget | null;
}) {
  const hasFiles = useMemo(() => sortedFilesDeep(root).length > 0, [root]);
  if (!hasFiles) {
    return <div className="text-sm text-muted-foreground">{emptyLabel}</div>;
  }
  return (
    <div className="space-y-1">
      {rootTarget &&
        (() => {
          const rootTargets = [...directoryManageTargets(root, { allowCacheDelete, allowLocalDelete }), rootTarget];
          const selectedCount = rootTargets.filter((target) => selectedKeys.has(mediaDeleteTargetKey(target))).length;
          const checked = selectedCount === rootTargets.length;
          const mixed = selectedCount > 0 && !checked;
          return (
            <div className="flex min-h-9 items-center gap-2 rounded-md px-2 text-sm font-medium hover:bg-muted">
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
              <Checkbox
                checked={checked}
                indeterminate={mixed}
                onCheckedChange={() => rootTargets.forEach((target) => onToggleTarget(target, !checked))}
                aria-label={`Select work root ${rootTarget.path}`}
              />
              <Folder className="h-4 w-4 shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate" title={rootTarget.path}>
                {rootTarget.path}
              </span>
              <span className="text-xs text-muted-foreground">
                {selectedCount}/{rootTargets.length}
              </span>
            </div>
          );
        })()}
      <DirectoryManagerNode
        node={root}
        depth={0}
        selectedKeys={selectedKeys}
        allowCacheDelete={allowCacheDelete}
        allowLocalDelete={allowLocalDelete}
        showOnlyDeletable={showOnlyDeletable}
        onToggleTarget={onToggleTarget}
        isRoot
      />
    </div>
  );
}

function DirectoryManagerNode({
  node,
  depth,
  isRoot,
  selectedKeys,
  allowCacheDelete,
  allowLocalDelete,
  showOnlyDeletable,
  onToggleTarget,
}: {
  node: TreeNode;
  depth: number;
  isRoot?: boolean;
  selectedKeys: Set<string>;
  allowCacheDelete?: boolean;
  allowLocalDelete?: boolean;
  showOnlyDeletable?: boolean;
  onToggleTarget: (target: MediaDeleteTarget, selected: boolean) => void;
}) {
  const [open, setOpen] = useState(isRoot);
  const options = { allowCacheDelete, allowLocalDelete };
  const folders = sortedFolders(node).filter(
    (folder) => !showOnlyDeletable || directoryManageTargets(folder, options).length > 0,
  );
  const files = sortedFiles(node).filter(
    (file) => !showOnlyDeletable || mediaDeleteTargetsForFile(file, options).length > 0,
  );
  const stats = treeStats(node);
  const hasChildren = folders.length > 0 || files.length > 0;
  const nodeTargets = directoryManageTargets(node, options);
  const selectedCount = nodeTargets.filter((target) => selectedKeys.has(mediaDeleteTargetKey(target))).length;
  const checked = nodeTargets.length > 0 && selectedCount === nodeTargets.length;
  const mixed = selectedCount > 0 && selectedCount < nodeTargets.length;
  const toggleNode = () => {
    for (const target of nodeTargets) onToggleTarget(target, !checked);
  };
  return (
    <div className="space-y-1">
      {!isRoot && (
        <div
          className="flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm font-medium hover:bg-muted"
          style={{ paddingLeft: depth * 14 + 8 }}
        >
          <button
            type="button"
            className="rounded p-0.5 hover:bg-background"
            onClick={() => setOpen((value) => !value)}
            aria-label={open ? `Collapse ${node.name}` : `Expand ${node.name}`}
          >
            {open ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
          <Checkbox
            checked={checked}
            indeterminate={mixed}
            disabled={nodeTargets.length === 0}
            onCheckedChange={toggleNode}
            aria-label={`Select ${node.name}`}
          />
          <Folder className="h-4 w-4 shrink-0 text-primary" />
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left"
            onClick={() => setOpen((value) => !value)}
          >
            {node.name}
          </button>
          <span className="shrink-0 text-xs text-muted-foreground">
            {selectedCount}/{nodeTargets.length} · {formatFolderStats(stats, playableFiles(node.files).length)}
          </span>
        </div>
      )}
      {(isRoot || open) && hasChildren && (
        <>
          {folders.map((folder) => (
            <DirectoryManagerNode
              key={folder.path || folder.name}
              node={folder}
              depth={isRoot ? 0 : depth + 1}
              selectedKeys={selectedKeys}
              allowCacheDelete={allowCacheDelete}
              allowLocalDelete={allowLocalDelete}
              showOnlyDeletable={showOnlyDeletable}
              onToggleTarget={onToggleTarget}
            />
          ))}
          {files.map((file) => (
            <ManagedFileRow
              key={`${file.locationType}:${file.locationId}:${file.sourcePath}`}
              file={file}
              depth={isRoot ? 0 : depth + 1}
              selectedKeys={selectedKeys}
              allowCacheDelete={allowCacheDelete}
              allowLocalDelete={allowLocalDelete}
              onToggleTarget={onToggleTarget}
            />
          ))}
        </>
      )}
    </div>
  );
}

function ManagedFileRow({
  file,
  depth,
  selectedKeys,
  allowCacheDelete,
  allowLocalDelete,
  onToggleTarget,
}: {
  file: TreeTrack;
  depth: number;
  selectedKeys: Set<string>;
  allowCacheDelete?: boolean;
  allowLocalDelete?: boolean;
  onToggleTarget: (target: MediaDeleteTarget, selected: boolean) => void;
}) {
  const targets = mediaDeleteTargetsForFile(file, { allowCacheDelete, allowLocalDelete });
  const selectedCount = targets.filter((target) => selectedKeys.has(mediaDeleteTargetKey(target))).length;
  const checked = targets.length > 0 && selectedCount === targets.length;
  const mixed = selectedCount > 0 && selectedCount < targets.length;
  const toggleFile = () => {
    for (const target of targets) onToggleTarget(target, !checked);
  };
  const fileMeta = [
    file.kind === "audio" || file.kind === "video" ? formatDuration(file.durationSeconds) : "",
    formatBytes(file.sizeBytes),
    file.locationType,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      className="grid min-h-10 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm"
      style={{ marginLeft: depth * 14, width: `calc(100% - ${depth * 14}px)` }}
    >
      <Checkbox
        checked={checked}
        indeterminate={mixed}
        disabled={targets.length === 0}
        onCheckedChange={toggleFile}
        aria-label={`Select ${file.title}`}
      />
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          {fileIcon(file)}
          <span className="truncate font-medium">{file.title}</span>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="max-w-full truncate">{file.sourcePath}</span>
          <span>{fileMeta}</span>
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-1">
        {targets.map((target) => (
          <Badge key={mediaDeleteTargetKey(target)} variant="outline">
            {target.kind === "cache" ? "Cache" : "Local"}
          </Badge>
        ))}
        {targets.length === 0 && (
          <span className="inline-flex h-8 items-center text-xs text-muted-foreground">No file action</span>
        )}
      </div>
    </div>
  );
}

function ConfirmMediaBatchDeleteModal({
  targets,
  mode,
  step,
  deleting,
  onCancel,
  onContinue,
  onConfirm,
}: {
  targets: MediaDeleteTarget[];
  mode: MediaCleanupMode;
  step: 1 | 2;
  deleting: boolean;
  onCancel: () => void;
  onContinue: () => void;
  onConfirm: () => void;
}) {
  const forgetWork = mode === "files_and_forget_work";
  const localCount = targets.filter((target) => target.kind === "local").length;
  const cacheCount = targets.filter((target) => target.kind === "cache").length;
  const rootCount = targets.filter((target) => target.kind === "local_root").length;
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/55 p-4" onMouseDown={onCancel}>
      <div
        className="w-full max-w-lg rounded-lg border bg-background shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b p-4">
          <div>
            <h3 className="text-base font-semibold">
              {step === 1
                ? forgetWork
                  ? "Review deletion and forget work"
                  : "Review file deletion"
                : "Final confirmation"}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {step === 1
                ? forgetWork
                  ? "The second confirmation will delete files first, then re-check every source before forgetting the work."
                  : "The second confirmation deletes files only; work history and marks remain."
                : forgetWork
                  ? "This action cannot be undone. Review both lists before continuing."
                  : "Deleted files cannot be restored by Kikoto."}
            </p>
          </div>
          <IconButton title="Close" onClick={onCancel}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="space-y-3 p-4 text-sm">
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive">
            Delete {targets.length} selected location{targets.length === 1 ? "" : "s"}
            {localCount > 0 ? `, including ${localCount} local` : ""}
            {cacheCount > 0 ? ` and ${cacheCount} cache` : ""}
            {rootCount > 0 ? ", including the complete local work root" : ""}.
          </div>
          <div className="app-scroll max-h-44 overflow-auto rounded-md border bg-muted px-3 py-2 text-xs text-muted-foreground">
            {targets.slice(0, 10).map((target) => (
              <div key={mediaDeleteTargetKey(target)} className="flex gap-2 py-0.5">
                <span className="w-12 shrink-0 font-medium">{target.kind}</span>
                <span className="min-w-0 flex-1 truncate">{target.path}</span>
              </div>
            ))}
            {targets.length > 10 && <div className="pt-1">...and {targets.length - 10} more</div>}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <section className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <h4 className="font-semibold text-destructive">Will be deleted</h4>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                <li>The selected cache and local files, plus their location availability state.</li>
                {forgetWork ? (
                  <li>
                    If no available source remains after the file step: the complete logical work family, all metadata,
                    playback history, Quick mark, and every List membership for every user.
                  </li>
                ) : (
                  <li>No work-level data, playback history, Quick mark, List membership, or metadata.</li>
                )}
              </ul>
            </section>
            <section className="rounded-md border bg-muted/30 p-3">
              <h4 className="font-semibold">Will be kept</h4>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                {forgetWork ? (
                  <>
                    <li>Any other available remote, tracked, cache, or local source; in that case the work stays.</li>
                    <li>Shared tags, people, circles, catalog discovery, audit history, and workflow history.</li>
                  </>
                ) : (
                  <>
                    <li>Playback records, Resume/recent playback, Quick mark, and all List memberships.</li>
                    <li>Work metadata and every other source or unselected file.</li>
                  </>
                )}
              </ul>
            </section>
          </div>
          {forgetWork && (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
              If another source is still available, the workflow finishes as partial: files are deleted, but the work
              and all work-level user data are retained.
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t p-4">
          <Button variant="outline" onClick={onCancel} disabled={deleting}>
            Cancel
          </Button>
          {step === 1 ? (
            <Button onClick={onContinue} disabled={targets.length === 0}>
              Continue
            </Button>
          ) : (
            <Button
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={onConfirm}
              disabled={deleting || targets.length === 0}
            >
              <Trash2 className="h-4 w-4" />
              {deleting ? "Deleting" : forgetWork ? "Delete files and forget work" : "Delete files only"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function directoryManageTargets(root: TreeNode, options: { allowCacheDelete?: boolean; allowLocalDelete?: boolean }) {
  return sortedFilesDeep(root).flatMap((file) => mediaDeleteTargetsForFile(file, options));
}

function mediaDeleteTargetsForFile(
  file: TreeTrack,
  options: { allowCacheDelete?: boolean; allowLocalDelete?: boolean },
) {
  const targets: MediaDeleteTarget[] = [];
  if (options.allowCacheDelete && file.cacheAvailable && file.cacheLocationId !== null) {
    targets.push({
      kind: "cache",
      locationId: file.cacheLocationId,
      workId: 0,
      title: file.title,
      path: file.cachePath,
      sizeBytes: file.sizeBytes,
    });
  }
  if (options.allowLocalDelete && file.localAvailable && file.localLocationId !== null) {
    targets.push({
      kind: "local",
      locationId: file.localLocationId,
      workId: 0,
      title: file.title,
      path: file.localPath,
      sizeBytes: file.sizeBytes,
    });
  }
  return targets;
}

function mediaDeleteTargetKey(target: MediaDeleteTarget) {
  return `${target.kind}:${target.folderId ?? target.locationId}`;
}

function isMediaPathWithinRoot(root: string, candidate: string) {
  const normalizedRoot = root
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  const normalizedCandidate = candidate
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function folderNameHasPriority(name: string) {
  const lower = name.toLowerCase();
  return ["本編", "honhen", "main", "mp3"].some((value) => lower.includes(value.toLowerCase()));
}

const defaultDirectoryRoutingRules: DirectoryRoutingRule[] = [
  {
    id: "main",
    label: "Main story",
    weight: 40,
    aliases: ["本編", "本篇", "honhen", "main"],
    negativeAliases: ["特典", "bonus", "おまけ"],
    enabled: true,
  },
  {
    id: "with_se",
    label: "SEあり",
    weight: 30,
    aliases: ["SEあり", "SE有", "SE付き", "効果音あり", "with se"],
    negativeAliases: ["SEなし", "SE無", "効果音なし", "without se"],
    enabled: true,
  },
  {
    id: "mp3",
    label: "mp3",
    weight: 20,
    aliases: ["mp3"],
    negativeAliases: ["wav", "flac"],
    enabled: true,
  },
];

type DirectoryCandidate = {
  node: TreeNode;
  path: string[];
  score: number;
  positiveMatches: string[];
  negativeMatches: string[];
  audioCount: number;
  durationSeconds: number;
  order: number;
};

type DirectoryRouteMatch = {
  path: string[];
  pathLabel: string;
  positiveMatches: string[];
  negativeMatches: string[];
};

function recommendedDirectoryPath(root: TreeNode, rules: DirectoryRoutingRule[]) {
  return recommendedDirectoryCandidate(root, rules)?.path ?? [];
}

function recommendedDirectoryCandidate(root: TreeNode, rules: DirectoryRoutingRule[]) {
  const candidates = directoryCandidates(root, rules);
  if (candidates.length === 0) return null;
  return candidates.sort(
    (left, right) =>
      right.score - left.score ||
      right.audioCount - left.audioCount ||
      right.durationSeconds - left.durationSeconds ||
      left.path.length - right.path.length ||
      left.order - right.order,
  )[0];
}

function directoryRouteSummary(root: TreeNode, rules: DirectoryRoutingRule[]): DirectoryRouteMatch | null {
  const candidate = recommendedDirectoryCandidate(root, rules);
  if (!candidate) return null;
  return {
    path: candidate.path,
    pathLabel: candidate.path.length > 0 ? `/${candidate.path.join("/")}` : "/",
    positiveMatches: candidate.positiveMatches,
    negativeMatches: candidate.negativeMatches,
  };
}

function directoryCandidates(root: TreeNode, rules: DirectoryRoutingRule[]) {
  const candidates: DirectoryCandidate[] = [];
  let order = 0;
  const visit = (node: TreeNode, path: string[]) => {
    const playable = playableFiles(node.files);
    if (playable.length > 0) {
      const match = scoreDirectoryCandidate(node, path, playable, rules);
      candidates.push({
        node,
        path,
        score: match.score,
        positiveMatches: match.positiveMatches,
        negativeMatches: match.negativeMatches,
        audioCount: playable.length,
        durationSeconds: playable.reduce((sum, file) => sum + (file.durationSeconds ?? 0), 0),
        order,
      });
      order += 1;
    }
    for (const child of sortedFolders(node)) {
      visit(child, [...path, child.name]);
    }
  };
  visit(root, []);
  return candidates;
}

function scoreDirectoryCandidate(node: TreeNode, path: string[], files: TreeTrack[], rules: DirectoryRoutingRule[]) {
  const text = normalizeDirectoryMatchText(
    [...path, node.name, node.path, ...files.map((file) => file.title), ...files.map((file) => file.baseName)].join(
      " / ",
    ),
  );
  let score = 0;
  const positiveMatches: string[] = [];
  const negativeMatches: string[] = [];
  const enabledRules = rules.filter((rule) => rule.enabled && rule.aliases.length > 0);
  enabledRules.forEach((rule, index) => {
    const weight = Number.isFinite(rule.weight) ? Math.max(1, rule.weight) : Math.max(1, 40 - index * 10);
    const alias = rule.aliases.find((alias) => directoryTextMatches(text, alias));
    if (alias) {
      score += weight;
      positiveMatches.push(alias);
    }
    const negativeAlias = rule.negativeAliases.find((alias) => directoryTextMatches(text, alias));
    if (negativeAlias) {
      score -= Math.ceil(weight * 0.9);
      negativeMatches.push(negativeAlias);
    }
  });
  score += Math.min(10, files.length);
  return { score, positiveMatches, negativeMatches };
}

function normalizeDirectoryMatchText(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[-＿_.[\]()【】]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function directoryTextMatches(text: string, alias: string) {
  const normalized = normalizeDirectoryMatchText(alias);
  return normalized !== "" && text.includes(normalized);
}

function sortedFolders(node: TreeNode) {
  return sortedTreeChildren(node);
}

function sortedFiles(node: TreeNode) {
  return sortedTreeFiles(node);
}

function sortedFilesDeep(node: TreeNode) {
  const files = [...node.files];
  for (const child of node.children.values()) {
    files.push(...sortedFilesDeep(child));
  }
  return files.sort((a, b) =>
    (a.sourcePath || a.title).localeCompare(b.sourcePath || b.title, undefined, { numeric: true, sensitivity: "base" }),
  );
}

type VisibleTreeRow =
  | { type: "folder"; node: TreeNode; depth: number }
  | { type: "file"; file: TreeTrack; parent: TreeNode; depth: number };

function initialExpandedTreePaths(root: TreeNode, rules: DirectoryRoutingRule[]) {
  const paths = new Set<string>();
  const recommended = recommendedDirectoryCandidate(root, rules);
  if (recommended) {
    let cursor: TreeNode | null = root;
    for (const part of recommended.path) {
      cursor = cursor?.children.get(part) ?? null;
      if (!cursor) break;
      paths.add(cursor.path);
    }
    return paths;
  }
  for (const folder of sortedFolders(root)) {
    if (folderNameHasPriority(folder.name) || folderContainsActiveAudio(folder)) {
      paths.add(folder.path);
      for (const child of sortedFolders(folder)) {
        if (folderNameHasPriority(child.name)) paths.add(child.path);
      }
    }
  }
  return paths;
}

function folderContainsActiveAudio(node: TreeNode) {
  if (playableFiles(node.files).length > 0) return true;
  return sortedFolders(node).some(
    (child) => folderNameHasPriority(child.name) && playableFiles(child.files).length > 0,
  );
}

function flattenVisibleTreeRows(root: TreeNode, expandedPaths: Set<string>) {
  const rows: VisibleTreeRow[] = [];
  const visit = (node: TreeNode, depth: number) => {
    rows.push({ type: "folder", node, depth });
    if (!expandedPaths.has(node.path)) return;
    for (const child of sortedFolders(node)) {
      visit(child, depth + 1);
    }
    for (const file of sortedFiles(node)) {
      rows.push({ type: "file", file, parent: node, depth: depth + 1 });
    }
  };
  for (const folder of sortedFolders(root)) {
    visit(folder, 0);
  }
  for (const file of sortedFiles(root)) {
    rows.push({ type: "file", file, parent: root, depth: 0 });
  }
  return rows;
}

function nodeAtPath(root: TreeNode, path: string[]) {
  let cursor: TreeNode | undefined = root;
  for (const part of path) {
    cursor = cursor?.children.get(part);
    if (!cursor) return null;
  }
  return cursor;
}

function folderSummary(node: TreeNode) {
  const stats = treeStats(node);
  return formatFolderStats(stats, playableFiles(node.files).length);
}

function formatFolderStats(stats: TreeStats, directPlayableCount: number) {
  const countLabel =
    directPlayableCount > 0
      ? `${directPlayableCount} ${stats.video > 0 ? "playable" : "audio"}`
      : stats.files > 0
        ? `${stats.files} files`
        : "";
  const sizeLabel = stats.knownSizeFiles > 0 ? formatBytes(stats.sizeBytes) : "";
  return [countLabel, sizeLabel].filter(Boolean).join(" · ");
}

function fileIcon(file: TreeTrack) {
  if (file.kind === "audio") return <FileAudio className="h-4 w-4 text-muted-foreground" />;
  if (file.kind === "video") return <FileVideo className="h-4 w-4 text-muted-foreground" />;
  if (file.kind === "image") return <ImageIcon className="h-4 w-4 text-muted-foreground" />;
  if (file.kind === "text") return <FileText className="h-4 w-4 text-muted-foreground" />;
  return <FileText className="h-4 w-4 text-muted-foreground" />;
}

function fileKindLabel(kind: string) {
  if (kind === "audio") return "Audio";
  if (kind === "video") return "Video";
  if (kind === "image") return "Image";
  if (kind === "text") return "Text";
  return "File";
}

function previewForFile(file: TreeTrack): FilePreviewState | null {
  if (file.kind === "image" && file.assetUrl) {
    return {
      kind: "image",
      title: file.title,
      url: file.assetUrl,
      locationId: file.locationId,
      canSetCover: file.locationType === "local" && file.locationId > 0,
    };
  }
  if (file.kind === "video" && file.streamUrl) {
    return {
      kind: "video",
      title: file.title,
      url: file.streamUrl,
      locationId: file.locationId,
      canTranscode: file.locationType === "local" || file.locationType === "cache",
    };
  }
  if (file.kind === "text" && (file.locationId > 0 || file.streamUrl || file.downloadUrl)) {
    return {
      kind: "text",
      title: file.title,
      locationId: file.locationId,
      url: file.textPreviewUrl || (file.locationId > 0 ? undefined : file.streamUrl || file.downloadUrl || undefined),
    };
  }
  return null;
}

function FilePreviewModal({
  preview,
  onClose,
  onSetCover,
}: {
  preview: FilePreviewState;
  onClose: () => void;
  onSetCover?: (locationId: number) => void | Promise<void>;
}) {
  const player = usePlayer();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [forceVideoTranscode, setForceVideoTranscode] = useState(false);

  useEffect(() => {
    setForceVideoTranscode(false);
  }, [preview]);

  useEffect(() => {
    setText(null);
    setError("");
    if (preview.kind !== "text") return;
    const request = preview.url
      ? fetch(assetURL(preview.url), { headers: { Accept: "text/plain,text/*" } }).then(async (response) => {
          if (!response.ok) throw new Error(`Text preview returned HTTP ${response.status}.`);
          const length = Number(response.headers.get("content-length") ?? 0);
          if (length > 512 * 1024) throw new Error("Text file is too large to preview.");
          const content = await response.text();
          if (content.length > 512 * 1024) throw new Error("Text file is too large to preview.");
          return { content };
        })
      : api.getMediaText(preview.locationId);
    request
      .then((result) => setText(result.content))
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Text preview failed.");
      });
  }, [preview]);

  useEffect(() => {
    if (preview.kind === "video" && player.isPlaying) videoRef.current?.pause();
  }, [player.isPlaying, preview.kind]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={onClose}
    >
      <div
        className="flex max-h-[86vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border bg-card shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex min-h-11 items-center justify-between gap-3 border-b px-4">
          <div className="min-w-0 truncate text-sm font-semibold">{preview.title}</div>
          <div className="flex items-center gap-2">
            {preview.kind === "image" && (
              <Button
                variant="outline"
                size="sm"
                disabled={!onSetCover || !preview.canSetCover}
                onClick={() => void onSetCover?.(preview.locationId)}
              >
                <ImageIcon className="h-4 w-4" />
                Set cover
              </Button>
            )}
            <IconButton title="Close preview" onClick={onClose}>
              <X className="h-4 w-4" />
            </IconButton>
          </div>
        </div>
        <div className="app-scroll min-h-0 flex-1 overflow-auto bg-background p-4">
          {preview.kind === "image" ? (
            <img
              src={assetURL(preview.url)}
              alt=""
              className="mx-auto max-h-[72vh] max-w-full rounded-md object-contain"
            />
          ) : preview.kind === "video" ? (
            <div className="grid min-h-[240px] place-items-center">
              <video
                ref={videoRef}
                src={assetURL(playbackURL(preview.url, "video", forceVideoTranscode))}
                controls
                playsInline
                preload="metadata"
                className="max-h-[72vh] w-full bg-black object-contain"
                onPlay={player.pause}
                onError={() => {
                  if (preview.canTranscode && !forceVideoTranscode) {
                    setForceVideoTranscode(true);
                  } else {
                    setError("This video could not be played.");
                  }
                }}
              />
              {error && <div className="mt-3 text-sm text-muted-foreground">{error}</div>}
            </div>
          ) : error ? (
            <div className="text-sm text-muted-foreground">{error}</div>
          ) : text === null ? (
            <TextPreviewSkeleton />
          ) : (
            <pre className="whitespace-pre-wrap break-words text-sm leading-relaxed">{text}</pre>
          )}
        </div>
      </div>
    </div>
  );
}

function TextPreviewSkeleton() {
  return (
    <div className="space-y-3" aria-label="Loading text preview">
      <div className="h-4 w-40 animate-pulse rounded bg-muted" />
      <div className="space-y-2">
        <div className="h-4 w-full animate-pulse rounded bg-muted" />
        <div className="h-4 w-11/12 animate-pulse rounded bg-muted" />
        <div className="h-4 w-4/5 animate-pulse rounded bg-muted" />
        <div className="h-4 w-10/12 animate-pulse rounded bg-muted" />
        <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
      </div>
    </div>
  );
}

function fileNameFromPath(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function formatDateTime(value: string) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
}

const languageLabels: Record<string, string> = {
  ja: "Japanese",
  "ja-jp": "Japanese",
  jpn: "Japanese",
  en: "English",
  "en-us": "English",
  eng: "English",
  zh: "Simplified Chinese",
  "zh-cn": "Simplified Chinese",
  chi_hans: "Simplified Chinese",
  "zh-tw": "Traditional Chinese",
  chi_hant: "Traditional Chinese",
  ko: "Korean",
  "ko-kr": "Korean",
  ko_kr: "Korean",
  id: "Indonesian",
  "id-id": "Indonesian",
  ind: "Indonesian",
  es: "Spanish",
  "es-es": "Spanish",
  spa: "Spanish",
  vi: "Vietnamese",
  "vi-vn": "Vietnamese",
  vie: "Vietnamese",
  pt: "Portuguese",
  "pt-br": "Portuguese",
  por: "Portuguese",
  fr: "French",
  "fr-fr": "French",
  fre: "French",
  de: "German",
  "de-de": "German",
  ger: "German",
  it: "Italian",
  "it-it": "Italian",
  ita: "Italian",
  th: "Thai",
  "th-th": "Thai",
  tha: "Thai",
  sv: "Swedish",
  "sv-se": "Swedish",
  swe: "Swedish",
};

function languageLabel(value: string) {
  return languageLabels[value.trim().toLowerCase()] ?? (value || "Unknown");
}

function openWorkCodeRoute(code: string, sourceIntent?: DetailSourceIntent, trackedSourceID?: number | null) {
  const cleanCode = code.trim();
  if (!cleanCode) return;
  openWorkDetail(
    {
      kind: "known",
      canonicalCode: cleanCode,
      view: sourceIntent === "tracked" ? "tracked" : sourceIntent === "local" ? "local" : undefined,
      trackedSourceId: sourceIntent === "tracked" ? trackedSourceID : undefined,
    },
    {
      returnTo: `${window.location.pathname}${window.location.search}${window.location.hash}`,
      returnLabel: "Back",
    },
  );
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

function detailReturnTarget(fallbackPath: string) {
  const state = window.history.state as { returnTo?: unknown; returnLabel?: unknown } | null;
  const path =
    typeof state?.returnTo === "string" && isInternalReturnPath(state.returnTo) ? state.returnTo : fallbackPath;
  const label = typeof state?.returnLabel === "string" && state.returnLabel.trim() ? state.returnLabel : "Back";
  return { path, label };
}

function isInternalReturnPath(path: string) {
  return path.startsWith("/") && !path.startsWith("//");
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
      codeFromLocation(window.location.pathname, window.location.search)?.toUpperCase() === code.toUpperCase()
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

function directoryLoadErrorMessage(error: unknown) {
  if (error instanceof ApiError && error.code === "database_busy") {
    return "The database is busy. The work details remain available; retry the directory shortly.";
  }
  return error instanceof Error && error.message ? error.message : "The directory could not be loaded.";
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

function listeningStatusLabel(status: ListeningStatus, t?: TFunction) {
  const fallback = listeningStatusOptions.find((option) => option.value === status)?.label ?? "Unmarked";
  return t?.(`library.status.${status}`, { defaultValue: fallback }) ?? fallback;
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

function searchQueryWithoutClause(clauses: SearchClause[], removeIndex: number) {
  return clauses
    .filter((_clause, index) => index !== removeIndex)
    .map(formatSearchClause)
    .join(" ");
}

function codeFromPath(path: string) {
  const match = path.match(WORK_CODE_PATH_PATTERN);
  return match ? match[1].toUpperCase() : null;
}

function codeFromLocation(path: string, search: string) {
  const standardCode = codeFromPath(path);
  if (standardCode) return standardCode;
  const params = new URLSearchParams(search);
  const sourceID = Number(params.get("source"));
  if (!Number.isFinite(sourceID) || sourceID <= 0) return null;
  const match = path.match(REMOTE_SOURCE_WORK_PATTERN);
  return match ? safeDecodePathSegment(match[1]) : null;
}

function remoteTargetFromLocation(path: string, search: string, sources: LibrarySource[]) {
  const code = codeFromLocation(path, search);
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

function remoteDetailActionCode(detail: RemoteWorkDetail) {
  return detail.remoteCode || detail.primaryCode || detail.remoteId;
}

function safeExternalHTTPURL(value: string | null | undefined) {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
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

function sourcePresenceActionCode(presence: SourcePresenceItem, fallbackCode: string) {
  return presence.remoteCode || fallbackCode;
}

function safeDecodePathSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
