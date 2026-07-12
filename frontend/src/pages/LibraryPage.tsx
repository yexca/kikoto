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
  Circle,
  CircleUserRound,
  Clock3,
  Database,
  GitBranchPlus,
  CloudOff,
  Edit3,
  Trash2,
  FileAudio,
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
  Star,
  Tags,
  Unlink,
  X,
  UserRound,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";

import { Badge } from "@/components/ui/badge";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { toastFromError, useToast } from "@/components/ui/toast";
import { openCircleRoute, openCircleSeriesRoute } from "@/pages/CirclesPage";
import { openVoiceRoute } from "@/pages/CreatorWorksPage";
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
  type RemoteFetchFileDecision,
  type RemoteFetchResolution,
  type RemoteWorkSavePlan,
  type RemoteWorkSaveResult,
  type SourceAvailabilitySource,
  type SourcePresenceItem,
  type SeriesSuggestion,
  type VoiceSuggestion,
  type VoiceCredit,
  type Work,
  type WorkCoverCandidate,
  type WorkDetail,
} from "@/lib/api";
import { formatRemoteFetchPlanConflict, hasRemoteFetchConflicts } from "@/lib/remoteFetchPlan";
import {
  defaultLibraryBrowseState,
  libraryBrowseSearch,
  libraryBrowseStateFromSearch,
  libraryLocation,
  localPageSize,
  localWorkPageSizeOptions,
  readLibraryBrowseState,
  writeLibraryBrowseState,
  type LibraryBrowseState,
  type LibraryColumnCount,
  type LibraryViewMode,
  type LocalWorkPageSize,
} from "@/pages/libraryBrowseState";
import {
  WorkCardActionButton,
  WorkCardDLsiteAction,
  WorkCardFooter,
  WorkCardListButton,
  WorkCardQuickMarkButton,
  WorkCardSelection,
  WorkCardShell,
  cardDate,
  dlsiteTagBadges,
  type WorkCardViewModel,
} from "@/components/work-card/WorkCardShell";
import { sourcePresenceBadges } from "@/components/work-card/sourceBadges";
import {
  WorkCollectionLayoutPicker as LayoutPicker,
  workCollectionClassName,
  workCollectionStyle,
  useWorkCollectionLayout,
} from "@/components/work-collection/WorkCollectionLayout";
import { type PlayerTrack, type PlayerTrackLocation, useLibraryPlayer } from "@/player/PlayerProvider";
import { findLyricsMatches } from "@/player/lyricsMatching";

type WorkPreview = Pick<Work, "primaryCode" | "title" | "coverUrl" | "circle" | "circleExternalId" | "rating" | "sales" | "releaseDate" | "tags" | "voiceActors">;

const WORK_CODE_PATTERN = /^\/((?:RJ|BJ|VJ|CC)\d{4,8})\/?$/i;
const REMOTE_SOURCE_WORK_PATTERN = /^\/([^/?#]+)\/?$/;
const listeningStatusOptions: { value: ListeningStatus; label: string }[] = [
  { value: "none", label: "Unmarked" },
  { value: "want_to_listen", label: "Want" },
  { value: "listening", label: "Listening" },
  { value: "finished", label: "Finished" },
  { value: "relisten", label: "Relisten" },
  { value: "paused", label: "Paused" },
];
const librarySortOptions: { value: LibrarySort; label: string }[] = [
  { value: "recent", label: "Recently added" },
  { value: "release", label: "Release date" },
  { value: "code", label: "Code" },
  { value: "title", label: "Title" },
  { value: "rating", label: "Rating" },
  { value: "sales", label: "Sales" },
  { value: "random", label: "Random" },
];

function remoteLibrarySort(value: LibrarySort): LibrarySort {
  return value === "release" || value === "rating" || value === "sales" || value === "random" ? value : "recent";
}

function createRandomSortSeed() {
  return window.crypto.getRandomValues(new Uint32Array(1))[0] % 2147483646 + 1;
}

function createFetchRequestID() {
  const random = typeof window.crypto?.randomUUID === "function"
    ? window.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `fetch:${random}`;
}

function openActivity() {
  window.history.pushState({}, "", "/activity");
  window.dispatchEvent(new Event("kikoto:navigation"));
}

function notifyFetchQueued(toast: ReturnType<typeof useToast>, result: RemoteWorkSaveResult) {
  toast.notify({
    kind: "success",
    message: result.deduplicated
      ? `Fetch was already queued as workflow run #${result.runId}.`
      : `Fetch queued for ${result.primaryCode} as workflow run #${result.runId}.`,
    actionLabel: "Activity",
    onAction: openActivity,
  });
}

function notifyFetchUnconfirmed(toast: ReturnType<typeof useToast>) {
  toast.notify({
    kind: "warning",
    message: "Fetch submission could not be confirmed. It may still be running; check Activity or retry this selection.",
    actionLabel: "Activity",
    onAction: openActivity,
  });
}
const librarySearchDebounceMs = 400;
const remoteSearchDebounceMs = 600;

type RemoteSourceViewState = { page: number; pageSize: number; query: string };
const defaultRemoteSourceViewState: RemoteSourceViewState = { page: 1, pageSize: 24, query: "" };
type SearchClauseKind =
  | "text"
  | "code"
  | "circle"
  | "voice_actor"
  | "tag"
  | "exclude_tag"
  | "rating_min"
  | "sales_min"
  | "duration_min"
  | "duration_max"
  | "age"
  | "language";
type SearchClause = { kind: SearchClauseKind; value: string };
type SearchClauseDraft = { kind: SearchClauseKind; value: string };
const editableSearchClauseKinds: { value: SearchClauseKind; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "code", label: "Code" },
  { value: "circle", label: "Circle" },
  { value: "voice_actor", label: "Voice actor" },
  { value: "tag", label: "Tag" },
  { value: "exclude_tag", label: "Not tag" },
  { value: "rating_min", label: "Rating >=" },
  { value: "sales_min", label: "Sales >=" },
  { value: "duration_min", label: "Duration >=" },
  { value: "duration_max", label: "Duration <=" },
  { value: "age", label: "Age" },
  { value: "language", label: "Language" },
];

type RemoteFetchDecisions = Record<string, RemoteFetchFileDecision>;

function remoteFetchDecisionList(decisions: RemoteFetchDecisions) {
  return Object.values(decisions);
}

export function LibraryPage() {
  const toast = useToast();
	const initialBrowseState = useRef(libraryBrowseStateFromSearch(window.location.search, defaultLibraryBrowseState)).current;
  const [works, setWorks] = useState<Work[]>([]);
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const [activeTab, setActiveTab] = useState<LibraryTab>(() => tabFromPath(window.location.pathname, []));
  const [localScope, setLocalScope] = useState<LocalLibraryScope>(() => localScopeFromPath(window.location.pathname));
  const [isDatabaseMenuOpen, setIsDatabaseMenuOpen] = useState(false);
  const [remoteResult, setRemoteResult] = useState<RemoteWorksResponse | null>(null);
  const [isRemoteLoading, setIsRemoteLoading] = useState(false);
  const [remoteSourceStates, setRemoteSourceStates] = useState<Record<number, RemoteSourceViewState>>({});
  const [settings, setSettings] = useState<{ cacheEnabled: boolean } | null>(null);
  const [selectedCode, setSelectedCode] = useState<string | null>(() => codeFromLocation(window.location.pathname, window.location.search));
  const [selectedWork, setSelectedWork] = useState<WorkDetail | null>(null);
  const [selectedWorkPreview, setSelectedWorkPreview] = useState<WorkPreview | null>(() => workPreviewFromHistory(codeFromLocation(window.location.pathname, window.location.search)));
  const [isSelectedMediaLoading, setIsSelectedMediaLoading] = useState(false);
  const [selectedRemoteTarget, setSelectedRemoteTarget] = useState<{ source: LibrarySource; code: string } | null>(null);
  const [libraryLoadError, setLibraryLoadError] = useState("");
	const [statusFilter, setStatusFilter] = useState<ListeningStatus | "all">(initialBrowseState.status);
	const [searchQuery, setSearchQuery] = useState(initialBrowseState.query);
	const [debouncedSearchQuery, setDebouncedSearchQuery] = useState(initialBrowseState.query);
	const [debouncedRemoteSearchQuery, setDebouncedRemoteSearchQuery] = useState(initialBrowseState.query);
  const [optimisticLibrarySearchClauses, setOptimisticLibrarySearchClauses] = useState<SearchClause[] | null>(null);
  const [clauseEditor, setClauseEditor] = useState<{ mode: "add" | "edit"; index: number | null; draft: SearchClauseDraft } | null>(null);
	const { mobileColumns, desktopColumns, viewMode, setMobileColumns, setDesktopColumns, setViewMode } = useWorkCollectionLayout({
		mobileColumns: initialBrowseState.mobileColumns,
		desktopColumns: initialBrowseState.desktopColumns,
		viewMode: initialBrowseState.view,
	});
	const [librarySort, setLibrarySort] = useState<LibrarySort>(initialBrowseState.sort);
	const [sortDirection, setSortDirection] = useState<SortDirection>(initialBrowseState.direction);
	const [randomSeed, setRandomSeed] = useState(initialBrowseState.randomSeed);
	const [workPage, setWorkPage] = useState(initialBrowseState.page);
	const [workPageSize, setWorkPageSize] = useState<LocalWorkPageSize>(localPageSize(initialBrowseState.pageSize));
  const [workTotal, setWorkTotal] = useState(0);
	const [isLibraryLoading, setIsLibraryLoading] = useState(false);
  const [untrackTarget, setUntrackTarget] = useState<{ work: Work; source: SourcePresenceItem } | null>(null);
  const [isUntracking, setIsUntracking] = useState(false);
  const [trackedFetchSelection, setTrackedFetchSelection] = useState<{ work: Work; source: LibrarySource; detail: RemoteWorkDetail; selectedPaths: Set<string>; selectedLocalPaths: Set<string>; targetRoot: string; decisions: RemoteFetchDecisions; planDirty: boolean; plan: RemoteWorkSavePlan | null; message: string; requestId: string } | null>(null);
  const [isTrackedFetching, setIsTrackedFetching] = useState(false);
  const libraryRequestSeq = useRef(0);
  const remoteRequestSeq = useRef(0);
  const skipNextLibraryEffect = useRef(false);
  const skipNextRemoteEffect = useRef(false);
  const databaseMenuRef = useRef<HTMLDivElement | null>(null);
	const resultsAnchorRef = useRef<HTMLDivElement | null>(null);
	const pendingResultsScroll = useRef(false);
	const pendingScrollRestore = useRef<number | null>(null);
	const browseSurfaceActive = useRef(true);
	browseSurfaceActive.current = selectedCode === null && selectedRemoteTarget === null;
  const searchClauses = useMemo(() => parseSearchClauses(searchQuery), [searchQuery]);
  const debouncedSearchClauses = useMemo(() => parseSearchClauses(debouncedSearchQuery), [debouncedSearchQuery]);
  const debouncedRemoteSearchClauses = useMemo(() => parseSearchClauses(debouncedRemoteSearchQuery), [debouncedRemoteSearchQuery]);
  const remoteSearchQuery = useMemo(() => formatRemoteSearchQuery(debouncedRemoteSearchClauses), [debouncedRemoteSearchClauses]);
  const librarySearchQuery = useMemo(() => compileLibrarySearchQuery(debouncedSearchClauses), [debouncedSearchClauses]);
  const workScope = localScope;
  const activePrimaryTab: "local" | "tracked" | "database" | null =
    activeTab.kind === "source" ? null : localScope === "local" ? "local" : localScope === "tracked" ? "tracked" : "database";
	const activeRemoteBrowseState = activeTab.kind === "source" ? (remoteSourceStates[activeTab.source.id] ?? defaultRemoteSourceViewState) : defaultRemoteSourceViewState;
	const activeBrowseState: LibraryBrowseState = {
		query: searchQuery,
		page: activeTab.kind === "source" ? activeRemoteBrowseState.page : workPage,
		pageSize: activeTab.kind === "source" ? activeRemoteBrowseState.pageSize : workPageSize,
		status: statusFilter,
		sort: librarySort,
		direction: sortDirection,
		randomSeed,
		view: viewMode,
		mobileColumns,
		desktopColumns,
		scrollY: 0,
	};
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
			window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
				if (pendingScrollRestore.current !== null) window.scrollTo({ top: pendingScrollRestore.current, behavior: "auto" });
			}));
		}
		if (tab.kind === "source") {
			setRemoteSourceStates((states) => ({
				...states,
				[tab.source.id]: { page: state.page, pageSize: state.pageSize, query: formatRemoteSearchQuery(parseSearchClauses(state.query)) },
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
			const anchor = resultsAnchorRef.current;
			if (!anchor) return;
			const behavior: ScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
			anchor.scrollIntoView({ behavior, block: "start" });
		});
	};
	const queueResultsScroll = () => {
		pendingResultsScroll.current = true;
	};

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
						query: formatRemoteSearchQuery(parseSearchClauses(searchQuery)),
					},
				}));
			}
		}
		setDebouncedRemoteSearchQuery(searchQuery);
	}, remoteSearchDebounceMs);
    return () => window.clearTimeout(timer);
	}, [activeTab, searchQuery, debouncedRemoteSearchQuery]);

  useEffect(() => {
    if (activeTab.kind === "source") return;
    if (skipNextLibraryEffect.current) {
      skipNextLibraryEffect.current = false;
      return;
    }
    const controller = new AbortController();
    const requestSeq = ++libraryRequestSeq.current;
    setLibraryLoadError("");
	setIsLibraryLoading(true);
    api
      .listWorksPage(workPage, workPageSize, librarySearchQuery, workScope, statusFilter, librarySort, sortDirection, randomSeed, controller.signal)
      .then((page) => {
        if (requestSeq !== libraryRequestSeq.current) return;
        setWorks(page.works);
        setWorkTotal(page.total);
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
  }, [activeTab.kind, librarySearchQuery, statusFilter, librarySort, randomSeed, sortDirection, workPage, workPageSize, workScope]);

  useEffect(() => {
    api.listLibrarySources().then((items) => {
      setSources(items);
	  const resolved = resolveTabFromPath(window.location.pathname, items, activeTab);
	  const scope = localScopeFromPath(window.location.pathname);
	  const stored = readLibraryBrowseState(libraryBrowseKey(resolved, scope));
	  applyBrowseState(libraryBrowseStateFromSearch(window.location.search, stored ?? defaultLibraryBrowseState), resolved, codeFromLocation(window.location.pathname, window.location.search) === null);
	  setActiveTab(resolved);
      const routeRemoteTarget = remoteTargetFromLocation(window.location.pathname, window.location.search, items);
      if (routeRemoteTarget) setSelectedRemoteTarget(routeRemoteTarget);
    }).catch(() => setSources([]));
  }, []);

  useEffect(() => {
    api.getRuntimeSettings().then((next) => setSettings(next)).catch(() => setSettings(null));
  }, []);

  useEffect(() => {
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
    api.listRemoteSourceWorks(activeTab.source.id, sourceState.page, sourceState.pageSize, remoteSearchQuery, remoteLibrarySort(librarySort), sortDirection, randomSeed, controller.signal).then((result) => {
      if (requestSeq !== remoteRequestSeq.current) return;
      setRemoteResult(result);
	  completeResultsUpdate();
    }).catch((error) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (requestSeq !== remoteRequestSeq.current) return;
      setRemoteResult({
        sourceId: activeTab.source.id,
        works: [],
        page: sourceState.page,
        pageSize: sourceState.pageSize,
        total: 0,
        status: "unavailable",
        sort: remoteLibrarySort(librarySort),
        direction: sortDirection,
        sortApplied: false,
      });
    }).finally(() => {
      if (!controller.signal.aborted && requestSeq === remoteRequestSeq.current) setIsRemoteLoading(false);
    });
    return () => controller.abort();
  }, [activeTab, librarySort, randomSeed, remoteSearchQuery, remoteSourceStates, sortDirection]);

  useEffect(() => {
    if (selectedCode === null) {
      setSelectedWork(null);
      setIsSelectedMediaLoading(false);
      return;
    }
    const controller = new AbortController();
    const work = works.find((item) => item.primaryCode.toUpperCase() === selectedCode.toUpperCase());
    if (work) {
      setSelectedWorkPreview(work);
      setIsSelectedMediaLoading(true);
      api.getWorkSummary(work.id, controller.signal).then((detail) => {
        if (detail.baseCode && detail.baseCode.toUpperCase() !== detail.primaryCode.toUpperCase()) {
          return resolveAndOpenWork(selectedCode, setSelectedWork, setSelectedWorkPreview, setSelectedCode, setIsSelectedMediaLoading, controller.signal);
        }
        setSelectedWork(detail);
        return api.getWorkMedia(detail.id, controller.signal).then((media) => {
          setSelectedWork((current) => current?.id === detail.id ? { ...current, mediaItems: media.mediaItems } : current);
        });
      }).catch((error) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setSelectedWork(null);
      }).finally(() => {
        if (!controller.signal.aborted) setIsSelectedMediaLoading(false);
      });
      return () => controller.abort();
    }
    setSelectedWorkPreview(workPreviewFromHistory(selectedCode));
    void resolveAndOpenWork(selectedCode, setSelectedWork, setSelectedWorkPreview, setSelectedCode, setIsSelectedMediaLoading, controller.signal);
    return () => controller.abort();
  }, [selectedCode, works]);

  useEffect(() => {
    const syncFromPath = () => {
	  const nextTab = resolveTabFromPath(window.location.pathname, sources, activeTab);
	  const nextScope = localScopeFromPath(window.location.pathname);
	  const stored = readLibraryBrowseState(libraryBrowseKey(nextTab, nextScope));
	  const nextCode = codeFromLocation(window.location.pathname, window.location.search);
	  applyBrowseState(libraryBrowseStateFromSearch(window.location.search, stored ?? defaultLibraryBrowseState), nextTab, nextCode === null);
      setSelectedCode(nextCode);
      setSelectedWorkPreview(workPreviewFromHistory(nextCode));
      setSelectedRemoteTarget(remoteTargetFromLocation(window.location.pathname, window.location.search, sources));
	  setActiveTab(nextTab);
	  setLocalScope(nextScope);
    };
    const handlePopState = () => syncFromPath();
    const handleAppNavigation = () => syncFromPath();
    window.addEventListener("popstate", handlePopState);
    window.addEventListener("kikoto:navigation", handleAppNavigation);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("kikoto:navigation", handleAppNavigation);
    };
	}, [sources, activeTab]);

	useEffect(() => {
		if (selectedCode !== null || selectedRemoteTarget !== null) return;
		writeLibraryBrowseState(libraryBrowseKey(activeTab, localScope), { ...activeBrowseState, scrollY: window.scrollY });
		const nextSearch = libraryBrowseSearch(activeBrowseState);
		if (window.location.search !== nextSearch) {
			window.history.replaceState(window.history.state ?? {}, "", `${window.location.pathname}${nextSearch}`);
		}
	}, [activeTab, desktopColumns, librarySort, localScope, mobileColumns, randomSeed, searchQuery, selectedCode, selectedRemoteTarget, sortDirection, statusFilter, viewMode, workPage, workPageSize, remoteSourceStates]);

	useEffect(() => {
		if (selectedCode !== null || selectedRemoteTarget !== null) return;
		let pendingWrite: number | null = null;
		const flushScroll = () => {
			if (pendingWrite !== null) window.clearTimeout(pendingWrite);
			pendingWrite = null;
			writeLibraryBrowseState(libraryBrowseKey(activeTab, localScope), { ...activeBrowseState, scrollY: window.scrollY });
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
	}, [activeTab, localScope, selectedCode, selectedRemoteTarget, searchQuery, statusFilter, librarySort, randomSeed, sortDirection, viewMode, mobileColumns, desktopColumns, workPage, workPageSize, remoteSourceStates]);

  useEffect(() => {
    if (!isDatabaseMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (databaseMenuRef.current?.contains(target)) return;
      setIsDatabaseMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsDatabaseMenuOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isDatabaseMenuOpen]);

  const openWork = (work: Work, sourceIntent: DetailSourceIntent = localScope === "tracked" ? "tracked" : "local") => {
	writeLibraryBrowseState(libraryBrowseKey(activeTab, localScope), { ...activeBrowseState, scrollY: window.scrollY });
    const path = `/${work.primaryCode}?view=${sourceIntent}`;
	setSelectedRemoteTarget(null);
	window.history.pushState({ returnTo: libraryLocation(pathForActiveLibrary(activeTab, localScope), activeBrowseState), returnLabel: "Back to library", workPreview: work }, "", path);
    window.dispatchEvent(new Event("kikoto:navigation"));
    setSelectedWorkPreview(work);
    setSelectedCode(work.primaryCode);
  };

  const openRemotePreview = (source: LibrarySource, work: RemoteWork) => {
    const code = remoteWorkRouteCode(work);
    if (!code) return;
	writeLibraryBrowseState(libraryBrowseKey(activeTab, localScope), { ...activeBrowseState, scrollY: window.scrollY });
    setSelectedRemoteTarget({ source, code });
	window.history.pushState({ returnTo: libraryLocation(pathForActiveLibrary(activeTab, localScope), activeBrowseState), returnLabel: "Back to library" }, "", `/${encodeURIComponent(code)}?source=${source.id}`);
    window.dispatchEvent(new Event("kikoto:navigation"));
    setSelectedCode(codeFromLocation(window.location.pathname, window.location.search));
  };

  const backToLibrary = () => {
	const historyState = window.history.state as { returnTo?: unknown } | null;
	if (typeof historyState?.returnTo === "string" && isInternalReturnPath(historyState.returnTo)) {
	  window.history.back();
	  return;
	}
	const returnTarget = detailReturnTarget(libraryLocation(pathForActiveLibrary(activeTab, localScope), activeBrowseState));
    window.history.pushState({}, "", returnTarget.path);
    window.dispatchEvent(new Event("kikoto:navigation"));
    setSelectedCode(null);
    setSelectedRemoteTarget(null);
  };

  const changeTab = (tab: LibraryTab) => {
	writeLibraryBrowseState(libraryBrowseKey(activeTab, localScope), { ...activeBrowseState, scrollY: window.scrollY });
	const nextScope: LocalLibraryScope = tab.kind === "all" ? "local" : localScope;
	const nextState = readLibraryBrowseState(libraryBrowseKey(tab, nextScope)) ?? defaultLibraryBrowseState;
    setActiveTab(tab);
	if (tab.kind === "all") setLocalScope(nextScope);
	applyBrowseState(nextState, tab);
    setIsDatabaseMenuOpen(false);
    setSelectedRemoteTarget(null);
	const path = libraryLocation(pathForLibraryTab(tab), nextState);
	if (`${window.location.pathname}${window.location.search}` !== path) {
	  window.history.pushState({}, "", path);
      window.dispatchEvent(new Event("kikoto:navigation"));
    }
  };

  const changeLocalScope = (scope: LocalLibraryScope) => {
	writeLibraryBrowseState(libraryBrowseKey(activeTab, localScope), { ...activeBrowseState, scrollY: window.scrollY });
	const nextTab: LibraryTab = { kind: "all" };
	const nextState = readLibraryBrowseState(libraryBrowseKey(nextTab, scope)) ?? defaultLibraryBrowseState;
    setActiveTab({ kind: "all" });
    setLocalScope(scope);
	applyBrowseState(nextState, nextTab);
    setSelectedRemoteTarget(null);
	const basePath = pathForLocalScope(scope);
	const path = basePath ? libraryLocation(basePath, nextState) : null;
	if (path && `${window.location.pathname}${window.location.search}` !== path) {
	  window.history.pushState({}, "", path);
      window.dispatchEvent(new Event("kikoto:navigation"));
    }
  };

  const changePrimaryTab = (tab: "local" | "tracked") => {
    setIsDatabaseMenuOpen(false);
    changeLocalScope(tab);
  };

  const updateWorkStatus = async (workID: number, status: ListeningStatus) => {
    try {
      const result = await api.updateWorkUserState(workID, { listeningStatus: status });
      setWorks((items) =>
        items.map((item) => (item.id === workID ? { ...item, listeningStatus: result.listeningStatus, favorite: result.favorite } : item)),
      );
      setSelectedWork((item) => (item?.id === workID ? { ...item, listeningStatus: result.listeningStatus, favorite: result.favorite } : item));
    } catch (error) {
      toast.notify(toastFromError(error, "Mark update failed."));
    }
  };

  const untrackWorkSource = async () => {
    if (!untrackTarget?.source.fileSourceId) return;
    setIsUntracking(true);
    try {
      await api.untrackWorkSource(untrackTarget.work.id, untrackTarget.source.fileSourceId);
      setUntrackTarget(null);
      await refreshCurrentWorksPage();
    } finally {
      setIsUntracking(false);
    }
  };

  const openTrackedFetchSelection = async (work: Work, presence: SourcePresenceItem) => {
    if (!presence.fileSourceId) return;
    const source = sources.find((item) => item.id === presence.fileSourceId);
    if (!source) return;
    setIsTrackedFetching(true);
    toast.info("Preparing language editions, source files, and the final Fetch tree…");
    try {
      const detail = await api.getRemoteSourceWork(source.id, sourcePresenceActionCode(presence, work.primaryCode));
      const paths = remoteSelectablePaths(buildRemoteTree(detail.tracks));
      const plan = await api.planRemoteSourceWorkFetch(source.id, remoteDetailActionCode(detail), paths);
      setTrackedFetchSelection({ work, source, detail, selectedPaths: new Set(paths), selectedLocalPaths: new Set(), targetRoot: "", decisions: {}, planDirty: false, plan, message: formatRemoteFetchPreparation(plan), requestId: createFetchRequestID() });
    } catch (error) {
      toast.notify(toastFromError(error, "Fetch preparation failed."));
    } finally {
      setIsTrackedFetching(false);
    }
  };

  const fetchTrackedSelection = async () => {
    if (!trackedFetchSelection) return;
    setIsTrackedFetching(true);
    const paths = Array.from(trackedFetchSelection.selectedPaths);
    const localPaths = Array.from(trackedFetchSelection.selectedLocalPaths);
    try {
      if (!trackedFetchSelection.plan || trackedFetchSelection.planDirty) {
      const plan = await api.planRemoteSourceWorkFetch(trackedFetchSelection.source.id, remoteDetailActionCode(trackedFetchSelection.detail), paths, localPaths, trackedFetchSelection.targetRoot, remoteFetchDecisionList(trackedFetchSelection.decisions));
        setTrackedFetchSelection((current) => current ? { ...current, plan, planDirty: false, message: formatRemoteFetchPreparation(plan) } : current);
        setIsTrackedFetching(false);
        return;
      }
      if (hasRemoteFetchConflicts(trackedFetchSelection.plan)) {
        setTrackedFetchSelection((current) => current ? { ...current, message: formatRemoteFetchPlanConflict(trackedFetchSelection.plan!) } : current);
        setIsTrackedFetching(false);
        return;
      }
    } catch (error) {
      toast.notify(toastFromError(error, "Fetch plan failed."));
      setIsTrackedFetching(false);
      return;
    }
    try {
      const result = await api.fetchRemoteSourceWork(trackedFetchSelection.source.id, remoteDetailActionCode(trackedFetchSelection.detail), paths, localPaths, trackedFetchSelection.requestId, trackedFetchSelection.targetRoot || trackedFetchSelection.plan?.saveRoot || "", remoteFetchDecisionList(trackedFetchSelection.decisions));
      notifyFetchQueued(toast, result);
      setTrackedFetchSelection(null);
      try {
        await refreshCurrentWorksPage();
      } catch (error) {
        toast.notify({ kind: "warning", message: error instanceof Error ? `Fetch was queued, but Library refresh failed: ${error.message}` : "Fetch was queued, but Library refresh failed." });
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) toast.notify(toastFromError(error, "Fetch submission failed."));
      else notifyFetchUnconfirmed(toast);
    } finally {
      setIsTrackedFetching(false);
    }
  };

  const activeRemoteSourceState =
    activeTab.kind === "source" ? (remoteSourceStates[activeTab.source.id] ?? defaultRemoteSourceViewState) : defaultRemoteSourceViewState;

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
    api.listWorksPage(page, workPageSize, query, workScope, statusFilter, librarySort, sortDirection, randomSeed).then((result) => {
      if (requestSeq !== libraryRequestSeq.current) return;
      setWorks(result.works);
      setWorkTotal(result.total);
      setLibraryLoadError("");
      setOptimisticLibrarySearchClauses(null);
	  completeResultsUpdate();
    }).catch((error) => {
      if (requestSeq !== libraryRequestSeq.current) return;
      setLibraryLoadError(error instanceof Error ? error.message : "Library request failed.");
      setOptimisticLibrarySearchClauses(null);
	  pendingResultsScroll.current = false;
	}).finally(() => {
	  if (requestSeq === libraryRequestSeq.current) setIsLibraryLoading(false);
	});
  };

  const loadRemoteWorksNow = (source: LibrarySource, query: string, page = 1, options: { clearResult?: boolean } = {}) => {
    const sourceState = remoteSourceStates[source.id] ?? defaultRemoteSourceViewState;
    const requestSeq = ++remoteRequestSeq.current;
    setIsRemoteLoading(true);
    if (options.clearResult !== false && remoteResult?.sourceId !== source.id) setRemoteResult(null);
    api.listRemoteSourceWorks(source.id, page, sourceState.pageSize, query, remoteLibrarySort(librarySort), sortDirection, randomSeed).then((result) => {
      if (requestSeq !== remoteRequestSeq.current) return;
      setRemoteResult(result);
	  completeResultsUpdate();
    }).catch(() => {
      if (requestSeq !== remoteRequestSeq.current) return;
      setRemoteResult({
        sourceId: source.id,
        works: [],
        page,
        pageSize: sourceState.pageSize,
        total: 0,
        status: "unavailable",
        sort: remoteLibrarySort(librarySort),
        direction: sortDirection,
        sortApplied: false,
      });
    }).finally(() => {
      if (requestSeq === remoteRequestSeq.current) setIsRemoteLoading(false);
    });
  };

  const refreshCurrentWorksPage = async () => {
    if (activeTab.kind === "source") return;
    const page = await api.listWorksPage(workPage, workPageSize, librarySearchQuery, workScope, statusFilter, librarySort, sortDirection, randomSeed);
    setWorks(page.works);
    setWorkTotal(page.total);
    setLibraryLoadError("");
  };

  const selectTrackedFetchEdition = async (code: string) => {
    if (!trackedFetchSelection) return false;
    setIsTrackedFetching(true);
    try {
      const detail = await api.getRemoteSourceWork(trackedFetchSelection.source.id, code);
      setTrackedFetchSelection((current) => current ? { ...current, detail, selectedPaths: new Set(remoteSelectablePaths(buildRemoteTree(detail.tracks))), selectedLocalPaths: new Set(), targetRoot: "", plan: null, message: "", requestId: createFetchRequestID() } : current);
      return true;
    } catch (error) {
      toast.notify(toastFromError(error, `The ${code} edition is not available from ${trackedFetchSelection.source.displayName}.`));
      return false;
    } finally {
      setIsTrackedFetching(false);
    }
  };

  const updateSearchClauses = (clauses: SearchClause[]) => {
    setOptimisticLibrarySearchClauses(null);
    setSearchQuery(clauses.map(formatSearchClause).join(" "));
  };

  const addTagSearchClause = (tag: string) => {
    const value = tag.trim();
    if (!value) return;
    const next = searchClauses.filter((clause) => !(clause.kind === "tag" && clause.value.toLowerCase() === value.toLowerCase()));
    const nextClauses = [...next, { kind: "tag" as const, value }];
    const nextQuery = nextClauses.map(formatSearchClause).join(" ");
    const nextLibraryQuery = compileLibrarySearchQuery(nextClauses);
    const nextRemoteQuery = formatRemoteSearchQuery(nextClauses);
    setSearchQuery(nextQuery);
    setDebouncedSearchQuery(nextQuery);
    setDebouncedRemoteSearchQuery(nextQuery);
	queueResultsScroll();
    if (activeTab.kind === "source") {
      skipNextRemoteEffect.current = true;
      updateRemoteSourceState(activeTab.source.id, { page: 1, query: nextRemoteQuery });
      loadRemoteWorksNow(activeTab.source, nextRemoteQuery, 1, { clearResult: false });
      return;
    }
	setWorkPage(1);
    setOptimisticLibrarySearchClauses(nextClauses);
    skipNextLibraryEffect.current = true;
    loadLibraryWorksNow(nextLibraryQuery, 1);
  };

  const removeSearchClause = (index: number) => {
    updateSearchClauses(searchClauses.filter((_clause, clauseIndex) => clauseIndex !== index));
    setClauseEditor(null);
  };

  const openAddClauseEditor = () => {
    setClauseEditor({ mode: "add", index: null, draft: { kind: "text", value: "" } });
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

  if (selectedRemoteTarget !== null) {
    return (
      <RemoteWorkDetailView
        source={selectedRemoteTarget.source}
        code={selectedRemoteTarget.code}
        onBack={backToLibrary}
        onOpenLocal={(workID) => {
          const work = works.find((item) => item.id === workID);
		  if (work) {
			openWork(work, "local");
			return;
		  }
		  void api.getWork(workID).then((detail) => {
			setSelectedRemoteTarget(null);
			openWorkCodeRoute(detail.primaryCode, "local");
		  }).catch((error) => toast.notify(toastFromError(error, "Local detail could not be opened.")));
        }}
        onWorksChanged={async () => await refreshCurrentWorksPage()}
      />
    );
  }

  if (selectedCode !== null) {
    return (
      <WorkDetailView
        code={selectedCode}
        work={selectedWork}
        workPreview={selectedWorkPreview}
        mediaLoading={isSelectedMediaLoading}
        sources={sources}
        initialSourceIntent={detailSourceIntentFromLocation(window.location.search)}
        onBack={backToLibrary}
        onStatusChange={updateWorkStatus}
        onWorkReload={async (workID) => {
          const detail = await api.getWork(workID);
          setSelectedWork(detail);
        }}
        onWorksChanged={async () => await refreshCurrentWorksPage()}
      />
    );
  }

  const visibleWorks = optimisticLibrarySearchClauses === null ? works : works.filter((work) => workMatchesSearch(work, optimisticLibrarySearchClauses));
  const totalWorkPages = Math.max(1, Math.ceil(workTotal / workPageSize));
  const currentWorkPage = Math.min(workPage, totalWorkPages);
  const pagedWorks = visibleWorks;
  const activeFilterCount = statusFilter === "all" ? 0 : 1;
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
		setLibrarySort(sort);
	};
	const reshuffle = () => {
		queueResultsScroll();
		if (activeTab.kind === "source") updateRemoteSourceState(activeTab.source.id, { page: 1 });
		else setWorkPage(1);
		setRandomSeed(createRandomSortSeed());
	};
	const changeSortDirection = (direction: SortDirection) => {
		queueResultsScroll();
		if (activeTab.kind === "source") updateRemoteSourceState(activeTab.source.id, { page: 1 });
		else setWorkPage(1);
		setSortDirection(direction);
	};
	const changeStatusFilter = (status: ListeningStatus | "all") => {
		queueResultsScroll();
		setWorkPage(1);
		setStatusFilter(status);
	};
  const localPagination = (
    <WorkPagination
      page={currentWorkPage}
      pageSize={workPageSize}
      totalItems={workTotal}
      totalPages={totalWorkPages}
	  pageSizeOptions={localWorkPageSizeOptions}
	  onPageChange={changeWorkPage}
	  onPageSizeChange={(value) => changeWorkPageSize(value as LocalWorkPageSize)}
    />
  );

  return (
    <div className="space-y-5">
      <section className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between" data-toast-avoid>
        <div className="flex min-h-10 flex-1 items-center gap-2 rounded-lg border bg-card px-3 text-sm lg:max-w-xl">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
            value={searchQuery}
            onChange={(event) => {
              setOptimisticLibrarySearchClauses(null);
              setSearchQuery(event.target.value);
            }}
            placeholder="Search title, code, circle, tag, or creator"
          />
          {searchQuery.trim() && (
            <button className="text-muted-foreground hover:text-foreground" onClick={() => {
              setOptimisticLibrarySearchClauses(null);
              setSearchQuery("");
            }} aria-label="Clear search">
              <X className="h-4 w-4" />
            </button>
          )}
          <button
            className="rounded-sm text-muted-foreground hover:text-foreground"
            onClick={openAddClauseEditor}
            aria-label="Add search condition"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
        <div className="flex w-full flex-wrap justify-end gap-2 lg:w-auto">
          <LayoutPicker
            viewMode={viewMode}
            mobileColumns={mobileColumns}
            desktopColumns={desktopColumns}
            onViewModeChange={setViewMode}
            onMobileColumnsChange={setMobileColumns}
            onDesktopColumnsChange={setDesktopColumns}
          />
		  <SortPicker activeTab={activeTab} value={librarySort} direction={sortDirection} onChange={changeLibrarySort} onDirectionChange={changeSortDirection} onReshuffle={reshuffle} />
		  <FilterPicker value={statusFilter} activeCount={activeFilterCount} disabled={activeTab.kind === "source"} onChange={changeStatusFilter} />
          <div ref={databaseMenuRef} className="relative">
            <IconButton title="Data" onClick={() => setIsDatabaseMenuOpen((value) => !value)}>
              <Database className="h-4 w-4" />
              {activePrimaryTab === "database" && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-primary" />}
            </IconButton>
            {isDatabaseMenuOpen && (
              <AnchoredPopover open anchorRef={databaseMenuRef} className="w-[min(16rem,calc(100vw-1.5rem))]">
                <DatabaseViewMenu
                  value={localScope}
                  onChange={(scope) => {
                    changeLocalScope(scope);
                    setIsDatabaseMenuOpen(false);
                  }}
                />
              </AnchoredPopover>
            )}
          </div>
        </div>
      </section>
      {activeFilterCount > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline" className="gap-1.5">
            <Filter className="h-4 w-4" />
            Mark: {statusFilterLabel(statusFilter)}
			<button className="rounded-sm text-muted-foreground hover:text-foreground" aria-label="Clear mark filter" onClick={() => changeStatusFilter("all")}>
              <X className="h-3 w-3" />
            </button>
          </Badge>
        </div>
      )}
      {searchClauses.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {searchClauses.map((clause, index) => (
            <Badge key={`${clause.kind}-${clause.value}-${index}`} variant={clause.kind === "exclude_tag" ? "warning" : "outline"} className="gap-1.5">
              <button className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => openEditClauseEditor(clause, index)}>
                <Edit3 className="h-3 w-3" />
                {searchClauseLabel(clause)}
              </button>
              <button
                className="rounded-sm text-muted-foreground hover:text-foreground"
                aria-label={`Remove ${searchClauseLabel(clause)}`}
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
          onChange={(draft) => setClauseEditor((current) => current ? { ...current, draft } : current)}
          onCancel={() => setClauseEditor(null)}
          onSave={saveClauseEditor}
        />
      )}

      <LibraryPrimaryTabs
        active={activePrimaryTab}
        activeSourceId={activeTab.kind === "source" ? activeTab.source.id : null}
        sources={sources}
        onChange={changePrimaryTab}
        onSourceChange={(source) => changeTab({ kind: "source", source })}
      />
      {activePrimaryTab === "database" && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="secondary" className="gap-1.5">
            <Database className="h-3.5 w-3.5" />
            Database view · {localScopeLabel(localScope)}
          </Badge>
        </div>
      )}
	  <div ref={resultsAnchorRef} className="scroll-mt-24" />

      {activeTab.kind === "source" ? (
        <div className="space-y-3">
          <RemoteSourcePanel
            source={activeTab.source}
            result={remoteResult}
            loading={isRemoteLoading}
            viewState={activeRemoteSourceState}
            searchClauses={searchClauses}
			viewMode={viewMode}
			mobileColumns={mobileColumns}
			desktopColumns={desktopColumns}
			onClearSearch={() => setSearchQuery("")}
			onPageChange={(page) => {
			  queueResultsScroll();
			  updateRemoteSourceState(activeTab.source.id, { page });
			}}
            onPageSizeChange={(value) => {
			  queueResultsScroll();
              updateRemoteSourceState(activeTab.source.id, { pageSize: value, page: 1 });
            }}
            onOpenPreview={(work) => openRemotePreview(activeTab.source, work)}
            onTagOpen={addTagSearchClause}
            onWorkStateChanged={(primaryCode, patch) => {
              setRemoteResult((current) => current ? {
                ...current,
                works: current.works.map((item) => item.primaryCode === primaryCode ? { ...item, ...patch } : item),
              } : current);
            }}
            onSynced={async (workId) => {
              if (workId <= 0) {
                await refreshCurrentWorksPage();
                return;
              }
              const detail = await api.getWork(workId);
              openWorkCodeRoute(detail.primaryCode, "local");
            }}
          />
        </div>
      ) : (
        <div className="space-y-3">
		  {isLibraryLoading && works.length > 0 && <div className="text-xs text-muted-foreground">Refreshing results…</div>}
          {!libraryLoadError && localPagination}
          {libraryLoadError ? (
            <LibraryLoadErrorCard
              message={libraryLoadError}
              onRetry={() => loadLibraryWorksNow(librarySearchQuery, currentWorkPage)}
            />
		  ) : visibleWorks.length === 0 ? (
			<EmptyLibraryWorksCard
			  scope={localScope}
			  filtered={searchQuery.trim() !== "" || statusFilter !== "all"}
			  onClear={() => {
				setSearchQuery("");
				changeStatusFilter("all");
			  }}
			/>
          ) : viewMode === "masonry" ? (
            <section className={workCollectionClassName("masonry")} style={workCollectionStyle(mobileColumns, desktopColumns)}>
              {pagedWorks.map((work) => (
                <div key={work.id} className="mb-4 [break-inside:avoid]">
                  <WorkCard
                    work={work}
                    onOpen={() => openWork(work)}
                    onStatusChange={updateWorkStatus}
                    onFavoriteSaved={(workID, favorite) => {
                      setWorks((items) => items.map((item) => (item.id === workID ? { ...item, favorite } : item)));
                      setSelectedWork((item) => (item?.id === workID ? { ...item, favorite } : item));
                    }}
                    onTagOpen={addTagSearchClause}
                    onUntrack={localScope === "tracked" ? (source) => setUntrackTarget({ work, source }) : undefined}
                    onFetch={localScope === "tracked" ? (source) => void openTrackedFetchSelection(work, source) : undefined}
                    isFetchBusy={isTrackedFetching}
                  />
                </div>
              ))}
            </section>
          ) : (
            <section className={workCollectionClassName("grid")} style={workCollectionStyle(mobileColumns, desktopColumns)}>
              {pagedWorks.map((work) => (
                <WorkCard
                  key={work.id}
                  work={work}
                  onOpen={() => openWork(work)}
                  onStatusChange={updateWorkStatus}
                  onFavoriteSaved={(workID, favorite) => {
                    setWorks((items) => items.map((item) => (item.id === workID ? { ...item, favorite } : item)));
                    setSelectedWork((item) => (item?.id === workID ? { ...item, favorite } : item));
                  }}
                  onTagOpen={addTagSearchClause}
                  onUntrack={localScope === "tracked" ? (source) => setUntrackTarget({ work, source }) : undefined}
                  onFetch={localScope === "tracked" ? (source) => void openTrackedFetchSelection(work, source) : undefined}
                  isFetchBusy={isTrackedFetching}
                />
              ))}
            </section>
          )}
          {!libraryLoadError && (viewMode === "masonry" ? (
			<CompactWorkPagination page={currentWorkPage} totalPages={totalWorkPages} onPageChange={changeWorkPage} />
          ) : (
            localPagination
          ))}
        </div>
      )}
      {untrackTarget && (
        <UntrackConfirmModal
          work={untrackTarget.work}
          source={untrackTarget.source}
          disabled={isUntracking}
          onClose={() => {
            if (!isUntracking) setUntrackTarget(null);
          }}
          onConfirm={() => void untrackWorkSource()}
        />
      )}
      {trackedFetchSelection && (
        <RemoteSaveSelectionPanel
          root={buildRemoteTree(trackedFetchSelection.detail.tracks)}
          selectedPaths={trackedFetchSelection.selectedPaths}
          selectedLocalPaths={trackedFetchSelection.selectedLocalPaths}
          plan={trackedFetchSelection.plan}
          decisions={trackedFetchSelection.decisions}
          planDirty={trackedFetchSelection.planDirty}
          message={trackedFetchSelection.message}
          sourceId={trackedFetchSelection.source.id}
          activeEditionCode={remoteDetailActionCode(trackedFetchSelection.detail)}
          onEditionChange={selectTrackedFetchEdition}
          targetRoot={trackedFetchSelection.targetRoot}
          onTargetRootChange={(targetRoot) => setTrackedFetchSelection((current) => current ? { ...current, targetRoot, plan: null, message: "" } : current)}
          onChange={(paths) => setTrackedFetchSelection((current) => current ? { ...current, selectedPaths: paths, plan: null, message: "" } : current)}
          onLocalChange={(paths) => setTrackedFetchSelection((current) => current ? { ...current, selectedLocalPaths: paths, plan: null, message: "" } : current)}
          onDecisionChange={(decision) => setTrackedFetchSelection((current) => current ? { ...current, decisions: { ...current.decisions, [decision.itemKey]: decision }, planDirty: true } : current)}
          disabled={isTrackedFetching}
          onClose={() => {
            if (!isTrackedFetching) setTrackedFetchSelection(null);
          }}
          onSave={() => void fetchTrackedSelection()}
        />
      )}
    </div>
  );
}

type LibraryTab = { kind: "all" } | { kind: "source"; source: LibrarySource };
type LocalLibraryScope = "all" | "local" | "tracked" | "remote" | "no_source";

const databaseScopeItems: { value: LocalLibraryScope; label: string; description: string; icon: ReactNode }[] = [
  { value: "all", label: "All records", description: "Every unified work row in the local database.", icon: <Database className="h-4 w-4" /> },
  { value: "local", label: "Local records", description: "Works with available local files.", icon: <HardDrive className="h-4 w-4" /> },
  { value: "tracked", label: "Tracked records", description: "Works intentionally tracked from a source.", icon: <GitBranchPlus className="h-4 w-4" /> },
  { value: "remote", label: "Known remote", description: "Works known from remote source presence.", icon: <Cloud className="h-4 w-4" /> },
  { value: "no_source", label: "No source", description: "Metadata-only works without current source presence.", icon: <CloudOff className="h-4 w-4" /> },
];

function LibraryPrimaryTabs({
  active,
  activeSourceId,
  sources,
  onChange,
  onSourceChange,
}: {
  active: "local" | "tracked" | "database" | null;
  activeSourceId: number | null;
  sources: LibrarySource[];
  onChange: (tab: "local" | "tracked") => void;
  onSourceChange: (source: LibrarySource) => void;
}) {
  return (
    <div className="flex gap-2 overflow-x-auto rounded-lg border bg-card p-1">
      <TabButton active={active === "local"} onClick={() => onChange("local")} icon={<HardDrive className="h-4 w-4" />}>
        Local
      </TabButton>
      <TabButton active={active === "tracked"} onClick={() => onChange("tracked")} icon={<GitBranchPlus className="h-4 w-4" />}>
        Tracked
      </TabButton>
      {sources.map((source) => (
        <TabButton key={source.id} active={activeSourceId === source.id} onClick={() => onSourceChange(source)} icon={<Cloud className="h-4 w-4" />} disabled={!source.enabled}>
          {source.displayName}
        </TabButton>
      ))}
    </div>
  );
}

function DatabaseViewMenu({ value, onChange }: { value: LocalLibraryScope; onChange: (scope: LocalLibraryScope) => void }) {
  return (
    <div className="rounded-lg border bg-card p-2 text-card-foreground shadow-xl">
      <div className="px-2 py-1.5">
        <div className="text-sm font-medium">Database view</div>
      </div>
      <div className="mt-1 space-y-1">
        {databaseScopeItems.map((item) => (
          <button
            key={item.value}
            className={`flex w-full items-start gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-muted ${value === item.value ? "bg-primary/10 text-primary ring-1 ring-inset ring-primary/15" : "text-muted-foreground"}`}
            aria-pressed={value === item.value}
            onClick={() => onChange(item.value)}
          >
            <span className="mt-0.5 shrink-0">{item.icon}</span>
            <span className="min-w-0">
              <span className="block font-medium text-foreground">{item.label}</span>
              <span className="block text-xs leading-5 text-muted-foreground">{item.description}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function localScopeLabel(scope: LocalLibraryScope) {
  return databaseScopeItems.find((item) => item.value === scope)?.label ?? "Database records";
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

function RemoteSourcePanel({
  source,
  result,
  loading,
  viewState,
  searchClauses,
	viewMode,
	mobileColumns,
	desktopColumns,
	onClearSearch,
  onPageChange,
  onPageSizeChange,
  onOpenPreview,
  onTagOpen,
  onWorkStateChanged,
  onSynced,
}: {
  source: LibrarySource;
  result: RemoteWorksResponse | null;
  loading: boolean;
  viewState: RemoteSourceViewState;
  searchClauses: SearchClause[];
	viewMode: LibraryViewMode;
	mobileColumns: LibraryColumnCount;
	desktopColumns: LibraryColumnCount;
	onClearSearch: () => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onOpenPreview: (work: RemoteWork) => void;
  onTagOpen: (tag: string) => void;
  onWorkStateChanged: (primaryCode: string, patch: Partial<Pick<RemoteWork, "workId" | "favorite" | "listeningStatus">>) => void;
  onSynced: (workID: number) => Promise<void>;
}) {
  const toast = useToast();
  const isInitialLoading = loading && result === null;
  const isRefreshing = loading && result !== null;
  const [isSyncingCode, setIsSyncingCode] = useState<string | null>(null);
  const [bulkCodes, setBulkCodes] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [isBulkBusy, setIsBulkBusy] = useState(false);
  const [saveConfirm, setSaveConfirm] = useState<{ codes: string[]; run: () => Promise<void> } | null>(null);
  const [saveSelection, setSaveSelection] = useState<{ work: RemoteWork; detail: RemoteWorkDetail; selectedPaths: Set<string>; selectedLocalPaths: Set<string>; targetRoot: string; decisions: RemoteFetchDecisions; planDirty: boolean; plan: RemoteWorkSavePlan | null; message: string; requestId: string } | null>(null);
  const { page, pageSize } = viewState;

  const syncWork = async (work: RemoteWork, reason: string) => {
    if (!work.primaryCode) {
      toast.warning("This remote work has no stable work code.");
      return;
    }
    setIsSyncingCode(work.primaryCode);
    try {
      const result = await api.trackRemoteSourceWork(source.id, remoteWorkActionCode(work), reason);
      toast.success(`Tracked ${result.primaryCode} through workflow run #${result.runId}.`);
      await onSynced(result.workId);
      return result.workId;
    } catch (error) {
      toast.notify(toastFromError(error, "Remote sync failed."));
      return null;
    } finally {
      setIsSyncingCode(null);
    }
  };

  const visibleWorks = useMemo(() => {
    const works = result?.works ?? [];
    return works.filter((work) => remoteWorkMatchesSearch(work, searchClauses));
  }, [result, searchClauses]);
  const selectableWorks = visibleWorks.filter((work) => work.primaryCode);
  const selectedWorks = selectableWorks.filter((work) => bulkCodes.has(work.primaryCode));
  const selectedSyncable = selectedWorks.filter((work) => work.workId === null);
  const selectedSaveable = selectedWorks;
  const selectionActive = selectionMode;
  const totalItems = result?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const currentPage = Math.min(page, totalPages);
  const remotePagination = (
    <WorkPagination
      page={currentPage}
      pageSize={pageSize}
      totalItems={totalItems}
      totalPages={totalPages}
      pageSizeOptions={[12, 24, 48, 96]}
      onPageChange={onPageChange}
      onPageSizeChange={onPageSizeChange}
    />
  );

  useEffect(() => {
    setBulkCodes((current) => new Set(Array.from(current).filter((code) => visibleWorks.some((work) => work.primaryCode === code))));
  }, [visibleWorks]);

  const toggleBulkCode = (code: string, checked: boolean) => {
    setBulkCodes((current) => {
      const next = new Set(current);
      if (checked) next.add(code);
      else next.delete(code);
      return next;
    });
  };

  const toggleAllVisible = (checked: boolean) => {
    setBulkCodes(() => checked ? new Set(selectableWorks.map((work) => work.primaryCode)) : new Set());
  };

  const bulkSyncSelected = async () => {
    if (selectedSyncable.length === 0) return;
    setIsBulkBusy(true);
    try {
      const parent = await api.recordRemoteBulkRun({ action: "track", sourceId: source.id, codes: selectedSyncable.map(remoteWorkActionCode) });
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
    if (selectedSaveable.length === 0) return;
    setSaveConfirm({ codes: selectedSaveable.map((work) => work.primaryCode), run: runBulkSaveSelected });
  };

  const runBulkSaveSelected = async () => {
    setIsBulkBusy(true);
    try {
      const parent = await api.recordRemoteBulkRun({ action: "fetch", sourceId: source.id, codes: selectedSaveable.map(remoteWorkActionCode) });
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

  const openSaveSelection = async (work: RemoteWork) => {
    if (!work.primaryCode) return;
    setIsSyncingCode(work.primaryCode);
    toast.info("Preparing language editions, source files, and the final Fetch tree…");
    try {
      const detail = await api.getRemoteSourceWork(source.id, remoteWorkActionCode(work));
      const root = buildRemoteTree(detail.tracks);
      const paths = remoteSelectablePaths(root);
      const plan = await api.planRemoteSourceWorkFetch(source.id, remoteDetailActionCode(detail), paths);
      setSaveSelection({ work, detail, selectedPaths: new Set(paths), selectedLocalPaths: new Set(), targetRoot: "", decisions: {}, planDirty: false, plan, message: formatRemoteFetchPreparation(plan), requestId: createFetchRequestID() });
    } catch (error) {
      toast.notify(toastFromError(error, "Remote directory failed."));
    } finally {
      setIsSyncingCode(null);
    }
  };

  const fetchSingleSelection = async () => {
    if (!saveSelection) return;
    const paths = Array.from(saveSelection.selectedPaths);
    const localPaths = Array.from(saveSelection.selectedLocalPaths);
    setIsSyncingCode(saveSelection.work.primaryCode);
    try {
      if (!saveSelection.plan || saveSelection.planDirty) {
      const plan = await api.planRemoteSourceWorkFetch(source.id, remoteDetailActionCode(saveSelection.detail), paths, localPaths, saveSelection.targetRoot, remoteFetchDecisionList(saveSelection.decisions));
        setSaveSelection((current) => current ? { ...current, plan, planDirty: false, message: formatRemoteFetchPreparation(plan) } : current);
        setIsSyncingCode(null);
        return;
      }
      if (hasRemoteFetchConflicts(saveSelection.plan)) {
        setSaveSelection((current) => current ? { ...current, message: formatRemoteFetchPlanConflict(saveSelection.plan!) } : current);
        setIsSyncingCode(null);
        return;
      }
    } catch (error) {
      toast.notify(toastFromError(error, "Fetch plan failed."));
      setIsSyncingCode(null);
      return;
    }
    try {
      const result = await api.fetchRemoteSourceWork(source.id, remoteDetailActionCode(saveSelection.detail), paths, localPaths, saveSelection.requestId, saveSelection.targetRoot || saveSelection.plan?.saveRoot || "", remoteFetchDecisionList(saveSelection.decisions));
      notifyFetchQueued(toast, result);
      setSaveSelection(null);
      try {
        await onSynced(0);
      } catch (error) {
        toast.notify({ kind: "warning", message: error instanceof Error ? `Fetch was queued, but Library refresh failed: ${error.message}` : "Fetch was queued, but Library refresh failed." });
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) toast.notify(toastFromError(error, "Fetch submission failed."));
      else notifyFetchUnconfirmed(toast);
    } finally {
      setIsSyncingCode(null);
    }
  };

  const selectSaveEdition = async (code: string) => {
    if (!saveSelection) return false;
    setIsSyncingCode(code);
    try {
      const detail = await api.getRemoteSourceWork(source.id, code);
      const paths = remoteSelectablePaths(buildRemoteTree(detail.tracks));
      setSaveSelection((current) => current ? { ...current, detail, selectedPaths: new Set(paths), selectedLocalPaths: new Set(), targetRoot: "", decisions: {}, planDirty: false, plan: null, message: "", requestId: createFetchRequestID() } : current);
      return true;
    } catch (error) {
      toast.notify(toastFromError(error, `The ${code} edition is not available from ${source.displayName}.`));
      return false;
    } finally {
      setIsSyncingCode(null);
    }
  };

  const markRemoteWork = async (work: RemoteWork, status: ListeningStatus) => {
    if (!work.primaryCode) return;
    setIsSyncingCode(work.primaryCode);
    try {
      const workId = work.workId ?? await syncWork(work, "mark_interest");
      if (!workId) return;
      await api.updateWorkUserState(workId, { listeningStatus: status });
      onWorkStateChanged(work.primaryCode, { workId, listeningStatus: status });
      toast.success(`Tracked and marked ${work.primaryCode}.`);
      await onSynced(workId);
    } catch (error) {
      toast.notify(toastFromError(error, "Mark update failed."));
    } finally {
      setIsSyncingCode(null);
    }
  };

  const syncAndMarkRemoteWork = async (work: RemoteWork, status: ListeningStatus) => {
    setIsSyncingCode(work.primaryCode);
    try {
      const result = await api.trackRemoteSourceWork(source.id, remoteWorkActionCode(work), "mark_interest");
      await api.updateWorkUserState(result.workId, { listeningStatus: status });
      toast.success(`Tracked and marked ${result.primaryCode}.`);
      await onSynced(result.workId);
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
      const result = await api.trackRemoteSourceWork(source.id, remoteWorkActionCode(work), "list_remote");
      toast.success(`Tracked ${result.primaryCode} for list selection.`);
      return result.workId;
    } catch (error) {
      toast.notify(toastFromError(error, "Remote sync failed."));
      return null;
    } finally {
      setIsSyncingCode(null);
    }
  };

  return (
    <section className="space-y-3 pb-4 lg:pb-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{source.displayName}</h2>
          <p className="text-sm text-muted-foreground">Browse source results without importing until a user action needs local state.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant={selectionMode ? "default" : "outline"} size="sm" onClick={() => {
            setSelectionMode((value) => {
              if (value) setBulkCodes(new Set());
              return !value;
            });
          }}>
            Select
          </Button>
          <Badge variant={source.enabled ? "outline" : "warning"}>{source.enabled ? "enabled" : "disabled"}</Badge>
          <Badge variant="secondary">{result?.status ?? "loading"}</Badge>
          {result?.status === "ok" && !result.sortApplied && <Badge variant="warning">source order fallback</Badge>}
        </div>
      </div>
      {remotePagination}
      {selectionMode && <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2 text-sm">
        <div className="text-muted-foreground">{selectedWorks.length} selected</div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => toggleAllVisible(true)}>Select all</Button>
          <Button variant="outline" size="sm" onClick={() => {
            setBulkCodes(new Set());
            setSelectionMode(false);
          }}>Cancel selection</Button>
          <Button variant="outline" size="sm" disabled={isBulkBusy || selectedSyncable.length === 0} onClick={() => void bulkSyncSelected()}>
            <GitBranchPlus className="h-4 w-4" />
            Track {selectedSyncable.length}
          </Button>
          <Button variant="outline" size="sm" disabled={isBulkBusy || selectedSaveable.length === 0} onClick={() => void bulkSaveSelected()}>
            <HardDriveDownload className="h-4 w-4" />
            Fetch {selectedSaveable.length}
          </Button>
        </div>
      </div>}
      {isInitialLoading ? (
        <RemoteWorkGridSkeleton viewMode={viewMode} mobileColumns={mobileColumns} desktopColumns={desktopColumns} />
      ) : visibleWorks.length === 0 ? (
        <Card>
		  <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5 text-sm text-muted-foreground">
			<span>{searchClauses.length > 0 ? "No remote works match the current search on this page." : "No remote works on this page."}</span>
			{searchClauses.length > 0 && <Button variant="outline" size="sm" onClick={onClearSearch}>Clear search</Button>}
		  </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {isRefreshing && <div className="rounded-md border bg-card px-3 py-2 text-xs text-muted-foreground">Refreshing remote results...</div>}
          <section
            className={workCollectionClassName(viewMode)}
            style={workCollectionStyle(mobileColumns, desktopColumns)}
          >
            {visibleWorks.map((work) => (
              <div key={work.remoteId} className={viewMode === "masonry" ? "mb-4 [break-inside:avoid]" : "h-full"}>
                <RemoteWorkCard
                  work={work}
                  source={source}
                  selected={bulkCodes.has(work.primaryCode)}
                  selectable={Boolean(work.primaryCode)}
                  selectionActive={selectionActive}
                  isBusy={isSyncingCode === work.primaryCode}
                  onSelectedChange={(checked) => toggleBulkCode(work.primaryCode, checked)}
                  onOpen={() => onOpenPreview(work)}
                  onFetch={() => void syncWork(work, "manual_track")}
                  onTagOpen={onTagOpen}
                  onMark={(status) => void markRemoteWork(work, status)}
                  onSave={() => void openSaveSelection(work)}
                  onEnsureWork={() => ensureRemoteWorkForList(work)}
                  onListSaved={(workId, favorite) => {
                    onWorkStateChanged(work.primaryCode, { workId, favorite });
                    void onSynced(0);
                  }}
                />
              </div>
            ))}
          </section>
        </div>
      )}
      {viewMode === "masonry"
        ? <CompactWorkPagination page={currentPage} totalPages={totalPages} onPageChange={onPageChange} />
        : remotePagination}
      {saveConfirm && (
        <SaveConfirmModal
          count={saveConfirm.codes.length}
          onClose={() => setSaveConfirm(null)}
          onConfirm={() => void saveConfirm.run()}
        />
      )}
      {saveSelection && (
        <RemoteSaveSelectionPanel
          root={buildRemoteTree(saveSelection.detail.tracks)}
          selectedPaths={saveSelection.selectedPaths}
          selectedLocalPaths={saveSelection.selectedLocalPaths}
          plan={saveSelection.plan}
          decisions={saveSelection.decisions}
          planDirty={saveSelection.planDirty}
          message={saveSelection.message}
          sourceId={source.id}
          activeEditionCode={remoteDetailActionCode(saveSelection.detail)}
          onEditionChange={selectSaveEdition}
          targetRoot={saveSelection.targetRoot}
          onTargetRootChange={(targetRoot) => setSaveSelection((current) => current ? { ...current, targetRoot, plan: null, message: "" } : current)}
          onChange={(paths) => setSaveSelection((current) => current ? { ...current, selectedPaths: paths, plan: null, message: "" } : current)}
          onLocalChange={(paths) => setSaveSelection((current) => current ? { ...current, selectedLocalPaths: paths, plan: null, message: "" } : current)}
          onDecisionChange={(decision) => setSaveSelection((current) => current ? { ...current, decisions: { ...current.decisions, [decision.itemKey]: decision }, planDirty: true } : current)}
          disabled={isSyncingCode === saveSelection.work.primaryCode}
          onClose={() => setSaveSelection(null)}
          onSave={() => void fetchSingleSelection()}
        />
      )}
    </section>
  );
}

function WorkCard({
  work,
  onOpen,
  onStatusChange,
  onFavoriteSaved,
  onTagOpen,
  onUntrack,
  onFetch,
  isFetchBusy,
}: {
  work: Work;
  onOpen: () => void;
  onStatusChange: (workID: number, status: ListeningStatus) => Promise<void>;
  onFavoriteSaved: (workID: number, favorite: boolean) => void;
  onTagOpen: (tag: string) => void;
  onUntrack?: (source: SourcePresenceItem) => void;
  onFetch?: (source: SourcePresenceItem) => void;
  isFetchBusy?: boolean;
}) {
  const view = libraryWorkCardView(work);
  const trackedSource = trackedSourceForWork(work);

  return (
    <WorkCardShell
      work={view}
      onOpen={onOpen}
      onCircleOpen={(externalId) => openCircleRoute(externalId)}
      onSeriesOpen={work.seriesTitleId && work.circleExternalId ? () => openCircleSeriesRoute(work.circleExternalId, work.seriesTitleId) : undefined}
      onTagOpen={onTagOpen}
      footer={(
        <WorkCardFooter
          left={<WorkCardDLsiteAction href={work.dlsiteUrl} />}
          right={(
            <>
              {onUntrack && trackedSource && (
                <WorkCardActionButton
                  title="Untrack source"
                  onClick={(event) => {
                    event.stopPropagation();
                    onUntrack(trackedSource);
                  }}
                >
                  <Unlink className="h-4 w-4" />
                </WorkCardActionButton>
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
              <WorkCardListButton workId={work.id} active={work.favorite} onSaved={(favorite) => onFavoriteSaved(work.id, favorite)} />
              <WorkCardQuickMarkButton value={work.listeningStatus} onChange={(status) => void onStatusChange(work.id, status)} />
            </>
          )}
        />
      )}
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
      selection={selectionActive ? <WorkCardSelection checked={selected} disabled={!selectable} onChange={onSelectedChange} /> : undefined}
      onOpen={onOpen}
      onTagOpen={onTagOpen}
      canOpen={Boolean(work.primaryCode)}
      footer={(
        <WorkCardFooter
          left={<WorkCardDLsiteAction href={dlsiteWorkURL(work.primaryCode)} />}
          right={(
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
            <WorkCardQuickMarkButton value={work.listeningStatus} disabled={isBusy || !work.primaryCode} onChange={onMark} />
            </>
          )}
        />
      )}
    />
  );
}

function RemoteWorkGridSkeleton({
  viewMode,
  mobileColumns,
  desktopColumns,
}: {
  viewMode: LibraryViewMode;
  mobileColumns: LibraryColumnCount;
  desktopColumns: LibraryColumnCount;
}) {
  return (
    <section
      className={workCollectionClassName(viewMode)}
      style={workCollectionStyle(mobileColumns, desktopColumns)}
    >
      {Array.from({ length: 12 }, (_, index) => (
        <div key={index} className={viewMode === "masonry" ? "mb-4 overflow-hidden rounded-lg border bg-card [break-inside:avoid]" : "overflow-hidden rounded-lg border bg-card"}>
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

function SaveConfirmModal({ count, onClose, onConfirm }: { count: number; onClose: () => void; onConfirm: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/50 p-4" onMouseDown={onClose}>
      <div className="w-full max-w-sm rounded-lg border bg-card p-4 shadow-xl" onMouseDown={(event) => event.stopPropagation()}>
        <h3 className="text-base font-semibold">Fetch remote directory</h3>
        <p className="mt-2 text-sm text-muted-foreground">This will download the full remote directory for {count} selected work{count === 1 ? "" : "s"}.</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={onConfirm}>Fetch</Button>
        </div>
      </div>
    </div>
  );
}

function UntrackConfirmModal({
  work,
  source,
  disabled,
  onClose,
  onConfirm,
}: {
  work: Work;
  source: SourcePresenceItem;
  disabled: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const sourceName = source.fileSourceName || source.fileSourceCode || "this source";
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/50 p-4" onMouseDown={onClose}>
      <div className="w-full max-w-sm rounded-lg border bg-card p-4 shadow-xl" onMouseDown={(event) => event.stopPropagation()}>
        <h3 className="text-base font-semibold">Untrack source</h3>
        <div className="mt-2 space-y-2 text-sm text-muted-foreground">
          <p>{work.primaryCode} will be removed from tracked works for {sourceName}.</p>
          <p>Work information, marks, lists, metadata, and local files will be kept.</p>
          <p>Cached files for this work under /cache will be deleted and their cache locations will be marked unavailable.</p>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" disabled={disabled} onClick={onClose}>Cancel</Button>
          <Button variant="outline" size="sm" className="border-destructive/40 text-destructive hover:bg-destructive/10" disabled={disabled} onClick={onConfirm}>
            {disabled ? "Untracking" : "Untrack"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function libraryWorkCardView(work: Work): WorkCardViewModel {
  return {
    code: work.primaryCode,
    title: work.title,
    circle: work.circle || "Unknown circle",
    circleExternalId: work.circleExternalId,
    voiceActors: work.voiceActors,
    voiceCredits: work.voiceCredits,
    coverUrl: work.coverUrl,
    rating: work.rating,
    series: work.series || null,
    dlsiteTags: dlsiteTagBadges(work.tags),
    date: cardDate(work.releaseDate, work.updatedAt || work.createdAt),
    progress: work.progress,
    userTags: [],
		sourceBadges: sourcePresenceBadges(work.sourcePresence, work.availability),
  };
}

function trackedSourceForWork(work: Work) {
  return (work.sourcePresence ?? []).find((item) => item.type === "tracked" && item.availability === "available" && item.fileSourceId);
}

function remoteWorkCardView(work: RemoteWork, source: LibrarySource): WorkCardViewModel {
  const sourceLabel = source.displayName || source.code || "remote source";
  return {
    code: work.primaryCode || work.remoteId,
    title: work.title,
    circle: work.circle || sourceLabel || "Unknown circle",
    voiceActors: work.voiceActors,
    coverUrl: work.coverUrl,
    rating: work.rating,
    series: null,
    dlsiteTags: dlsiteTagBadges(work.tags),
    date: cardDate(work.releaseDate, work.updatedAt || work.releaseDate),
    progress: null,
    userTags: [],
    sourceBadges: work.remotePlayable
      ? [{ key: `source:remote:${source.id}`, label: sourceLabel, variant: "outline" }]
      : [{ key: `source:remote:${source.id}:unavailable`, label: `${sourceLabel} unavailable`, variant: "warning" }],
  };
}

function workHasNoSource(work: { sourcePresence?: SourcePresenceItem[] | null; availability?: string[]; mediaItems?: MediaItem[] }) {
  const sourcePresence = work.sourcePresence ?? [];
  const hasPresence = sourcePresence.some((item) => item.type && item.type !== "location" && item.type !== "remote");
  if (hasPresence) return false;
  if (work.availability && work.availability.some((item) => ["local", "cache", "cached", "remote"].includes(item.toLowerCase()))) return false;
  if ((work.mediaItems ?? []).some((item) => item.locations.some((location) => location.availability === "available"))) return false;
  return true;
}

function WorkProgress({ progress }: { progress: Work["progress"] }) {
  if (!progress.mediaItemId || !progress.lastPlayedAt) {
    return <div className="h-8 text-xs text-muted-foreground">No playback yet</div>;
  }
  return (
    <div className="space-y-1">
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${progressPercent(progress)}%` }} />
      </div>
      <div className="truncate text-xs text-muted-foreground">
        {progress.completed ? "Finished" : `Resume ${progress.title || "track"} at ${formatTime(progress.positionSeconds)}`}
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
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const options = activeTab.kind === "source"
	? librarySortOptions.filter((option) => ["recent", "release", "rating", "sales", "random"].includes(option.value))
	: librarySortOptions;
  const label = options.find((option) => option.value === value)?.label ?? "Sort";
  useDismissiblePopover(open, popoverRef, () => setOpen(false));
  const nextDirection = direction === "asc" ? "desc" : "asc";
  return (
    <div className="relative" ref={popoverRef}>
      <div className="inline-flex rounded-md border bg-background">
        <button
          className="relative inline-flex h-8 w-8 items-center justify-center rounded-l-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          title={`Sort: ${label}`}
          aria-label={`Sort: ${label}`}
          onClick={() => setOpen((current) => !current)}
        >
          <ArrowUpDown className="h-4 w-4" />
        </button>
        <button
          className="relative inline-flex h-8 w-8 items-center justify-center rounded-r-md border-l text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          title={value === "random" ? "Reshuffle" : direction === "asc" ? "Ascending" : "Descending"}
          aria-label={value === "random" ? "Reshuffle" : direction === "asc" ? "Ascending" : "Descending"}
          onClick={() => value === "random" ? onReshuffle() : onDirectionChange(nextDirection)}
        >
          {value === "random" ? <RefreshCw className="h-4 w-4" /> : direction === "asc" ? <ArrowDownAZ className="h-4 w-4" /> : <ArrowDownZA className="h-4 w-4" />}
        </button>
      </div>
	  <AnchoredPopover open={open} anchorRef={popoverRef} onOpenChange={setOpen} className="w-[min(11rem,calc(100vw-1.5rem))] p-1 text-sm">
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
			  {option.label}
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
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  useDismissiblePopover(open, popoverRef, () => setOpen(false));
  return (
    <div className="relative" ref={popoverRef}>
      <IconButton title={disabled ? "Mark filters are unavailable for source browsing" : activeCount > 0 ? `Filters: ${activeCount} active` : "Filters"} disabled={disabled} onClick={() => setOpen((current) => !current)}>
        <Filter className="h-4 w-4" />
        {activeCount > 0 && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-primary" />}
      </IconButton>
      <AnchoredPopover open={open && !disabled} anchorRef={popoverRef} className="flex w-10 flex-col gap-1 rounded-lg border bg-card p-1 text-sm shadow-lg">
          <button
            className={`flex h-8 items-center justify-center rounded-md hover:bg-muted ${value === "all" ? "bg-primary/10 text-primary ring-1 ring-inset ring-primary/15" : "text-muted-foreground"}`}
            aria-pressed={value === "all"}
            title="All marks"
            aria-label="All marks"
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
                title={option.label}
                aria-label={option.label}
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
      return { icon: CheckCircle2, className: "text-emerald-600" };
    case "relisten":
      return { icon: Repeat2, className: "text-primary" };
    case "paused":
      return { icon: PauseCircle, className: "text-amber-600" };
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

function statusFilterLabel(value: ListeningStatus | "all") {
  if (value === "all") return "All marks";
  return listeningStatusOptions.find((option) => option.value === value)?.label ?? value;
}

function EmptyLibraryWorksCard({ scope, filtered, onClear }: { scope: LocalLibraryScope; filtered: boolean; onClear: () => void }) {
  return (
    <Card>
	  <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5 text-sm text-muted-foreground">
		<span>{scope === "tracked"
          ? "No tracked works match this view."
          : scope === "remote"
          ? "No untracked remote-available works match this view."
          : scope === "no_source"
          ? "No works without sources match this view."
          : scope === "local"
          ? "No local works match this view."
		  : "No works match this view."}</span>
		{filtered && <Button variant="outline" size="sm" onClick={onClear}>Clear search and filters</Button>}
      </CardContent>
    </Card>
  );
}

function WorkPagination({
  page,
  pageSize,
  totalItems,
  totalPages,
  pageSizeOptions,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  pageSizeOptions: readonly number[];
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  const [jumpPage, setJumpPage] = useState(String(page));

  useEffect(() => {
    setJumpPage(String(page));
  }, [page]);

  const goToJumpPage = () => {
    const next = Math.min(totalPages, Math.max(1, Number(jumpPage) || page));
    onPageChange(next);
    setJumpPage(String(next));
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="text-xs text-muted-foreground">
        Page {page} / {totalPages} · {totalItems} works
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="h-8 rounded-md border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
          value={pageSize}
          onChange={(event) => onPageSizeChange(Number(event.target.value))}
          aria-label="Works per page"
        >
          {pageSizeOptions.map((value) => (
            <option key={value} value={value}>
              {value} / page
            </option>
          ))}
        </select>
        <IconButton title="Previous page" disabled={page <= 1} onClick={() => onPageChange(Math.max(1, page - 1))}>
          <ChevronLeft className="h-4 w-4" />
        </IconButton>
        <IconButton title="Next page" disabled={page >= totalPages} onClick={() => onPageChange(Math.min(totalPages, page + 1))}>
          <ChevronRight className="h-4 w-4" />
        </IconButton>
        <input
          className="h-8 w-16 rounded-md border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
          type="number"
          min={1}
          max={totalPages}
          value={jumpPage}
          onChange={(event) => setJumpPage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") goToJumpPage();
          }}
          aria-label="Jump to page"
        />
        <Button variant="outline" size="sm" onClick={goToJumpPage}>
          Go
        </Button>
      </div>
    </div>
  );
}

function CompactWorkPagination({
  page,
  totalPages,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}) {
  const [jumpPage, setJumpPage] = useState(String(page));

  useEffect(() => {
    setJumpPage(String(page));
  }, [page]);

  const goToJumpPage = () => {
    const next = Math.min(totalPages, Math.max(1, Number(jumpPage) || page));
    onPageChange(next);
    setJumpPage(String(next));
  };

  return (
    <div className="flex justify-center sm:justify-end">
      <div className="inline-flex flex-wrap items-center gap-2 rounded-lg border bg-card px-2 py-2 text-sm">
        <IconButton title="Previous page" disabled={page <= 1} onClick={() => onPageChange(Math.max(1, page - 1))}>
          <ChevronLeft className="h-4 w-4" />
        </IconButton>
        <div className="min-w-20 text-center text-xs text-muted-foreground">
          {page} / {totalPages}
        </div>
        <IconButton title="Next page" disabled={page >= totalPages} onClick={() => onPageChange(Math.min(totalPages, page + 1))}>
          <ChevronRight className="h-4 w-4" />
        </IconButton>
        <input
          className="h-8 w-16 rounded-md border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
          type="number"
          min={1}
          max={totalPages}
          value={jumpPage}
          onChange={(event) => setJumpPage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") goToJumpPage();
          }}
          aria-label="Jump to page"
        />
        <Button variant="outline" size="sm" onClick={goToJumpPage}>
          Go
        </Button>
      </div>
    </div>
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
  const value = editor.draft.value;
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-2 text-sm shadow-sm sm:flex-row sm:items-center">
      <select
        className="h-9 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring sm:w-40"
        value={editor.draft.kind}
        onChange={(event) => onChange({ ...editor.draft, kind: event.target.value as SearchClauseKind })}
        aria-label="Search clause type"
      >
        {editableSearchClauseKinds.map((kind) => (
          <option key={kind.value} value={kind.value}>
            {kind.label}
          </option>
        ))}
      </select>
      <input
        className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
        value={value}
        onChange={(event) => onChange({ ...editor.draft, value: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === "Enter") onSave();
          if (event.key === "Escape") onCancel();
        }}
        placeholder="Value"
      />
      <div className="flex gap-2">
        <Button size="sm" disabled={!value.trim()} onClick={onSave}>
          <Check className="h-4 w-4" />
          {editor.mode === "add" ? "Add" : "Save"}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel}>
          <X className="h-4 w-4" />
          Cancel
        </Button>
      </div>
    </div>
  );
}

function dlsiteWorkURL(code: string) {
  const site = code.toUpperCase().startsWith("RJ") ? "maniax" : "home";
  return `https://www.dlsite.com/${site}/work/=/product_id/${encodeURIComponent(code)}.html`;
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
          <ListChecks className={value === option.value && value !== "none" ? "h-3.5 w-3.5 text-primary" : "h-3.5 w-3.5"} />
          {option.label}
        </button>
      ))}
    </div>
  );
}

function RemoteWorkDetailView({
  source,
  code,
  onBack,
  onOpenLocal,
  onWorksChanged,
}: {
  source: LibrarySource;
  code: string;
  onBack: () => void;
  onOpenLocal: (workID: number) => void;
  onWorksChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const [detail, setDetail] = useState<RemoteWorkDetail | null>(null);
  const [message, setMessage] = useState("");
  const [isFetching, setIsFetching] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [directoryMode, setDirectoryMode] = useState<DirectoryMode>("browse");
  const [isManageOpen, setIsManageOpen] = useState(false);
  const [directoryRoutingRules, setDirectoryRoutingRules] = useState<DirectoryRoutingRule[]>(defaultDirectoryRoutingRules);
  const tree = useMemo(() => buildRemoteTree(detail?.tracks ?? []), [detail]);
  const remoteFilePaths = useMemo(() => remoteSelectablePaths(tree), [tree]);
  const [selectedSavePaths, setSelectedSavePaths] = useState<Set<string>>(new Set());
  const [selectedLocalSavePaths, setSelectedLocalSavePaths] = useState<Set<string>>(new Set());
  const [selectedTargetRoot, setSelectedTargetRoot] = useState("");
  const [isSaveSelectionOpen, setIsSaveSelectionOpen] = useState(false);
  const [savePlan, setSavePlan] = useState<RemoteWorkSavePlan | null>(null);
  const [saveDecisions, setSaveDecisions] = useState<RemoteFetchDecisions>({});
  const [savePlanDirty, setSavePlanDirty] = useState(false);
  const [savePlanMessage, setSavePlanMessage] = useState("");
  const directoryStats = useMemo(() => treeStats(tree), [tree]);
  const trackCount = useMemo(() => countTreeFiles(tree), [tree]);
  const remotePlayableTracks = useMemo(() => flattenTracks(tree), [tree]);
  const remoteTabs = useMemo<SourceTabInfo[]>(() => detail ? [{ key: remoteSourceTabKey(source.id), label: detail.sourceName, fileSourceId: null, kind: "remote", status: "green", statusLabel: "Available" }] : [], [detail, source.id]);
  const player = useLibraryPlayer();

  useEffect(() => {
    let cancelled = false;
    api.getRuntimeSettings()
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
    setDetail(null);
    setMessage("");
    setSelectedSavePaths(new Set());
    setSelectedLocalSavePaths(new Set());
    setSelectedTargetRoot("");
    setSavePlan(null);
    setSavePlanMessage("");
    const controller = new AbortController();
    api.getRemoteSourceWork(source.id, code, controller.signal).then(setDetail).catch((error) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      const text = error instanceof Error ? error.message : "Remote preview failed.";
      setMessage(text);
      toast.notify({ kind: "error", message: text });
    });
    return () => controller.abort();
  }, [source.id, code]);

  useEffect(() => {
    setSelectedSavePaths(new Set(remoteFilePaths));
    setSelectedLocalSavePaths(new Set());
    setSavePlan(null);
    setSavePlanMessage("");
  }, [remoteFilePaths]);

  const fetchWork = async (reason: string) => {
    if (!detail?.primaryCode) return;
    setIsFetching(true);
    setMessage("");
    try {
      const result = await api.trackRemoteSourceWork(source.id, remoteDetailActionCode(detail), reason);
      toast.success(`Tracked ${result.primaryCode} through workflow run #${result.runId}.`);
      await onWorksChanged();
      onOpenLocal(result.workId);
    } catch (error) {
      toast.notify(toastFromError(error, "Remote track failed."));
    } finally {
      setIsFetching(false);
    }
  };

  const syncForUserState = async (reason: string) => {
    if (!detail?.primaryCode) return null;
    setIsFetching(true);
    setMessage("");
    try {
      const result = await api.trackRemoteSourceWork(source.id, remoteDetailActionCode(detail), reason);
      await onWorksChanged();
      setDetail((current) => current ? { ...current, workId: result.workId, importStatus: "synced" } : current);
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
    const workID = detail.workId ?? await syncForUserState("detail_mark_interest");
    if (!workID) return;
    try {
      const result = await api.updateWorkUserState(workID, { listeningStatus: status });
      toast.success(`Marked ${detail.primaryCode} as ${listeningStatusLabel(result.listeningStatus)}.`);
      await onWorksChanged();
    } catch (error) {
      toast.notify(toastFromError(error, "Mark update failed."));
    }
  };

  const selectedPaths = Array.from(selectedSavePaths).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  const selectedLocalPaths = Array.from(selectedLocalSavePaths).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  const openSaveWorkspace = async () => {
    if (!detail?.primaryCode || remoteFilePaths.length === 0) return;
    setIsSaving(true);
    toast.info("Preparing language editions, source files, and the final Fetch tree…");
    try {
      const plan = await api.planRemoteSourceWorkFetch(source.id, remoteDetailActionCode(detail), remoteFilePaths);
      setSelectedSavePaths(new Set(remoteFilePaths));
      setSelectedLocalSavePaths(new Set());
      setSelectedTargetRoot("");
      setSaveDecisions({});
      setSavePlanDirty(false);
      setSavePlan(plan);
      setSavePlanMessage(formatRemoteFetchPreparation(plan));
      setIsSaveSelectionOpen(true);
    } catch (error) {
      toast.notify(toastFromError(error, "Fetch preparation failed."));
    } finally {
      setIsSaving(false);
    }
  };
  const saveSelected = async () => {
    if (!detail?.primaryCode || (selectedPaths.length === 0 && selectedLocalPaths.length === 0)) return;
    setIsSaving(true);
    setMessage("");
    setSavePlanMessage("");
    try {
      if (!savePlan || savePlanDirty) {
        const plan = await api.planRemoteSourceWorkFetch(source.id, remoteDetailActionCode(detail), selectedPaths, selectedLocalPaths, selectedTargetRoot, remoteFetchDecisionList(saveDecisions));
        setSavePlan(plan);
        setSavePlanDirty(false);
        setSavePlanMessage(formatRemoteFetchPreparation(plan));
        return;
      }
      if (hasRemoteFetchConflicts(savePlan)) {
        setSavePlanMessage(formatRemoteFetchPlanConflict(savePlan));
        return;
      }
      const result = await api.fetchRemoteSourceWork(source.id, remoteDetailActionCode(detail), selectedPaths, selectedLocalPaths, "", selectedTargetRoot || savePlan.saveRoot, remoteFetchDecisionList(saveDecisions));
      toast.success(`Fetch queued for ${result.primaryCode} as workflow run #${result.runId}.`);
      setIsSaveSelectionOpen(false);
      setSavePlan(null);
      setSaveDecisions({});
      setSavePlanDirty(false);
      setSavePlanMessage("");
      await onWorksChanged();
    } catch (error) {
      toast.notify(toastFromError(error, "Save failed."));
    } finally {
      setIsSaving(false);
    }
  };

  const playRemoteTracks = (tracks: TreeTrack[], locationId: number) => {
    if (!detail || tracks.length === 0) return;
    player.playQueue(
      tracks.map((track) => toRemotePreviewPlayerTrack(track, detail)),
      locationId,
    );
  };

  const selectPreparedRemoteEdition = async (editionCode: string) => {
    setIsSaving(true);
    try {
      const nextDetail = await api.getRemoteSourceWork(source.id, editionCode);
      const nextTree = buildRemoteTree(nextDetail.tracks);
      setDetail(nextDetail);
      setSelectedSavePaths(new Set(remoteSelectablePaths(nextTree)));
      setSelectedLocalSavePaths(new Set());
      setSelectedTargetRoot("");
      setSavePlan(null);
      setSaveDecisions({});
      setSavePlanDirty(false);
      setSavePlanMessage("");
      return true;
    } catch (error) {
      toast.notify(toastFromError(error, `The ${editionCode} edition is not available from ${source.displayName}.`));
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const queueRemoteTrack = (track: TreeTrack, next: boolean) => {
    if (!detail) return;
    const queuedTrack = toRemotePreviewPlayerTrack(track, detail);
    if (next) player.playNext(queuedTrack);
    else player.appendQueue([queuedTrack]);
    toast.info(next ? `Playing ${track.title} next.` : `Added ${track.title} to the queue.`);
  };

  if (!detail) {
    return (
      <div className="space-y-4">
        <Button variant="outline" size="sm" onClick={onBack}>
          <ChevronLeft className="h-4 w-4" />
          Back to source
        </Button>
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">{message || `Loading ${code}...`}</CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Button variant="outline" size="sm" onClick={onBack}>
        <ChevronLeft className="h-4 w-4" />
        Back to source
      </Button>

      <DetailHero
        coverUrl={detail.coverUrl}
        fallbackCode={detail.primaryCode || detail.remoteId}
        code={detail.primaryCode || detail.remoteId}
        title={detail.title}
        circle={detail.circle}
        circleExternalId=""
        ratingLabel="Rating"
        rating={detail.rating}
        ratingCount={null}
        sales={detail.sales}
        series=""
        seriesTitleId=""
        seriesCircleExternalId=""
        dlsiteFetchedAt=""
        releaseDate={detail.releaseDate || "Unknown"}
        ageRating={detail.ageRating}
        durationSeconds={detail.durationSeconds}
        voiceActors={detail.voiceActors}
        voiceCredits={[]}
        tags={detail.tags}
        actions={
          <DetailActionBar
            canPlay={remotePlayableTracks.length > 0}
            busy={isFetching || isSaving}
            mode="remote_source"
            listeningStatus="none"
            favorite={false}
            listWorkId={detail.workId}
            onEnsureListWork={() => syncForUserState("detail_list_remote")}
            onListSaved={async () => {
              await onWorksChanged();
            }}
            onPlay={() => playRemoteTracks(remotePlayableTracks, remotePlayableTracks[0].locationId)}
            onMark={(status) => void updateRemoteMark(status)}
            onSync={() => void fetchWork("manual_track")}
            onTrack={() => void fetchWork("manual_track")}
            onFetch={() => void openSaveWorkspace()}
            onManage={() => setIsManageOpen(true)}
            dlsiteUrl={dlsiteWorkURL(detail.primaryCode)}
            syncLabel="Track"
            showSync={false}
            showFetch
          />
        }
      />

      <SourceDirectoryPanel
        title={detail.sourceName}
        description={`Previewing remote files from ${detail.sourceName}; fetch before local marks or saves.`}
        statsLabel={formatTreeStats(directoryStats)}
        tabs={remoteTabs}
        activeKey={remoteSourceTabKey(source.id)}
        onActiveKeyChange={() => undefined}
        directoryMode={directoryMode}
        onDirectoryModeChange={setDirectoryMode}
        root={tree}
        directoryRoutingRules={directoryRoutingRules}
        currentLocationId={player.currentLocationId}
        emptyLabel="No remote files detected."
        toolbar={message ? <DirectoryMessage message={message} /> : undefined}
        selectionModal={isSaveSelectionOpen ? (
          <RemoteSaveSelectionPanel
            root={tree}
            selectedPaths={selectedSavePaths}
            selectedLocalPaths={selectedLocalSavePaths}
            plan={savePlan}
            decisions={saveDecisions}
            planDirty={savePlanDirty}
            message={savePlanMessage}
            sourceId={source.id}
            activeEditionCode={detail ? remoteDetailActionCode(detail) : code}
            onEditionChange={selectPreparedRemoteEdition}
            targetRoot={selectedTargetRoot}
            onTargetRootChange={(targetRoot) => {
              setSelectedTargetRoot(targetRoot);
              setSavePlan(null);
              setSavePlanMessage("");
            }}
            onChange={(paths) => {
              setSelectedSavePaths(paths);
              setSavePlan(null);
              setSavePlanMessage("");
            }}
            onLocalChange={(paths) => {
              setSelectedLocalSavePaths(paths);
              setSavePlan(null);
              setSavePlanMessage("");
            }}
            onDecisionChange={(decision) => {
              setSaveDecisions((current) => ({ ...current, [decision.itemKey]: decision }));
              setSavePlanDirty(true);
            }}
            disabled={isSaving}
            onClose={() => setIsSaveSelectionOpen(false)}
            onSave={() => void saveSelected()}
          />
        ) : null}
        onPlayFolder={playRemoteTracks}
        onPlayNext={(track) => queueRemoteTrack(track, true)}
        onAppendQueue={(track) => queueRemoteTrack(track, false)}
      />
      {isManageOpen && (
        <DirectoryManagerModal
          root={tree}
          emptyLabel="No remote files detected."
          onClose={() => setIsManageOpen(false)}
        />
      )}
    </div>
  );
}

function WorkDetailView({
  code,
  work,
  workPreview,
  mediaLoading,
  sources,
  initialSourceIntent,
  onBack,
  onStatusChange,
  onWorkReload,
  onWorksChanged,
}: {
  code: string;
  work: WorkDetail | null;
  workPreview: WorkPreview | null;
  mediaLoading: boolean;
  sources: LibrarySource[];
  initialSourceIntent: DetailSourceIntent;
  onBack: () => void;
  onStatusChange: (workID: number, status: ListeningStatus) => Promise<void>;
  onWorkReload: (workID: number) => Promise<void>;
  onWorksChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const [remoteSources, setRemoteSources] = useState<RemoteSourceAvailability[]>([]);
  const [isCheckingSources, setIsCheckingSources] = useState(false);
  const [sourceCheckedAt, setSourceCheckedAt] = useState("");
  const sourceTabs = useMemo(() => buildSourceTabs(work?.mediaItems ?? [], remoteSources, work?.sourcePresence ?? []), [work, remoteSources]);
  const [activeSourceKey, setActiveSourceKey] = useState<string>(initialSourceIntent);
  const [directoryMode, setDirectoryMode] = useState<DirectoryMode>("browse");
  const [isManageOpen, setIsManageOpen] = useState(false);
  const [isMetadataEditorOpen, setIsMetadataEditorOpen] = useState(false);
  const [preview, setPreview] = useState<FilePreviewState | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRefreshingLocalFiles, setIsRefreshingLocalFiles] = useState(false);
  const [message, setMessage] = useState("");
  const [selectedSavePaths, setSelectedSavePaths] = useState<Set<string>>(new Set());
  const [selectedLocalSavePaths, setSelectedLocalSavePaths] = useState<Set<string>>(new Set());
  const [selectedTargetRoot, setSelectedTargetRoot] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isSyncingDetail, setIsSyncingDetail] = useState(false);
  const [isSaveSelectionOpen, setIsSaveSelectionOpen] = useState(false);
  const [savePlan, setSavePlan] = useState<RemoteWorkSavePlan | null>(null);
  const [saveDecisions, setSaveDecisions] = useState<RemoteFetchDecisions>({});
  const [savePlanDirty, setSavePlanDirty] = useState(false);
  const [savePlanMessage, setSavePlanMessage] = useState("");
  const [favoriteLists, setFavoriteLists] = useState<FavoriteList[]>([]);
  const [activeEdition, setActiveEdition] = useState<WorkDetail | null>(null);
  const [activeEditionCode, setActiveEditionCode] = useState("");
  const [reforkTarget, setReforkTarget] = useState<ReforkTarget | null>(null);
  const [directoryRoutingRules, setDirectoryRoutingRules] = useState<DirectoryRoutingRule[]>(defaultDirectoryRoutingRules);
  const [mobileDetailTab, setMobileDetailTab] = useState<"info" | "directory">("directory");
  const isCompactDetailLayout = useCompactDetailLayout();
  const selectedSource = sourceTabs.find((source) => source.key === activeSourceKey)
    ?? sourceTabs.find((source) => source.kind === activeSourceKey)
    ?? sourceTabs[0];
  const resolvedActiveSourceKey = selectedSource?.key ?? activeSourceKey;
  const selectedRemoteSource = selectedSource?.kind === "remote" ? remoteSources.find((item) => selectedSource.key === remoteSourceTabKey(item.source.id)) : undefined;
  const selectedTrackedPresence = selectedSource?.kind === "tracked" ? selectedSource.presence ?? null : null;
  const selectedTrackedForked = trackedPresenceForked(selectedTrackedPresence, work?.mediaItems ?? []);
  const selectedTrackedSourceID = trackedPresenceSourceID(selectedTrackedPresence);
  const selectedTrackedRemoteSource = remoteSourceForTrackedPresence(selectedTrackedPresence, remoteSources);
  const selectedRemoteDetail = selectedRemoteSource?.detail ?? null;
  const selectedRemoteSourceID = selectedRemoteSource?.source.id ?? null;
  const selectedRemoteWorkCode = selectedRemoteSource ? remoteAvailabilityRouteCode(selectedRemoteSource.summary, work?.primaryCode || code) : work?.primaryCode || code;
  const localDirectoryWork = activeEdition ?? work;
  const [tree, setTree] = useState<TreeNode>(() => emptyTree());
  const [isDirectoryLoading, setIsDirectoryLoading] = useState(false);
  const allTracks = useMemo(() => flattenTracks(tree), [tree]);
  const directoryStats = useMemo(() => treeStats(tree), [tree]);
  const resumeTrack = useMemo(() => latestResumeTrack(allTracks), [allTracks]);
  const remoteFilePaths = useMemo(() => selectedRemoteDetail ? remoteSelectablePaths(tree) : [], [selectedRemoteDetail, tree]);
  const selectedPaths = useMemo(() => Array.from(selectedSavePaths).sort((a, b) => naturalCompare(a, b)), [selectedSavePaths]);
  const selectedLocalPaths = useMemo(() => Array.from(selectedLocalSavePaths).sort((a, b) => naturalCompare(a, b)), [selectedLocalSavePaths]);
  const player = useLibraryPlayer();
  const directoryTitle = "Directory";
  const workHasNoLinkedSource = Boolean(work && workHasNoSource(work));
  const showNoSourceDirectory = workHasNoLinkedSource && !selectedRemoteSource && !selectedTrackedPresence;
  const directoryDescription = selectedTrackedPresence
    ? selectedTrackedForked
      ? "Browsing the forked tracked source directory."
      : "Tracked source directory has not been forked yet."
    : selectedRemoteSource
    ? `Previewing remote files from ${selectedRemoteSource.source.displayName}.`
    : workHasNoLinkedSource
    ? "No local, cached, tracked, or remote source is currently linked to this work."
    : "File locations are grouped by local, cache, and remote source.";
  const sourceStatsLabel = formatTreeStats(directoryStats);
  const favoriteSelected = favoriteLists.some((list) => list.selected);
  const isDetailLoading = !work;
  const actionMode: DetailActionMode = selectedRemoteSource
    ? "remote_source"
    : selectedTrackedPresence
      ? selectedTrackedForked ? "tracked_forked" : "tracked_unforked"
      : "local";
  const forkSources = availableForkSources(remoteSources);
  const currentForkSource = selectedTrackedRemoteSource ?? selectedRemoteSource ?? null;
  const canTrackRemote = Boolean(selectedRemoteSource?.detail?.primaryCode && !selectedRemoteSource.summary.workId && !selectedRemoteSource.summary.hasRemote);

  useEffect(() => {
    if (mediaLoading && (localDirectoryWork?.mediaItems.length ?? 0) === 0 && !selectedRemoteDetail) {
      setIsDirectoryLoading(true);
      return;
    }
    let cancelled = false;
    setIsDirectoryLoading(true);
    const timer = window.setTimeout(() => {
      const nextTree =
        selectedRemoteSource && !selectedRemoteDetail
          ? emptyTree()
          : selectedTrackedPresence && !selectedTrackedForked
            ? emptyTree()
            : selectedRemoteDetail
              ? buildRemoteTree(selectedRemoteDetail.tracks)
              : buildTree(
                localDirectoryWork?.mediaItems ?? [],
                selectedTrackedForked ? selectedTrackedSourceID : selectedSource?.fileSourceId ?? null,
                localDirectoryWork?.primaryCode ?? work?.primaryCode ?? "",
              );
      if (!cancelled) {
        setTree(nextTree);
        setIsDirectoryLoading(false);
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [localDirectoryWork, mediaLoading, work?.primaryCode, selectedSource, selectedRemoteDetail, selectedRemoteSource, selectedTrackedPresence, selectedTrackedForked, selectedTrackedSourceID]);

  useEffect(() => {
    if (!work || sourceTabs.length === 0 || sourceTabs.some((source) => source.key === activeSourceKey)) return;
    const intendedSource = sourceTabs.find((source) => source.kind === activeSourceKey);
    if (intendedSource) {
      setActiveSourceKey(intendedSource.key);
    } else {
      setActiveSourceKey(sourceTabs[0].key);
    }
  }, [activeSourceKey, sourceTabs, work]);

  useEffect(() => {
    setRemoteSources([]);
    setSourceCheckedAt("");
    if (!work?.primaryCode || sources.length === 0) return;
    let cancelled = false;
    api.getSourceAvailability(work.primaryCode)
      .then((result) => {
        if (cancelled) return;
        const knownSources = result.sources.flatMap((summary) => {
          const source = sources.find((candidate) => candidate.id === summary.sourceId);
          return source ? [{ source, summary }] : [];
        });
        setRemoteSources(knownSources);
        setSourceCheckedAt(result.checkedAt);
      })
      .catch(() => {
        if (!cancelled) setRemoteSources([]);
      });
    return () => {
      cancelled = true;
    };
  }, [work?.primaryCode, sources]);

  useEffect(() => {
    if (!selectedRemoteSource || !remoteSourceCanBrowse(selectedRemoteSource.summary) || selectedRemoteSource.detail || selectedRemoteSource.loading || selectedRemoteSource.error) return;
    const controller = new AbortController();
    const sourceID = selectedRemoteSource.source.id;
    setRemoteSources((items) => items.map((item) => item.source.id === sourceID ? { ...item, loading: true, error: "" } : item));
    api.getRemoteSourceWork(sourceID, selectedRemoteWorkCode, controller.signal)
      .then((detail) => {
        setRemoteSources((items) => items.map((item) => item.source.id === sourceID ? { ...item, detail, loading: false, error: "" } : item));
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setRemoteSources((items) => items.map((item) => item.source.id === sourceID ? { ...item, loading: false, error: error instanceof Error ? error.message : "Remote detail failed." } : item));
      });
    return () => controller.abort();
  }, [selectedRemoteSourceID, selectedRemoteWorkCode]);

  useEffect(() => {
    setSelectedSavePaths(new Set(remoteFilePaths));
    setSelectedLocalSavePaths(new Set());
    setSavePlan(null);
    setSavePlanMessage("");
  }, [remoteFilePaths]);

  useEffect(() => {
    setActiveEdition(null);
    setActiveEditionCode("");
	setActiveSourceKey(initialSourceIntent);
  }, [initialSourceIntent, work?.id]);

  useEffect(() => {
    if (!work || activeEditionCode) return;
    const translations = work.translations ?? [];
    const currentVersion = translations.find((translation) => translation.primaryCode.toUpperCase() === work.primaryCode.toUpperCase());
    if (currentVersion?.hasMedia) return;
    const firstPlayableVersion = translations.find((translation) => translation.hasMedia && translation.workId);
    if (firstPlayableVersion) {
      void selectEdition(firstPlayableVersion);
    }
  }, [activeEditionCode, work]);

  useEffect(() => {
    if (!work?.id) return;
    let cancelled = false;
    api.getWorkFavoriteLists(work.id)
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
    api.getRuntimeSettings()
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
    if (!work || tracks.length === 0) return;
    player.playQueue(tracks.map((track) => toPlayerTrack(track, work)), locationId);
  };

  const playAll = () => {
    if (work && allTracks.length > 0) {
      playTracks(allTracks, allTracks[0].locationId);
    }
  };

  const resumePlayback = () => {
    if (resumeTrack) {
      playTracks(allTracks, resumeTrack.locationId);
    }
  };

  const playRemoteTracks = (tracks: TreeTrack[], locationId: number) => {
    if (!selectedRemoteDetail || tracks.length === 0) return;
    player.playQueue(
      tracks.map((track) => toRemotePreviewPlayerTrack(track, selectedRemoteDetail)),
      locationId,
    );
  };

  const queueTrack = (track: TreeTrack, next: boolean) => {
    const queuedTrack = selectedRemoteDetail
      ? toRemotePreviewPlayerTrack(track, selectedRemoteDetail)
      : work
        ? toPlayerTrack(track, work)
        : null;
    if (!queuedTrack) return;
    if (next) player.playNext(queuedTrack);
    else player.appendQueue([queuedTrack]);
    toast.info(next ? `Playing ${track.title} next.` : `Added ${track.title} to the queue.`);
  };

  const deleteMediaTargets = async (targets: MediaDeleteTarget[]) => {
    if (targets.length === 0) return;
    setIsDeleting(true);
    setMessage("");
    try {
      const orderedTargets = [...targets.filter((target) => target.kind !== "local_root"), ...targets.filter((target) => target.kind === "local_root")];
      const batches = Array.from({ length: Math.ceil(orderedTargets.length / 500) }, (_, index) => orderedTargets.slice(index * 500, (index + 1) * 500));
      const results = [];
      for (const batch of batches) {
        const result = await api.cleanupMediaLocations(batch.map(({ kind, locationId }) => ({ kind, locationId })));
        results.push(result);
        let completed = false;
        for (let attempt = 0; attempt < 60; attempt += 1) {
          const run = await api.getWorkflowRun(result.runId);
          if (run.status === "succeeded") {
            completed = true;
            break;
          }
          if (["failed", "cancelled"].includes(run.status)) throw new Error(`Delete workflow #${result.runId} ${run.status}.`);
          await new Promise((resolve) => window.setTimeout(resolve, 500));
        }
        if (!completed) throw new Error(`Delete workflow #${result.runId} did not finish in time.`);
      }
      toast.success(`Deleted ${targets.length} ${targets.length === 1 ? "item" : "items"} in ${results.length} workflow ${results.length === 1 ? "run" : "runs"}.`);
      if (activeEdition) {
        setActiveEdition(await api.getWork(activeEdition.id));
      } else if (work) {
        await onWorkReload(work.id);
      }
      await onWorksChanged();
    } catch (error) {
      toast.notify(toastFromError(error, "Delete submission failed."));
      await onWorksChanged();
    } finally {
      setIsDeleting(false);
    }
  };

  const openWorkSaveWorkspace = async () => {
    if (!selectedRemoteSource?.detail || remoteFilePaths.length === 0) return;
    setIsSaving(true);
    toast.info("Preparing language editions, source files, and the final Fetch tree…");
    try {
      const plan = await api.planRemoteSourceWorkFetch(selectedRemoteSource.source.id, remoteDetailActionCode(selectedRemoteSource.detail), remoteFilePaths);
      setSelectedSavePaths(new Set(remoteFilePaths));
      setSelectedLocalSavePaths(new Set());
      setSelectedTargetRoot("");
      setSaveDecisions({});
      setSavePlanDirty(false);
      setSavePlan(plan);
      setSavePlanMessage(formatRemoteFetchPreparation(plan));
      setIsSaveSelectionOpen(true);
    } catch (error) {
      toast.notify(toastFromError(error, "Fetch preparation failed."));
    } finally {
      setIsSaving(false);
    }
  };

  const refreshLocalFiles = async () => {
    const target = localDirectoryWork ?? work;
    if (!target || selectedSource?.kind !== "local") return;
    setIsRefreshingLocalFiles(true);
    setMessage("");
    try {
      const result = await api.refreshWorkLocalFiles(target.id, selectedSource.fileSourceId);
      const refreshed = await api.getWork(result.workId);
      if (activeEdition || result.workId !== work?.id) {
        setActiveEdition(refreshed);
        setActiveEditionCode(refreshed.primaryCode);
      } else {
        await onWorkReload(result.workId);
      }
      await onWorksChanged();
      toast.success(`Refreshed ${result.indexedFiles} local files.`);
    } catch (error) {
      toast.notify(toastFromError(error, "Local files could not be refreshed."));
    } finally {
      setIsRefreshingLocalFiles(false);
    }
  };

  const planRemoteSave = async () => {
    if (!selectedRemoteSource?.detail || (selectedPaths.length === 0 && selectedLocalPaths.length === 0)) return;
    setIsSaving(true);
    setMessage("");
    setSavePlanMessage("");
    try {
      if (!savePlan || savePlanDirty) {
        const plan = await api.planRemoteSourceWorkFetch(selectedRemoteSource.source.id, remoteDetailActionCode(selectedRemoteSource.detail), selectedPaths, selectedLocalPaths, selectedTargetRoot, remoteFetchDecisionList(saveDecisions));
        setSavePlan(plan);
        setSavePlanDirty(false);
        setSavePlanMessage(formatRemoteFetchPreparation(plan));
        return;
      }
      if (hasRemoteFetchConflicts(savePlan)) {
        setSavePlanMessage(formatRemoteFetchPlanConflict(savePlan));
        return;
      }
      const result = await api.fetchRemoteSourceWork(selectedRemoteSource.source.id, remoteDetailActionCode(selectedRemoteSource.detail), selectedPaths, selectedLocalPaths, "", selectedTargetRoot || savePlan.saveRoot, remoteFetchDecisionList(saveDecisions));
      toast.success(`Fetch queued for ${result.primaryCode} as workflow run #${result.runId}.`);
      setIsSaveSelectionOpen(false);
      setSavePlan(null);
      setSaveDecisions({});
      setSavePlanDirty(false);
      setSavePlanMessage("");
      await onWorksChanged();
    } catch (error) {
      toast.notify(toastFromError(error, "Save failed."));
    } finally {
      setIsSaving(false);
    }
  };

  const selectPreparedWorkEdition = async (editionCode: string) => {
    if (!selectedRemoteSource) return false;
    setIsSaving(true);
    try {
      const detail = await api.getRemoteSourceWork(selectedRemoteSource.source.id, editionCode);
      setRemoteSources((current) => current.map((entry) => entry.source.id === selectedRemoteSource.source.id ? { ...entry, detail } : entry));
      setSelectedSavePaths(new Set(remoteSelectablePaths(buildRemoteTree(detail.tracks))));
      setSelectedLocalSavePaths(new Set());
      setSelectedTargetRoot("");
      setSavePlan(null);
      setSaveDecisions({});
      setSavePlanDirty(false);
      setSavePlanMessage("");
      return true;
    } catch (error) {
      toast.notify(toastFromError(error, `The ${editionCode} edition is not available from ${selectedRemoteSource.source.displayName}.`));
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const syncDetailMetadata = async () => {
    if (!work?.primaryCode) return;
    setIsSyncingDetail(true);
    setMessage("");
    try {
      if (selectedRemoteSource?.detail?.primaryCode) {
        const result = await api.trackRemoteSourceWork(selectedRemoteSource.source.id, remoteDetailActionCode(selectedRemoteSource.detail), "manual_track");
        toast.success(`Tracked ${result.primaryCode} through workflow run #${result.runId}.`);
        await onWorksChanged();
        openRemoteLocal(result.workId);
      } else {
        const result = await api.runDLsiteSync();
        toast.success(`DLsite sync run #${result.runId}: ${result.syncedWorks}/${result.targetWorks} works synced.`);
        await onWorksChanged();
      }
    } catch (error) {
      toast.notify(toastFromError(error, "Sync failed."));
    } finally {
      setIsSyncingDetail(false);
    }
  };

  const trackSelectedRemoteSource = async () => {
    if (!selectedRemoteSource?.detail?.primaryCode) return;
    setIsSyncingDetail(true);
    setMessage("");
    try {
      const result = await api.trackRemoteSourceWork(selectedRemoteSource.source.id, remoteDetailActionCode(selectedRemoteSource.detail), "manual_track");
      toast.success(`Tracked ${result.primaryCode} through workflow run #${result.runId}.`);
      await onWorkReload(result.workId);
      await onWorksChanged();
    } catch (error) {
      toast.notify(toastFromError(error, "Track failed."));
    } finally {
      setIsSyncingDetail(false);
    }
  };

  const ensureSelectedRemoteSourceWork = async (reason: string) => {
    if (!work || !selectedRemoteSource?.detail?.primaryCode) return null;
    if (selectedRemoteSource.summary.workId) return selectedRemoteSource.summary.workId;
    if (selectedRemoteSource.summary.hasRemote) return work.id;
    setIsSyncingDetail(true);
    setMessage("");
    try {
      const result = await api.trackRemoteSourceWork(selectedRemoteSource.source.id, remoteDetailActionCode(selectedRemoteSource.detail), reason);
      toast.success(`Tracked ${result.primaryCode} through workflow run #${result.runId}.`);
      setRemoteSources((items) => items.map((item) => item.source.id === selectedRemoteSource.source.id
        ? { ...item, summary: { ...item.summary, workId: result.workId, hasRemote: true } }
        : item));
      await onWorkReload(result.workId);
      await onWorksChanged();
      return result.workId;
    } catch (error) {
      toast.notify(toastFromError(error, "Track failed."));
      return null;
    } finally {
      setIsSyncingDetail(false);
    }
  };

  const markDetailWork = async (status: ListeningStatus) => {
    if (!work) return;
    if (!selectedRemoteSource) {
      await onStatusChange(work.id, status);
      return;
    }
    const workID = await ensureSelectedRemoteSourceWork("detail_mark_interest");
    if (!workID) return;
    try {
      const result = await api.updateWorkUserState(workID, { listeningStatus: status });
      toast.success(`Marked ${selectedRemoteSource.detail?.primaryCode ?? work.primaryCode} as ${listeningStatusLabel(result.listeningStatus)}.`);
      if (workID === work.id) await onWorkReload(work.id);
      await onWorksChanged();
    } catch (error) {
      toast.notify(toastFromError(error, "Mark update failed."));
    }
  };

  const ensureDetailListWork = async () => {
    if (!work) return null;
    if (!selectedRemoteSource) return work.id;
    return ensureSelectedRemoteSourceWork("detail_list_remote");
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
    setIsCheckingSources(true);
    setMessage("");
    try {
      const result = await api.checkSourceAvailability(work.primaryCode);
      const checkedSources = result.sources.flatMap((summary) => {
        const source = sources.find((candidate) => candidate.id === summary.sourceId);
        return source ? [{ source, summary }] : [];
      });
      setRemoteSources(checkedSources);
      setSourceCheckedAt(result.checkedAt);
      toast.success(`Checked source availability through workflow run #${result.runId}.`);
    } catch (error) {
      toast.notify(toastFromError(error, "Source check failed."));
    } finally {
      setIsCheckingSources(false);
    }
  };

  const forkTrackedSource = async (remote: RemoteSourceAvailability) => {
    if (!work?.primaryCode) return;
    setIsSyncingDetail(true);
    setMessage("");
    try {
      const result = await api.trackRemoteSourceWork(remote.source.id, remoteAvailabilityRouteCode(remote.summary, work.primaryCode), "manual_fork");
      toast.success(`Forked ${result.primaryCode} from ${remote.source.displayName} through workflow run #${result.runId}.`);
      await onWorkReload(result.workId);
      await onWorksChanged();
      setActiveSourceKey("tracked");
    } catch (error) {
      toast.notify(toastFromError(error, "Fork failed."));
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

  const openRemoteLocal = (workID: number) => {
    if (!work || work.id === workID) {
      setActiveSourceKey(sourceTabs.find((source) => source.kind === "local")?.key ?? "local");
    }
  };

  const changeSourceKey = (key: string) => {
    setActiveSourceKey(key);
    if (!key.startsWith("remote-source:")) return;
    setRemoteSources((items) =>
      items.map((item) => (remoteSourceTabKey(item.source.id) === key && item.error ? { ...item, error: "" } : item)),
    );
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
  const displayDurationSeconds = directoryStats.knownDurationAudio > 0 ? directoryStats.durationSeconds : hero.durationSeconds;
  const detailActions = work ? <DetailActionBar
    canPlay={allTracks.length > 0}
    busy={isSyncingDetail || isSaving || isRefreshingLocalFiles}
    mode={actionMode}
    listeningStatus={work.listeningStatus}
    favorite={favoriteLists.length > 0 ? favoriteSelected : work.favorite}
    listWorkId={selectedRemoteSource && !selectedRemoteSource.summary.workId && !selectedRemoteSource.summary.hasRemote ? null : work.id}
    onEnsureListWork={ensureDetailListWork}
    onListSaved={favoriteSaved}
    onPlay={selectedRemoteDetail ? () => playRemoteTracks(allTracks, allTracks[0].locationId) : playAll}
    onResume={resumeTrack ? resumePlayback : undefined}
    onMark={(status) => void markDetailWork(status)}
    onSync={() => void syncDetailMetadata()}
    onTrack={selectedRemoteSource ? () => void trackSelectedRemoteSource() : undefined}
    trackDisabled={selectedRemoteSource ? !canTrackRemote : undefined}
    forkSources={forkSources}
    currentForkSource={currentForkSource}
    onFork={(remote) => requestForkSource(remote)}
    onFetch={selectedRemoteDetail ? () => void openWorkSaveWorkspace() : undefined}
    onEditMetadata={() => setIsMetadataEditorOpen(true)}
    onManage={() => setIsManageOpen(true)}
    onRefreshLocalFiles={actionMode === "local" && selectedSource?.kind === "local" ? () => void refreshLocalFiles() : undefined}
    dlsiteUrl={work.dlsiteUrl}
    syncLabel="Sync"
    showSync
    showFetch={Boolean(selectedRemoteDetail)}
  /> : <DetailSkeletonActions />;
  const directoryPanel = (
    <SourceDirectoryPanel
      title={directoryTitle}
      description={activeEdition ? `Showing files from ${activeEdition.primaryCode} ${languageLabel(activeEdition.metadataLanguage)}.` : directoryDescription}
      statsLabel={sourceStatsLabel}
      tabs={sourceTabs}
      activeKey={resolvedActiveSourceKey}
      onActiveKeyChange={changeSourceKey}
      checkingSources={isCheckingSources}
      checkedAt={sourceCheckedAt}
      onCheckSources={() => void refreshSourceAvailability()}
      directoryMode={directoryMode}
      onDirectoryModeChange={setDirectoryMode}
      root={tree}
      directoryRoutingRules={directoryRoutingRules}
      currentLocationId={player.currentLocationId}
      emptyLabel={showNoSourceDirectory ? "No source linked." : selectedRemoteSource ? "No remote files detected." : "No local files detected."}
      toolbar={message ? <DirectoryMessage message={message} /> : undefined}
      selectionModal={isSaveSelectionOpen && selectedRemoteDetail ? (
        <RemoteSaveSelectionPanel
          root={tree}
          selectedPaths={selectedSavePaths}
          selectedLocalPaths={selectedLocalSavePaths}
          plan={savePlan}
          decisions={saveDecisions}
          planDirty={savePlanDirty}
          message={savePlanMessage}
          sourceId={selectedRemoteSource?.source.id}
          activeEditionCode={remoteDetailActionCode(selectedRemoteDetail)}
          onEditionChange={selectPreparedWorkEdition}
          targetRoot={selectedTargetRoot}
          onTargetRootChange={(targetRoot) => {
            setSelectedTargetRoot(targetRoot);
            setSavePlan(null);
            setSavePlanMessage("");
          }}
          onChange={(paths) => {
            setSelectedSavePaths(paths);
            setSavePlan(null);
            setSavePlanMessage("");
          }}
          onLocalChange={(paths) => {
            setSelectedLocalSavePaths(paths);
            setSavePlan(null);
            setSavePlanMessage("");
          }}
          onDecisionChange={(decision) => {
            setSaveDecisions((current) => ({ ...current, [decision.itemKey]: decision }));
            setSavePlanDirty(true);
          }}
          disabled={isSaving}
          onClose={() => setIsSaveSelectionOpen(false)}
          onSave={() => void planRemoteSave()}
        />
      ) : null}
      emptyState={!work ? <DirectorySkeleton /> : selectedSource?.kind === "local" && selectedSource.status !== "green" ? (
        <LocalSourceStatePanel
          status={selectedSource.status}
          remoteSources={remoteSources}
          onSelectRemote={(remote) => changeSourceKey(remoteSourceTabKey(remote.source.id))}
        />
      ) : selectedRemoteSource && !remoteSourceCanBrowse(selectedRemoteSource.summary) ? (
        <RemoteSourceStatePanel remote={selectedRemoteSource} />
      ) : selectedTrackedPresence && !selectedTrackedForked ? (
        <TrackedUnforkedPanel
          presence={selectedTrackedPresence}
          remoteSources={remoteSources}
          busy={isSyncingDetail}
          onFork={(remote) => requestForkSource(remote)}
        />
      ) : showNoSourceDirectory ? (
        <NoSourceDirectoryPanel
          checking={isCheckingSources}
          checkedAt={sourceCheckedAt}
          remoteSources={remoteSources}
          onRefresh={() => void refreshSourceAvailability()}
        />
      ) : undefined}
      loadingMessage={!work ? "Loading work details..." : isDirectoryLoading ? "Loading directory..." : selectedRemoteSource && !selectedRemoteDetail ? (selectedRemoteSource.loading ? "Loading remote directory..." : selectedRemoteSource.error || "Remote directory is not loaded yet.") : ""}
      onPlayFolder={selectedRemoteDetail ? playRemoteTracks : playTracks}
      onPlayNext={(track) => queueTrack(track, true)}
      onAppendQueue={(track) => queueTrack(track, false)}
      onPreview={setPreview}
    />
  );

  return (
    <div className="space-y-5">
      <Button variant="outline" size="sm" onClick={onBack}>
        <ChevronLeft className="h-4 w-4" />
        {detailReturnTarget("library").label}
      </Button>

      {isCompactDetailLayout ? (
        <MobileWorkDetailLayout
          coverUrl={hero.coverUrl}
          fallbackCode={hero.primaryCode}
          code={hero.primaryCode}
          title={hero.title}
          circle={hero.circle}
          circleExternalId={hero.circleExternalId}
          series={hero.series}
          seriesTitleId={work?.seriesTitleId ?? ""}
          seriesCircleExternalId={work?.seriesCircleExternalId ?? work?.circleExternalId ?? ""}
          ratingLabel="DL rating"
          rating={hero.rating}
          ratingCount={hero.ratingCount}
          sales={hero.sales}
          baseCode={work?.baseCode}
          metadataLanguage={work?.metadataLanguage}
          translations={work?.translations ?? []}
          activeVersionCode={activeEditionCode || hero.primaryCode}
          onVersionSelect={(translation) => void selectEdition(translation)}
          dlsiteFetchedAt={hero.dlsiteFetchedAt}
          releaseDate={hero.releaseDate ?? "Unknown"}
          ageRating={hero.ageRating}
          durationSeconds={displayDurationSeconds}
          voiceActors={hero.voiceActors}
          voiceCredits={work?.voiceCredits ?? []}
          tags={hero.tags}
          loading={isDetailLoading}
          activeTab={mobileDetailTab}
          onActiveTabChange={setMobileDetailTab}
          actions={detailActions}
          directory={directoryPanel}
        />
      ) : (
        <>
          <DetailHero
            coverUrl={hero.coverUrl}
            fallbackCode={hero.primaryCode}
            code={hero.primaryCode}
            title={hero.title}
            circle={hero.circle}
            circleExternalId={hero.circleExternalId}
            ratingLabel="DL rating"
            rating={hero.rating}
            ratingCount={hero.ratingCount}
            sales={hero.sales}
            series={hero.series}
            seriesTitleId={work?.seriesTitleId ?? ""}
            seriesCircleExternalId={work?.seriesCircleExternalId ?? work?.circleExternalId ?? ""}
            baseCode={work?.baseCode}
            metadataLanguage={work?.metadataLanguage}
            translations={work?.translations ?? []}
            activeVersionCode={activeEditionCode || hero.primaryCode}
            onVersionSelect={(translation) => void selectEdition(translation)}
            dlsiteFetchedAt={hero.dlsiteFetchedAt}
            releaseDate={hero.releaseDate ?? "Unknown"}
            ageRating={hero.ageRating}
            durationSeconds={displayDurationSeconds}
            voiceActors={hero.voiceActors}
            voiceCredits={work?.voiceCredits ?? []}
            tags={hero.tags}
            loading={isDetailLoading}
            actions={detailActions}
          />
          {directoryPanel}
        </>
      )}
      {preview && <FilePreviewModal
        preview={preview}
        onClose={() => setPreview(null)}
        onSetCover={work ? async (locationId) => {
          try {
            await api.setWorkCoverOverride(work.id, locationId);
            toast.success("Cover override saved.");
            setPreview(null);
            await metadataSaved();
          } catch (error) {
            toast.notify(toastFromError(error, "Cover override could not be saved."));
          }
        } : undefined}
      />}
      {isManageOpen && (
        <DirectoryManagerModal
          root={tree}
          emptyLabel={showNoSourceDirectory ? "No source linked." : selectedRemoteSource ? "No remote files detected." : "No local files detected."}
          onClose={() => setIsManageOpen(false)}
          deleting={isDeleting}
          onDeleteTargets={deleteMediaTargets}
          allowCacheDelete={!selectedRemoteSource}
          allowLocalDelete={!selectedRemoteSource && !selectedTrackedPresence}
          localRootPath={work?.sourcePresence?.find((presence) => presence.type === "local" && presence.availability === "available" && presence.fileSourceId === selectedSource?.fileSourceId)?.sourceUrl ?? ""}
          showCachedFilter={Boolean(selectedTrackedPresence)}
        />
      )}
      {isMetadataEditorOpen && work && (
        <WorkMetadataEditorModal
          work={work}
          onClose={() => setIsMetadataEditorOpen(false)}
          onSaved={() => void metadataSaved()}
        />
      )}
      {reforkTarget && (
        <ReforkConfirmModal
          currentName={reforkTarget.current?.source.displayName ?? "the current fork"}
          nextName={reforkTarget.next.source.displayName}
          busy={isSyncingDetail}
          onClose={() => setReforkTarget(null)}
          onConfirm={() => {
            const next = reforkTarget.next;
            setReforkTarget(null);
            void forkTrackedSource(next);
          }}
        />
      )}
    </div>
  );
}

function DetailHero({
  coverUrl,
  fallbackCode,
  code,
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
  translations,
  activeVersionCode,
  onVersionSelect,
  dlsiteFetchedAt,
  releaseDate,
  ageRating,
  durationSeconds,
  voiceActors,
  voiceCredits,
  tags,
  loading = false,
  actions,
}: {
  coverUrl: string;
  fallbackCode: string;
  code: string;
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
  translations?: WorkDetail["translations"];
  activeVersionCode?: string;
  onVersionSelect?: (translation: WorkDetail["translations"][number]) => void;
  dlsiteFetchedAt: string;
  releaseDate: string;
  ageRating: string;
  durationSeconds: number | null;
  voiceActors: string[];
  voiceCredits: VoiceCredit[];
  tags: string[];
  loading?: boolean;
  actions?: ReactNode;
}) {
  const entityResolver = useDetailEntityResolver(code);

  return (
    <section className="grid gap-5 xl:grid-cols-[minmax(420px,560px)_minmax(0,1fr)]">
      <div className="self-start overflow-hidden rounded-lg border bg-muted">
        <div className="aspect-[4/3]">
          {coverUrl ? (
            <img src={assetURL(coverUrl)} alt="" className="h-full w-full object-contain" />
          ) : (
            <div className="grid h-full place-items-center text-4xl font-bold">{fallbackCode.slice(0, 2)}</div>
          )}
        </div>
      </div>

      <div className="min-w-0 space-y-4">
        <DetailTitleBlock
          fallbackCode={fallbackCode}
          code={code}
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
          ratingLabel={ratingLabel}
          rating={rating}
          ratingCount={ratingCount}
          sales={sales}
          releaseDate={releaseDate}
          dlsiteFetchedAt={dlsiteFetchedAt}
          ageRating={ageRating}
          metadataLanguage={metadataLanguage}
          baseCode={baseCode}
          translations={translations}
          activeVersionCode={activeVersionCode}
          onVersionSelect={onVersionSelect}
          durationSeconds={durationSeconds}
          voiceActors={voiceActors}
          voiceCredits={voiceCredits}
          tags={tags}
          code={code}
          entityResolver={entityResolver}
        />

        {actions && <div className="flex flex-wrap gap-2 rounded-lg border bg-card p-3">{actions}</div>}
      </div>
    </section>
  );
}

function MobileWorkDetailLayout({
  coverUrl,
  fallbackCode,
  code,
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
  translations,
  activeVersionCode,
  onVersionSelect,
  dlsiteFetchedAt,
  releaseDate,
  ageRating,
  durationSeconds,
  voiceActors,
  voiceCredits,
  tags,
  loading,
  activeTab,
  onActiveTabChange,
  actions,
  directory,
}: {
  coverUrl: string;
  fallbackCode: string;
  code: string;
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
  translations?: WorkDetail["translations"];
  activeVersionCode?: string;
  onVersionSelect?: (translation: WorkDetail["translations"][number]) => void;
  dlsiteFetchedAt: string;
  releaseDate: string;
  ageRating: string;
  durationSeconds: number | null;
  voiceActors: string[];
  voiceCredits: VoiceCredit[];
  tags: string[];
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
        title={title}
        circle={circle}
        circleExternalId={circleExternalId}
        series={series}
        seriesTitleId={seriesTitleId}
        seriesCircleExternalId={seriesCircleExternalId}
        loading={loading}
        entityResolver={entityResolver}
      />

      <div className="flex flex-wrap gap-2 rounded-lg border bg-card p-3">{actions}</div>

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
            baseCode={baseCode}
            translations={translations}
            activeVersionCode={activeVersionCode}
            onVersionSelect={onVersionSelect}
            durationSeconds={durationSeconds}
            voiceActors={voiceActors}
            voiceCredits={voiceCredits}
            tags={tags}
            code={code}
            entityResolver={entityResolver}
          />
        </div>
      ) : (
        directory
      )}
    </section>
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
  title: string;
  circle: string;
  circleExternalId: string;
  series: string;
  seriesTitleId: string;
  seriesCircleExternalId: string;
  loading?: boolean;
  entityResolver: DetailEntityResolver;
}) {
  const codeLabel = code || fallbackCode || "Remote";
  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <Badge variant="secondary" className="w-fit">{codeLabel}</Badge>
        <h2 className="min-w-0 text-2xl font-semibold leading-tight lg:text-3xl">{title}</h2>
        {loading && <div className="h-2 w-40 animate-pulse rounded bg-muted" />}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        {circle ? (
          <button className="inline-flex max-w-full items-center gap-1 truncate hover:text-primary" onClick={() => circleExternalId ? openCircleRoute(circleExternalId) : entityResolver.resolveEntity("circle", circle)}>
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
            <button className="truncate hover:text-primary" onClick={() => seriesTitleId && seriesCircleExternalId ? openCircleSeriesRoute(seriesCircleExternalId, seriesTitleId) : entityResolver.resolveEntity("series", series)}>{series}</button>
          </span>
        )}
      </div>
    </div>
  );
}

function DetailMetadataContent({
  ratingLabel,
  rating,
  ratingCount,
  sales,
  releaseDate,
  dlsiteFetchedAt,
  ageRating,
  metadataLanguage,
  baseCode,
  translations = [],
  activeVersionCode,
  onVersionSelect,
  durationSeconds,
  voiceActors,
  voiceCredits,
  tags,
  code,
  entityResolver,
}: {
  ratingLabel: string;
  rating: number | null;
  ratingCount: number | null;
  sales: number | null;
  releaseDate: string;
  dlsiteFetchedAt: string;
  ageRating: string;
  metadataLanguage?: string;
  baseCode?: string;
  translations?: WorkDetail["translations"];
  activeVersionCode?: string;
  onVersionSelect?: (translation: WorkDetail["translations"][number]) => void;
  durationSeconds: number | null;
  voiceActors: string[];
  voiceCredits: VoiceCredit[];
  tags: string[];
  code: string;
  entityResolver: DetailEntityResolver;
}) {
  const displayVoiceCredits = voiceCredits.length > 0
    ? voiceCredits
    : voiceActors.map((name) => ({ personId: 0, displayName: name }));
  const baseTranslation = translations.find((translation) => translation.primaryCode.toUpperCase() === (baseCode ?? "").toUpperCase());
  return (
    <>
      <DlsiteMetrics
        ratingLabel={ratingLabel}
        rating={rating}
        ratingCount={ratingCount}
        sales={sales}
        releaseDate={releaseDate}
        dlsiteFetchedAt={dlsiteFetchedAt}
        ageRating={ageRating}
      />

      {(metadataLanguage || baseCode || translations.length > 0) && (
        <WorkVersionSelector
          metadataLanguage={metadataLanguage ?? ""}
          baseCode={baseCode ?? ""}
          baseAvailable={Boolean(baseTranslation?.workId)}
          translations={translations}
          activeVersionCode={activeVersionCode ?? code}
          onVersionSelect={onVersionSelect}
        />
      )}

      <div className="space-y-3 rounded-lg border bg-card p-3">
        <DetailChipRow
          icon={<UserRound className="h-4 w-4" />}
          label="Voice"
          emptyLabel="No voice actor metadata"
          items={displayVoiceCredits.map((credit) => ({
            key: `${credit.personId}:${credit.displayName}`,
            label: credit.displayName,
            onClick: credit.personId > 0 ? () => openVoiceRoute(credit.personId) : () => entityResolver.resolveEntity("voice", credit.displayName),
          }))}
        />
        <DetailChipRow
          icon={<Tags className="h-4 w-4" />}
          label="Tags"
          emptyLabel="No tag metadata"
          items={tags.map((tag) => ({ key: tag, label: tag, onClick: () => openDetailTagSearch(tag) }))}
        />
        <InfoRow icon={<Clock3 className="h-4 w-4" />} label="Duration" value={formatDuration(durationSeconds)} />
      </div>
    </>
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
    <div className="space-y-2">
      <div className="h-10 animate-pulse rounded-md bg-muted" />
      <div className="h-10 animate-pulse rounded-md bg-muted" />
      <div className="h-10 animate-pulse rounded-md bg-muted" />
    </div>
  );
}

function detailHeroModel(code: string, work: WorkDetail | null, preview: WorkPreview | null) {
  return {
    primaryCode: work?.primaryCode ?? preview?.primaryCode ?? code,
    title: work?.title ?? preview?.title ?? code,
    coverUrl: work?.coverUrl ?? preview?.coverUrl ?? "",
    circle: work?.circle ?? preview?.circle ?? "",
    circleExternalId: work?.circleExternalId ?? preview?.circleExternalId ?? "",
    rating: work?.rating ?? preview?.rating ?? null,
    ratingCount: work?.ratingCount ?? null,
    sales: work?.sales ?? preview?.sales ?? null,
    series: work?.series ?? "",
    dlsiteFetchedAt: work?.dlsiteFetchedAt ?? "",
    releaseDate: work?.releaseDate ?? preview?.releaseDate ?? null,
    ageRating: work?.ageRating ?? "",
    durationSeconds: work?.durationSeconds ?? null,
    voiceActors: work?.voiceActors ?? preview?.voiceActors ?? [],
    tags: work?.tags ?? preview?.tags ?? [],
  };
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
  busy,
  onFork,
}: {
  presence: NonNullable<WorkDetail["sourcePresence"]>[number];
  remoteSources: RemoteSourceAvailability[];
  busy: boolean;
  onFork: (remote: RemoteSourceAvailability) => void;
}) {
  const sourceName = presence.fileSourceName || presence.fileSourceCode || "Tracked source";
  const candidates = remoteSources.filter((remote) => remoteSourceCanBrowse(remote.summary));
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
      <div className="font-medium">{sourceName} is unforked</div>
      <p className="mt-1 text-amber-900">
        This work is tracked, but no tracked directory tree has been forked yet.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {candidates.length > 0 ? candidates.map((remote) => (
          <Button key={remote.source.id} variant="outline" size="sm" disabled={busy} onClick={() => onFork(remote)}>
            Fork from {remote.source.displayName}
          </Button>
        )) : (
          <Badge variant="warning">No browsable remote source</Badge>
        )}
      </div>
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
    <div className={`rounded-md border p-4 text-sm ${status === "red" ? "border-red-300 bg-red-50 text-red-950" : "border-amber-300 bg-amber-50 text-amber-950"}`}>
      <div className="font-medium">Local files unavailable</div>
      <div className="mt-3 flex flex-wrap gap-2">
        {availableSources.length > 0 ? availableSources.map((remote) => (
          <Button key={remote.source.id} variant="outline" size="sm" onClick={() => onSelectRemote(remote)}>
            Fetch from {remote.source.displayName}
          </Button>
        )) : (
          <Badge variant={status === "red" ? "outline" : "warning"} className={status === "red" ? "border-red-300 text-red-800" : ""}>{status === "red" ? "No remote source available" : "Check remote sources"}</Badge>
        )}
      </div>
    </div>
  );
}

function RemoteSourceStatePanel({ remote }: { remote: RemoteSourceAvailability }) {
  const status = remoteSourceTabStatus(remote.summary);
  return (
    <div className={`rounded-md border p-4 text-sm ${status.status === "red" ? "border-red-300 bg-red-50 text-red-950" : "border-amber-300 bg-amber-50 text-amber-950"}`}>
      <div className="font-medium">{remote.source.displayName} · {status.statusLabel}</div>
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
    <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
      <div className="font-medium">No source linked</div>
      <p className="mt-1 text-amber-900">
        This work exists in the local database, but Kikoto has no local files, cache, tracked source, or known source presence for it yet.
      </p>
      {availableSources.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {availableSources.map((remote) => (
            <Badge key={remote.source.id} variant="outline">{remote.source.displayName} available</Badge>
          ))}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={checking}>
          <RefreshCw className={`h-4 w-4 ${checking ? "animate-spin" : ""}`} />
          Refresh sources
        </Button>
        {!checking && checkedAt && <span className="text-xs text-amber-900">Checked {formatDateTime(checkedAt)}</span>}
      </div>
    </div>
  );
}

type DirectoryMode = "browse" | "tree";

function SourceDirectoryPanel({
  title,
  description,
  statsLabel,
  tabs,
  activeKey,
  onActiveKeyChange,
  checkingSources = false,
  checkedAt,
  onCheckSources,
  directoryMode,
  onDirectoryModeChange,
  root,
  directoryRoutingRules,
  currentLocationId,
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
  checkingSources?: boolean;
  checkedAt?: string;
  onCheckSources?: () => void;
  directoryMode: DirectoryMode;
  onDirectoryModeChange: (mode: DirectoryMode) => void;
  root: TreeNode;
  directoryRoutingRules: DirectoryRoutingRule[];
  currentLocationId: number | null;
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
  const content = emptyState ? emptyState : directoryMode === "browse" ? (
    <DirectoryBrowser
      root={root}
      directoryRoutingRules={directoryRoutingRules}
      currentLocationId={currentLocationId}
      emptyLabel={emptyLabel}
      onPlayFolder={onPlayFolder}
      onPlayNext={onPlayNext}
      onAppendQueue={onAppendQueue}
      onPreview={onPreview}
    />
  ) : (
    <DirectoryTree
      root={root}
      directoryRoutingRules={directoryRoutingRules}
      currentLocationId={currentLocationId}
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
            <h3 className="text-lg font-semibold">{title}</h3>
            {statsLabel && <p className="mt-1 text-xs text-muted-foreground">{statsLabel}</p>}
          </div>
          <p className="text-sm text-muted-foreground lg:text-right">{description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DirectoryModeSwitch mode={directoryMode} onChange={onDirectoryModeChange} />
          <div className="flex min-w-0 flex-1 items-center overflow-hidden rounded-md border bg-card p-1">
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
              {tabs.map((source) => (
                <button
                  key={source.key}
                  className={`inline-flex h-7 shrink-0 items-center gap-2 rounded px-2.5 text-xs font-medium ${
                    source.key === activeKey ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
                  }`}
                  onClick={() => onActiveKeyChange(source.key)}
                  title={`${source.label}: ${source.statusLabel}`}
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${sourceTabStatusClass(source.status)}`} aria-hidden="true" />
                  <span>{source.label}</span>
                  <span className="sr-only">{source.statusLabel}</span>
                </button>
              ))}
            </div>
            {onCheckSources && (
              <IconButton
                title={checkingSources ? "Checking sources" : checkedAt ? `Check sources · Last checked ${formatDateTime(checkedAt)}` : "Check sources"}
                onClick={onCheckSources}
                disabled={checkingSources}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${checkingSources ? "animate-spin" : ""}`} />
              </IconButton>
            )}
          </div>
        </div>
        {routeSummary && <DirectoryRouteSummary summary={routeSummary} />}
      </div>
      <Card>
        <CardContent className="p-4">
          {toolbar}
          {loadingMessage && <div className="mb-4 rounded-md border bg-background p-3 text-sm text-muted-foreground">{loadingMessage}</div>}
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

function DirectoryRouteSummary({ summary }: { summary: DirectoryRouteMatch }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-card px-3 py-2 text-xs">
      <span className="font-medium text-muted-foreground">Default folder</span>
      <Badge variant="secondary" className="max-w-full truncate">{summary.pathLabel}</Badge>
      {summary.positiveMatches.length > 0 ? (
        <span className="min-w-0 text-muted-foreground">
          matched {summary.positiveMatches.join(" + ")}
        </span>
      ) : (
        <span className="text-muted-foreground">fallback: most playable audio</span>
      )}
      {summary.negativeMatches.length > 0 && (
        <span className="text-muted-foreground">excluded {summary.negativeMatches.join(" + ")}</span>
      )}
    </div>
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

function DetailActionBar({
  canPlay,
  busy,
  mode,
  listeningStatus,
  favorite,
  listWorkId,
  onEnsureListWork,
  onListSaved,
  onPlay,
  onResume,
  onMark,
  onSync,
  onTrack,
  trackDisabled,
  forkSources = [],
  currentForkSource,
  onFork,
  onFetch,
  onEditMetadata,
  onManage,
  onRefreshLocalFiles,
  dlsiteUrl,
  syncLabel,
  showSync,
  showFetch,
}: {
  canPlay: boolean;
  busy: boolean;
  mode: DetailActionMode;
  listeningStatus: ListeningStatus;
  favorite: boolean;
  listWorkId: number | null;
  onEnsureListWork?: () => Promise<number | null>;
  onListSaved?: (favorite: boolean, workID: number) => void;
  onPlay: () => void;
  onResume?: () => void;
  onMark: (status: ListeningStatus) => void;
  onSync?: () => void;
  onTrack?: () => void;
  trackDisabled?: boolean;
  forkSources?: RemoteSourceAvailability[];
  currentForkSource?: RemoteSourceAvailability | null;
  onFork?: (remote: RemoteSourceAvailability) => void;
  onFetch?: () => void;
  onEditMetadata?: () => void;
  onManage?: () => void;
  onRefreshLocalFiles?: () => void;
  dlsiteUrl: string;
  syncLabel: string;
  showSync?: boolean;
  showFetch?: boolean;
}) {
  const [forkMenuOpen, setForkMenuOpen] = useState(false);
  const [manageMenuOpen, setManageMenuOpen] = useState(false);
  const forkMenuRef = useRef<HTMLDivElement | null>(null);
  const manageMenuRef = useRef<HTMLDivElement | null>(null);

  return (
    <>
      {mode !== "tracked_unforked" && (
        <>
          <Button size="sm" className="h-8" disabled={!canPlay || busy} onClick={onPlay}>
            <Play className="h-4 w-4" />
            Play
          </Button>
          {onResume && (
            <Button variant="outline" size="sm" className="h-8" disabled={busy} onClick={onResume}>
              <Clock3 className="h-4 w-4" />
              Resume
            </Button>
          )}
          <WorkCardQuickMarkButton value={listeningStatus} disabled={busy} showLabel onChange={onMark} />
          <WorkCardListButton
            workId={listWorkId}
            active={favorite}
            disabled={busy}
            showLabel
            ensureWorkId={onEnsureListWork}
            onSaved={onListSaved}
          />
        </>
      )}
      {mode === "local" && showSync && onSync && (
        <Button variant="outline" size="sm" className="h-8" disabled={busy} onClick={onSync}>
          <RefreshCw className="h-4 w-4" />
          {syncLabel}
        </Button>
      )}
      {mode === "remote_source" && onTrack && (
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          disabled={busy || trackDisabled}
          onClick={onTrack}
          title={trackDisabled ? "Already tracked" : "Track remote work"}
        >
          <GitBranchPlus className="h-4 w-4" />
          Track
        </Button>
      )}
      {(mode === "tracked_forked" || mode === "remote_source") && onFork && (
        <div className="relative" ref={forkMenuRef}>
          <Button
            variant="outline"
            size="sm"
            className="relative h-8 pr-7"
            disabled={busy || forkSources.length === 0}
            onClick={() => setForkMenuOpen((open) => !open)}
            title={mode === "tracked_forked" ? "Switch fork source" : "Fork remote source"}
          >
            <GitBranchPlus className="h-4 w-4" />
            {mode === "tracked_forked" ? "Switch fork" : "Fork"}
            {forkSources.length > 0 && <ChevronDown className="absolute right-2 h-3 w-3" />}
          </Button>
		  <AnchoredPopover open={forkMenuOpen} anchorRef={forkMenuRef} onOpenChange={setForkMenuOpen} className="w-60 p-1 text-sm">
              {forkSources.map((remote) => {
                const active = currentForkSource?.source.id === remote.source.id;
                return (
                  <button
                    key={remote.source.id}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted"
                    onClick={() => {
                      setForkMenuOpen(false);
                      onFork(remote);
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{remote.source.displayName}</span>
                    {active && <Check className="h-3.5 w-3.5 text-primary" />}
                  </button>
                );
              })}
		  </AnchoredPopover>
        </div>
      )}
      {showFetch && onFetch && (
        <Button variant="outline" size="sm" className="h-8" disabled={busy} onClick={onFetch}>
          <HardDriveDownload className="h-4 w-4" />
          Fetch
        </Button>
      )}
      {(onManage || onEditMetadata || onRefreshLocalFiles) && (
        <div className="relative" ref={manageMenuRef}>
          <Button variant="outline" size="sm" className="relative h-8 pr-7" disabled={busy} onClick={() => setManageMenuOpen((open) => !open)}>
            <MoreHorizontal className="h-4 w-4" />
            Manage
            <ChevronDown className="absolute right-2 h-3 w-3" />
          </Button>
		  <AnchoredPopover open={manageMenuOpen} anchorRef={manageMenuRef} onOpenChange={setManageMenuOpen} className="w-48 p-1 text-sm">
              {onEditMetadata && (
                <button
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted"
                  onClick={() => {
                    setManageMenuOpen(false);
                    onEditMetadata();
                  }}
                >
                  <Edit3 className="h-3.5 w-3.5" />
                  <span>Edit metadata</span>
                </button>
              )}
              {onManage && (
                <button
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted"
                  onClick={() => {
                    setManageMenuOpen(false);
                    onManage();
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>Manage files</span>
                </button>
              )}
              {onRefreshLocalFiles && (
                <button
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted"
                  onClick={() => {
                    setManageMenuOpen(false);
                    onRefreshLocalFiles();
                  }}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span>Refresh local files</span>
                </button>
              )}
		  </AnchoredPopover>
        </div>
      )}
      {dlsiteUrl && (
        <Button variant="outline" size="sm" className="h-8" asChild>
          <a href={dlsiteUrl} target="_blank" rel="noreferrer">
            <ExternalLink className="h-4 w-4" />
            DLsite
          </a>
        </Button>
      )}
    </>
  );
}

function WorkMetadataEditorModal({ work, onClose, onSaved }: { work: WorkDetail; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const manual = work.manualOverrides ?? {};
  const [title, setTitle] = useState(manual.title ?? work.title);
  const [circleName, setCircleName] = useState(manual.circle?.name ?? work.circle);
  const [circleExternalId, setCircleExternalId] = useState(manual.circle?.externalId ?? work.circleExternalId);
  const [seriesName, setSeriesName] = useState(manual.series?.name ?? work.series);
  const [seriesTitleId, setSeriesTitleId] = useState(manual.series?.titleId ?? work.seriesTitleId ?? "");
  const [seriesCircleExternalId, setSeriesCircleExternalId] = useState(manual.series?.circleExternalId ?? work.seriesCircleExternalId ?? work.circleExternalId ?? "");
  const [voiceActors, setVoiceActors] = useState<ManualOverridePerson[]>(() => initialManualVoiceActors(work));
  const [coverCandidates, setCoverCandidates] = useState<WorkCoverCandidate[]>([]);
  const [selectedCoverId, setSelectedCoverId] = useState<number | null>(null);
  const [circleSuggestions, setCircleSuggestions] = useState<{ items: CircleSuggestion[]; truncated: boolean }>({ items: [], truncated: false });
  const [seriesSuggestions, setSeriesSuggestions] = useState<{ items: SeriesSuggestion[]; truncated: boolean }>({ items: [], truncated: false });
  const [voiceSuggestions, setVoiceSuggestions] = useState<{ index: number; items: VoiceSuggestion[]; truncated: boolean }>({ index: -1, items: [], truncated: false });
  const [focusedVoiceIndex, setFocusedVoiceIndex] = useState(-1);
  const [loadingCovers, setLoadingCovers] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadingCovers(true);
    api.listWorkCoverCandidates(work.id)
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
  }, [toast, work.id]);

  useEffect(() => {
    const query = circleName.trim();
    if ([...query].length < 2) {
      setCircleSuggestions({ items: [], truncated: false });
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api.suggestCircles(query).then((result) => {
        if (!cancelled) setCircleSuggestions(result);
      }).catch(() => {
        if (!cancelled) setCircleSuggestions({ items: [], truncated: false });
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [circleName]);

  useEffect(() => {
    const query = seriesName.trim();
    if ([...query].length < 2) {
      setSeriesSuggestions({ items: [], truncated: false });
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api.suggestSeries(query, seriesCircleExternalId).then((result) => {
        if (!cancelled) setSeriesSuggestions(result);
      }).catch(() => {
        if (!cancelled) setSeriesSuggestions({ items: [], truncated: false });
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [seriesName, seriesCircleExternalId]);

  useEffect(() => {
    const actor = focusedVoiceIndex >= 0 ? voiceActors[focusedVoiceIndex] : null;
    const query = actor?.name.trim() ?? "";
    if ([...query].length < 2) {
      setVoiceSuggestions({ index: focusedVoiceIndex, items: [], truncated: false });
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api.suggestVoices(query).then((result) => {
        if (!cancelled) setVoiceSuggestions({ index: focusedVoiceIndex, ...result });
      }).catch(() => {
        if (!cancelled) setVoiceSuggestions({ index: focusedVoiceIndex, items: [], truncated: false });
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [focusedVoiceIndex, voiceActors]);

  const save = async () => {
    setSaving(true);
    try {
      await api.updateWorkManualOverrides(work.id, {
        title: nullableTrimmed(title),
        circle: nullableEntity(circleName, circleExternalId),
        series: nullableSeries(seriesName, seriesTitleId, seriesCircleExternalId),
        voiceActors: voiceActors.map((actor) => ({ name: actor.name.trim(), personId: Number(actor.personId) || 0 })).filter((actor) => actor.name),
      });
      if (selectedCoverId !== null) {
        await api.setWorkCoverOverride(work.id, selectedCoverId);
      }
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

  const addVoiceActor = () => setVoiceActors((items) => [...items, { name: "", personId: 0 }]);
  const updateVoiceActor = (index: number, patch: Partial<ManualOverridePerson>) => {
    setVoiceActors((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
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
              <Button variant="outline" size="sm" disabled={saving || !manual.title} onClick={() => void resetField("title")}>Reset title</Button>
            </div>
          </EditorSection>

          <EditorSection title="Cover">
            {manual.cover?.url && (
              <div className="flex items-center gap-3 rounded-md border bg-background p-2">
                <img src={assetURL(manual.cover.url)} alt="" className="h-16 w-16 rounded object-contain" />
                <div className="min-w-0 text-xs text-muted-foreground">
                  <div className="truncate text-foreground">{manual.cover.assetPath}</div>
                  {manual.cover.originalPath && <div className="truncate">{manual.cover.originalPath}</div>}
                </div>
              </div>
            )}
            {loadingCovers ? (
              <div className="rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">Loading cover candidates...</div>
            ) : coverCandidates.length === 0 ? (
              <div className="rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">No indexed local images found for this work.</div>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {coverCandidates.map((candidate) => (
                  <button
                    key={candidate.locationId}
                    className={`flex items-center gap-3 rounded-md border bg-background p-2 text-left hover:border-primary ${selectedCoverId === candidate.locationId ? "border-primary ring-1 ring-primary" : ""}`}
                    onClick={() => setSelectedCoverId(candidate.locationId)}
                  >
                    <img src={assetURL(candidate.previewUrl)} alt="" className="h-16 w-16 shrink-0 rounded object-contain" loading="lazy" />
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
              <Button variant="outline" size="sm" disabled={saving || !manual.cover} onClick={() => void resetField("cover")}>Reset cover</Button>
            </div>
          </EditorSection>

          <EditorSection title="Circle">
            <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
              <LabeledInput label="Name" value={circleName} onChange={setCircleName} />
              <LabeledInput label="External ID" value={circleExternalId} onChange={setCircleExternalId} />
            </div>
            <SuggestionList
              truncated={circleSuggestions.truncated}
              emptyLabel="Type at least two characters to search circles."
              items={circleSuggestions.items.map((item) => ({
                key: String(item.partyId),
                label: item.name,
                detail: item.externalId,
                onSelect: () => {
                  setCircleName(item.name);
                  setCircleExternalId(item.externalId);
                  setSeriesCircleExternalId(item.externalId);
                  setCircleSuggestions({ items: [], truncated: false });
                },
              }))}
            />
            <div className="flex justify-end">
              <Button variant="outline" size="sm" disabled={saving || !manual.circle} onClick={() => void resetField("circle")}>Reset circle</Button>
            </div>
          </EditorSection>

          <EditorSection title="Series">
            <div className="grid gap-3 sm:grid-cols-[1fr_160px_180px]">
              <LabeledInput label="Name" value={seriesName} onChange={setSeriesName} />
              <LabeledInput label="Title ID" value={seriesTitleId} onChange={setSeriesTitleId} />
              <LabeledInput label="Circle ID" value={seriesCircleExternalId} onChange={setSeriesCircleExternalId} />
            </div>
            <SuggestionList
              truncated={seriesSuggestions.truncated}
              emptyLabel="Type at least two characters to search series."
              items={seriesSuggestions.items.map((item) => ({
                key: String(item.seriesId),
                label: item.name,
                detail: [item.titleId, item.circleName, item.circleExternalId].filter(Boolean).join(" · "),
                onSelect: () => {
                  setSeriesName(item.name);
                  setSeriesTitleId(item.titleId);
                  setSeriesCircleExternalId(item.circleExternalId);
                  setSeriesSuggestions({ items: [], truncated: false });
                },
              }))}
            />
            <div className="flex justify-end">
              <Button variant="outline" size="sm" disabled={saving || !manual.series} onClick={() => void resetField("series")}>Reset series</Button>
            </div>
          </EditorSection>

          <EditorSection title="Voice actors">
            <div className="space-y-2">
              {voiceActors.map((actor, index) => (
                <div key={`${index}:${actor.personId}`} className="grid gap-2 sm:grid-cols-[1fr_120px_auto]">
                  <LabeledInput label="Name" value={actor.name} onFocus={() => setFocusedVoiceIndex(index)} onChange={(value) => updateVoiceActor(index, { name: value, personId: 0 })} />
                  <LabeledInput label="Person ID" value={actor.personId ? String(actor.personId) : ""} onChange={(value) => updateVoiceActor(index, { personId: Number(value) || 0 })} />
                  <Button variant="outline" size="icon" className="mt-5 h-9 w-9" onClick={() => removeVoiceActor(index)} aria-label="Remove voice actor">
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              {focusedVoiceIndex >= 0 && voiceSuggestions.index === focusedVoiceIndex && (
                <SuggestionList
                  truncated={voiceSuggestions.truncated}
                  emptyLabel="Type at least two characters to search voices."
                  items={voiceSuggestions.items.map((item) => ({
                    key: String(item.personId),
                    label: item.name,
                    detail: `Person #${item.personId}`,
                    onSelect: () => {
                      updateVoiceActor(focusedVoiceIndex, { name: item.name, personId: item.personId });
                      setVoiceSuggestions({ index: focusedVoiceIndex, items: [], truncated: false });
                    },
                  }))}
                />
              )}
            </div>
            <div className="flex flex-wrap justify-between gap-2">
              <Button variant="outline" size="sm" onClick={addVoiceActor}>
                <Plus className="h-4 w-4" />
                Add voice
              </Button>
              <Button variant="outline" size="sm" disabled={saving || !manual.voiceActors?.length} onClick={() => void resetField("voice_actors")}>Reset voices</Button>
            </div>
          </EditorSection>
        </div>
        <div className="flex justify-end gap-2 border-t px-4 py-3">
          <Button variant="outline" size="sm" disabled={saving} onClick={onClose}>Cancel</Button>
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
        <button key={item.key} className="flex min-h-8 w-full items-center justify-between gap-3 rounded px-2 text-left text-xs hover:bg-muted" onClick={item.onSelect}>
          <span className="min-w-0 flex-1 truncate font-medium">{item.label}</span>
          {item.detail && <span className="shrink-0 truncate text-muted-foreground">{item.detail}</span>}
        </button>
      ))}
      {truncated && <div className="px-2 py-1 text-xs text-muted-foreground">Too many matches. Keep typing to narrow results.</div>}
    </div>
  );
}

function LabeledInput({ label, value, onChange, onFocus }: { label: string; value: string; onChange: (value: string) => void; onFocus?: () => void }) {
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
  return nextName || nextTitleId || nextCircleExternalId ? { name: nextName, titleId: nextTitleId, circleExternalId: nextCircleExternalId } : null;
}

function DirectoryMessage({ message }: { message: string }) {
  return <div className="mb-4 rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">{message}</div>;
}

function WorkVersionSelector({
  metadataLanguage,
  baseCode,
  baseAvailable,
  translations,
  activeVersionCode,
  onVersionSelect,
}: {
  metadataLanguage: string;
  baseCode: string;
  baseAvailable: boolean;
  translations: WorkDetail["translations"];
  activeVersionCode: string;
  onVersionSelect?: (translation: WorkDetail["translations"][number]) => void;
}) {
  return (
    <div className="space-y-2 rounded-lg border bg-card px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
        <Languages className="h-3.5 w-3.5" />
        <span className="font-medium text-foreground">Versions</span>
		<span>Metadata <span className="font-semibold text-foreground">Origin</span></span>
        {baseCode && (
          baseAvailable ? (
            <button className="font-semibold text-primary hover:underline" onClick={() => openWorkCodeRoute(baseCode)}>
              Base {baseCode}
            </button>
          ) : (
            <span className="font-semibold text-foreground">Base {baseCode}</span>
          )
        )}
      </div>
      {translations.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {translations.map((translation) => {
            const available = Boolean(translation.workId && translation.hasMedia);
            const active = translation.primaryCode.toUpperCase() === activeVersionCode.toUpperCase();
			const language = translation.metadataLanguage ? languageLabel(translation.metadataLanguage) : "Unknown";
			const label = translation.origin ? "Origin" : language;
            return (
              <button
                key={translation.primaryCode}
                className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 ${
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : available
                      ? "border-primary/30 text-primary hover:bg-primary/10"
                      : "border-muted bg-muted text-muted-foreground"
                }`}
                disabled={active || !available}
                onClick={() => {
                  if (!translation.workId || active) return;
                  if (onVersionSelect) {
                    onVersionSelect(translation);
                  } else {
                    openWorkCodeRoute(translation.primaryCode);
                  }
                }}
              >
                <span className="font-semibold">{translation.primaryCode}</span>
                <span>{label}</span>
				{translation.official && <span>Official</span>}
                {!available && <span>not local</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
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
  const rateValue = rating === null
    ? "No rating"
    : `${rating.toFixed(2)}${ratingCount ? ` (${ratingCount.toLocaleString()})` : ""}`;
  const age = ageRatingView(ageRating);
  const dateValue = dlsiteFetchedAt ? `${releaseDate} / ${dlsiteFetchedAt}` : releaseDate;
  return (
    <div className="max-w-3xl rounded-lg border bg-card p-3 text-sm">
      <div className="grid gap-x-5 gap-y-2 sm:grid-cols-[minmax(11rem,0.8fr)_minmax(18rem,1.2fr)]">
        <MetricLine icon={<Star className="h-3.5 w-3.5 fill-current" />} label={normalizedRatingLabel} value={rateValue} />
        <MetricLine icon={<CircleUserRound className="h-3.5 w-3.5" />} label="Age" value={age.label} valueClassName={age.className} />
        <MetricLine icon={<HardDriveDownload className="h-3.5 w-3.5" />} label="Sales" value={sales === null ? "Unknown" : sales.toLocaleString()} />
        <MetricLine icon={<Clock3 className="h-3.5 w-3.5" />} label={dlsiteFetchedAt ? "Released / Updated" : "Released"} value={dateValue} />
      </div>
    </div>
  );
}

function MetricLine({ icon, label, value, valueClassName = "" }: { icon: ReactNode; label: string; value: string; valueClassName?: string }) {
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
            {items.map((item) => item.onClick ? (
              <button key={item.key} className="rounded-md border bg-background px-2 py-1 text-xs text-muted-foreground hover:border-primary hover:text-primary" onClick={item.onClick}>
                {item.label}
              </button>
            ) : (
              <span key={item.key} className="rounded-md border bg-background px-2 py-1 text-xs text-muted-foreground">
                {item.label}
              </span>
            ))}
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

type TreeNode = {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  files: TreeTrack[];
};

type TreeTrack = {
  mediaItemId: number;
  locationId: number;
  title: string;
  baseName: string;
  sourcePath: string;
  kind: string;
  folderPath: string;
  locationType: string;
  streamUrl: string;
  downloadUrl: string;
  assetUrl: string;
  sizeBytes: number | null;
  durationSeconds: number | null;
  availability: string;
  cacheLocationId: number | null;
  cachePath: string;
  cacheAvailable: boolean;
  cacheStreamUrl: string;
  localLocationId: number | null;
  localPath: string;
  localAvailable: boolean;
  progress: MediaItem["progress"];
  locations: PlayerTrackLocation[];
};

type FilePreviewState =
  | { kind: "image"; title: string; url: string; locationId: number; canSetCover: boolean }
  | { kind: "text"; title: string; locationId: number };

type MediaDeleteTarget = { kind: "cache" | "local" | "local_root"; locationId: number; title: string; path: string; sizeBytes: number | null };

type DetailSourceIntent = "local" | "tracked";

type SourceTabInfo = {
  key: string;
  label: string;
  fileSourceId: number | null;
  kind?: "local" | "remote" | "tracked" | "no_source";
  presence?: NonNullable<WorkDetail["sourcePresence"]>[number];
  status: "green" | "yellow" | "red";
  statusLabel: string;
};

type RemoteSourceAvailability = {
  source: LibrarySource;
  summary: SourceAvailabilitySource;
  detail?: RemoteWorkDetail;
  loading?: boolean;
  error?: string;
};

function sourceTabStatusClass(status: SourceTabInfo["status"]) {
  if (status === "green") return "bg-emerald-500";
  if (status === "yellow") return "bg-amber-500";
  return "bg-red-500";
}

type DetailActionMode = "local" | "tracked_unforked" | "tracked_forked" | "remote_source";

type ReforkTarget = {
  current: RemoteSourceAvailability | null;
  next: RemoteSourceAvailability;
};

function emptyTree(): TreeNode {
  return { name: "", path: "", children: new Map(), files: [] };
}

function buildSourceTabs(
  items: MediaItem[],
  remoteSources: RemoteSourceAvailability[] = [],
  sourcePresence: NonNullable<WorkDetail["sourcePresence"]> = [],
): SourceTabInfo[] {
  const sources = new Map<number, SourceTabInfo>();
  for (const item of items) {
    for (const location of item.locations) {
      if (location.locationType !== "local" || location.availability !== "available") continue;
      if (!sources.has(location.fileSourceId)) {
        sources.set(location.fileSourceId, {
          key: `${location.fileSourceId}:${location.locationType}`,
          label: "Local",
          fileSourceId: location.fileSourceId,
          kind: "local",
          status: "green",
          statusLabel: "Local files available",
        });
      }
    }
  }
  const availableRemotes = remoteSources.filter((remote) => remote.summary.status === "available");
  const pendingRemotes = remoteSources.filter((remote) => ["unknown", "error"].includes(remote.summary.status));
  const tabs = Array.from(sources.values());
  if (tabs.length === 0) {
    tabs.push({
      key: "local",
      label: "Local",
      fileSourceId: -1,
      kind: "local",
      status: availableRemotes.length > 0 || pendingRemotes.length > 0 || remoteSources.length === 0 ? "yellow" : "red",
      statusLabel: availableRemotes.length > 0 ? `Fetch available from ${availableRemotes[0].source.displayName}` : pendingRemotes.length > 0 || remoteSources.length === 0 ? "Remote sources need checking" : "No local or remote files available",
    });
  }
  const baseTabs: SourceTabInfo[] = [...tabs];
  for (const presence of sourcePresence) {
    if (presence.type !== "tracked") continue;
    const sourceID = trackedPresenceSourceID(presence);
    const forked = trackedPresenceForked(presence, items);
    const matchingRemote = remoteSources.find((remote) => remote.source.id === sourceID);
    const canFork = matchingRemote?.summary.status === "available" || availableRemotes.length > 0;
    const sourceName = presence.fileSourceName || presence.fileSourceCode || "Source";
    baseTabs.push({
	  key: trackedSourceTabKey(presence),
	  label: `Tracked · ${sourceName}`,
      fileSourceId: null,
      kind: "tracked",
      presence,
      status: forked ? "green" : canFork ? "yellow" : "red",
      statusLabel: forked ? "Tracked directory available" : canFork ? `Fork available from ${matchingRemote?.source.displayName ?? availableRemotes[0].source.displayName}` : "Tracked directory unavailable",
    });
  }
  for (const remote of remoteSources) {
    const status = remoteSourceTabStatus(remote.summary);
    baseTabs.push({
      key: remoteSourceTabKey(remote.source.id),
      label: remote.source.displayName,
      fileSourceId: null,
      kind: "remote",
      status: status.status,
      statusLabel: status.statusLabel,
    });
  }
  return baseTabs;
}

function remoteSourceTabStatus(summary: SourceAvailabilitySource): Pick<SourceTabInfo, "status" | "statusLabel"> {
  if (summary.status === "available") return { status: "green", statusLabel: "Available" };
  if (summary.status === "unknown" || summary.status === "error") return { status: "yellow", statusLabel: summary.status === "unknown" ? "Needs checking" : "Check failed" };
  if (summary.status === "not_found") return { status: "red", statusLabel: "Not found" };
  if (summary.status === "disabled") return { status: "red", statusLabel: "Disabled" };
  return { status: "red", statusLabel: summary.error || "Unavailable" };
}

function trackedPresenceSourceID(presence: NonNullable<WorkDetail["sourcePresence"]>[number] | null) {
  return presence?.fileSourceId ?? null;
}

function trackedPresenceForked(presence: NonNullable<WorkDetail["sourcePresence"]>[number] | null, items: MediaItem[]) {
  const sourceID = trackedPresenceSourceID(presence);
  if (!sourceID) return false;
  return items.some((item) => item.locations.some((location) =>
    location.fileSourceId === sourceID
    && location.locationType === "remote_stream"
    && location.availability === "available",
  ));
}

function availableForkSources(remoteSources: RemoteSourceAvailability[]) {
  return remoteSources.filter((remote) => remoteSourceCanBrowse(remote.summary));
}

function remoteSourceForTrackedPresence(presence: NonNullable<WorkDetail["sourcePresence"]>[number] | null, remoteSources: RemoteSourceAvailability[]) {
  const sourceID = trackedPresenceSourceID(presence);
  if (!sourceID) return null;
  return remoteSources.find((remote) => remote.source.id === sourceID) ?? null;
}

function trackedSourceTabKey(presence: NonNullable<WorkDetail["sourcePresence"]>[number]) {
  return `tracked:${presence.fileSourceId ?? 0}:${presence.remoteId ?? ""}:${presence.sourceUrl ?? ""}`;
}

function remoteSourceCanBrowse(summary: SourceAvailabilitySource) {
  return summary.status === "available";
}

function remoteSourceTabKey(sourceID: number) {
  return `remote-source:${sourceID}`;
}

function buildTree(items: MediaItem[], fileSourceId: number | null, workCode: string): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map(), files: [] };
  for (const item of items) {
    const sourceLocations = fileSourceId === null ? item.locations : item.locations.filter((location) => location.fileSourceId === fileSourceId);
    const location = sourceLocations.find((candidate) => candidate.availability === "available" && candidate.streamUrl) ?? sourceLocations[0];
    if (!location) continue;
    const cacheLocation = sourceLocations.find((candidate) => candidate.locationType === "cache" && candidate.availability === "available");
    const localLocation = sourceLocations.find((candidate) => candidate.locationType === "local" && candidate.availability === "available");
    const parts = displayPathParts(location.path, location.locationType, workCode);
    const fileName = parts.pop() ?? item.title;
    let cursor = root;
    for (const part of parts) {
      if (!cursor.children.has(part)) {
        const childPath = cursor.path ? `${cursor.path}/${part}` : part;
        cursor.children.set(part, { name: part, path: childPath, children: new Map(), files: [] });
      }
      cursor = cursor.children.get(part)!;
    }
    cursor.files.push({
      mediaItemId: item.id,
      locationId: location.id,
      title: fileName,
      baseName: baseNameWithoutExtension(fileName),
      sourcePath: parts.length > 0 ? `${parts.join("/")}/${fileName}` : fileName,
      kind: item.kind,
      folderPath: cursor.path,
      locationType: location.locationType,
      streamUrl: location.streamUrl,
      downloadUrl: location.downloadUrl,
      assetUrl: location.locationType === "local" ? versionedMediaAssetURL(location.id, item.fingerprint, location.sizeBytes) : location.downloadUrl,
      sizeBytes: location.sizeBytes,
      durationSeconds: location.durationSeconds ?? item.durationSeconds,
      availability: location.availability,
      cacheLocationId: cacheLocation?.id ?? null,
      cachePath: cacheLocation?.path ?? "",
      cacheAvailable: Boolean(cacheLocation),
      cacheStreamUrl: cacheLocation ? `/api/media/${cacheLocation.id}/stream` : "",
      localLocationId: localLocation?.id ?? null,
      localPath: localLocation?.path ?? "",
      localAvailable: Boolean(localLocation),
      progress: item.progress,
      locations: item.locations
        .filter((candidate) => candidate.streamUrl && ["available", "remote"].includes(candidate.availability))
        .map((candidate) => ({
          locationId: candidate.id,
          locationType: candidate.locationType,
          streamUrl: candidate.streamUrl,
          sourceId: candidate.fileSourceId,
          sourceName: candidate.fileSourceName,
          availability: candidate.availability,
        })),
    });
  }
  return normalizeDisplayTree(root);
}

function displayPathParts(path: string, locationType: string, workCode: string) {
  const parts = path.split("/").filter(Boolean);
  if (locationType !== "local" || !workCode) return parts;
  const code = workCode.toUpperCase();
  const workRootIndex = parts.findIndex((part) => {
    const normalized = part.toUpperCase();
    return normalized.includes(code) || /\b(RJ|BJ|VJ)[0-9]{5,8}\b/i.test(part);
  });
  if (workRootIndex < 0 || workRootIndex >= parts.length - 1) return parts;
  return parts.slice(workRootIndex + 1);
}

function buildRemoteTree(tracks: RemoteTrack[]): TreeNode {
  let nextID = -1;
  const root: TreeNode = { name: "", path: "", children: new Map(), files: [] };
  const walk = (nodes: RemoteTrack[], cursor: TreeNode) => {
    nodes.forEach((node, index) => {
      const title = (node.title ?? "").trim() || `Track ${index + 1}`;
      const children = node.children ?? [];
      if (children.length > 0 || node.type === "folder") {
        const childPath = cursor.path ? `${cursor.path}/${title}` : title;
        const child = cursor.children.get(title) ?? { name: title, path: childPath, children: new Map(), files: [] };
        cursor.children.set(title, child);
        walk(children, child);
        return;
      }
      const hasCache = node.cacheAvailable && node.cacheLocationId !== null;
      cursor.files.push({
        mediaItemId: nextID,
        locationId: hasCache ? node.cacheLocationId! : nextID,
        title,
        baseName: baseNameWithoutExtension(title),
        sourcePath: cursor.path ? `${cursor.path}/${title}` : title,
        kind: node.type || "file",
        folderPath: cursor.path,
        locationType: hasCache ? "cache" : "remote_stream",
        streamUrl: hasCache ? `/api/media/${node.cacheLocationId}/stream` : node.streamUrl,
        downloadUrl: node.downloadUrl,
        assetUrl: hasCache ? `/api/media/${node.cacheLocationId}/asset` : node.downloadUrl || node.streamUrl,
        sizeBytes: node.sizeBytes,
        durationSeconds: node.durationSeconds,
        availability: hasCache ? "available" : node.streamUrl || node.downloadUrl ? "remote" : "metadata",
        cacheLocationId: node.cacheLocationId,
        cachePath: node.cachePath,
        cacheAvailable: node.cacheAvailable,
        cacheStreamUrl: node.cacheAvailable && node.cacheLocationId !== null ? `/api/media/${node.cacheLocationId}/stream` : "",
        localLocationId: node.localLocationId,
        localPath: node.localPath,
        localAvailable: node.localAvailable,
        progress: null,
        locations: [
          ...(node.localAvailable && node.localLocationId ? [{
            locationId: node.localLocationId,
            locationType: "local",
            streamUrl: `/api/media/${node.localLocationId}/stream`,
            sourceId: 0,
            sourceName: "Local",
            availability: "available",
          }] : []),
          ...(node.cacheAvailable && node.cacheLocationId ? [{
            locationId: node.cacheLocationId,
            locationType: "cache",
            streamUrl: `/api/media/${node.cacheLocationId}/stream`,
            sourceId: 0,
            sourceName: "Cache",
            availability: "available",
          }] : []),
          ...(node.streamUrl ? [{
            locationId: nextID,
            locationType: "remote_stream",
            streamUrl: node.streamUrl,
            sourceId: 0,
            sourceName: "Remote",
            availability: "remote",
          }] : []),
        ],
      });
      nextID -= 1;
    });
  };
  walk(tracks, root);
  return normalizeDisplayTree(root);
}

function normalizeDisplayTree(root: TreeNode): TreeNode {
  let displayRoot = cloneTree(root, "");
  while (displayRoot.files.length === 0 && displayRoot.children.size === 1) {
    const onlyChild = Array.from(displayRoot.children.values())[0];
    if (onlyChild.files.length > 0 || onlyChild.children.size !== 1) break;
    displayRoot = cloneTree(onlyChild, "");
  }
  return collapseSingleChildFolders(displayRoot, true);
}

function cloneTree(node: TreeNode, path: string): TreeNode {
  const clone: TreeNode = { name: node.name, path, children: new Map(), files: [...node.files] };
  for (const child of node.children.values()) {
    const childPath = path ? `${path}/${child.name}` : child.name;
    clone.children.set(child.name, cloneTree(child, childPath));
  }
  return clone;
}

function collapseSingleChildFolders(node: TreeNode, isRoot = false): TreeNode {
  const collapsed: TreeNode = { ...node, children: new Map(), files: [...node.files] };
  for (const child of node.children.values()) {
    let next = collapseSingleChildFolders(child);
    while (!isRoot && next.files.length === 0 && next.children.size === 1) {
      const grandChild = Array.from(next.children.values())[0];
      next = collapseSingleChildFolders({
        ...grandChild,
        name: `${next.name}/${grandChild.name}`,
        path: next.path,
      });
    }
    collapsed.children.set(next.name, next);
  }
  return collapsed;
}

function DirectoryTree({
  root,
  directoryRoutingRules,
  currentLocationId,
  onPlayFolder,
  onPlayNext,
  onAppendQueue,
  onPreview,
  emptyLabel = "No local files detected.",
}: {
  root: TreeNode;
  directoryRoutingRules: DirectoryRoutingRule[];
  currentLocationId: number | null;
  onPlayFolder?: (tracks: TreeTrack[], locationId: number) => void;
  onPlayNext?: (track: TreeTrack) => void;
  onAppendQueue?: (track: TreeTrack) => void;
  onPreview?: (preview: FilePreviewState) => void;
  emptyLabel?: string;
}) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => initialExpandedTreePaths(root, directoryRoutingRules));
  const [visibleLimit, setVisibleLimit] = useState(160);
  useEffect(() => {
    setExpandedPaths(initialExpandedTreePaths(root, directoryRoutingRules));
    setVisibleLimit(160);
  }, [root, directoryRoutingRules]);
  const rows = useMemo(() => flattenVisibleTreeRows(root, expandedPaths), [root, expandedPaths]);
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
      <div className="space-y-1">
        {visibleRows.map((row) => row.type === "folder" ? (
          <TreeFolderRow
            key={`folder:${row.node.path}`}
            node={row.node}
            depth={row.depth}
            expanded={expandedPaths.has(row.node.path)}
            onToggle={() => toggleFolder(row.node.path)}
          />
        ) : (
          <TreeFile
            key={`file:${row.file.locationId}`}
            file={row.file}
            files={playableFiles(row.parent.files)}
            depth={row.depth}
            isActive={row.file.locationId === currentLocationId}
            onPlayFolder={onPlayFolder}
            onPlayNext={onPlayNext}
            onAppendQueue={onAppendQueue}
            onPreview={onPreview}
          />
        ))}
      </div>
      {visibleRows.length < rows.length && (
        <Button variant="outline" size="sm" className="w-full" onClick={() => setVisibleLimit((value) => value + 160)}>
          Show more files ({rows.length - visibleRows.length} remaining)
        </Button>
      )}
    </div>
  );
}

function RemoteSaveSelectionPanel({
  root,
  selectedPaths,
  selectedLocalPaths,
  disabled,
  plan,
  decisions,
  planDirty,
  message,
  onClose,
  onSave,
  onChange,
  onLocalChange,
  onDecisionChange,
  activeEditionCode,
  onEditionChange,
  sourceId,
  targetRoot,
  onTargetRootChange,
}: {
  root: TreeNode;
  selectedPaths: Set<string>;
  selectedLocalPaths: Set<string>;
  disabled: boolean;
  plan?: RemoteWorkSavePlan | null;
  decisions?: RemoteFetchDecisions;
  planDirty?: boolean;
  message?: string;
  onClose: () => void;
  onSave: () => void;
  onChange: (paths: Set<string>) => void;
  onLocalChange: (paths: Set<string>) => void;
  onDecisionChange?: (decision: RemoteFetchFileDecision) => void;
  activeEditionCode?: string;
  onEditionChange?: (code: string) => Promise<boolean>;
  sourceId?: number;
  targetRoot?: string;
  onTargetRootChange?: (root: string) => void;
}) {
  const [activePane, setActivePane] = useState<"local" | "remote" | "result">("remote");
  const currentEditionCode = remoteFetchCurrentEditionCode(plan, activeEditionCode);
	const [selectedEditionCode, setSelectedEditionCode] = useState(currentEditionCode);
  const [checkingEditionCode, setCheckingEditionCode] = useState("");
  const [refreshScheduled, setRefreshScheduled] = useState(false);
  const onSaveRef = useRef(onSave);
  const allPaths = remoteSelectablePaths(root);
  const planByPath = useMemo(() => new Map((plan?.items ?? []).map((item) => [item.path, item])), [plan]);
  const localTree = useMemo(() => buildRemoteFetchLocalTree(plan), [plan]);
  const hasLocalFiles = Boolean(plan?.localFiles.length);
  const activeEdition = plan?.preparation.editions.find((edition) => edition.primaryCode.toUpperCase() === (activeEditionCode ?? plan.primaryCode).toUpperCase());
  const plannedRoot = activeEdition?.localRoots.find((root) => root.rootPath === plan?.saveRoot);
  const messageIsConflict = Boolean(plan && hasRemoteFetchConflicts(plan));
  const previewNeedsRefresh = !plan || Boolean(planDirty);
  const previewRevision = useMemo(() => JSON.stringify({
    edition: selectedEditionCode,
    remote: Array.from(selectedPaths).sort(),
    local: Array.from(selectedLocalPaths).sort(),
    targetRoot: targetRoot ?? "",
    decisions: Object.values(decisions ?? {}).sort((a, b) => a.itemKey.localeCompare(b.itemKey)),
  }), [decisions, selectedEditionCode, selectedLocalPaths, selectedPaths, targetRoot]);
  const setAll = () => onChange(new Set(allPaths));
  const extensionSelection = (extension: string) => {
    const matching = allPaths.filter((path) => path.toLowerCase().endsWith(`.${extension}`));
    const selected = matching.filter((path) => selectedPaths.has(path)).length;
    return {
      count: matching.length,
      checked: matching.length > 0 && selected === matching.length,
      indeterminate: selected > 0 && selected < matching.length,
    };
  };
  const setExtensionIncluded = (extension: string, included: boolean) => {
    const next = new Set(selectedPaths);
    for (const path of allPaths) {
      if (!path.toLowerCase().endsWith(`.${extension}`)) continue;
      if (included) next.add(path);
      else next.delete(path);
    }
    onChange(next);
  };
  const clear = () => onChange(new Set());
  const selectLocalPath = (path: string, selected: boolean) => {
    const next = new Set(selectedLocalPaths);
    if (selected) next.add(path);
    else next.delete(path);
    onLocalChange(next);
  };

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    if (currentEditionCode) setSelectedEditionCode(currentEditionCode);
  }, [currentEditionCode]);

  useEffect(() => {
    if (!selectedEditionCode || disabled || !previewNeedsRefresh || (selectedPaths.size === 0 && selectedLocalPaths.size === 0)) {
      setRefreshScheduled(false);
      return;
    }
    setRefreshScheduled(true);
    const timer = window.setTimeout(() => {
      setRefreshScheduled(false);
      onSaveRef.current();
    }, 750);
    return () => window.clearTimeout(timer);
  }, [disabled, previewNeedsRefresh, previewRevision, selectedEditionCode, selectedLocalPaths.size, selectedPaths.size]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4">
      <div className="flex max-h-[90dvh] w-full max-w-7xl flex-col overflow-hidden rounded-lg border bg-background shadow-xl" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex min-h-12 items-center justify-between gap-3 border-b px-4">
          <div>
            <h3 className="text-base font-semibold">Fetch selection</h3>
            <p className="text-xs text-muted-foreground">Compare the exact language edition, remote source, and final published directory.</p>
          </div>
          <IconButton title="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        {plan?.preparation && (
          <div className="border-b bg-muted/30 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Languages className="h-3.5 w-3.5" /> Language editions
              <Badge variant={plan.preparation.metadataStatus === "complete" ? "secondary" : "outline"}>{plan.preparation.metadataStatus}</Badge>
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {plan.preparation.editions.map((edition) => {
				const viewing = (activeEditionCode ?? plan.primaryCode).toUpperCase() === edition.primaryCode.toUpperCase();
				const selected = selectedEditionCode.toUpperCase() === edition.primaryCode.toUpperCase();
                const availableSources = edition.sources.filter((source) => source.status === "available").length;
                const selectedSourceAvailable = !sourceId || edition.sources.some((source) => source.sourceId === sourceId && source.status === "available");
                const checking = checkingEditionCode.toUpperCase() === edition.primaryCode.toUpperCase();
                return (
				  <label key={edition.primaryCode} className={`flex min-w-48 cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-left transition-colors ${selected ? "border-primary bg-primary/10" : "bg-background hover:bg-muted"}`}>
					<Checkbox
					  checked={selected}
					  disabled={disabled || checking}
					  aria-label={`Select ${edition.primaryCode}`}
					  onCheckedChange={(checked) => {
						if (!checked) {
						  setSelectedEditionCode("");
						  return;
						}
						if (!onEditionChange) {
						  setSelectedEditionCode(edition.primaryCode);
						  return;
						}
						setCheckingEditionCode(edition.primaryCode);
						void onEditionChange(edition.primaryCode).then((available) => {
						  if (available) setSelectedEditionCode(edition.primaryCode);
						}).finally(() => setCheckingEditionCode(""));
					  }}
					/>
					<span className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold">{translationKindLabel(edition.translationKind)}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">{edition.primaryCode}</span>
                    </div>
                    <div className="mt-1 truncate text-xs" title={edition.title}>{edition.metadataLanguage || edition.editionLabel || "Unknown language"}</div>
                    <div className="mt-1 flex gap-1 text-[10px] text-muted-foreground"><span>{edition.localRoots.length} local</span><span>·</span><span>{availableSources} remote</span><span>·</span><span>{checking ? "checking" : viewing || selectedSourceAvailable ? "available" : "not checked"}</span></div>
					</span>
				  </label>
                );
              })}
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <Badge variant="secondary">{selectedPaths.size} remote / {allPaths.length}</Badge>
          {plan && plan.localFiles.length > 0 && <Badge variant="secondary">{selectedLocalPaths.size} local</Badge>}
          {plan && plan.summary.conflict > 0 && <Badge variant="outline" className="border-destructive/40 text-destructive">{plan.summary.conflict} conflicts</Badge>}
          {plan && plan.summary.conflict === 0 && <Badge variant="outline">{plan.summary.promote} to fetch</Badge>}
          {previewNeedsRefresh && <Badge variant="outline">{disabled ? "Refreshing preview" : refreshScheduled ? "Preview scheduled" : "Preview required"}</Badge>}
          <div className="ml-auto flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={disabled} onClick={setAll}>All</Button>
            {(["mp3", "wav", "flac"] as const).map((extension) => {
              const state = extensionSelection(extension);
              return (
                <label key={extension} className="inline-flex h-8 items-center gap-2 rounded-md border bg-background px-2 text-xs">
                  <Checkbox
                    checked={state.checked}
                    indeterminate={state.indeterminate}
                    disabled={disabled || state.count === 0}
                    onCheckedChange={() => setExtensionIncluded(extension, !state.checked)}
                    aria-label={`Include ${extension.toUpperCase()}`}
                  />
                  <span>{extension.toUpperCase()}</span>
                </label>
              );
            })}
            <Button variant="outline" size="sm" disabled={disabled} onClick={clear}>None</Button>
          </div>
        </div>
        <div className="grid grid-cols-3 border-b bg-background p-1 md:hidden">
          {(["local", "remote", "result"] as const).map((pane) => <Button key={pane} type="button" size="sm" variant={activePane === pane ? "secondary" : "ghost"} onClick={() => setActivePane(pane)} className="capitalize">{pane}</Button>)}
        </div>
        <div className={hasLocalFiles ? "grid min-h-0 flex-1 grid-cols-1 overflow-hidden bg-card md:grid-cols-3" : "grid min-h-0 flex-1 grid-cols-1 overflow-hidden bg-card md:grid-cols-2"}>
          {hasLocalFiles && (
            <div className={`${activePane === "local" ? "block" : "hidden"} app-scroll min-h-0 overflow-auto border-b p-2 md:block md:border-b-0 md:border-r`}>
              <div className="mb-2 flex items-center justify-between gap-2 px-1">
                <div className="text-sm font-medium">Local files</div>
                <Badge variant="secondary">{selectedLocalPaths.size} selected</Badge>
              </div>
              {plan && (
                <label className="mb-2 block space-y-1 px-1 text-xs text-muted-foreground">
                  <span>Publish target</span>
                  <select className="h-8 w-full rounded-md border bg-background px-2 text-xs text-foreground" value={targetRoot || plan.saveRoot} disabled={disabled || !onTargetRootChange} onChange={(event) => onTargetRootChange?.(event.target.value)}>
                    <option value={plan.saveRoot}>{plannedRoot?.role === "external" ? "Existing" : "Managed"} · {plan.saveRoot}</option>
                    {(activeEdition?.localRoots ?? []).filter((root) => root.rootPath !== plan.saveRoot).map((root) => <option key={root.id} value={root.rootPath}>{root.role === "managed_fetch" ? "Managed" : "Existing"} · {root.rootPath}</option>)}
                  </select>
                </label>
              )}
              <RemoteFetchLocalTreeNode
                node={localTree}
                depth={0}
                selectedLocalPaths={selectedLocalPaths}
                disabled={disabled}
                onSelect={selectLocalPath}
                isRoot
              />
            </div>
          )}
          <div className={`${activePane === "remote" ? "block" : "hidden"} app-scroll min-h-0 overflow-auto border-b p-2 md:block md:border-b-0 md:border-r`}>
            {hasLocalFiles && (
              <div className="mb-2 flex items-center justify-between gap-2 px-1">
                <div className="text-sm font-medium">Remote files</div>
                <Badge variant="secondary">{selectedPaths.size} selected</Badge>
              </div>
            )}
            <RemoteSaveSelectionNode
              node={root}
              depth={0}
              selectedPaths={selectedPaths}
              planByPath={planByPath}
              disabled={disabled}
              onChange={onChange}
              isRoot
            />
          </div>
          <div className={`${activePane === "result" ? "block" : "hidden"} app-scroll min-h-0 overflow-auto p-2 md:block`}>
            <div className="mb-2 flex items-center justify-between gap-2 px-1">
              <div className="text-sm font-medium">After Fetch</div>
              <Badge variant="secondary">{plan?.items.length ?? 0} files</Badge>
            </div>
            {plan ? <RemoteFetchResultTree plan={plan} decisions={decisions ?? {}} onDecisionChange={onDecisionChange} /> : <FetchPaneEmpty label="Refresh the comparison to build the result tree." />}
          </div>
        </div>
        {message && (
          <div className={`border-t px-3 py-2 text-sm ${messageIsConflict ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"}`}>
            {message}
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2 border-t p-3">
          <Button variant="outline" onClick={onClose} disabled={disabled}>
            Cancel
          </Button>
		  <Button onClick={onSave} disabled={disabled || refreshScheduled || previewNeedsRefresh || messageIsConflict || !selectedEditionCode || (selectedPaths.size === 0 && selectedLocalPaths.size === 0)}>
            <HardDriveDownload className="h-4 w-4" />
            {disabled || refreshScheduled ? "Refreshing preview" : "Publish Fetch"}
          </Button>
        </div>
      </div>
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
  const clauses = parseSearchClauses(browseState.query).filter((clause) => !(clause.kind === "tag" && clause.value.toLowerCase() === value.toLowerCase()));
  const query = [...clauses, { kind: "tag" as const, value }].map(formatSearchClause).join(" ");
  target.search = libraryBrowseSearch({ ...browseState, query, page: 1, scrollY: 0 });
  window.history.pushState({}, "", `${target.pathname}${target.search}`);
  window.dispatchEvent(new Event("kikoto:navigation"));
}

function openResolvedEntityRoute(route: string) {
  if (!route.startsWith("/")) return;
  const returnTo = `${window.location.pathname}${window.location.search}`;
  window.history.pushState({ returnTo, returnLabel: "Back" }, "", route);
  window.dispatchEvent(new Event("kikoto:navigation"));
}

type RemoteFetchResultNode = {
  name: string;
  path: string;
  children: Map<string, RemoteFetchResultNode>;
  items: RemoteWorkSavePlan["items"];
};

function RemoteFetchResultTree({ plan, decisions, onDecisionChange }: { plan: RemoteWorkSavePlan; decisions: RemoteFetchDecisions; onDecisionChange?: (decision: RemoteFetchFileDecision) => void }) {
  const root = useMemo(() => {
    const result: RemoteFetchResultNode = { name: "", path: "", children: new Map(), items: [] };
    const prefix = `${plan.saveRoot.replace(/\\/g, "/").replace(/\/$/, "")}/`;
    for (const item of plan.items) {
      const normalized = item.targetPath.replace(/\\/g, "/");
      const relative = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
      const parts = relative.split("/").filter(Boolean);
      let node = result;
      for (const folder of parts.slice(0, -1)) {
        const path = node.path ? `${node.path}/${folder}` : folder;
        if (!node.children.has(folder)) node.children.set(folder, { name: folder, path, children: new Map(), items: [] });
        node = node.children.get(folder)!;
      }
      node.items.push({ ...item, path: parts.length > 0 ? parts[parts.length - 1] : item.path });
    }
    return result;
  }, [plan]);
  return <RemoteFetchResultNodeView node={root} depth={0} decisions={decisions} onDecisionChange={onDecisionChange} isRoot />;
}

function RemoteFetchResultNodeView({ node, depth, decisions, onDecisionChange, isRoot = false }: { node: RemoteFetchResultNode; depth: number; decisions: RemoteFetchDecisions; onDecisionChange?: (decision: RemoteFetchFileDecision) => void; isRoot?: boolean }) {
  const [open, setOpen] = useState(true);
  const folders = Array.from(node.children.values()).sort((a, b) => naturalCompare(a.name, b.name));
  const items = [...node.items].sort((a, b) => naturalCompare(a.path, b.path));
  return (
    <div className="space-y-1">
      {!isRoot && (
        <button type="button" className="flex min-h-7 w-full items-center gap-2 rounded px-2 text-left text-sm hover:bg-muted" style={{ paddingLeft: depth * 14 + 8 }} onClick={() => setOpen((value) => !value)}>
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <Folder className="h-4 w-4 text-primary" />
          <span className="truncate">{node.name}</span>
        </button>
      )}
      {(isRoot || open) && folders.map((child) => <RemoteFetchResultNodeView key={child.path} node={child} depth={depth + 1} decisions={decisions} onDecisionChange={onDecisionChange} />)}
      {(isRoot || open) && items.map((item) => {
        const decision = decisions[item.itemKey] ?? { itemKey: item.itemKey, sourceId: item.remoteSourceId, resolution: (item.resolution || "auto") as RemoteFetchResolution, targetPath: item.targetPath };
        const showEditor = item.targetConflict || decision.resolution !== "auto" || item.sourceOptions.length > 1;
        const updateDecision = (patch: Partial<RemoteFetchFileDecision>) => onDecisionChange?.({ ...decision, ...patch });
        return (
          <div key={item.itemKey || item.targetPath} className="rounded hover:bg-muted/60" style={{ marginLeft: (depth + 1) * 14 + 8 }} title={item.targetPath}>
            <div className="flex min-h-8 items-center gap-2 px-2 text-xs">
              {item.kind === "audio" ? <FileAudio className="h-3.5 w-3.5 text-primary" /> : item.kind === "image" ? <ImageIcon className="h-3.5 w-3.5 text-muted-foreground" /> : <FileText className="h-3.5 w-3.5 text-muted-foreground" />}
              <span className="min-w-0 flex-1 truncate">{item.path}</span>
              <Badge variant={item.action === "skip" || item.targetConflict ? "outline" : "secondary"} className={item.targetConflict ? "border-destructive/40 text-destructive" : ""}>{fetchResultActionLabel(item.action)}</Badge>
            </div>
            {showEditor && (
              <div className="grid gap-2 border-t px-2 py-2 text-xs sm:grid-cols-2">
                {item.sourceOptions.length > 1 && (
                  <label className="space-y-1">
                    <span className="text-muted-foreground">Remote source</span>
                    <select className="h-8 w-full rounded-md border bg-background px-2" value={decision.sourceId || item.remoteSourceId} onChange={(event) => updateDecision({ sourceId: Number(event.target.value) })}>
                      {item.sourceOptions.map((option) => <option key={option.sourceId} value={option.sourceId}>{option.sourceName}{option.path !== item.path ? ` · ${option.path}` : ""}</option>)}
                    </select>
                  </label>
                )}
                {(item.targetConflict || decision.resolution !== "auto") && (
                  <label className="space-y-1">
                    <span className="text-muted-foreground">Conflict action</span>
                    <select className="h-8 w-full rounded-md border bg-background px-2" value={decision.resolution} onChange={(event) => updateDecision({ resolution: event.target.value as RemoteFetchResolution })}>
                      <option value="auto">Unresolved</option>
                      <option value="keep_local">Keep local</option>
                      <option value="replace">Replace with selected source</option>
                      <option value="keep_both">Keep both</option>
                      <option value="rename">Rename incoming</option>
                      <option value="exclude">Exclude</option>
                    </select>
                  </label>
                )}
                {decision.resolution === "rename" && (
                  <label className="space-y-1 sm:col-span-2">
                    <span className="text-muted-foreground">Target path inside Fetch root</span>
                    <input className="h-8 w-full rounded-md border bg-background px-2" value={decision.targetPath} onChange={(event) => updateDecision({ targetPath: event.target.value })} />
                  </label>
                )}
                {item.targetConflictReason && <div className="text-destructive sm:col-span-2">{item.targetConflictReason}</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function FetchPaneEmpty({ label }: { label: string }) {
  return <div className="grid min-h-32 place-items-center rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">{label}</div>;
}

function fetchResultActionLabel(action: string) {
  switch (action) {
    case "skip": return "Keep";
    case "copy_local": return "Local";
    case "cache_hit": return "Cached";
    case "cache_download": return "Add";
    case "conflict": return "Conflict";
    case "exclude": return "Excluded";
    default: return action;
  }
}

function translationKindLabel(kind: string) {
  switch (kind) {
    case "origin": return "Origin";
    case "official": return "Official";
    case "community": return "Community";
    case "third_party": return "Third-party";
    default: return "Unknown";
  }
}

type RemoteFetchLocalTree = {
  name: string;
  path: string;
  children: Map<string, RemoteFetchLocalTree>;
  items: RemoteFetchLocalTreeItem[];
};

type RemoteFetchLocalTreeItem = {
  name: string;
  path: string;
  fullPath: string;
  sizeBytes: number | null;
  available: boolean;
  remotePath: string | null;
};

function RemoteFetchLocalTreeNode({
  node,
  depth,
  selectedLocalPaths,
  disabled,
  isRoot,
  onSelect,
}: {
  node: RemoteFetchLocalTree;
  depth: number;
  selectedLocalPaths: Set<string>;
  disabled: boolean;
  isRoot?: boolean;
  onSelect: (path: string, selected: boolean) => void;
}) {
  const [open, setOpen] = useState(isRoot);
  const folders = Array.from(node.children.values()).sort((a, b) => naturalCompare(a.name, b.name));
  const items = [...node.items].sort((a, b) => naturalCompare(a.name, b.name));
  const descendantItems = remoteFetchLocalTreeItems(node);
  const selectedCount = descendantItems.filter((item) => selectedLocalPaths.has(item.fullPath)).length;
  const checked = descendantItems.length > 0 && selectedCount === descendantItems.length;
  const mixed = selectedCount > 0 && selectedCount < descendantItems.length;
  const toggleNode = () => {
    const selected = !checked;
    for (const item of descendantItems) {
      onSelect(item.fullPath, selected);
    }
  };
  return (
    <div className="space-y-1">
      {!isRoot && (
        <div className="flex min-h-7 items-center gap-2 rounded px-2 text-sm hover:bg-muted" style={{ paddingLeft: depth * 14 + 8 }}>
          <button className="rounded p-0.5 hover:bg-background" onClick={() => setOpen((value) => !value)} title={open ? "Collapse" : "Expand"} aria-label={open ? "Collapse" : "Expand"}>
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
          <Checkbox checked={checked} indeterminate={mixed} disabled={disabled || descendantItems.length === 0} onCheckedChange={toggleNode} aria-label={`Select ${node.name}`} />
          <Folder className="h-4 w-4 text-primary" />
          <span className="min-w-0 flex-1 truncate" title={node.path}>{node.name}</span>
          <span className="text-xs text-muted-foreground">{selectedCount}/{descendantItems.length}</span>
        </div>
      )}
      {(isRoot || open) && folders.map((child) => (
        <RemoteFetchLocalTreeNode
          key={child.path}
          node={child}
          depth={isRoot ? 0 : depth + 1}
          selectedLocalPaths={selectedLocalPaths}
          disabled={disabled}
          onSelect={onSelect}
        />
      ))}
      {(isRoot || open) && items.map((item) => {
        const selected = selectedLocalPaths.has(item.fullPath);
        return (
          <label key={`${item.path}:${item.remotePath ?? ""}`} className="flex min-h-7 items-center gap-2 rounded px-2 text-sm hover:bg-muted" style={{ paddingLeft: (isRoot ? 0 : depth + 1) * 14 + 8 }}>
            <span className="w-5" />
            <Checkbox checked={selected} disabled={disabled} onCheckedChange={(checked) => onSelect(item.fullPath, checked)} aria-label={`Select ${item.name}`} />
            <HardDrive className="h-4 w-4 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate" title={item.fullPath}>{item.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(item.sizeBytes)}</span>
          </label>
        );
      })}
    </div>
  );
}

function RemoteSaveSelectionNode({
  node,
  depth,
  selectedPaths,
  planByPath,
  disabled,
  isRoot,
  onChange,
}: {
  node: TreeNode;
  depth: number;
  selectedPaths: Set<string>;
  planByPath: Map<string, { status: string; targetConflict: boolean; targetConflictReason: string }>;
  disabled: boolean;
  isRoot?: boolean;
  onChange: (paths: Set<string>) => void;
}) {
  const [open, setOpen] = useState(isRoot);
  const folders = sortedFolders(node);
  const files = sortedFiles(node);
  const hasChildren = folders.length > 0 || files.length > 0;
  const nodePaths = remoteSelectablePaths(node);
  const checkedCount = nodePaths.filter((path) => selectedPaths.has(path)).length;
  const checked = nodePaths.length > 0 && checkedCount === nodePaths.length;
  const mixed = checkedCount > 0 && checkedCount < nodePaths.length;
  const toggleNode = () => {
    const next = new Set(selectedPaths);
    for (const path of nodePaths) {
      if (checked) next.delete(path);
      else next.add(path);
    }
    onChange(next);
  };
  return (
    <div className="space-y-1">
      {!isRoot && (
        <div className="flex min-h-7 items-center gap-2 rounded px-2 text-sm hover:bg-muted" style={{ paddingLeft: depth * 14 + 8 }}>
          <button className="rounded p-0.5 hover:bg-background" disabled={!hasChildren} onClick={() => setOpen((value) => !value)} title={open ? "Collapse" : "Expand"} aria-label={open ? "Collapse" : "Expand"}>
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
          <Checkbox checked={checked} indeterminate={mixed} disabled={disabled || nodePaths.length === 0} onCheckedChange={toggleNode} aria-label={`Select ${node.name}`} />
          <Folder className="h-4 w-4 text-primary" />
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          <span className="text-xs text-muted-foreground">{checkedCount}/{nodePaths.length}</span>
        </div>
      )}
      {(isRoot || open) && folders.map((child) => (
        <RemoteSaveSelectionNode
          key={child.path}
          node={child}
          depth={isRoot ? 0 : depth + 1}
          selectedPaths={selectedPaths}
          planByPath={planByPath}
          disabled={disabled}
          onChange={onChange}
        />
      ))}
      {(isRoot || open) && files.map((file) => {
        const path = file.sourcePath;
        const plan = planByPath.get(path);
        return (
          <label key={path} className="flex min-h-7 items-center gap-2 rounded px-2 text-sm hover:bg-muted" style={{ paddingLeft: (isRoot ? 0 : depth + 1) * 14 + 8 }}>
            <Checkbox
              checked={selectedPaths.has(path)}
              disabled={disabled}
              onCheckedChange={(checked) => {
                const next = new Set(selectedPaths);
                if (checked) next.add(path);
                else next.delete(path);
                onChange(next);
              }}
              aria-label={`Select ${file.title}`}
            />
            {fileIcon(file)}
            <span className="min-w-0 flex-1 truncate">{file.title}</span>
            {plan && (
              <span
                className={plan.targetConflict ? "max-w-48 truncate text-xs text-destructive" : "text-xs text-muted-foreground"}
                title={plan.targetConflictReason || plan.status}
              >
                {plan.status}
              </span>
            )}
          </label>
        );
      })}
    </div>
  );
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
      <div className="w-full max-w-lg rounded-lg border bg-background shadow-xl" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b p-4">
          <div>
            <h3 className="text-base font-semibold">{isLocal ? "Delete local file" : "Delete cached file"}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {isLocal ? "This removes only this local file location." : "The remote source and saved local files will not be deleted."}
            </p>
          </div>
          <IconButton title="Close" onClick={onCancel}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="space-y-3 p-4 text-sm">
          <div>
            <div className="font-medium">{target.title}</div>
            <div className="mt-1 break-all rounded-md border bg-muted px-3 py-2 text-xs text-muted-foreground">{target.path}</div>
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
          <Button className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={onConfirm} disabled={deleting}>
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
      <div className="w-full max-w-lg rounded-lg border bg-background shadow-xl" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b p-4">
          <div>
            <h3 className="text-base font-semibold">Switch fork source</h3>
            <p className="mt-1 text-sm text-muted-foreground">Choose a different remote source for this tracked directory.</p>
          </div>
          <IconButton title="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="space-y-3 p-4 text-sm">
          <div className="rounded-md border bg-muted px-3 py-2 text-muted-foreground">
            {currentName} will be replaced by {nextName}. Cached files for the current fork should be cleaned when backend reFork cleanup is added.
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t p-4">
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
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
  currentLocationId,
  onPlayFolder,
  onPlayNext,
  onAppendQueue,
  onPreview,
  emptyLabel = "No local files detected.",
}: {
  root: TreeNode;
  directoryRoutingRules: DirectoryRoutingRule[];
  currentLocationId: number | null;
  onPlayFolder?: (tracks: TreeTrack[], locationId: number) => void;
  onPlayNext?: (track: TreeTrack) => void;
  onAppendQueue?: (track: TreeTrack) => void;
  onPreview?: (preview: FilePreviewState) => void;
  emptyLabel?: string;
}) {
  const [path, setPath] = useState<string[]>(() => recommendedDirectoryPath(root, directoryRoutingRules));
  const current = useMemo(() => nodeAtPath(root, path) ?? root, [root, path]);
  const folders = sortedFolders(current);
  const files = sortedFiles(current);
  useEffect(() => {
    if (!nodeAtPath(root, path)) {
      setPath(recommendedDirectoryPath(root, directoryRoutingRules));
    }
  }, [root, path, directoryRoutingRules]);

  useEffect(() => {
    setPath(recommendedDirectoryPath(root, directoryRoutingRules));
  }, [root, directoryRoutingRules]);

  if (folders.length === 0 && files.length === 0) {
    return <div className="text-sm text-muted-foreground">{emptyLabel}</div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex min-h-9 flex-wrap items-center gap-1 rounded-md border bg-background px-2 text-sm">
        <button className="rounded px-2 py-1 font-medium hover:bg-muted" onClick={() => setPath([])}>
          root
        </button>
        {path.map((part, index) => (
          <span key={`${part}:${index}`} className="inline-flex items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            <button className="rounded px-2 py-1 font-medium hover:bg-muted" onClick={() => setPath(path.slice(0, index + 1))}>
              {part}
            </button>
          </span>
        ))}
      </div>
      <div className="space-y-1">
        {path.length > 0 && (
          <button
            className="flex min-h-11 w-full items-center gap-2 rounded-md border bg-background px-3 text-left text-sm hover:bg-muted"
            onClick={() => setPath(path.slice(0, -1))}
          >
            <ChevronLeft className="h-4 w-4 text-muted-foreground" />
            <span>Parent folder</span>
          </button>
        )}
        {folders.map((folder) => (
          <button
            key={folder.path || folder.name}
            className="flex min-h-11 w-full items-center gap-2 rounded-md border bg-background px-3 text-left text-sm hover:bg-muted"
            onClick={() => setPath([...path, folder.name])}
          >
            <Folder className="h-4 w-4 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate">{folder.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{folderSummary(folder)}</span>
          </button>
        ))}
        {files.map((file) => (
          <TreeFile
            key={file.locationId}
            file={file}
            files={playableFiles(current.files)}
            depth={0}
            isActive={file.locationId === currentLocationId}
            onPlayFolder={onPlayFolder}
            onPlayNext={onPlayNext}
            onAppendQueue={onAppendQueue}
            onPreview={onPreview}
          />
        ))}
      </div>
    </div>
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
      className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm font-medium hover:bg-muted"
      style={{ paddingLeft: depth * 14 + 8 }}
      onClick={onToggle}
    >
      {expanded ? (
        <ChevronDown className="h-4 w-4 text-muted-foreground" />
      ) : (
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
      )}
      <Folder className="h-4 w-4 shrink-0 text-primary" />
      <span className="truncate">{node.name}</span>
      {filesLabel && <span className="ml-auto shrink-0 text-xs text-muted-foreground">{filesLabel}</span>}
    </button>
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
}: {
  file: TreeTrack;
  files: TreeTrack[];
  depth: number;
  isActive: boolean;
  onPlayFolder?: (tracks: TreeTrack[], locationId: number) => void;
  onPlayNext?: (track: TreeTrack) => void;
  onAppendQueue?: (track: TreeTrack) => void;
  onPreview?: (preview: FilePreviewState) => void;
}) {
  const [queueMenuOpen, setQueueMenuOpen] = useState(false);
  const queueMenuRef = useRef<HTMLDivElement | null>(null);
  useDismissiblePopover(queueMenuOpen, queueMenuRef, () => setQueueMenuOpen(false));
  const canPlay = Boolean(file.kind === "audio" && onPlayFolder && ["available", "remote"].includes(file.availability) && file.streamUrl);
  const preview = previewForFile(file);
  const canPreview = Boolean(preview && onPreview);
  const canDownload = Boolean(file.locationId > 0 && ["available"].includes(file.availability) && (file.locationType === "local" || file.locationType === "cache"));
  const canOpen = canPlay || canPreview || canDownload;
  const fileMeta = [file.kind === "audio" ? formatDuration(file.durationSeconds) : "", formatBytes(file.sizeBytes)].filter(Boolean).join(" · ");
  const mobileAudioMeta = fileMeta || "Audio";
  const openFile = () => {
    if (canPlay) {
      onPlayFolder?.(files, file.locationId);
      return;
    }
    if (preview) {
      onPreview?.(preview);
      return;
    }
    if (canDownload) {
      window.open(mediaDownloadURL(file.locationId), "_blank", "noopener,noreferrer");
    }
  };
  return (
    <div
      role={canOpen ? "button" : undefined}
      tabIndex={canOpen ? 0 : undefined}
      className={`flex ${file.kind === "audio" ? "min-h-14 sm:min-h-11" : "min-h-11"} items-center justify-between gap-3 rounded-md border px-3 text-left text-sm ${
        isActive ? "border-primary bg-secondary" : "bg-background hover:bg-muted"
      } ${canOpen ? "cursor-pointer" : "cursor-default"}`}
      style={{ marginLeft: depth * 14, width: `calc(100% - ${depth * 14}px)` }}
      onClick={() => {
        if (canOpen) openFile();
      }}
      onKeyDown={(event) => {
        if (!canOpen || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        openFile();
      }}
    >
      <span className="flex min-w-0 flex-1 items-start gap-2 sm:items-center">
        <span className="mt-0.5 shrink-0 sm:mt-0">
          {isActive ? <Pause className="h-4 w-4 text-primary" /> : fileIcon(file)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate">{file.title}</span>
          {file.kind === "audio" && (
            <span className="mt-0.5 block truncate text-xs text-muted-foreground sm:hidden">{mobileAudioMeta}</span>
          )}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
        {file.kind === "file" && canDownload && <ExternalLink className="h-3.5 w-3.5 text-primary" aria-label="Downloads in new tab" />}
        <span className={file.kind === "audio" ? "hidden sm:inline" : ""}>{fileMeta}</span>
        {canPlay && (onPlayNext || onAppendQueue) && (
          <div ref={queueMenuRef} onClick={(event) => event.stopPropagation()}>
            <button
              className="grid h-11 w-11 place-items-center rounded-md hover:bg-secondary hover:text-foreground sm:h-9 sm:w-9"
              onClick={() => setQueueMenuOpen((value) => !value)}
              aria-label={`Queue actions for ${file.title}`}
              aria-expanded={queueMenuOpen}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            <AnchoredPopover open={queueMenuOpen} anchorRef={queueMenuRef} className="w-44 rounded-lg border bg-card p-1 text-sm text-card-foreground shadow-xl">
              {onPlayNext && (
                <button className="flex h-9 w-full items-center rounded-md px-2 text-left hover:bg-muted" onClick={() => {
                  onPlayNext(file);
                  setQueueMenuOpen(false);
                }}>
                  Play next
                </button>
              )}
              {onAppendQueue && (
                <button className="flex h-9 w-full items-center rounded-md px-2 text-left hover:bg-muted" onClick={() => {
                  onAppendQueue(file);
                  setQueueMenuOpen(false);
                }}>
                  Add to queue
                </button>
              )}
            </AnchoredPopover>
          </div>
        )}
      </span>
    </div>
  );
}

function DirectoryManagerModal({
  root,
  emptyLabel,
  onClose,
  deleting = false,
  onDeleteTargets,
  allowCacheDelete,
  allowLocalDelete,
  localRootPath = "",
  showCachedFilter = false,
}: {
  root: TreeNode;
  emptyLabel: string;
  onClose: () => void;
  deleting?: boolean;
  onDeleteTargets?: (targets: MediaDeleteTarget[]) => void;
  allowCacheDelete?: boolean;
  allowLocalDelete?: boolean;
  localRootPath?: string;
  showCachedFilter?: boolean;
}) {
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [confirmStep, setConfirmStep] = useState<0 | 1 | 2>(0);
  const [showOnlyDeletable, setShowOnlyDeletable] = useState(showCachedFilter);
  const [previewTargets, setPreviewTargets] = useState<MediaDeleteTarget[]>([]);
  const fileTargets = useMemo(() => directoryManageTargets(root, { allowCacheDelete, allowLocalDelete }), [root, allowCacheDelete, allowLocalDelete]);
  const rootTarget = useMemo<MediaDeleteTarget | null>(() => {
    const representative = fileTargets.find((target) => target.kind === "local");
    if (!allowLocalDelete || !localRootPath || !representative) return null;
    return { kind: "local_root", locationId: representative.locationId, title: "Work root", path: localRootPath, sizeBytes: null };
  }, [allowLocalDelete, fileTargets, localRootPath]);
  const targets = useMemo(() => rootTarget ? [...fileTargets, rootTarget] : fileTargets, [fileTargets, rootTarget]);
  const selectedTargets = useMemo(() => targets.filter((target) => selectedKeys.has(mediaDeleteTargetKey(target))), [targets, selectedKeys]);
  const selectedSignature = selectedTargets.map(mediaDeleteTargetKey).sort().join("|");
  const previewSignature = previewTargets.map(mediaDeleteTargetKey).sort().join("|");
  const previewRefreshing = selectedTargets.length > 0 && selectedSignature !== previewSignature;
  const allSelected = targets.length > 0 && selectedTargets.length === targets.length;
  const toggleAll = () => setSelectedKeys(allSelected ? new Set() : new Set(targets.map(mediaDeleteTargetKey)));
  const extensionSelection = (extension: string) => {
    const matching = targets.filter((target) => target.path.toLowerCase().endsWith(`.${extension}`));
    const selected = matching.filter((target) => selectedKeys.has(mediaDeleteTargetKey(target))).length;
    return {
      count: matching.length,
      checked: matching.length > 0 && selected === matching.length,
      indeterminate: selected > 0 && selected < matching.length,
    };
  };
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
  const confirmDelete = () => {
    onDeleteTargets?.(previewTargets);
    setConfirmStep(0);
    setSelectedKeys(new Set());
  };

  useEffect(() => {
    const timer = window.setTimeout(() => setPreviewTargets(selectedTargets), selectedTargets.length === 0 ? 0 : 600);
    return () => window.clearTimeout(timer);
  }, [selectedSignature, selectedTargets]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4" onMouseDown={onClose}>
      <div className="flex max-h-[86vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border bg-background shadow-xl" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex min-h-12 items-center justify-between gap-3 border-b px-4">
          <div>
            <h3 className="text-base font-semibold">Manage files</h3>
            <p className="text-xs text-muted-foreground">Review file operations in the same folder structure as the directory tree.</p>
          </div>
          <IconButton title="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden bg-card md:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.75fr)]">
          <div className="app-scroll min-h-0 overflow-auto border-b p-3 md:border-b-0 md:border-r">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" disabled={targets.length === 0 || deleting} onClick={() => setSelectedKeys(new Set(targets.map(mediaDeleteTargetKey)))}>All</Button>
              {(["mp3", "wav", "flac"] as const).map((extension) => {
                const state = extensionSelection(extension);
                return (
                  <label key={extension} className="inline-flex h-8 items-center gap-2 rounded-md border bg-background px-2 text-xs">
                    <Checkbox
                      checked={state.checked}
                      indeterminate={state.indeterminate}
                      disabled={deleting || state.count === 0}
                      onCheckedChange={() => setExtensionIncluded(extension, !state.checked)}
                      aria-label={`Include ${extension.toUpperCase()}`}
                    />
                    <span>{extension.toUpperCase()}</span>
                  </label>
                );
              })}
              <Button variant="outline" size="sm" disabled={deleting} onClick={() => setSelectedKeys(new Set())}>None</Button>
              {showCachedFilter && (
                <label className="ml-auto inline-flex h-8 items-center gap-2 rounded-md border bg-background px-2 text-xs">
                  <Checkbox checked={showOnlyDeletable} onCheckedChange={setShowOnlyDeletable} aria-label="Show cached files only" />
                  <span>Cached only</span>
                </label>
              )}
            </div>
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
                  <div key={mediaDeleteTargetKey(target)} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 border-b py-2 text-xs last:border-b-0">
                    <Badge variant="outline" className="row-span-2 h-fit">{target.kind}</Badge>
                    <span className="truncate font-medium" title={target.path}>{target.path}</span>
                    <span className="text-muted-foreground">{target.title}{target.sizeBytes !== null ? ` · ${formatBytes(target.sizeBytes)}` : ""}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" disabled={targets.length === 0 || deleting} onClick={toggleAll}>{allSelected ? "Clear all" : "Select all"}</Button>
            <span className="text-xs text-muted-foreground">{selectedTargets.length} selected / {targets.length} deletable</span>
          </div>
          <Button className="bg-destructive text-destructive-foreground hover:bg-destructive/90" size="sm" disabled={selectedTargets.length === 0 || previewRefreshing || deleting} onClick={() => setConfirmStep(1)}>
            <Trash2 className="h-4 w-4" />
            {deleting ? "Deleting" : previewRefreshing ? "Refreshing preview" : "Review deletion"}
          </Button>
        </div>
      </div>
      {confirmStep > 0 && (
        <ConfirmMediaBatchDeleteModal
          targets={previewTargets}
          step={confirmStep === 2 ? 2 : 1}
          deleting={deleting}
          onCancel={() => setConfirmStep(0)}
          onContinue={() => setConfirmStep(2)}
          onConfirm={confirmDelete}
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
      {rootTarget && (() => {
        const rootTargets = [...directoryManageTargets(root, { allowCacheDelete, allowLocalDelete }), rootTarget];
        const selectedCount = rootTargets.filter((target) => selectedKeys.has(mediaDeleteTargetKey(target))).length;
        const checked = selectedCount === rootTargets.length;
        const mixed = selectedCount > 0 && !checked;
        return (
          <div className="flex min-h-9 items-center gap-2 rounded-md px-2 text-sm font-medium hover:bg-muted">
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
            <Checkbox checked={checked} indeterminate={mixed} onCheckedChange={() => rootTargets.forEach((target) => onToggleTarget(target, !checked))} aria-label={`Select work root ${rootTarget.path}`} />
            <Folder className="h-4 w-4 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate" title={rootTarget.path}>{rootTarget.path}</span>
            <span className="text-xs text-muted-foreground">{selectedCount}/{rootTargets.length}</span>
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
  const folders = sortedFolders(node).filter((folder) => !showOnlyDeletable || directoryManageTargets(folder, options).length > 0);
  const files = sortedFiles(node).filter((file) => !showOnlyDeletable || mediaDeleteTargetsForFile(file, options).length > 0);
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
            {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
          </button>
          <Checkbox checked={checked} indeterminate={mixed} disabled={nodeTargets.length === 0} onCheckedChange={toggleNode} aria-label={`Select ${node.name}`} />
          <Folder className="h-4 w-4 shrink-0 text-primary" />
          <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => setOpen((value) => !value)}>{node.name}</button>
          <span className="shrink-0 text-xs text-muted-foreground">{selectedCount}/{nodeTargets.length} · {formatFolderStats(stats, playableFiles(node.files).length)}</span>
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
  const fileMeta = [file.kind === "audio" ? formatDuration(file.durationSeconds) : "", formatBytes(file.sizeBytes), file.locationType].filter(Boolean).join(" · ");
  return (
    <div
      className="grid min-h-10 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm"
      style={{ marginLeft: depth * 14, width: `calc(100% - ${depth * 14}px)` }}
    >
      <Checkbox checked={checked} indeterminate={mixed} disabled={targets.length === 0} onCheckedChange={toggleFile} aria-label={`Select ${file.title}`} />
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
        {targets.map((target) => <Badge key={mediaDeleteTargetKey(target)} variant="outline">{target.kind === "cache" ? "Cache" : "Local"}</Badge>)}
        {targets.length === 0 && (
          <span className="inline-flex h-8 items-center text-xs text-muted-foreground">No file action</span>
        )}
      </div>
    </div>
  );
}

function ConfirmMediaBatchDeleteModal({
  targets,
  step,
  deleting,
  onCancel,
  onContinue,
  onConfirm,
}: {
  targets: MediaDeleteTarget[];
  step: 1 | 2;
  deleting: boolean;
  onCancel: () => void;
  onContinue: () => void;
  onConfirm: () => void;
}) {
  const localCount = targets.filter((target) => target.kind === "local").length;
  const cacheCount = targets.filter((target) => target.kind === "cache").length;
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/55 p-4" onMouseDown={onCancel}>
      <div className="w-full max-w-lg rounded-lg border bg-background shadow-xl" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b p-4">
          <div>
            <h3 className="text-base font-semibold">{step === 1 ? "Review deletion" : "Final confirmation"}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{step === 1 ? "Confirm that the refreshed preview contains only the intended files." : "Deleted files cannot be restored by Kikoto."}</p>
          </div>
          <IconButton title="Close" onClick={onCancel}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="space-y-3 p-4 text-sm">
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive">
            Delete {targets.length} selected location{targets.length === 1 ? "" : "s"}{localCount > 0 ? `, including ${localCount} local` : ""}{cacheCount > 0 ? ` and ${cacheCount} cache` : ""}.
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
        </div>
        <div className="flex justify-end gap-2 border-t p-4">
          <Button variant="outline" onClick={onCancel} disabled={deleting}>
            Cancel
          </Button>
          {step === 1 ? (
            <Button onClick={onContinue} disabled={targets.length === 0}>Continue</Button>
          ) : (
            <Button className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={onConfirm} disabled={deleting || targets.length === 0}>
              <Trash2 className="h-4 w-4" />
              {deleting ? "Deleting" : "Permanently delete"}
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

function mediaDeleteTargetsForFile(file: TreeTrack, options: { allowCacheDelete?: boolean; allowLocalDelete?: boolean }) {
  const targets: MediaDeleteTarget[] = [];
  if (options.allowCacheDelete && file.cacheAvailable && file.cacheLocationId !== null) {
    targets.push({ kind: "cache", locationId: file.cacheLocationId, title: file.title, path: file.cachePath, sizeBytes: file.sizeBytes });
  }
  if (options.allowLocalDelete && file.localAvailable && file.localLocationId !== null) {
    targets.push({ kind: "local", locationId: file.localLocationId, title: file.title, path: file.localPath, sizeBytes: file.sizeBytes });
  }
  return targets;
}

function mediaDeleteTargetKey(target: MediaDeleteTarget) {
  return `${target.kind}:${target.locationId}`;
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
  return candidates.sort((left, right) =>
    right.score - left.score
    || right.audioCount - left.audioCount
    || right.durationSeconds - left.durationSeconds
    || left.path.length - right.path.length
    || left.order - right.order,
  )[0];
}

function directoryRouteSummary(root: TreeNode, rules: DirectoryRoutingRule[]): DirectoryRouteMatch | null {
  const candidate = recommendedDirectoryCandidate(root, rules);
  if (!candidate) return null;
  return {
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
  const text = normalizeDirectoryMatchText([
    ...path,
    node.name,
    node.path,
    ...files.map((file) => file.title),
    ...files.map((file) => file.baseName),
  ].join(" / "));
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

function remoteSelectableFiles(root: TreeNode) {
  const files: TreeTrack[] = [];
  const visit = (node: TreeNode) => {
    files.push(...node.files.filter((file) => file.downloadUrl || file.streamUrl));
    for (const child of node.children.values()) visit(child);
  };
  visit(root);
  return files;
}

function remoteSelectablePaths(root: TreeNode) {
  return remoteSelectableFiles(root).map((file) => file.sourcePath);
}

function remoteFetchLocalItems(plan?: RemoteWorkSavePlan | null) {
  return (plan?.items ?? [])
    .filter((item) => item.targetExists || item.localPaths.length > 0)
    .sort((a, b) => naturalCompare(a.targetPath, b.targetPath));
}

function remoteFetchLocalDisplayPaths(item: RemoteWorkSavePlan["items"][number]) {
  const paths = [...item.localPaths];
  if (item.targetExists && !paths.includes(item.targetPath)) paths.unshift(item.targetPath);
  return paths.length > 0 ? paths : [item.targetPath];
}

function buildRemoteFetchLocalTree(plan?: RemoteWorkSavePlan | null) {
  const root: RemoteFetchLocalTree = { name: "", path: "", children: new Map(), items: [] };
  const localFiles = plan?.localFiles ?? [];
  const rootPrefix = commonLocalPathPrefix(localFiles.map((file) => file.path));
  const remoteByLocalPath = remoteFetchRemotePathByLocalPath(plan);
  for (const file of localFiles) {
    const displayPath = trimLocalRootPrefix(file.path, rootPrefix);
    const parts = displayPath.split(/[\\/]+/).filter(Boolean);
    const folders = parts.slice(0, -1);
    let cursor = root;
    let cursorPath = "";
    for (const folder of folders) {
      cursorPath = cursorPath ? `${cursorPath}/${folder}` : folder;
      let child = cursor.children.get(folder);
      if (!child) {
        child = { name: folder, path: cursorPath, children: new Map(), items: [] };
        cursor.children.set(folder, child);
      }
      cursor = child;
    }
    cursor.items.push({
      name: parts[parts.length - 1] ?? file.path,
      path: displayPath,
      fullPath: file.path,
      sizeBytes: file.sizeBytes,
      available: file.available,
      remotePath: remoteByLocalPath.get(file.path) ?? null,
    });
  }
  return root;
}

function remoteFetchLocalTreeItems(node: RemoteFetchLocalTree): RemoteFetchLocalTreeItem[] {
  return [...node.items, ...Array.from(node.children.values()).flatMap((child) => remoteFetchLocalTreeItems(child))];
}

function remoteFetchRemotePathByLocalPath(plan?: RemoteWorkSavePlan | null) {
  const result = new Map<string, string>();
  for (const item of plan?.items ?? []) {
    for (const localPath of remoteFetchLocalDisplayPaths(item)) {
      result.set(localPath, item.path);
    }
  }
  return result;
}

function commonLocalPathPrefix(paths: string[]) {
  if (paths.length === 0) return "";
  const splitPaths = paths.map((path) => {
    const parts = path.split(/[\\/]+/).filter(Boolean);
    return parts.slice(0, -1);
  });
  const prefix: string[] = [];
  for (let index = 0; ; index += 1) {
    const segment = splitPaths[0]?.[index];
    if (!segment || splitPaths.some((parts) => parts[index] !== segment)) break;
    prefix.push(segment);
  }
  if (prefix.length <= 1) return "";
  return prefix.join("/");
}

function trimLocalRootPrefix(path: string, prefix: string) {
  const normalized = path.replace(/\\/g, "/");
  if (!prefix) return normalized;
  return normalized === prefix ? normalized.split("/").pop() ?? normalized : normalized.startsWith(`${prefix}/`) ? normalized.slice(prefix.length + 1) : normalized;
}

function formatRemoteFetchPreparation(plan: RemoteWorkSavePlan) {
  if (hasRemoteFetchConflicts(plan)) return formatRemoteFetchPlanConflict(plan);
  const editions = plan.preparation?.editions.length ?? 0;
  const local = plan.localFiles.length;
  const warning = plan.preparation?.warnings[0];
  const summary = `Review ${editions || 1} language ${editions === 1 ? "edition" : "editions"}, ${local} local files, and the planned result before fetching.`;
  return warning ? `${summary} Metadata is ${plan.preparation.metadataStatus}: ${warning}` : summary;
}

function sortedFolders(node: TreeNode) {
  return Array.from(node.children.values()).sort((a, b) => naturalCompare(a.name, b.name));
}

function sortedFiles(node: TreeNode) {
  return [...node.files].sort((a, b) => naturalCompare(a.title, b.title));
}

function sortedFilesDeep(node: TreeNode) {
  const files = [...node.files];
  for (const child of node.children.values()) {
    files.push(...sortedFilesDeep(child));
  }
  return files.sort((a, b) => naturalCompare(a.sourcePath || a.title, b.sourcePath || b.title));
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
  return sortedFolders(node).some((child) => folderNameHasPriority(child.name) && playableFiles(child.files).length > 0);
}

function flattenVisibleTreeRows(root: TreeNode, expandedPaths: Set<string>) {
  const rows: VisibleTreeRow[] = [];
  for (const file of sortedFiles(root)) {
    rows.push({ type: "file", file, parent: root, depth: 0 });
  }
  const visit = (node: TreeNode, depth: number) => {
    rows.push({ type: "folder", node, depth });
    if (!expandedPaths.has(node.path)) return;
    for (const file of sortedFiles(node)) {
      rows.push({ type: "file", file, parent: node, depth: depth + 1 });
    }
    for (const child of sortedFolders(node)) {
      visit(child, depth + 1);
    }
  };
  for (const folder of sortedFolders(root)) {
    visit(folder, 0);
  }
  return rows;
}

function playableFiles(files: TreeTrack[]) {
  return files.filter((file) => file.kind === "audio" && ["available", "remote"].includes(file.availability) && file.streamUrl);
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

type TreeStats = {
  files: number;
  audio: number;
  sizeBytes: number;
  knownSizeFiles: number;
  durationSeconds: number;
  knownDurationAudio: number;
};

function treeStats(node: TreeNode): TreeStats {
  const stats: TreeStats = { files: 0, audio: 0, sizeBytes: 0, knownSizeFiles: 0, durationSeconds: 0, knownDurationAudio: 0 };
  const visit = (cursor: TreeNode) => {
    for (const file of cursor.files) {
      stats.files += 1;
      if (file.kind === "audio") stats.audio += 1;
      if (file.sizeBytes !== null && file.sizeBytes >= 0) {
        stats.sizeBytes += file.sizeBytes;
        stats.knownSizeFiles += 1;
      }
      if (file.kind === "audio" && file.durationSeconds !== null && file.durationSeconds > 0) {
        stats.durationSeconds += file.durationSeconds;
        stats.knownDurationAudio += 1;
      }
    }
    for (const child of cursor.children.values()) visit(child);
  };
  visit(node);
  return stats;
}

function formatTreeStats(stats: TreeStats) {
  const parts = [
    stats.audio > 0 ? `${stats.audio} audio` : stats.files > 0 ? `${stats.files} files` : "",
    stats.knownSizeFiles > 0 ? formatBytes(stats.sizeBytes) : "",
    stats.knownDurationAudio > 0 ? formatDuration(stats.durationSeconds) : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "";
}

function formatFolderStats(stats: TreeStats, directPlayableCount: number) {
  const countLabel = directPlayableCount > 0 ? `${directPlayableCount} audio` : stats.files > 0 ? `${stats.files} files` : "";
  const sizeLabel = stats.knownSizeFiles > 0 ? formatBytes(stats.sizeBytes) : "";
  return [countLabel, sizeLabel].filter(Boolean).join(" · ");
}

function naturalCompare(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function fileIcon(file: TreeTrack) {
  if (file.kind === "audio") return <FileAudio className="h-4 w-4 text-muted-foreground" />;
  if (file.kind === "image") return <ImageIcon className="h-4 w-4 text-muted-foreground" />;
  if (file.kind === "text") return <FileText className="h-4 w-4 text-muted-foreground" />;
  return <FileText className="h-4 w-4 text-muted-foreground" />;
}

function previewForFile(file: TreeTrack): FilePreviewState | null {
  if (file.kind === "image" && file.assetUrl) {
    return { kind: "image", title: file.title, url: file.assetUrl, locationId: file.locationId, canSetCover: file.locationType === "local" && file.locationId > 0 };
  }
  if (file.kind === "text" && file.locationId > 0) {
    return { kind: "text", title: file.title, locationId: file.locationId };
  }
  return null;
}

function FilePreviewModal({ preview, onClose, onSetCover }: { preview: FilePreviewState; onClose: () => void; onSetCover?: (locationId: number) => void | Promise<void> }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setText(null);
    setError("");
    if (preview.kind !== "text") return;
    api.getMediaText(preview.locationId).then((result) => setText(result.content)).catch((err) => {
      setError(err instanceof Error ? err.message : "Text preview failed.");
    });
  }, [preview]);

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
              <Button variant="outline" size="sm" disabled={!onSetCover || !preview.canSetCover} onClick={() => void onSetCover?.(preview.locationId)}>
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
            <img src={assetURL(preview.url)} alt="" className="mx-auto max-h-[72vh] max-w-full rounded-md object-contain" />
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

function flattenTracks(root: TreeNode) {
  const tracks: TreeTrack[] = [];
  const visit = (node: TreeNode) => {
    tracks.push(...playableFiles(node.files));
    for (const child of node.children.values()) {
      visit(child);
    }
  };
  visit(root);
  return tracks;
}

function latestResumeTrack(tracks: TreeTrack[]) {
  return tracks
    .filter((track) => track.progress && !track.progress.completed && track.progress.positionSeconds > 0)
    .sort((left, right) => {
      const leftTime = left.progress?.lastPlayedAt ? Date.parse(left.progress.lastPlayedAt) : 0;
      const rightTime = right.progress?.lastPlayedAt ? Date.parse(right.progress.lastPlayedAt) : 0;
      return rightTime - leftTime;
    })[0] ?? null;
}

function countTreeFiles(root: TreeNode) {
  let count = root.files.length;
  for (const child of root.children.values()) {
    count += countTreeFiles(child);
  }
  return count;
}

function toPlayerTrack(track: TreeTrack, work: WorkDetail): PlayerTrack {
  const lyricsChoices = findLyricsForTrack(track, work.mediaItems);
  const audioItem = work.mediaItems.find((item) => item.id === track.mediaItemId);
  const automaticLyrics = lyricsChoices[0] ?? null;
  const lyrics = lyricsChoices.find((choice) => choice.mediaItemId === audioItem?.preferredLyricsMediaItemId) ?? automaticLyrics;
  return {
    ...track,
    workId: work.id,
    workCode: work.primaryCode,
    workTitle: work.title,
    coverUrl: work.coverUrl,
    circle: work.circle,
    progress: track.progress,
    progressRecordable: true,
    lyricsLocationId: lyrics?.locationId ?? null,
    lyricsTitle: lyrics?.title ?? "",
    lyricsChoices,
    autoLyricsLocationId: automaticLyrics?.locationId ?? null,
    preferredLyricsMediaItemId: audioItem?.preferredLyricsMediaItemId ?? null,
  };
}

function toRemotePreviewPlayerTrack(track: TreeTrack, detail: RemoteWorkDetail): PlayerTrack {
  return {
    ...track,
    workId: detail.workId ?? 0,
    workCode: detail.primaryCode || detail.remoteId,
    workTitle: detail.title,
    coverUrl: detail.coverUrl,
    circle: detail.circle,
    progress: null,
    progressRecordable: false,
    lyricsLocationId: null,
    lyricsTitle: "",
    lyricsChoices: [],
    autoLyricsLocationId: null,
    preferredLyricsMediaItemId: null,
    remoteSourceId: detail.sourceId,
    remoteWorkCode: detail.primaryCode || detail.remoteId,
    remotePath: track.sourcePath,
  };
}

function findLyricsForTrack(track: TreeTrack, items: MediaItem[]) {
  return findLyricsMatches(track.sourcePath || track.title, items);
}

function fileNameFromPath(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function baseNameWithoutExtension(name: string) {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(0, index) : name;
}

function formatBytes(value: number | null) {
  if (value === null) return "unknown";
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function formatDuration(value: number | null) {
  if (!value || value <= 0) return "Unknown";
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
  return `${minutes}m`;
}

function formatDateTime(value: string) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
}

function ageRatingView(value: string) {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
  case "adult":
  case "r18":
  case "r-18":
  case "18":
    return { label: "R18", className: "text-destructive" };
  case "r15":
  case "r-15":
  case "15":
    return { label: "R15", className: "text-blue-600" };
  case "general":
  case "all":
  case "全年齢":
  case "all ages":
    return { label: "全年齢", className: "text-emerald-600" };
  case "":
    return { label: "Unknown", className: "text-muted-foreground" };
  default:
    return { label: value, className: "text-foreground" };
  }
}

function languageLabel(value: string) {
  switch (value.trim().toLowerCase()) {
  case "ja":
  case "ja-jp":
	case "jpn":
    return "Japanese";
  case "en":
  case "en-us":
	case "eng":
    return "English";
  case "zh":
  case "zh-cn":
	case "chi_hans":
    return "Simplified Chinese";
  case "zh-tw":
	case "chi_hant":
    return "Traditional Chinese";
  case "ko":
  case "ko-kr":
	case "ko_kr":
    return "Korean";
  default:
    return value || "Unknown";
  }
}

function openWorkCodeRoute(code: string, sourceIntent?: DetailSourceIntent) {
  const cleanCode = code.trim();
  if (!cleanCode) return;
  const query = sourceIntent ? `?view=${sourceIntent}` : "";
  window.history.pushState({ returnTo: window.location.pathname, returnLabel: "Back" }, "", `/${cleanCode}${query}`);
  window.dispatchEvent(new Event("kikoto:navigation"));
}

function detailSourceIntentFromLocation(search: string): DetailSourceIntent {
  return new URLSearchParams(search).get("view") === "tracked" ? "tracked" : "local";
}

function detailReturnTarget(fallbackPath: string) {
  const state = window.history.state as { returnTo?: unknown; returnLabel?: unknown } | null;
  const path = typeof state?.returnTo === "string" && isInternalReturnPath(state.returnTo) ? state.returnTo : fallbackPath;
  const label = typeof state?.returnLabel === "string" && state.returnLabel.trim() ? state.returnLabel : "Back";
  return { path, label };
}

function isInternalReturnPath(path: string) {
  return path.startsWith("/") && !path.startsWith("//");
}

async function resolveAndOpenWork(
  code: string,
  setSelectedWork: (work: WorkDetail | null) => void,
  setSelectedWorkPreview: (work: WorkPreview | null) => void,
  setSelectedCode: (code: string | null) => void,
  setMediaLoading: (loading: boolean) => void,
  signal?: AbortSignal,
) {
  try {
    setMediaLoading(true);
    const resolved = await api.resolveWorkCode(code, signal);
    setSelectedWorkPreview(workPreviewFromResolve(resolved));
    const work = await api.getWorkSummary(resolved.workId, signal);
    setSelectedWork(work);
    const media = await api.getWorkMedia(resolved.workId, signal);
    setSelectedWork({ ...work, mediaItems: media.mediaItems });
    if (resolved.resolvedCode && resolved.resolvedCode.toUpperCase() !== code.toUpperCase()) {
      window.history.replaceState(window.history.state ?? {}, "", `/${resolved.resolvedCode}`);
      setSelectedCode(resolved.resolvedCode);
      window.dispatchEvent(new Event("kikoto:navigation"));
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    setSelectedWork(null);
  } finally {
    if (!signal?.aborted) setMediaLoading(false);
  }
}

function workPreviewFromHistory(code: string | null): WorkPreview | null {
  const value = (window.history.state as { workPreview?: unknown } | null)?.workPreview;
  if (!code || !value || typeof value !== "object") return null;
  const preview = value as Partial<WorkPreview>;
  if (typeof preview.primaryCode !== "string" || preview.primaryCode.toUpperCase() !== code.toUpperCase()) return null;
  return {
    primaryCode: preview.primaryCode,
    title: typeof preview.title === "string" ? preview.title : preview.primaryCode,
    coverUrl: typeof preview.coverUrl === "string" ? preview.coverUrl : "",
    circle: typeof preview.circle === "string" ? preview.circle : "",
    circleExternalId: typeof preview.circleExternalId === "string" ? preview.circleExternalId : "",
    rating: typeof preview.rating === "number" ? preview.rating : null,
    sales: typeof preview.sales === "number" ? preview.sales : null,
    releaseDate: typeof preview.releaseDate === "string" ? preview.releaseDate : null,
    tags: Array.isArray(preview.tags) ? preview.tags.filter((item): item is string => typeof item === "string") : [],
    voiceActors: Array.isArray(preview.voiceActors) ? preview.voiceActors.filter((item): item is string => typeof item === "string") : [],
  };
}

function workPreviewFromResolve(resolved: Awaited<ReturnType<typeof api.resolveWorkCode>>): WorkPreview {
  return {
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

function listeningStatusLabel(status: ListeningStatus) {
  return listeningStatusOptions.find((option) => option.value === status)?.label ?? "Unmarked";
}

function parseSearchClauses(query: string): SearchClause[] {
  const clauses: SearchClause[] = [];
  let rest = query;
  const wrappedPattern = /\$(-?tagw?|-?circle|-?va|duration|-duration|rate|sell|age|lang):([^$]+)\$/gi;
  rest = rest.replace(wrappedPattern, (_match, key: string, value: string) => {
    const clause = searchClauseFromKeyValue(key, value);
    if (clause) clauses.push(clause);
    return " ";
  });
  const parts = splitSearchParts(rest);
  for (let index = 0; index < parts.length; index++) {
    const rawPart = parts[index];
    const part = rawPart.trim();
    if (!part) continue;
    const pendingPrefix = part.match(/^(-?tagw?|-?circle|-?va|circle|va|voice|creator|tag|duration|-duration|rate|rating|sell|sales|age|lang|language):$/i);
    if (pendingPrefix && index + 1 < parts.length) {
      const clause = searchClauseFromKeyValue(pendingPrefix[1], parts[index + 1]);
      if (clause) {
        clauses.push(clause);
        index += 1;
        continue;
      }
    }
    const prefixed = part.match(/^(-?tagw?|-?circle|-?va|circle|va|voice|creator|tag|duration|-duration|rate|rating|sell|sales|age|lang|language):(.+)$/i);
    if (prefixed) {
      const clause = searchClauseFromKeyValue(prefixed[1], prefixed[2]);
      if (clause) {
        clauses.push(clause);
        continue;
      }
    }
    if (/^(RJ|BJ|VJ|CC)\d{4,8}$/i.test(part)) {
      clauses.push({ kind: "code", value: part.toUpperCase() });
    } else {
      clauses.push({ kind: "text", value: part });
    }
  }
  return clauses.filter((clause) => clause.value.trim() !== "");
}

function splitSearchParts(value: string) {
  const parts: string[] = [];
  const pattern = /(\S+):"([^"]+)"|(\S+):'([^']+)'|"([^"]+)"|'([^']+)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    if (match[1]) {
      parts.push(`${match[1]}:${match[2]}`);
    } else if (match[3]) {
      parts.push(`${match[3]}:${match[4]}`);
    } else {
      parts.push(match[5] ?? match[6] ?? match[7] ?? "");
    }
  }
  return parts;
}

function versionedMediaAssetURL(locationId: number, fingerprint: string, sizeBytes: number | null) {
  const revision = `${fingerprint}:${sizeBytes ?? "unknown"}`;
  return `/api/media/${locationId}/asset?v=${encodeURIComponent(revision)}`;
}

function LibraryLoadErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card className="border-destructive/35">
      <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-semibold text-destructive">Library could not be loaded.</div>
          <div className="mt-1 text-xs text-muted-foreground">{message}</div>
        </div>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="h-4 w-4" />
          Retry
        </Button>
      </CardContent>
    </Card>
  );
}

function searchClauseFromKeyValue(key: string, rawValue: string): SearchClause | null {
  const normalizedKey = key.trim().toLowerCase();
  const value = rawValue.trim();
  if (!value) return null;
  switch (normalizedKey) {
    case "circle":
      return { kind: "circle", value };
    case "-circle":
      return { kind: "text", value: `-${value}` };
    case "va":
    case "-va":
    case "voice":
    case "creator":
      return { kind: "voice_actor", value };
    case "tag":
    case "tagw":
      return { kind: "tag", value };
    case "-tag":
    case "-tagw":
      return { kind: "exclude_tag", value };
    case "rate":
    case "rating":
      return { kind: "rating_min", value };
    case "sell":
    case "sales":
      return { kind: "sales_min", value };
    case "duration":
      return { kind: "duration_min", value };
    case "-duration":
      return { kind: "duration_max", value };
    case "age":
      return { kind: "age", value };
    case "lang":
    case "language":
      return { kind: "language", value };
    default:
      return null;
  }
}

function normalizeSearchClauseDraft(draft: SearchClauseDraft): SearchClause | null {
  const value = draft.value.trim();
  if (!value) return null;
  if (draft.kind === "code") {
    return { kind: "code", value: value.toUpperCase() };
  }
  return { kind: draft.kind, value };
}

function compileLibrarySearchQuery(clauses: SearchClause[]) {
  return clauses.map((clause) => {
    switch (clause.kind) {
      case "code":
      case "text":
        return clause.value;
      case "circle":
        return `$circle:${clause.value}$`;
      case "voice_actor":
        return `$va:${clause.value}$`;
      case "tag":
        return `$tag:${clause.value}$`;
      case "exclude_tag":
        return `$-tag:${clause.value}$`;
      case "rating_min":
        return `rating:${clause.value}`;
      case "sales_min":
        return `sales:${clause.value}`;
      case "age":
        return `$age:${clause.value}$`;
      case "language":
        return `$lang:${clause.value}$`;
      default:
        return clause.value;
    }
  }).join(" ");
}

function formatRemoteSearchQuery(clauses: SearchClause[]) {
  return clauses.map(formatRemoteSearchClause).join(" ");
}

function formatRemoteSearchClause(clause: SearchClause) {
  switch (clause.kind) {
    case "circle":
      return `$circle:${clause.value}$`;
    case "voice_actor":
      return `$va:${clause.value}$`;
    case "tag":
      return `$tag:${clause.value}$`;
    case "exclude_tag":
      return `$-tag:${clause.value}$`;
    case "duration_min":
      return `$duration:${clause.value}$`;
    case "duration_max":
      return `$-duration:${clause.value}$`;
    case "rating_min":
      return `$rate:${clause.value}$`;
    case "sales_min":
      return `$sell:${clause.value}$`;
    case "age":
      return `$age:${clause.value}$`;
    case "language":
      return `$lang:${clause.value}$`;
    default:
      return formatSearchClause(clause);
  }
}

function workMatchesSearch(work: Work, clauses: SearchClause[]) {
  if (clauses.length === 0) return true;
  return clauses.every((clause) => workMatchesClause(work, clause));
}

function workMatchesClause(work: Work, clause: SearchClause) {
  const value = clause.value.trim().toLowerCase();
  if (!value) return true;
  switch (clause.kind) {
    case "code":
      return work.primaryCode.toLowerCase().includes(value);
    case "circle":
      return work.circle.toLowerCase().includes(value) || work.circleExternalId.toLowerCase().includes(value);
    case "voice_actor":
      return work.voiceActors.some((actor) => actor.toLowerCase().includes(value));
    case "tag":
      return work.tags.some((tag) => tag.toLowerCase().includes(value));
    case "exclude_tag":
      return !work.tags.some((tag) => tag.toLowerCase().includes(value));
    case "rating_min":
      return work.rating !== null && work.rating >= numericClauseValue(value);
    case "sales_min":
      return work.sales !== null && work.sales >= numericClauseValue(value);
    case "age":
      return workMatchesText([work.primaryCode, work.title, ...work.tags], value);
    case "language":
      return workMatchesText([work.title, ...work.tags], value);
    case "duration_min":
    case "duration_max":
      return true;
    case "text":
    default:
      return workMatchesText(
        [work.primaryCode, work.title, work.circle, work.circleExternalId, work.releaseDate ?? "", ...work.tags, ...work.voiceActors],
        value,
      );
  }
}

function workMatchesText(values: string[], needle: string) {
  return values.some((item) => item.toLowerCase().includes(needle));
}

function remoteWorkMatchesSearch(work: RemoteWork, clauses: SearchClause[]) {
  if (clauses.length === 0) return true;
  return clauses.every((clause) => remoteWorkMatchesClause(work, clause));
}

function remoteWorkMatchesClause(work: RemoteWork, clause: SearchClause) {
  const value = clause.value.trim().toLowerCase();
  if (!value) return true;
  switch (clause.kind) {
    case "code":
      return work.primaryCode.toLowerCase().includes(value) || work.remoteId.toLowerCase().includes(value);
    case "circle":
      return work.circle.toLowerCase().includes(value);
    case "tag":
      return work.tags.some((tag) => tag.toLowerCase().includes(value));
    case "exclude_tag":
      return !work.tags.some((tag) => tag.toLowerCase().includes(value));
    case "rating_min":
      return work.rating !== null && work.rating >= numericClauseValue(value);
    case "sales_min":
      return work.sales !== null && work.sales >= numericClauseValue(value);
    case "voice_actor":
    case "age":
    case "language":
    case "duration_min":
    case "duration_max":
      return true;
    case "text":
    default:
      return workMatchesText([work.primaryCode, work.remoteId, work.title, work.circle, work.releaseDate, ...work.tags], value);
  }
}

function numericClauseValue(value: string) {
  const number = Number(value.replace(/[^\d.]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function searchClauseLabel(clause: SearchClause) {
  switch (clause.kind) {
    case "code":
      return `Code: ${clause.value}`;
    case "circle":
      return `Circle: ${clause.value}`;
    case "voice_actor":
      return `VA: ${clause.value}`;
    case "tag":
      return `Tag: ${clause.value}`;
    case "exclude_tag":
      return `Exclude tag: ${clause.value}`;
    case "rating_min":
      return `Rating >= ${clause.value}`;
    case "sales_min":
      return `Sales >= ${clause.value}`;
    case "duration_min":
      return `Duration >= ${clause.value}`;
    case "duration_max":
      return `Duration <= ${clause.value}`;
    case "age":
      return `Age: ${clause.value}`;
    case "language":
      return `Language: ${clause.value}`;
    case "text":
    default:
      return `Text: ${clause.value}`;
  }
}

function searchQueryWithoutClause(clauses: SearchClause[], removeIndex: number) {
  return clauses.filter((_clause, index) => index !== removeIndex).map(formatSearchClause).join(" ");
}

function formatSearchClause(clause: SearchClause) {
  const value = formatSearchValue(clause.value);
  switch (clause.kind) {
    case "code":
    case "text":
      return value;
    case "circle":
      return `circle:${value}`;
    case "voice_actor":
      return `va:${value}`;
    case "tag":
      return `tag:${value}`;
    case "exclude_tag":
      return `-tag:${value}`;
    case "rating_min":
      return `rating:${clause.value}`;
    case "sales_min":
      return `sales:${clause.value}`;
    case "duration_min":
      return `duration:${clause.value}`;
    case "duration_max":
      return `-duration:${clause.value}`;
    case "age":
      return `age:${value}`;
    case "language":
      return `lang:${value}`;
    default:
      return value;
  }
}

function formatSearchValue(value: string) {
  return /\s/.test(value) ? `"${value.replace(/"/g, "")}"` : value;
}

function codeFromPath(path: string) {
  const match = path.match(WORK_CODE_PATTERN);
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
  const sourceID = Number(params.get("source"));
  if (!Number.isFinite(sourceID) || sourceID <= 0) return null;
  const source = sources.find((candidate) => candidate.id === sourceID);
  return source ? { source, code } : null;
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
  if (WORK_CODE_PATTERN.test(`/${encodedKey}`)) {
    return fallback;
  }
  const key = safeDecodePathSegment(encodedKey).toLowerCase();
  const source = sources.find((item) => sourceRouteKey(item).toLowerCase() === key || item.displayName.toLowerCase() === key);
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
    case "no_source":
      return "/no-source";
    case "local":
      return "/";
	case "remote":
	  return "/library/remote";
	case "all":
	  return "/library/all";
    default:
      return null;
  }
}

function pathForActiveLibrary(tab: LibraryTab, scope: LocalLibraryScope) {
	return tab.kind === "source" ? pathForLibraryTab(tab) : pathForLocalScope(scope) ?? "/";
}

function libraryBrowseKey(tab: LibraryTab, scope: LocalLibraryScope) {
	return tab.kind === "source" ? `source:${tab.source.id}` : `scope:${scope}`;
}

function localScopeFromPath(path: string): LocalLibraryScope {
  if (path === "/tracked" || path === "/library/tracked") return "tracked";
  if (path === "/no-source" || path === "/library/no-source") return "no_source";
	if (path === "/library/remote") return "remote";
	if (path === "/library/all") return "all";
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

function remoteFetchCurrentEditionCode(plan: RemoteWorkSavePlan | null | undefined, activeEditionCode?: string) {
  const active = (activeEditionCode ?? "").trim();
  if (!plan) return active;
  const activeEdition = plan.preparation.editions.find((edition) => edition.primaryCode.toUpperCase() === active.toUpperCase());
  if (activeEdition) return activeEdition.primaryCode;
  const plannedEdition = plan.preparation.editions.find((edition) => edition.primaryCode.toUpperCase() === plan.primaryCode.toUpperCase());
  return plannedEdition?.primaryCode ?? plan.primaryCode;
}

function sourcePresenceActionCode(presence: SourcePresenceItem, fallbackCode: string) {
  return presence.remoteCode || fallbackCode;
}

function remoteAvailabilityRouteCode(summary: SourceAvailabilitySource, fallbackCode: string) {
  return fallbackCode || summary.primaryCode || summary.remoteId;
}

function safeDecodePathSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
