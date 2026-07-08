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
import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode, type RefObject } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toastFromError, useToast } from "@/components/ui/toast";
import { openCircleRoute, openCircleSeriesRoute } from "@/pages/CirclesPage";
import { openVoiceRoute } from "@/pages/CreatorWorksPage";
import {
  api,
  assetURL,
  mediaDownloadURL,
  type LibrarySource,
  type LibrarySort,
  type SortDirection,
  type FavoriteList,
  type ListeningStatus,
  type MediaItem,
  type RemoteTrack,
  type RemoteWorksResponse,
  type RemoteWork,
  type RemoteWorkDetail,
  type RemoteWorkSavePlan,
  type SourceAvailabilitySource,
  type SourcePresenceItem,
  type VoiceCredit,
  type Work,
  type WorkDetail,
} from "@/lib/api";
import { formatRemoteFetchPlanConflict, hasRemoteFetchConflicts } from "@/lib/remoteFetchPlan";
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
import { type PlayerTrack, usePlayer } from "@/player/PlayerProvider";

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
const localWorkPageSizeOptions = [24, 48] as const;
type LocalWorkPageSize = (typeof localWorkPageSizeOptions)[number];
const columnOptions = [1, 2, 3, 4, 5, 6, 7, 8] as const;
type LibraryColumnCount = (typeof columnOptions)[number];
const librarySortOptions: { value: LibrarySort; label: string }[] = [
  { value: "recent", label: "Recently added" },
  { value: "release", label: "Release date" },
  { value: "code", label: "Code" },
  { value: "title", label: "Title" },
  { value: "rating", label: "Rating" },
  { value: "sales", label: "Sales" },
];
const librarySearchDebounceMs = 400;
const remoteSearchDebounceMs = 600;

type RemoteSourceViewState = { page: number; pageSize: number; query: string };
const defaultRemoteSourceViewState: RemoteSourceViewState = { page: 1, pageSize: 24, query: "" };
type SearchTokenKind =
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
type SearchToken = { kind: SearchTokenKind; value: string };
type SearchTokenDraft = { kind: SearchTokenKind; value: string };
const editableSearchTokenKinds: { value: SearchTokenKind; label: string }[] = [
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

export function LibraryPage() {
  const [works, setWorks] = useState<Work[]>([]);
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const [activeTab, setActiveTab] = useState<LibraryTab>(() => tabFromPath(window.location.pathname, []));
  const [localScope, setLocalScope] = useState<LocalLibraryScope>(() => localScopeFromPath(window.location.pathname));
  const [remoteResult, setRemoteResult] = useState<RemoteWorksResponse | null>(null);
  const [isRemoteLoading, setIsRemoteLoading] = useState(false);
  const [remoteSourceStates, setRemoteSourceStates] = useState<Record<number, RemoteSourceViewState>>({});
  const [settings, setSettings] = useState<{ cacheEnabled: boolean } | null>(null);
  const [selectedCode, setSelectedCode] = useState<string | null>(() => codeFromLocation(window.location.pathname, window.location.search));
  const [selectedWork, setSelectedWork] = useState<WorkDetail | null>(null);
  const [selectedWorkPreview, setSelectedWorkPreview] = useState<Work | null>(null);
  const [selectedRemoteTarget, setSelectedRemoteTarget] = useState<{ source: LibrarySource; code: string } | null>(null);
  const [isAPIAvailable, setIsAPIAvailable] = useState(false);
  const [statusFilter, setStatusFilter] = useState<ListeningStatus | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [debouncedRemoteSearchQuery, setDebouncedRemoteSearchQuery] = useState("");
  const [optimisticLibrarySearchTokens, setOptimisticLibrarySearchTokens] = useState<SearchToken[] | null>(null);
  const [tokenEditor, setTokenEditor] = useState<{ mode: "add" | "edit"; index: number | null; draft: SearchTokenDraft } | null>(null);
  const [mobileColumns, setMobileColumns] = useState<LibraryColumnCount>(1);
  const [desktopColumns, setDesktopColumns] = useState<LibraryColumnCount>(6);
  const [librarySort, setLibrarySort] = useState<LibrarySort>("recent");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [workPage, setWorkPage] = useState(1);
  const [workPageSize, setWorkPageSize] = useState<LocalWorkPageSize>(24);
  const [workTotal, setWorkTotal] = useState(0);
  const [untrackTarget, setUntrackTarget] = useState<{ work: Work; source: SourcePresenceItem } | null>(null);
  const [isUntracking, setIsUntracking] = useState(false);
  const [trackedFetchSelection, setTrackedFetchSelection] = useState<{ work: Work; source: LibrarySource; detail: RemoteWorkDetail; selectedPaths: Set<string>; selectedLocalPaths: Set<string>; plan: RemoteWorkSavePlan | null; message: string } | null>(null);
  const [isTrackedFetching, setIsTrackedFetching] = useState(false);
  const libraryRequestSeq = useRef(0);
  const remoteRequestSeq = useRef(0);
  const skipNextLibraryEffect = useRef(false);
  const skipNextRemoteEffect = useRef(false);
  const searchTokens = useMemo(() => parseSearchTokens(searchQuery), [searchQuery]);
  const debouncedSearchTokens = useMemo(() => parseSearchTokens(debouncedSearchQuery), [debouncedSearchQuery]);
  const debouncedRemoteSearchTokens = useMemo(() => parseSearchTokens(debouncedRemoteSearchQuery), [debouncedRemoteSearchQuery]);
  const remoteSearchQuery = useMemo(() => formatRemoteSearchQuery(debouncedRemoteSearchTokens), [debouncedRemoteSearchTokens]);
  const librarySearchQuery = useMemo(() => compileLibrarySearchQuery(debouncedSearchTokens), [debouncedSearchTokens]);
  const workScope = localScope;

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearchQuery(searchQuery), librarySearchDebounceMs);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedRemoteSearchQuery(searchQuery), remoteSearchDebounceMs);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
    if (activeTab.kind === "source") return;
    if (skipNextLibraryEffect.current) {
      skipNextLibraryEffect.current = false;
      return;
    }
    const requestSeq = ++libraryRequestSeq.current;
    api
      .listWorksPage(workPage, workPageSize, librarySearchQuery, workScope, statusFilter, librarySort, sortDirection)
      .then((page) => {
        if (requestSeq !== libraryRequestSeq.current) return;
        setWorks(page.works);
        setWorkTotal(page.total);
        setIsAPIAvailable(true);
        setOptimisticLibrarySearchTokens(null);
      })
      .catch(() => {
        if (requestSeq !== libraryRequestSeq.current) return;
        setWorks([]);
        setWorkTotal(0);
        setIsAPIAvailable(false);
        setOptimisticLibrarySearchTokens(null);
      });
  }, [activeTab.kind, librarySearchQuery, statusFilter, librarySort, sortDirection, workPage, workPageSize, workScope]);

  useEffect(() => {
    api.listLibrarySources().then((items) => {
      setSources(items);
      setActiveTab((tab) => resolveTabFromPath(window.location.pathname, items, tab));
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
    const sourceState = remoteSourceStates[activeTab.source.id] ?? defaultRemoteSourceViewState;
    const requestSeq = ++remoteRequestSeq.current;
    setRemoteResult((current) => (current?.sourceId === activeTab.source.id ? current : null));
    setIsRemoteLoading(true);
    api.listRemoteSourceWorks(activeTab.source.id, sourceState.page, sourceState.pageSize, remoteSearchQuery).then((result) => {
      if (requestSeq !== remoteRequestSeq.current) return;
      setRemoteResult(result);
    }).catch(() => {
      if (requestSeq !== remoteRequestSeq.current) return;
      setRemoteResult({
        sourceId: activeTab.source.id,
        works: [],
        page: sourceState.page,
        pageSize: sourceState.pageSize,
        total: 0,
        status: "unavailable",
      });
    }).finally(() => {
      if (requestSeq === remoteRequestSeq.current) setIsRemoteLoading(false);
    });
  }, [activeTab, remoteSearchQuery, remoteSourceStates]);

  useEffect(() => {
    if (selectedCode === null) {
      setSelectedWork(null);
      return;
    }
    const work = works.find((item) => item.primaryCode.toUpperCase() === selectedCode.toUpperCase());
    if (work) {
      setSelectedWorkPreview(work);
      api.getWork(work.id).then((detail) => {
        if (detail.baseCode && detail.baseCode.toUpperCase() !== detail.primaryCode.toUpperCase()) {
          void resolveAndOpenWork(selectedCode, setSelectedWork, setSelectedCode);
          return;
        }
        setSelectedWork(detail);
      }).catch(() => setSelectedWork(null));
      return;
    }
    setSelectedWorkPreview(null);
    if (works.length > 0) {
      void resolveAndOpenWork(selectedCode, setSelectedWork, setSelectedCode);
    }
  }, [selectedCode, works]);

  useEffect(() => {
    const syncFromPath = () => {
      setSelectedCode(codeFromLocation(window.location.pathname, window.location.search));
      setSelectedRemoteTarget(remoteTargetFromLocation(window.location.pathname, window.location.search, sources));
      setActiveTab((tab) => resolveTabFromPath(window.location.pathname, sources, tab));
      setLocalScope(localScopeFromPath(window.location.pathname));
    };
    const handlePopState = () => syncFromPath();
    const handleAppNavigation = () => syncFromPath();
    window.addEventListener("popstate", handlePopState);
    window.addEventListener("kikoto:navigation", handleAppNavigation);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("kikoto:navigation", handleAppNavigation);
    };
  }, [sources]);

  useEffect(() => {
    setWorkPage(1);
  }, [activeTab.kind, activeTab.kind === "source" ? activeTab.source.id : "", localScope, librarySearchQuery, statusFilter, librarySort, sortDirection, workPageSize]);

  useEffect(() => {
    if (activeTab.kind !== "source") return;
    updateRemoteSourceState(activeTab.source.id, { page: 1, query: remoteSearchQuery });
  }, [activeTab, remoteSearchQuery]);

  const openWork = (work: Work) => {
    const path = `/${work.primaryCode}`;
    window.history.pushState({ returnTo: pathForLibraryTab(activeTab), returnLabel: "Back to library" }, "", path);
    window.dispatchEvent(new Event("kikoto:navigation"));
    setSelectedWorkPreview(work);
    setSelectedCode(work.primaryCode);
  };

  const openRemotePreview = (source: LibrarySource, work: RemoteWork) => {
    const code = remoteWorkRouteCode(work);
    if (!code) return;
    setSelectedRemoteTarget({ source, code });
    window.history.pushState({ returnTo: pathForLibraryTab(activeTab), returnLabel: "Back to library" }, "", `/${encodeURIComponent(code)}?source=${source.id}`);
    window.dispatchEvent(new Event("kikoto:navigation"));
    setSelectedCode(codeFromLocation(window.location.pathname, window.location.search));
  };

  const backToLibrary = () => {
    const returnTarget = detailReturnTarget(pathForLibraryTab(activeTab));
    window.history.pushState({}, "", returnTarget.path);
    window.dispatchEvent(new Event("kikoto:navigation"));
    setSelectedCode(null);
    setSelectedRemoteTarget(null);
  };

  const changeTab = (tab: LibraryTab) => {
    setActiveTab(tab);
    if (tab.kind === "all") setLocalScope("local");
    setSelectedRemoteTarget(null);
    const path = pathForLibraryTab(tab);
    if (window.location.pathname !== path) {
      window.history.pushState({}, "", path);
      window.dispatchEvent(new Event("kikoto:navigation"));
    }
  };

  const changeLocalScope = (scope: LocalLibraryScope) => {
    setLocalScope(scope);
    setWorkPage(1);
  };

  const updateWorkStatus = async (workID: number, status: ListeningStatus) => {
    const result = await api.updateWorkUserState(workID, { listeningStatus: status });
    setWorks((items) =>
      items.map((item) => (item.id === workID ? { ...item, listeningStatus: result.listeningStatus, favorite: result.favorite } : item)),
    );
    setSelectedWork((item) => (item?.id === workID ? { ...item, listeningStatus: result.listeningStatus, favorite: result.favorite } : item));
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
    try {
      const detail = await api.getRemoteSourceWork(source.id, work.primaryCode);
      setTrackedFetchSelection({ work, source, detail, selectedPaths: new Set(remoteSelectablePaths(buildRemoteTree(detail.tracks))), selectedLocalPaths: new Set(), plan: null, message: "" });
    } finally {
      setIsTrackedFetching(false);
    }
  };

  const fetchTrackedSelection = async () => {
    if (!trackedFetchSelection) return;
    setIsTrackedFetching(true);
    try {
      const paths = Array.from(trackedFetchSelection.selectedPaths);
      const localPaths = Array.from(trackedFetchSelection.selectedLocalPaths);
      const plan = await api.planRemoteSourceWorkFetch(trackedFetchSelection.source.id, trackedFetchSelection.detail.primaryCode, paths, localPaths);
      if (!trackedFetchSelection.plan && remoteFetchNeedsLocalReview(plan)) {
        setTrackedFetchSelection((current) => current ? { ...current, plan, message: formatRemoteFetchLocalReview(plan) } : current);
        return;
      }
      if (hasRemoteFetchConflicts(plan)) {
        setTrackedFetchSelection((current) => current ? { ...current, plan, message: formatRemoteFetchPlanConflict(plan) } : current);
        return;
      }
      const result = await api.fetchRemoteSourceWork(trackedFetchSelection.source.id, trackedFetchSelection.detail.primaryCode, paths, localPaths);
      setTrackedFetchSelection((current) => current ? { ...current, message: `Fetch queued as workflow run #${result.runId}.` } : current);
      setTrackedFetchSelection(null);
      await refreshCurrentWorksPage();
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
    api.listWorksPage(page, workPageSize, query, workScope, statusFilter, librarySort, sortDirection).then((result) => {
      if (requestSeq !== libraryRequestSeq.current) return;
      setWorks(result.works);
      setWorkTotal(result.total);
      setIsAPIAvailable(true);
      setOptimisticLibrarySearchTokens(null);
    }).catch(() => {
      if (requestSeq !== libraryRequestSeq.current) return;
      setWorks([]);
      setWorkTotal(0);
      setIsAPIAvailable(false);
      setOptimisticLibrarySearchTokens(null);
    });
  };

  const loadRemoteWorksNow = (source: LibrarySource, query: string, page = 1, options: { clearResult?: boolean } = {}) => {
    const sourceState = remoteSourceStates[source.id] ?? defaultRemoteSourceViewState;
    const requestSeq = ++remoteRequestSeq.current;
    setIsRemoteLoading(true);
    if (options.clearResult !== false && remoteResult?.sourceId !== source.id) setRemoteResult(null);
    api.listRemoteSourceWorks(source.id, page, sourceState.pageSize, query).then((result) => {
      if (requestSeq !== remoteRequestSeq.current) return;
      setRemoteResult(result);
    }).catch(() => {
      if (requestSeq !== remoteRequestSeq.current) return;
      setRemoteResult({
        sourceId: source.id,
        works: [],
        page,
        pageSize: sourceState.pageSize,
        total: 0,
        status: "unavailable",
      });
    }).finally(() => {
      if (requestSeq === remoteRequestSeq.current) setIsRemoteLoading(false);
    });
  };

  const refreshCurrentWorksPage = async () => {
    if (activeTab.kind === "source") return;
    const page = await api.listWorksPage(workPage, workPageSize, librarySearchQuery, workScope, statusFilter, librarySort, sortDirection);
    setWorks(page.works);
    setWorkTotal(page.total);
    setIsAPIAvailable(true);
  };

  const updateSearchTokens = (tokens: SearchToken[]) => {
    setOptimisticLibrarySearchTokens(null);
    setSearchQuery(tokens.map(formatSearchToken).join(" "));
  };

  const addTagSearchToken = (tag: string) => {
    const value = tag.trim();
    if (!value) return;
    const next = searchTokens.filter((token) => !(token.kind === "tag" && token.value.toLowerCase() === value.toLowerCase()));
    const nextTokens = [...next, { kind: "tag" as const, value }];
    const nextQuery = nextTokens.map(formatSearchToken).join(" ");
    const nextLibraryQuery = compileLibrarySearchQuery(nextTokens);
    const nextRemoteQuery = formatRemoteSearchQuery(nextTokens);
    setSearchQuery(nextQuery);
    setDebouncedSearchQuery(nextQuery);
    setDebouncedRemoteSearchQuery(nextQuery);
    setWorkPage(1);
    if (activeTab.kind === "source") {
      skipNextRemoteEffect.current = true;
      updateRemoteSourceState(activeTab.source.id, { page: 1, query: nextRemoteQuery });
      loadRemoteWorksNow(activeTab.source, nextRemoteQuery, 1, { clearResult: false });
      return;
    }
    setOptimisticLibrarySearchTokens(nextTokens);
    skipNextLibraryEffect.current = true;
    loadLibraryWorksNow(nextLibraryQuery, 1);
  };

  const removeSearchToken = (index: number) => {
    updateSearchTokens(searchTokens.filter((_token, tokenIndex) => tokenIndex !== index));
    setTokenEditor(null);
  };

  const openAddTokenEditor = () => {
    setTokenEditor({ mode: "add", index: null, draft: { kind: "text", value: "" } });
  };

  const openEditTokenEditor = (token: SearchToken, index: number) => {
    setTokenEditor({ mode: "edit", index, draft: { kind: token.kind, value: token.value } });
  };

  const saveTokenEditor = () => {
    if (!tokenEditor) return;
    const token = normalizeSearchTokenDraft(tokenEditor.draft);
    if (!token) return;
    if (tokenEditor.mode === "add") {
      updateSearchTokens([...searchTokens, token]);
    } else if (tokenEditor.index !== null) {
      updateSearchTokens(searchTokens.map((item, index) => (index === tokenEditor.index ? token : item)));
    }
    setTokenEditor(null);
  };

  if (selectedRemoteTarget !== null) {
    return (
      <RemoteWorkDetailView
        source={selectedRemoteTarget.source}
        code={selectedRemoteTarget.code}
        onBack={backToLibrary}
        onOpenLocal={(workID) => {
          const work = works.find((item) => item.id === workID);
          if (work) openWork(work);
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
        sources={sources}
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

  const visibleWorks = optimisticLibrarySearchTokens === null ? works : works.filter((work) => workMatchesSearch(work, optimisticLibrarySearchTokens));
  const totalWorkPages = Math.max(1, Math.ceil(workTotal / workPageSize));
  const currentWorkPage = Math.min(workPage, totalWorkPages);
  const pagedWorks = visibleWorks;
  const activeFilterCount = statusFilter === "all" ? 0 : 1;
  const localPagination = (
    <WorkPagination
      page={currentWorkPage}
      pageSize={workPageSize}
      totalItems={workTotal}
      totalPages={totalWorkPages}
      onPageChange={setWorkPage}
      onPageSizeChange={setWorkPageSize}
    />
  );

  return (
    <div className="space-y-5">
      <section className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-h-10 flex-1 items-center gap-2 rounded-lg border bg-card px-3 text-sm lg:max-w-xl">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
            value={searchQuery}
            onChange={(event) => {
              setOptimisticLibrarySearchTokens(null);
              setSearchQuery(event.target.value);
            }}
            placeholder="Search title, code, circle, tag, or creator"
          />
          {searchQuery.trim() && (
            <button className="text-muted-foreground hover:text-foreground" onClick={() => {
              setOptimisticLibrarySearchTokens(null);
              setSearchQuery("");
            }} aria-label="Clear search">
              <X className="h-4 w-4" />
            </button>
          )}
          <button
            className="rounded-sm text-muted-foreground hover:text-foreground"
            onClick={openAddTokenEditor}
            aria-label="Add search condition"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          <ColumnPicker mobileColumns={mobileColumns} desktopColumns={desktopColumns} onMobileChange={setMobileColumns} onDesktopChange={setDesktopColumns} />
          <SortPicker activeTab={activeTab} value={librarySort} direction={sortDirection} onChange={setLibrarySort} onDirectionChange={setSortDirection} />
          <FilterPicker value={statusFilter} activeCount={activeFilterCount} onChange={setStatusFilter} />
        </div>
      </section>
      {activeFilterCount > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline" className="gap-1.5">
            <Filter className="h-4 w-4" />
            Mark: {statusFilterLabel(statusFilter)}
            <button className="rounded-sm text-muted-foreground hover:text-foreground" aria-label="Clear mark filter" onClick={() => setStatusFilter("all")}>
              <X className="h-3 w-3" />
            </button>
          </Badge>
        </div>
      )}
      {searchTokens.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {searchTokens.map((token, index) => (
            <Badge key={`${token.kind}-${token.value}-${index}`} variant={token.kind === "exclude_tag" ? "warning" : "outline"} className="gap-1.5">
              <button className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => openEditTokenEditor(token, index)}>
                <Edit3 className="h-3 w-3" />
                {searchTokenLabel(token)}
              </button>
              <button
                className="rounded-sm text-muted-foreground hover:text-foreground"
                aria-label={`Remove ${searchTokenLabel(token)}`}
                onClick={() => removeSearchToken(index)}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      {tokenEditor && (
        <SearchTokenEditor
          editor={tokenEditor}
          onChange={(draft) => setTokenEditor((current) => current ? { ...current, draft } : current)}
          onCancel={() => setTokenEditor(null)}
          onSave={saveTokenEditor}
        />
      )}

      <LibraryTabs activeTab={activeTab} sources={sources} onChange={changeTab} />

      {activeTab.kind === "source" ? (
        <RemoteSourcePanel
          source={activeTab.source}
          result={remoteResult}
          loading={isRemoteLoading}
          viewState={activeRemoteSourceState}
          searchTokens={searchTokens}
          onPageChange={(page) => updateRemoteSourceState(activeTab.source.id, { page })}
          onPageSizeChange={(value) => {
            updateRemoteSourceState(activeTab.source.id, { pageSize: value, page: 1 });
          }}
          onOpenPreview={(work) => openRemotePreview(activeTab.source, work)}
          onTagOpen={addTagSearchToken}
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
            openWorkCodeRoute(detail.primaryCode);
          }}
        />
      ) : (
        <div className="space-y-3">
          <LocalScopeTabs value={localScope} onChange={changeLocalScope} />
          {localPagination}
          <section className={workGridClassName()} style={workGridStyle(mobileColumns, desktopColumns)}>
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
                onTagOpen={addTagSearchToken}
                onUntrack={localScope === "tracked" ? (source) => setUntrackTarget({ work, source }) : undefined}
                onFetch={localScope === "tracked" ? (source) => void openTrackedFetchSelection(work, source) : undefined}
                isFetchBusy={isTrackedFetching}
              />
            ))}
            {visibleWorks.length === 0 && (
              <Card className="sm:col-span-2 xl:col-span-3">
                <CardContent className="p-5 text-sm text-muted-foreground">
                  {localScope === "tracked"
                    ? "No tracked works match this view."
                    : localScope === "remote"
                    ? "No untracked remote-available works match this view."
                    : localScope === "no_source"
                    ? "No works without sources match this view."
                    : localScope === "local"
                    ? "No local works match this view."
                    : "No works match this view."}
                </CardContent>
              </Card>
            )}
          </section>
          {localPagination}
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
          message={trackedFetchSelection.message}
          onChange={(paths) => setTrackedFetchSelection((current) => current ? { ...current, selectedPaths: paths } : current)}
          onLocalChange={(paths) => setTrackedFetchSelection((current) => current ? { ...current, selectedLocalPaths: paths } : current)}
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

const localScopeTabs: { value: LocalLibraryScope; label: string; icon: ReactNode }[] = [
  { value: "local", label: "Local", icon: <HardDrive className="h-4 w-4" /> },
  { value: "tracked", label: "Tracked", icon: <GitBranchPlus className="h-4 w-4" /> },
  { value: "remote", label: "Remote", icon: <Cloud className="h-4 w-4" /> },
  { value: "no_source", label: "No source", icon: <CloudOff className="h-4 w-4" /> },
  { value: "all", label: "All", icon: <Database className="h-4 w-4" /> },
];

function LibraryTabs({
  activeTab,
  sources,
  onChange,
}: {
  activeTab: LibraryTab;
  sources: LibrarySource[];
  onChange: (tab: LibraryTab) => void;
}) {
  return (
    <div className="flex gap-2 overflow-x-auto rounded-lg border bg-card p-1">
      <TabButton active={activeTab.kind === "all"} onClick={() => onChange({ kind: "all" })} icon={<Database className="h-4 w-4" />}>
        Library
      </TabButton>
      {sources.map((source) => (
        <TabButton
          key={source.id}
          active={activeTab.kind === "source" && activeTab.source.id === source.id}
          onClick={() => onChange({ kind: "source", source })}
          icon={<Cloud className="h-4 w-4" />}
          disabled={!source.enabled}
        >
          {source.displayName}
        </TabButton>
      ))}
    </div>
  );
}

function LocalScopeTabs({ value, onChange }: { value: LocalLibraryScope; onChange: (scope: LocalLibraryScope) => void }) {
  return (
    <div className="flex gap-1 overflow-x-auto rounded-lg border bg-card/60 p-1">
      {localScopeTabs.map((tab) => (
        <TabButton key={tab.value} active={value === tab.value} onClick={() => onChange(tab.value)} icon={tab.icon}>
          {tab.label}
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

function RemoteSourcePanel({
  source,
  result,
  loading,
  viewState,
  searchTokens,
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
  searchTokens: SearchToken[];
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onOpenPreview: (work: RemoteWork) => void;
  onTagOpen: (tag: string) => void;
  onWorkStateChanged: (primaryCode: string, patch: Partial<Pick<RemoteWork, "workId" | "favorite">>) => void;
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
  const [saveSelection, setSaveSelection] = useState<{ work: RemoteWork; detail: RemoteWorkDetail; selectedPaths: Set<string>; selectedLocalPaths: Set<string>; plan: RemoteWorkSavePlan | null; message: string } | null>(null);
  const { page, pageSize } = viewState;

  const syncWork = async (work: RemoteWork, reason: string) => {
    if (!work.primaryCode) {
      toast.warning("This remote work has no stable work code.");
      return;
    }
    setIsSyncingCode(work.primaryCode);
    try {
      const result = await api.trackRemoteSourceWork(source.id, work.primaryCode, reason);
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
    return works.filter((work) => remoteWorkMatchesSearch(work, searchTokens));
  }, [result, searchTokens]);
  const selectableWorks = visibleWorks.filter((work) => work.primaryCode);
  const selectedWorks = selectableWorks.filter((work) => bulkCodes.has(work.primaryCode));
  const selectedSyncable = selectedWorks.filter((work) => work.workId === null);
  const selectedSaveable = selectedWorks;
  const selectionActive = selectionMode;
  const canGoNext = result !== null && result.works.length >= pageSize;
  const canGoPrevious = page > 1;

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
      const parent = await api.recordRemoteBulkRun({ action: "track", sourceId: source.id, codes: selectedSyncable.map((work) => work.primaryCode) });
      toast.success(`Bulk workflow #${parent.runId}: tracked ${parent.synced} remote-only works.`);
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
      const parent = await api.recordRemoteBulkRun({ action: "fetch", sourceId: source.id, codes: selectedSaveable.map((work) => work.primaryCode) });
      toast.success(`Bulk workflow #${parent.runId}: fetched ${parent.fetched} selected works.`);
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
    try {
      const detail = await api.getRemoteSourceWork(source.id, work.primaryCode);
      const root = buildRemoteTree(detail.tracks);
      setSaveSelection({ work, detail, selectedPaths: new Set(remoteSelectablePaths(root)), selectedLocalPaths: new Set(), plan: null, message: "" });
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
      const plan = await api.planRemoteSourceWorkFetch(source.id, saveSelection.detail.primaryCode, paths, localPaths);
      if (!saveSelection.plan && remoteFetchNeedsLocalReview(plan)) {
        setSaveSelection((current) => current ? { ...current, plan, message: formatRemoteFetchLocalReview(plan) } : current);
        return;
      }
      if (hasRemoteFetchConflicts(plan)) {
        setSaveSelection((current) => current ? { ...current, plan, message: formatRemoteFetchPlanConflict(plan) } : current);
        return;
      }
      const result = await api.fetchRemoteSourceWork(source.id, saveSelection.detail.primaryCode, paths, localPaths);
      toast.success(`Fetch queued for ${result.primaryCode} as workflow run #${result.runId}.`);
      await onSynced(0);
      setSaveSelection(null);
    } catch (error) {
      toast.notify(toastFromError(error, "Fetch failed."));
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
      const result = await api.trackRemoteSourceWork(source.id, work.primaryCode, "mark_interest");
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
      const result = await api.trackRemoteSourceWork(source.id, work.primaryCode, "list_remote");
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
    <section className="space-y-3 pb-28 lg:pb-8">
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
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2">
        <div className="text-xs text-muted-foreground">
          Page {page}
          {result?.total ? ` · ${result.total} works` : ""}
        </div>
        <div className="flex items-center gap-2">
          <select
            className="h-8 rounded-md border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
            aria-label="Remote page size"
          >
            {[12, 24, 48, 96].map((value) => (
              <option key={value} value={value}>
                {value} / page
              </option>
            ))}
          </select>
          <IconButton title="Previous page" disabled={!canGoPrevious || isInitialLoading} onClick={() => onPageChange(Math.max(1, page - 1))}>
            <ChevronLeft className="h-4 w-4" />
          </IconButton>
          <IconButton title="Next page" disabled={!canGoNext || isInitialLoading} onClick={() => onPageChange(page + 1)}>
            <ChevronRight className="h-4 w-4" />
          </IconButton>
        </div>
      </div>
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
        <RemoteWorkGridSkeleton />
      ) : visibleWorks.length === 0 ? (
        <Card>
          <CardContent className="p-5 text-sm text-muted-foreground">No remote works on this page.</CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {isRefreshing && <div className="rounded-md border bg-card px-3 py-2 text-xs text-muted-foreground">Refreshing remote results...</div>}
          <section className={workGridClassName()} style={workGridStyle(2, 6)}>
            {visibleWorks.map((work) => (
              <RemoteWorkCard
                key={work.remoteId}
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
            ))}
          </section>
        </div>
      )}
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
          message={saveSelection.message}
          onChange={(paths) => setSaveSelection((current) => current ? { ...current, selectedPaths: paths } : current)}
          onLocalChange={(paths) => setSaveSelection((current) => current ? { ...current, selectedLocalPaths: paths } : current)}
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
            <WorkCardQuickMarkButton value="none" disabled={isBusy || !work.primaryCode} onChange={onMark} />
            </>
          )}
        />
      )}
    />
  );
}

function RemoteWorkGridSkeleton() {
  return (
    <section className={workGridClassName()} style={workGridStyle(2, 6)}>
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

function ColumnPicker({
  mobileColumns,
  desktopColumns,
  onMobileChange,
  onDesktopChange,
}: {
  mobileColumns: LibraryColumnCount;
  desktopColumns: LibraryColumnCount;
  onMobileChange: (value: LibraryColumnCount) => void;
  onDesktopChange: (value: LibraryColumnCount) => void;
}) {
  const [open, setOpen] = useState(false);
  const isWide = useIsWideLibraryLayout();
  const popoverRef = useRef<HTMLDivElement | null>(null);
  useDismissiblePopover(open, popoverRef, () => setOpen(false));
  const currentValue = isWide ? desktopColumns : mobileColumns;
  const options = isWide ? columnOptions : ([1, 2] as const);
  const setColumns = (value: LibraryColumnCount) => {
    if (isWide) onDesktopChange(value);
    else onMobileChange(value);
    setOpen(false);
  };
  return (
    <div className="relative" ref={popoverRef}>
      <IconButton title={`Columns: ${currentValue}`} onClick={() => setOpen((value) => !value)}>
        <FolderTree className="h-4 w-4" />
      </IconButton>
      {open && (
        <div className="absolute right-0 z-30 mt-2 flex w-10 flex-col gap-1 rounded-lg border bg-card p-1 text-sm shadow-lg">
          {options.map((option) => (
            <button
              key={option}
              className={`flex h-8 items-center justify-center rounded-md text-sm font-medium hover:bg-muted ${currentValue === option ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
              title={`${option} ${option === 1 ? "column" : "columns"}`}
              aria-label={`${option} ${option === 1 ? "column" : "columns"}`}
              onClick={() => setColumns(option)}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SortPicker({
  activeTab,
  value,
  direction,
  onChange,
  onDirectionChange,
}: {
  activeTab: LibraryTab;
  value: LibrarySort;
  direction: SortDirection;
  onChange: (value: LibrarySort) => void;
  onDirectionChange: (value: SortDirection) => void;
}) {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const disabled = activeTab.kind === "source";
  const label = disabled ? "Source order" : librarySortOptions.find((option) => option.value === value)?.label ?? "Sort";
  useDismissiblePopover(open, popoverRef, () => setOpen(false));
  const nextDirection = direction === "asc" ? "desc" : "asc";
  return (
    <div className="relative" ref={popoverRef}>
      <div className="inline-flex rounded-md border bg-background">
        <button
          className="relative inline-flex h-8 w-8 items-center justify-center rounded-l-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          title={disabled ? "Source order" : `Sort: ${label}`}
          aria-label={disabled ? "Source order" : `Sort: ${label}`}
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
        >
          <ArrowUpDown className="h-4 w-4" />
        </button>
        <button
          className="relative inline-flex h-8 w-8 items-center justify-center rounded-r-md border-l text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          title={disabled ? "Source order" : direction === "asc" ? "Ascending" : "Descending"}
          aria-label={disabled ? "Source order" : direction === "asc" ? "Ascending" : "Descending"}
          disabled={disabled}
          onClick={() => onDirectionChange(nextDirection)}
        >
          {direction === "asc" ? <ArrowDownAZ className="h-4 w-4" /> : <ArrowDownZA className="h-4 w-4" />}
        </button>
      </div>
      {open && !disabled && (
        <div className="absolute right-0 z-30 mt-2 w-56 rounded-lg border bg-card p-1 text-sm shadow-lg">
          {librarySortOptions.map((option) => (
            <button
              key={option.value}
              className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left hover:bg-muted ${value === option.value ? "text-foreground" : "text-muted-foreground"}`}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              {option.label}
              {value === option.value && <Check className="h-4 w-4" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function FilterPicker({
  value,
  activeCount,
  onChange,
}: {
  value: ListeningStatus | "all";
  activeCount: number;
  onChange: (value: ListeningStatus | "all") => void;
}) {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  useDismissiblePopover(open, popoverRef, () => setOpen(false));
  return (
    <div className="relative" ref={popoverRef}>
      <IconButton title={activeCount > 0 ? `Filters: ${activeCount} active` : "Filters"} onClick={() => setOpen((current) => !current)}>
        <Filter className="h-4 w-4" />
        {activeCount > 0 && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-primary" />}
      </IconButton>
      {open && (
        <div className="absolute right-0 z-30 mt-2 flex w-10 flex-col gap-1 rounded-lg border bg-card p-1 text-sm shadow-lg">
          <button
            className={`flex h-8 items-center justify-center rounded-md hover:bg-muted ${value === "all" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
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
                className={`flex h-8 items-center justify-center rounded-md hover:bg-muted ${value === option.value ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
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
        </div>
      )}
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

function useIsWideLibraryLayout() {
  const [isWide, setIsWide] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.matchMedia("(min-width: 640px)").matches;
  });

  useEffect(() => {
    const media = window.matchMedia("(min-width: 640px)");
    const update = () => setIsWide(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return isWide;
}

function statusFilterLabel(value: ListeningStatus | "all") {
  if (value === "all") return "All marks";
  return listeningStatusOptions.find((option) => option.value === value)?.label ?? value;
}

function workGridClassName() {
  return "grid gap-4 [grid-template-columns:repeat(var(--mobile-columns),minmax(0,1fr))] sm:[grid-template-columns:repeat(var(--desktop-columns),minmax(0,1fr))]";
}

function workGridStyle(mobileColumns: LibraryColumnCount, desktopColumns: LibraryColumnCount) {
  return {
    "--mobile-columns": mobileColumns,
    "--desktop-columns": desktopColumns,
  } as CSSProperties;
}

function WorkPagination({
  page,
  pageSize,
  totalItems,
  totalPages,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageSize: LocalWorkPageSize;
  totalItems: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: LocalWorkPageSize) => void;
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
          onChange={(event) => onPageSizeChange(Number(event.target.value) as LocalWorkPageSize)}
          aria-label="Works per page"
        >
          {localWorkPageSizeOptions.map((value) => (
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

function SearchTokenEditor({
  editor,
  onChange,
  onCancel,
  onSave,
}: {
  editor: { mode: "add" | "edit"; index: number | null; draft: SearchTokenDraft };
  onChange: (draft: SearchTokenDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const value = editor.draft.value;
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-2 text-sm shadow-sm sm:flex-row sm:items-center">
      <select
        className="h-9 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring sm:w-40"
        value={editor.draft.kind}
        onChange={(event) => onChange({ ...editor.draft, kind: event.target.value as SearchTokenKind })}
        aria-label="Search token type"
      >
        {editableSearchTokenKinds.map((kind) => (
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
  const tree = useMemo(() => buildRemoteTree(detail?.tracks ?? []), [detail]);
  const remoteFilePaths = useMemo(() => remoteSelectablePaths(tree), [tree]);
  const [selectedSavePaths, setSelectedSavePaths] = useState<Set<string>>(new Set());
  const [selectedLocalSavePaths, setSelectedLocalSavePaths] = useState<Set<string>>(new Set());
  const [isSaveSelectionOpen, setIsSaveSelectionOpen] = useState(false);
  const [savePlan, setSavePlan] = useState<RemoteWorkSavePlan | null>(null);
  const [savePlanMessage, setSavePlanMessage] = useState("");
  const directoryStats = useMemo(() => treeStats(tree), [tree]);
  const trackCount = useMemo(() => countTreeFiles(tree), [tree]);
  const remotePlayableTracks = useMemo(() => flattenTracks(tree), [tree]);
  const remoteTabs = useMemo<SourceTabInfo[]>(() => detail ? [{ key: remoteSourceTabKey(source.id), label: detail.sourceName, fileSourceId: null }] : [], [detail, source.id]);
  const player = usePlayer();

  useEffect(() => {
    setDetail(null);
    setMessage("");
    setSelectedSavePaths(new Set());
    setSelectedLocalSavePaths(new Set());
    setSavePlan(null);
    setSavePlanMessage("");
    api.getRemoteSourceWork(source.id, code).then(setDetail).catch((error) => {
      const text = error instanceof Error ? error.message : "Remote preview failed.";
      setMessage(text);
      toast.notify({ kind: "error", message: text });
    });
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
      const result = await api.trackRemoteSourceWork(source.id, detail.primaryCode, reason);
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
      const result = await api.trackRemoteSourceWork(source.id, detail.primaryCode, reason);
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
  const saveSelected = async () => {
    if (!detail?.primaryCode || (selectedPaths.length === 0 && selectedLocalPaths.length === 0)) return;
    setIsSaving(true);
    setMessage("");
    setSavePlanMessage("");
    try {
      const plan = await api.planRemoteSourceWorkFetch(source.id, detail.primaryCode, selectedPaths, selectedLocalPaths);
      if (!savePlan && remoteFetchNeedsLocalReview(plan)) {
        setSavePlan(plan);
        setSavePlanMessage(formatRemoteFetchLocalReview(plan));
        return;
      }
      if (hasRemoteFetchConflicts(plan)) {
        setSavePlan(plan);
        setSavePlanMessage(formatRemoteFetchPlanConflict(plan));
        return;
      }
      const result = await api.fetchRemoteSourceWork(source.id, detail.primaryCode, selectedPaths, selectedLocalPaths);
      toast.success(`Fetch queued for ${result.primaryCode} as workflow run #${result.runId}.`);
      setIsSaveSelectionOpen(false);
      setSavePlan(null);
      setSavePlanMessage("");
      await onWorksChanged();
      onOpenLocal(result.workId);
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
            onFetch={() => setIsSaveSelectionOpen(true)}
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
        currentLocationId={player.currentTrack?.locationId ?? null}
        emptyLabel="No remote files detected."
        toolbar={message ? <DirectoryMessage message={message} /> : undefined}
        selectionModal={isSaveSelectionOpen ? (
          <RemoteSaveSelectionPanel
            root={tree}
            selectedPaths={selectedSavePaths}
            selectedLocalPaths={selectedLocalSavePaths}
            plan={savePlan}
            message={savePlanMessage}
            onChange={(paths) => {
              setSelectedSavePaths(paths);
            }}
            onLocalChange={setSelectedLocalSavePaths}
            disabled={isSaving}
            onClose={() => setIsSaveSelectionOpen(false)}
            onSave={() => void saveSelected()}
          />
        ) : null}
        onPlayFolder={playRemoteTracks}
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
  sources,
  onBack,
  onStatusChange,
  onWorkReload,
  onWorksChanged,
}: {
  code: string;
  work: WorkDetail | null;
  workPreview: Work | null;
  sources: LibrarySource[];
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
  const [activeSourceKey, setActiveSourceKey] = useState("local");
  const [directoryMode, setDirectoryMode] = useState<DirectoryMode>("browse");
  const [isManageOpen, setIsManageOpen] = useState(false);
  const [preview, setPreview] = useState<FilePreviewState | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [message, setMessage] = useState("");
  const [selectedSavePaths, setSelectedSavePaths] = useState<Set<string>>(new Set());
  const [selectedLocalSavePaths, setSelectedLocalSavePaths] = useState<Set<string>>(new Set());
  const [isSaving, setIsSaving] = useState(false);
  const [isSyncingDetail, setIsSyncingDetail] = useState(false);
  const [isSaveSelectionOpen, setIsSaveSelectionOpen] = useState(false);
  const [savePlan, setSavePlan] = useState<RemoteWorkSavePlan | null>(null);
  const [savePlanMessage, setSavePlanMessage] = useState("");
  const [favoriteLists, setFavoriteLists] = useState<FavoriteList[]>([]);
  const [activeEdition, setActiveEdition] = useState<WorkDetail | null>(null);
  const [activeEditionCode, setActiveEditionCode] = useState("");
  const [reforkTarget, setReforkTarget] = useState<ReforkTarget | null>(null);
  const selectedSource = sourceTabs.find((source) => source.key === activeSourceKey) ?? sourceTabs[0];
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
  const player = usePlayer();
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
  }, [localDirectoryWork, work?.primaryCode, selectedSource, selectedRemoteDetail, selectedRemoteSource, selectedTrackedPresence, selectedTrackedForked, selectedTrackedSourceID]);

  useEffect(() => {
    if (sourceTabs.length > 0 && !sourceTabs.some((source) => source.key === activeSourceKey)) {
      setActiveSourceKey(sourceTabs[0].key);
    }
  }, [activeSourceKey, sourceTabs]);

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
    if (!selectedRemoteSource || selectedRemoteSource.detail || selectedRemoteSource.loading || selectedRemoteSource.error) return;
    const sourceID = selectedRemoteSource.source.id;
    setRemoteSources((items) => items.map((item) => item.source.id === sourceID ? { ...item, loading: true, error: "" } : item));
    api.getRemoteSourceWork(sourceID, selectedRemoteWorkCode)
      .then((detail) => {
        setRemoteSources((items) => items.map((item) => item.source.id === sourceID ? { ...item, detail, loading: false, error: "" } : item));
      })
      .catch((error) => {
        setRemoteSources((items) => items.map((item) => item.source.id === sourceID ? { ...item, loading: false, error: error instanceof Error ? error.message : "Remote detail failed." } : item));
      });
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
  }, [work?.id]);

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

  const deleteMediaTargets = async (targets: MediaDeleteTarget[]) => {
    if (targets.length === 0) return;
    setIsDeleting(true);
    setMessage("");
    let deleted = 0;
    try {
      for (const target of targets) {
        if (target.kind === "cache") {
          await api.deleteMediaCacheLocation(target.locationId);
        } else {
          await api.deleteMediaLocalLocation(target.locationId);
        }
        deleted += 1;
      }
      toast.success(`Deleted ${deleted} file ${deleted === 1 ? "location" : "locations"}.`);
      await onWorksChanged();
    } catch (error) {
      toast.notify(toastFromError(error, deleted > 0 ? `Deleted ${deleted} before the next delete failed.` : "Delete failed."));
      await onWorksChanged();
    } finally {
      setIsDeleting(false);
    }
  };

  const planRemoteSave = async () => {
    if (!selectedRemoteSource?.detail || (selectedPaths.length === 0 && selectedLocalPaths.length === 0)) return;
    setIsSaving(true);
    setMessage("");
    setSavePlanMessage("");
    try {
      const plan = await api.planRemoteSourceWorkFetch(selectedRemoteSource.source.id, selectedRemoteSource.detail.primaryCode, selectedPaths, selectedLocalPaths);
      if (!savePlan && remoteFetchNeedsLocalReview(plan)) {
        setSavePlan(plan);
        setSavePlanMessage(formatRemoteFetchLocalReview(plan));
        return;
      }
      if (hasRemoteFetchConflicts(plan)) {
        setSavePlan(plan);
        setSavePlanMessage(formatRemoteFetchPlanConflict(plan));
        return;
      }
      const result = await api.fetchRemoteSourceWork(selectedRemoteSource.source.id, selectedRemoteSource.detail.primaryCode, selectedPaths, selectedLocalPaths);
      toast.success(`Fetch queued for ${result.primaryCode} as workflow run #${result.runId}.`);
      setIsSaveSelectionOpen(false);
      setSavePlan(null);
      setSavePlanMessage("");
      await onWorksChanged();
      openRemoteLocal(result.workId);
    } catch (error) {
      toast.notify(toastFromError(error, "Save failed."));
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
        const result = await api.trackRemoteSourceWork(selectedRemoteSource.source.id, selectedRemoteSource.detail.primaryCode, "manual_track");
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
      const result = await api.trackRemoteSourceWork(selectedRemoteSource.source.id, selectedRemoteSource.detail.primaryCode, "manual_track");
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
      const result = await api.trackRemoteSourceWork(selectedRemoteSource.source.id, selectedRemoteSource.detail.primaryCode, reason);
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
      setActiveSourceKey(`${remote.source.id}:remote_stream`);
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
      setActiveSourceKey("local");
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

  return (
    <div className="space-y-5">
      <Button variant="outline" size="sm" onClick={onBack}>
        <ChevronLeft className="h-4 w-4" />
        {detailReturnTarget("library").label}
      </Button>

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
        actions={
          work ? <DetailActionBar
            canPlay={allTracks.length > 0}
            busy={isSyncingDetail || isSaving}
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
            onFetch={selectedRemoteDetail ? () => setIsSaveSelectionOpen(true) : undefined}
            onManage={() => setIsManageOpen(true)}
            dlsiteUrl={work.dlsiteUrl}
            syncLabel="Sync"
            showSync
            showFetch={Boolean(selectedRemoteDetail)}
          /> : <DetailSkeletonActions />
        }
      />

      <SourceDirectoryPanel
        title={directoryTitle}
        description={activeEdition ? `Showing files from ${activeEdition.primaryCode} ${languageLabel(activeEdition.metadataLanguage)}.` : directoryDescription}
        statsLabel={sourceStatsLabel}
        tabs={sourceTabs}
        activeKey={activeSourceKey}
        onActiveKeyChange={changeSourceKey}
        checkingLabel={isCheckingSources ? "Checking sources..." : ""}
        sourceSummary={work ? (
          <SourceAvailabilitySummary
            tabs={sourceTabs}
            remoteSources={remoteSources}
            sourcePresence={work.sourcePresence ?? []}
            checking={isCheckingSources}
            checkedAt={sourceCheckedAt}
            onRefresh={() => void refreshSourceAvailability()}
          />
        ) : <DirectorySkeletonSummary />}
        directoryMode={directoryMode}
        onDirectoryModeChange={setDirectoryMode}
        root={tree}
        currentLocationId={player.currentTrack?.locationId ?? null}
        emptyLabel={showNoSourceDirectory ? "No source linked." : selectedRemoteSource ? "No remote files detected." : "No local files detected."}
        toolbar={message ? <DirectoryMessage message={message} /> : undefined}
        selectionModal={isSaveSelectionOpen && selectedRemoteDetail ? (
          <RemoteSaveSelectionPanel
            root={tree}
            selectedPaths={selectedSavePaths}
            selectedLocalPaths={selectedLocalSavePaths}
            plan={savePlan}
            message={savePlanMessage}
            onChange={(paths) => {
              setSelectedSavePaths(paths);
            }}
            onLocalChange={setSelectedLocalSavePaths}
            disabled={isSaving}
            onClose={() => setIsSaveSelectionOpen(false)}
            onSave={() => void planRemoteSave()}
          />
        ) : null}
        emptyState={!work ? <DirectorySkeleton /> : selectedTrackedPresence && !selectedTrackedForked ? (
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
        onPreview={setPreview}
      />
      {preview && <FilePreviewModal preview={preview} onClose={() => setPreview(null)} />}
      {isManageOpen && (
        <DirectoryManagerModal
          root={tree}
          emptyLabel={showNoSourceDirectory ? "No source linked." : selectedRemoteSource ? "No remote files detected." : "No local files detected."}
          onClose={() => setIsManageOpen(false)}
          deleting={isDeleting}
          onDeleteTargets={deleteMediaTargets}
          allowCacheDelete
          allowLocalDelete={!selectedRemoteSource}
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
  const codeLabel = code || fallbackCode || "Remote";
  const displayVoiceCredits = voiceCredits.length > 0
    ? voiceCredits
    : voiceActors.map((name) => ({ personId: 0, displayName: name }));
  const baseTranslation = translations?.find((translation) => translation.primaryCode.toUpperCase() === (baseCode ?? "").toUpperCase());

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
        <div className="space-y-2">
          <div className="space-y-1.5">
            <Badge variant="secondary" className="w-fit">{codeLabel}</Badge>
            <h2 className="min-w-0 text-2xl font-semibold leading-tight lg:text-3xl">{title}</h2>
            {loading && <div className="h-2 w-40 animate-pulse rounded bg-muted" />}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {circleExternalId ? (
              <button className="inline-flex max-w-full items-center gap-1 truncate hover:text-primary" onClick={() => openCircleRoute(circleExternalId)}>
                <CircleUserRound className="h-4 w-4 shrink-0" />
                <span className="truncate">{circle || "Unknown circle"}</span>
              </button>
            ) : (
              <span className="inline-flex max-w-full items-center gap-1 truncate">
                <CircleUserRound className="h-4 w-4 shrink-0" />
                <span className="truncate">{circle || "Unknown circle"}</span>
              </span>
            )}
            {series && <span className="inline-flex max-w-full items-center gap-1 truncate"><span className="text-border">/</span><span className="truncate">{series}</span></span>}
          </div>
        </div>

        <DlsiteMetrics
          ratingLabel={ratingLabel}
          rating={rating}
          ratingCount={ratingCount}
          sales={sales}
          releaseDate={releaseDate}
          dlsiteFetchedAt={dlsiteFetchedAt}
          ageRating={ageRating}
        />

        {(metadataLanguage || baseCode || (translations && translations.length > 0)) && (
          <WorkVersionSelector
            metadataLanguage={metadataLanguage ?? ""}
            baseCode={baseCode ?? ""}
            baseAvailable={Boolean(baseTranslation?.workId)}
            translations={translations ?? []}
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
              onClick: credit.personId > 0 ? () => openVoiceRoute(credit.personId) : undefined,
            }))}
          />
          <DetailChipRow
            icon={<Tags className="h-4 w-4" />}
            label="Tags"
            emptyLabel="No tag metadata"
            items={tags.map((tag) => ({ key: tag, label: tag }))}
          />
          <InfoRow icon={<Clock3 className="h-4 w-4" />} label="Duration" value={formatDuration(durationSeconds)} />
        </div>

        {actions && <div className="flex flex-wrap gap-2 rounded-lg border bg-card p-3">{actions}</div>}
      </div>
    </section>
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

function DirectorySkeletonSummary() {
  return (
    <div className="rounded-md border bg-background p-3">
      <div className="flex flex-wrap gap-2">
        <div className="h-7 w-28 animate-pulse rounded-full bg-muted" />
        <div className="h-7 w-36 animate-pulse rounded-full bg-muted" />
      </div>
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

function detailHeroModel(code: string, work: WorkDetail | null, preview: Work | null) {
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

function SourceAvailabilitySummary({
  tabs,
  remoteSources,
  sourcePresence,
  checking,
  checkedAt,
  onRefresh,
}: {
  tabs: SourceTabInfo[];
  remoteSources: RemoteSourceAvailability[];
  sourcePresence: NonNullable<WorkDetail["sourcePresence"]>;
  checking: boolean;
  checkedAt: string;
  onRefresh: () => void;
}) {
  const localTabs = tabs.filter((tab) => !tab.key.startsWith("remote-source:"));
  const unforkedSources = trackedUnforkedSources(sourcePresence, remoteSources);
  if (localTabs.length === 0 && remoteSources.length === 0 && unforkedSources.length === 0 && !checking) return null;
  return (
    <div className="rounded-md border bg-background p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {localTabs.map((tab) => (
            <Badge key={tab.key} variant="secondary">
              {tab.label}
            </Badge>
          ))}
          {remoteSources.map((remote) => (
            <SourceStatusBadge key={remote.source.id} remote={remote} />
          ))}
          {unforkedSources.map((presence) => (
            <UnforkedSourceBadge key={`${presence.type}:${presence.availability}`} presence={presence} />
          ))}
          {checking && <Badge variant="secondary">Checking sources</Badge>}
          {!checking && checkedAt && <span className="text-xs text-muted-foreground">Checked {formatDateTime(checkedAt)}</span>}
        </div>
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={checking}>
          <RefreshCw className={`h-4 w-4 ${checking ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>
    </div>
  );
}

function UnforkedSourceBadge({ presence }: { presence: NonNullable<WorkDetail["sourcePresence"]>[number] }) {
  const availability = presence.availability || "unknown";
  const sourceName = presence.fileSourceName || presence.fileSourceCode || "Tracked";
  const title = availability === "available"
    ? "Tracked from a remote source, but no forked directory tree has been saved yet."
    : `Tracked source is ${availability}. Fork is unavailable until the source can be refreshed.`;
  return (
    <div
      className="inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs text-amber-900"
      title={title}
    >
      <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />
      <span className="truncate font-medium">{sourceName}</span>
      <span>unforked</span>
      {availability !== "available" && (
        <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[11px]">{availability}</span>
      )}
    </div>
  );
}

function SourceStatusBadge({ remote }: { remote: RemoteSourceAvailability }) {
  const meta = sourceStatusMeta(remote.summary);
  const known = sourceKnownStates(remote.summary);
  return (
    <div
      className="inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs"
      title={sourceStatusTitle(remote.summary, known)}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${meta.dotClass}`} />
      <span className="truncate font-medium">{remote.source.displayName}</span>
      <span className="text-muted-foreground">{meta.label}</span>
      {known.map((item) => (
        <span key={item} className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
          {item}
        </span>
      ))}
    </div>
  );
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

function sourceStatusMeta(summary: SourceAvailabilitySource) {
  if (summary.status === "available") {
    return { label: summary.hasCache ? "available + cache" : "available", dotClass: "bg-emerald-500" };
  }
  if (summary.status === "not_found") {
    return { label: "not found", dotClass: "bg-muted-foreground" };
  }
  if (summary.status === "disabled") {
    return { label: "disabled", dotClass: "bg-muted-foreground" };
  }
  if (summary.status === "unavailable") {
    return { label: "unsupported", dotClass: "bg-amber-500" };
  }
  if (summary.status === "unknown") {
    return { label: "not checked", dotClass: "bg-muted-foreground" };
  }
  return { label: "error", dotClass: "bg-destructive" };
}

function sourceKnownStates(summary: SourceAvailabilitySource) {
  const states: string[] = [];
  if (summary.hasLocal) states.push("local");
  if (summary.hasCache) states.push("cache");
  if (summary.hasRemote && summary.status !== "available") states.push("source known");
  return states;
}

function sourceStatusTitle(summary: SourceAvailabilitySource, known: string[]) {
  const details = [summary.title || summary.primaryCode || summary.remoteId, known.length > 0 ? `Known: ${known.join(", ")}` : "", summary.error].filter(Boolean);
  return details.join("\n");
}

type DirectoryMode = "browse" | "tree";

function SourceDirectoryPanel({
  title,
  description,
  statsLabel,
  tabs,
  activeKey,
  onActiveKeyChange,
  checkingLabel,
  sourceSummary,
  directoryMode,
  onDirectoryModeChange,
  root,
  currentLocationId,
  emptyLabel,
  toolbar,
  selectionPanel,
  selectionModal,
  loadingMessage,
  emptyState,
  onPlayFolder,
  onPreview,
}: {
  title: string;
  description: string;
  statsLabel?: string;
  tabs: SourceTabInfo[];
  activeKey: string;
  onActiveKeyChange: (key: string) => void;
  checkingLabel?: string;
  sourceSummary?: ReactNode;
  directoryMode: DirectoryMode;
  onDirectoryModeChange: (mode: DirectoryMode) => void;
  root: TreeNode;
  currentLocationId: number | null;
  emptyLabel: string;
  toolbar?: ReactNode;
  selectionPanel?: ReactNode;
  selectionModal?: ReactNode;
  loadingMessage?: string;
  emptyState?: ReactNode;
  onPlayFolder?: (tracks: TreeTrack[], locationId: number) => void;
  onPreview?: (preview: FilePreviewState) => void;
}) {
  const content = emptyState ? emptyState : directoryMode === "browse" ? (
    <DirectoryBrowser
      root={root}
      currentLocationId={currentLocationId}
      emptyLabel={emptyLabel}
      onPlayFolder={onPlayFolder}
      onPreview={onPreview}
    />
  ) : (
    <DirectoryTree
      root={root}
      currentLocationId={currentLocationId}
      emptyLabel={emptyLabel}
      onPlayFolder={onPlayFolder}
      onPreview={onPreview}
    />
  );
  return (
    <section className="space-y-3 pb-28 lg:pb-8">
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
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto rounded-md border bg-card p-1">
            {tabs.map((source) => (
              <button
                key={source.key}
                className={`h-7 shrink-0 rounded px-2.5 text-xs font-medium ${
                  source.key === activeKey ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
                }`}
                onClick={() => onActiveKeyChange(source.key)}
              >
                {source.label}
              </button>
            ))}
          </div>
          {checkingLabel && <span className="inline-flex h-8 items-center px-2 text-xs text-muted-foreground">{checkingLabel}</span>}
        </div>
        {sourceSummary}
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
  onManage,
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
  onManage?: () => void;
  dlsiteUrl: string;
  syncLabel: string;
  showSync?: boolean;
  showFetch?: boolean;
}) {
  const [forkMenuOpen, setForkMenuOpen] = useState(false);
  const forkMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!forkMenuOpen) return;
    const close = (event: globalThis.MouseEvent) => {
      const target = event.target as Node | null;
      if (target && forkMenuRef.current?.contains(target)) return;
      setForkMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [forkMenuOpen]);

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
          {forkMenuOpen && (
            <div className="absolute right-0 z-30 mt-2 w-60 rounded-md border bg-popover p-1 text-sm shadow-lg">
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
            </div>
          )}
        </div>
      )}
      {showFetch && onFetch && (
        <Button variant="outline" size="sm" className="h-8" disabled={busy} onClick={onFetch}>
          <HardDriveDownload className="h-4 w-4" />
          Fetch
        </Button>
      )}
      {onManage && (
        <Button variant="outline" size="sm" className="h-8" disabled={busy} onClick={onManage}>
          <Trash2 className="h-4 w-4" />
          Manage
        </Button>
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
        {metadataLanguage && <span>Metadata <span className="font-semibold text-foreground">{languageLabel(metadataLanguage)}</span></span>}
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
            const label = translation.metadataLanguage ? languageLabel(translation.metadataLanguage) : "Unknown";
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
};

type FilePreviewState =
  | { kind: "image"; title: string; url: string }
  | { kind: "text"; title: string; locationId: number };

type MediaDeleteTarget = { kind: "cache" | "local"; locationId: number; title: string; path: string };

type SourceTabInfo = {
  key: string;
  label: string;
  fileSourceId: number | null;
  kind?: "local" | "remote" | "tracked" | "no_source";
  presence?: NonNullable<WorkDetail["sourcePresence"]>[number];
};

type RemoteSourceAvailability = {
  source: LibrarySource;
  summary: SourceAvailabilitySource;
  detail?: RemoteWorkDetail;
  loading?: boolean;
  error?: string;
};

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
      if (!sources.has(location.fileSourceId)) {
        const label =
          location.locationType === "local"
            ? "Local"
            : location.locationType === "cache"
              ? "Cache"
              : location.locationType === "remote_stream"
                ? "Remote"
                : location.fileSourceName;
        sources.set(location.fileSourceId, {
          key: `${location.fileSourceId}:${location.locationType}`,
          label,
          fileSourceId: location.fileSourceId,
        });
      }
    }
  }
  const tabs = Array.from(sources.values());
  const hasPresence = sourcePresence.some((presence) => presence.type && presence.type !== "location" && presence.type !== "remote");
  const baseTabs = tabs.length > 0
    ? tabs
    : hasPresence
      ? [{ key: "local", label: "Local", fileSourceId: null, kind: "local" as const }]
      : [{ key: "no-source", label: "No source", fileSourceId: null, kind: "no_source" as const }];
  for (const presence of sourcePresence) {
    if (presence.type !== "tracked") continue;
    baseTabs.push({
      key: trackedSourceTabKey(presence),
      label: "Tracked",
      fileSourceId: null,
      kind: "tracked",
      presence,
    });
  }
  for (const remote of remoteSources) {
    if (!remoteSourceCanBrowse(remote.summary)) continue;
    baseTabs.push({
      key: remoteSourceTabKey(remote.source.id),
      label: remote.source.displayName,
      fileSourceId: null,
      kind: "remote",
    });
  }
  return baseTabs;
}

function trackedUnforkedSources(sourcePresence: NonNullable<WorkDetail["sourcePresence"]>, remoteSources: RemoteSourceAvailability[]) {
  if (remoteSources.some((remote) => remoteSourceCanBrowse(remote.summary))) return [];
  return sourcePresence.filter((presence) => presence.type === "tracked");
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
      assetUrl: location.locationType === "local" ? `/api/media/${location.id}/asset` : location.downloadUrl,
      sizeBytes: location.sizeBytes,
      durationSeconds: location.durationSeconds ?? item.durationSeconds,
      availability: location.availability,
      cacheLocationId: location.locationType === "cache" && location.availability === "available" ? location.id : null,
      cachePath: location.locationType === "cache" ? location.path : "",
      cacheAvailable: location.locationType === "cache" && location.availability === "available",
      cacheStreamUrl: location.locationType === "cache" && location.availability === "available" ? `/api/media/${location.id}/stream` : "",
      localLocationId: location.locationType === "local" && location.availability === "available" ? location.id : null,
      localPath: location.locationType === "local" ? location.path : "",
      localAvailable: location.locationType === "local" && location.availability === "available",
      progress: item.progress,
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
  currentLocationId,
  onPlayFolder,
  onPreview,
  emptyLabel = "No local files detected.",
}: {
  root: TreeNode;
  currentLocationId: number | null;
  onPlayFolder?: (tracks: TreeTrack[], locationId: number) => void;
  onPreview?: (preview: FilePreviewState) => void;
  emptyLabel?: string;
}) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => initialExpandedTreePaths(root));
  const [visibleLimit, setVisibleLimit] = useState(160);
  useEffect(() => {
    setExpandedPaths(initialExpandedTreePaths(root));
    setVisibleLimit(160);
  }, [root]);
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
  message,
  onClose,
  onSave,
  onChange,
  onLocalChange,
}: {
  root: TreeNode;
  selectedPaths: Set<string>;
  selectedLocalPaths: Set<string>;
  disabled: boolean;
  plan?: RemoteWorkSavePlan | null;
  message?: string;
  onClose: () => void;
  onSave: () => void;
  onChange: (paths: Set<string>) => void;
  onLocalChange: (paths: Set<string>) => void;
}) {
  const allPaths = remoteSelectablePaths(root);
  const planByPath = useMemo(() => new Map((plan?.items ?? []).map((item) => [item.path, item])), [plan]);
  const localTree = useMemo(() => buildRemoteFetchLocalTree(plan), [plan]);
  const hasLocalFiles = Boolean(plan?.localFiles.length);
  const messageIsConflict = Boolean(plan && hasRemoteFetchConflicts(plan));
  const setAll = () => onChange(new Set(allPaths));
  const setAudioOnly = () => onChange(new Set(remoteSelectableFiles(root).filter((file) => file.kind === "audio").map((file) => file.sourcePath)));
  const clear = () => onChange(new Set());
  const selectLocalPath = (path: string, selected: boolean) => {
    const next = new Set(selectedLocalPaths);
    if (selected) next.add(path);
    else next.delete(path);
    onLocalChange(next);
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4">
      <div className="flex max-h-[86vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border bg-background shadow-xl" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex min-h-12 items-center justify-between gap-3 border-b px-4">
          <div>
            <h3 className="text-base font-semibold">Fetch selection</h3>
            <p className="text-xs text-muted-foreground">Choose local and remote files to merge into the fetched work directory.</p>
          </div>
          <IconButton title="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <Badge variant="secondary">{selectedPaths.size} remote / {allPaths.length}</Badge>
          {plan && plan.localFiles.length > 0 && <Badge variant="secondary">{selectedLocalPaths.size} local</Badge>}
          {plan && plan.summary.conflict > 0 && <Badge variant="outline" className="border-destructive/40 text-destructive">{plan.summary.conflict} conflicts</Badge>}
          {plan && plan.summary.conflict === 0 && <Badge variant="outline">{plan.summary.promote} to fetch</Badge>}
          <div className="ml-auto flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={disabled} onClick={setAll}>All</Button>
            <Button variant="outline" size="sm" disabled={disabled} onClick={setAudioOnly}>Audio</Button>
            <Button variant="outline" size="sm" disabled={disabled} onClick={clear}>None</Button>
          </div>
        </div>
        <div className={hasLocalFiles ? "grid min-h-0 flex-1 grid-cols-1 overflow-hidden bg-card md:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]" : "min-h-0 flex-1 overflow-auto bg-card p-2"}>
          {hasLocalFiles && (
            <div className="min-h-0 overflow-auto border-b p-2 md:border-b-0 md:border-r">
              <div className="mb-2 flex items-center justify-between gap-2 px-1">
                <div className="text-sm font-medium">Local files</div>
                <Badge variant="secondary">{selectedLocalPaths.size} selected</Badge>
              </div>
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
          <div className={hasLocalFiles ? "min-h-0 overflow-auto p-2" : ""}>
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
          <Button onClick={onSave} disabled={disabled || (selectedPaths.size === 0 && selectedLocalPaths.size === 0)}>
            <HardDriveDownload className="h-4 w-4" />
            Fetch
          </Button>
        </div>
      </div>
    </div>
  );
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
          <input type="checkbox" checked={checked} ref={(input) => { if (input) input.indeterminate = mixed; }} disabled={disabled || descendantItems.length === 0} onChange={toggleNode} />
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
            <input type="checkbox" checked={selected} disabled={disabled} onChange={(event) => onSelect(item.fullPath, event.target.checked)} />
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
          <input type="checkbox" checked={checked} ref={(input) => { if (input) input.indeterminate = mixed; }} disabled={disabled || nodePaths.length === 0} onChange={toggleNode} />
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
            <input
              type="checkbox"
              checked={selectedPaths.has(path)}
              disabled={disabled}
              onChange={(event) => {
                const next = new Set(selectedPaths);
                if (event.target.checked) next.add(path);
                else next.delete(path);
                onChange(next);
              }}
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
              {isLocal ? "This removes the local file and clears playback state for the work." : "The remote source and saved local files will not be deleted."}
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
              ? "This removes the local file from disk, marks its location unavailable, and clears progress and marks for the work."
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
  currentLocationId,
  onPlayFolder,
  onPreview,
  emptyLabel = "No local files detected.",
}: {
  root: TreeNode;
  currentLocationId: number | null;
  onPlayFolder?: (tracks: TreeTrack[], locationId: number) => void;
  onPreview?: (preview: FilePreviewState) => void;
  emptyLabel?: string;
}) {
  const [path, setPath] = useState<string[]>([]);
  const current = useMemo(() => nodeAtPath(root, path) ?? root, [root, path]);
  const folders = sortedFolders(current);
  const files = sortedFiles(current);
  useEffect(() => {
    if (!nodeAtPath(root, path)) {
      setPath([]);
    }
  }, [root, path]);

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
            className="flex min-h-9 w-full items-center gap-2 rounded-md border bg-background px-3 text-left text-sm hover:bg-muted"
            onClick={() => setPath(path.slice(0, -1))}
          >
            <ChevronLeft className="h-4 w-4 text-muted-foreground" />
            <span>Parent folder</span>
          </button>
        )}
        {folders.map((folder) => (
          <button
            key={folder.path || folder.name}
            className="flex min-h-9 w-full items-center gap-2 rounded-md border bg-background px-3 text-left text-sm hover:bg-muted"
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
      className="flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm font-medium hover:bg-muted"
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
  onPreview,
}: {
  file: TreeTrack;
  files: TreeTrack[];
  depth: number;
  isActive: boolean;
  onPlayFolder?: (tracks: TreeTrack[], locationId: number) => void;
  onPreview?: (preview: FilePreviewState) => void;
}) {
  const canPlay = Boolean(onPlayFolder && ["available", "remote"].includes(file.availability) && file.streamUrl);
  const preview = previewForFile(file);
  const canPreview = Boolean(preview && onPreview);
  const canDownload = Boolean(file.locationId > 0 && ["available"].includes(file.availability) && (file.locationType === "local" || file.locationType === "cache"));
  const canOpen = canPlay || canPreview || canDownload;
  const fileMeta = [file.kind === "audio" ? formatDuration(file.durationSeconds) : "", formatBytes(file.sizeBytes)].filter(Boolean).join(" · ");
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
      className={`flex min-h-9 items-center justify-between gap-3 rounded-md border px-3 text-left text-sm ${
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
      <span className="flex min-w-0 flex-1 items-center gap-2">
        {isActive ? <Pause className="h-4 w-4 text-primary" /> : fileIcon(file)}
        <span className="truncate">{file.title}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground" onClick={(event) => event.stopPropagation()}>
        {file.kind === "file" && canDownload && <ExternalLink className="h-3.5 w-3.5 text-primary" aria-label="Downloads in new tab" />}
        <span>{fileMeta}</span>
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
}: {
  root: TreeNode;
  emptyLabel: string;
  onClose: () => void;
  deleting?: boolean;
  onDeleteTargets?: (targets: MediaDeleteTarget[]) => void;
  allowCacheDelete?: boolean;
  allowLocalDelete?: boolean;
}) {
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const targets = useMemo(() => directoryManageTargets(root, { allowCacheDelete, allowLocalDelete }), [root, allowCacheDelete, allowLocalDelete]);
  const selectedTargets = useMemo(() => targets.filter((target) => selectedKeys.has(mediaDeleteTargetKey(target))), [targets, selectedKeys]);
  const allSelected = targets.length > 0 && selectedTargets.length === targets.length;
  const toggleAll = () => setSelectedKeys(allSelected ? new Set() : new Set(targets.map(mediaDeleteTargetKey)));
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
    onDeleteTargets?.(selectedTargets);
    setConfirming(false);
    setSelectedKeys(new Set());
  };
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
        <div className="min-h-0 flex-1 overflow-auto bg-card p-3">
          <DirectoryManager
            root={root}
            emptyLabel={emptyLabel}
            selectedKeys={selectedKeys}
            allowCacheDelete={allowCacheDelete}
            allowLocalDelete={allowLocalDelete}
            onToggleTarget={toggleTarget}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" disabled={targets.length === 0 || deleting} onClick={toggleAll}>
              {allSelected ? "Clear" : "Select all"}
            </Button>
            <span className="text-xs text-muted-foreground">{selectedTargets.length} selected / {targets.length} deletable</span>
          </div>
          <Button className="bg-destructive text-destructive-foreground hover:bg-destructive/90" size="sm" disabled={selectedTargets.length === 0 || deleting} onClick={() => setConfirming(true)}>
            <Trash2 className="h-4 w-4" />
            {deleting ? "Deleting" : "Delete selected"}
          </Button>
        </div>
      </div>
      {confirming && (
        <ConfirmMediaBatchDeleteModal
          targets={selectedTargets}
          deleting={deleting}
          onCancel={() => setConfirming(false)}
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
  onToggleTarget,
}: {
  root: TreeNode;
  emptyLabel: string;
  selectedKeys: Set<string>;
  allowCacheDelete?: boolean;
  allowLocalDelete?: boolean;
  onToggleTarget: (target: MediaDeleteTarget, selected: boolean) => void;
}) {
  const hasFiles = useMemo(() => sortedFilesDeep(root).length > 0, [root]);
  if (!hasFiles) {
    return <div className="text-sm text-muted-foreground">{emptyLabel}</div>;
  }
  return (
    <div className="space-y-1">
      <DirectoryManagerNode
        node={root}
        depth={0}
        selectedKeys={selectedKeys}
        allowCacheDelete={allowCacheDelete}
        allowLocalDelete={allowLocalDelete}
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
  onToggleTarget,
}: {
  node: TreeNode;
  depth: number;
  isRoot?: boolean;
  selectedKeys: Set<string>;
  allowCacheDelete?: boolean;
  allowLocalDelete?: boolean;
  onToggleTarget: (target: MediaDeleteTarget, selected: boolean) => void;
}) {
  const [open, setOpen] = useState(isRoot);
  const folders = sortedFolders(node);
  const files = sortedFiles(node);
  const stats = treeStats(node);
  const hasChildren = folders.length > 0 || files.length > 0;
  return (
    <div className="space-y-1">
      {!isRoot && (
        <button
          className="flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm font-medium hover:bg-muted"
          style={{ paddingLeft: depth * 14 + 8 }}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
          <Folder className="h-4 w-4 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{formatFolderStats(stats, playableFiles(node.files).length)}</span>
        </button>
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
  const fileMeta = [file.kind === "audio" ? formatDuration(file.durationSeconds) : "", formatBytes(file.sizeBytes), file.locationType].filter(Boolean).join(" · ");
  return (
    <div
      className="grid min-h-10 gap-2 rounded-md border bg-background px-3 py-2 text-sm md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
      style={{ marginLeft: depth * 14, width: `calc(100% - ${depth * 14}px)` }}
    >
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
      <div className="flex flex-wrap gap-2 md:justify-end">
        {targets.map((target) => {
          const key = mediaDeleteTargetKey(target);
          return (
            <label key={key} className="inline-flex h-8 items-center gap-2 rounded-md border bg-background px-2 text-xs hover:bg-muted">
              <input
                type="checkbox"
                checked={selectedKeys.has(key)}
                onChange={(event) => onToggleTarget(target, event.target.checked)}
              />
              <span>{target.kind === "cache" ? "Cache" : "Local"}</span>
            </label>
          );
        })}
        {targets.length === 0 && (
          <span className="inline-flex h-8 items-center text-xs text-muted-foreground">No file action</span>
        )}
      </div>
    </div>
  );
}

function ConfirmMediaBatchDeleteModal({
  targets,
  deleting,
  onCancel,
  onConfirm,
}: {
  targets: MediaDeleteTarget[];
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const localCount = targets.filter((target) => target.kind === "local").length;
  const cacheCount = targets.filter((target) => target.kind === "cache").length;
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/55 p-4" onMouseDown={onCancel}>
      <div className="w-full max-w-lg rounded-lg border bg-background shadow-xl" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b p-4">
          <div>
            <h3 className="text-base font-semibold">Confirm delete</h3>
            <p className="mt-1 text-sm text-muted-foreground">This is the second confirmation before deleting selected file locations.</p>
          </div>
          <IconButton title="Close" onClick={onCancel}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="space-y-3 p-4 text-sm">
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive">
            Delete {targets.length} selected location{targets.length === 1 ? "" : "s"}{localCount > 0 ? `, including ${localCount} local` : ""}{cacheCount > 0 ? ` and ${cacheCount} cache` : ""}.
          </div>
          <div className="max-h-44 overflow-auto rounded-md border bg-muted px-3 py-2 text-xs text-muted-foreground">
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
          <Button className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={onConfirm} disabled={deleting || targets.length === 0}>
            <Trash2 className="h-4 w-4" />
            {deleting ? "Deleting" : "Delete selected"}
          </Button>
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
    targets.push({ kind: "cache", locationId: file.cacheLocationId, title: file.title, path: file.cachePath });
  }
  if (options.allowLocalDelete && file.localAvailable && file.localLocationId !== null) {
    targets.push({ kind: "local", locationId: file.localLocationId, title: file.title, path: file.localPath });
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

function remoteFetchNeedsLocalReview(plan: RemoteWorkSavePlan) {
  return plan.localFiles.length > 0;
}

function formatRemoteFetchLocalReview(plan: RemoteWorkSavePlan) {
  const count = plan.localFiles.length;
  return `${count} local ${count === 1 ? "file is" : "files are"} available. Select the local and remote files that should be merged into the fetched work directory.`;
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

function initialExpandedTreePaths(root: TreeNode) {
  const paths = new Set<string>();
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
    return { kind: "image", title: file.title, url: file.assetUrl };
  }
  if (file.kind === "text" && file.locationId > 0) {
    return { kind: "text", title: file.title, locationId: file.locationId };
  }
  return null;
}

function FilePreviewModal({ preview, onClose }: { preview: FilePreviewState; onClose: () => void }) {
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
              <Button variant="outline" size="sm" disabled>
                <ImageIcon className="h-4 w-4" />
                Set cover
              </Button>
            )}
            <IconButton title="Close preview" onClick={onClose}>
              <X className="h-4 w-4" />
            </IconButton>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-background p-4">
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
  const lyrics = findLyricsForTrack(track, work.mediaItems);
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
    remoteSourceId: detail.sourceId,
    remoteWorkCode: detail.primaryCode || detail.remoteId,
    remotePath: track.sourcePath,
  };
}

function findLyricsForTrack(track: TreeTrack, items: MediaItem[]) {
  const candidates = items.flatMap((item) =>
    item.kind === "text"
      ? item.locations
          .filter((location) => location.locationType === "local" && location.availability === "available" && isLyricsPath(location.path))
          .map((location) => {
            const name = fileNameFromPath(location.path);
            return {
              locationId: location.id,
              title: name,
              keys: lyricMatchKeys(baseNameWithoutExtension(name)),
            };
          })
      : [],
  );
  if (candidates.length === 0) return null;
  const trackKeys = lyricMatchKeys(track.baseName || track.title);
  return candidates.find((candidate) => candidate.keys.some((key) => trackKeys.includes(key))) ?? null;
}

function isLyricsPath(path: string) {
  const lower = path.toLowerCase();
  return [".lrc", ".srt", ".vtt", ".txt", ".cue"].some((extension) => lower.endsWith(extension));
}

function lyricMatchKeys(value: string) {
  const normalized = normalizeLyricName(value);
  const withoutLeadingNumber = normalized.replace(/^\d+/, "");
  const withoutTrackPrefix = normalized.replace(/^track\d+/, "");
  return Array.from(new Set([normalized, withoutLeadingNumber, withoutTrackPrefix].filter((item) => item.length >= 2)));
}

function normalizeLyricName(value: string) {
  return value
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, "")
    .replace(/^(track|tr|disc|cd)[\s_.-]*/i, "")
    .replace(/[\s_.\-()[\]【】「」『』]+/g, "");
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
    return "Japanese";
  case "en":
  case "en-us":
    return "English";
  case "zh":
  case "zh-cn":
    return "Simplified Chinese";
  case "zh-tw":
    return "Traditional Chinese";
  case "ko":
  case "ko-kr":
    return "Korean";
  default:
    return value || "Unknown";
  }
}

function openWorkCodeRoute(code: string) {
  const cleanCode = code.trim();
  if (!cleanCode) return;
  window.history.pushState({ returnTo: window.location.pathname, returnLabel: "Back" }, "", `/${cleanCode}`);
  window.dispatchEvent(new Event("kikoto:navigation"));
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
  setSelectedCode: (code: string | null) => void,
) {
  try {
    const resolved = await api.resolveWorkCode(code);
    const work = await api.getWork(resolved.workId);
    setSelectedWork(work);
    if (resolved.resolvedCode && resolved.resolvedCode.toUpperCase() !== code.toUpperCase()) {
      window.history.replaceState(window.history.state ?? {}, "", `/${resolved.resolvedCode}`);
      setSelectedCode(resolved.resolvedCode);
      window.dispatchEvent(new Event("kikoto:navigation"));
    }
  } catch {
    setSelectedWork(null);
  }
}

function listeningStatusLabel(status: ListeningStatus) {
  return listeningStatusOptions.find((option) => option.value === status)?.label ?? "Unmarked";
}

function parseSearchTokens(query: string): SearchToken[] {
  const tokens: SearchToken[] = [];
  let rest = query;
  const wrappedPattern = /\$(-?tagw?|-?circle|-?va|duration|-duration|rate|sell|age|lang):([^$]+)\$/gi;
  rest = rest.replace(wrappedPattern, (_match, key: string, value: string) => {
    const token = searchTokenFromKeyValue(key, value);
    if (token) tokens.push(token);
    return " ";
  });
  const parts = splitSearchParts(rest);
  for (let index = 0; index < parts.length; index++) {
    const rawPart = parts[index];
    const part = rawPart.trim();
    if (!part) continue;
    const pendingPrefix = part.match(/^(-?tagw?|-?circle|-?va|circle|va|voice|creator|tag|duration|-duration|rate|rating|sell|sales|age|lang|language):$/i);
    if (pendingPrefix && index + 1 < parts.length) {
      const token = searchTokenFromKeyValue(pendingPrefix[1], parts[index + 1]);
      if (token) {
        tokens.push(token);
        index += 1;
        continue;
      }
    }
    const prefixed = part.match(/^(-?tagw?|-?circle|-?va|circle|va|voice|creator|tag|duration|-duration|rate|rating|sell|sales|age|lang|language):(.+)$/i);
    if (prefixed) {
      const token = searchTokenFromKeyValue(prefixed[1], prefixed[2]);
      if (token) {
        tokens.push(token);
        continue;
      }
    }
    if (/^(RJ|BJ|VJ|CC)\d{4,8}$/i.test(part)) {
      tokens.push({ kind: "code", value: part.toUpperCase() });
    } else {
      tokens.push({ kind: "text", value: part });
    }
  }
  return tokens.filter((token) => token.value.trim() !== "");
}

function splitSearchParts(value: string) {
  const parts: string[] = [];
  const pattern = /"([^"]+)"|'([^']+)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    parts.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return parts;
}

function searchTokenFromKeyValue(key: string, rawValue: string): SearchToken | null {
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

function normalizeSearchTokenDraft(draft: SearchTokenDraft): SearchToken | null {
  const value = draft.value.trim();
  if (!value) return null;
  if (draft.kind === "code") {
    return { kind: "code", value: value.toUpperCase() };
  }
  return { kind: draft.kind, value };
}

function compileLibrarySearchQuery(tokens: SearchToken[]) {
  return tokens.map((token) => {
    switch (token.kind) {
      case "code":
      case "text":
        return token.value;
      case "circle":
        return `$circle:${token.value}$`;
      case "voice_actor":
        return `$va:${token.value}$`;
      case "tag":
        return `$tag:${token.value}$`;
      case "exclude_tag":
        return `$-tag:${token.value}$`;
      case "rating_min":
        return `rating:${token.value}`;
      case "sales_min":
        return `sales:${token.value}`;
      case "age":
        return `$age:${token.value}$`;
      case "language":
        return `$lang:${token.value}$`;
      default:
        return token.value;
    }
  }).join(" ");
}

function formatRemoteSearchQuery(tokens: SearchToken[]) {
  return tokens.map(formatRemoteSearchToken).join(" ");
}

function formatRemoteSearchToken(token: SearchToken) {
  switch (token.kind) {
    case "circle":
      return `$circle:${token.value}$`;
    case "voice_actor":
      return `$va:${token.value}$`;
    case "tag":
      return `$tag:${token.value}$`;
    case "exclude_tag":
      return `$-tag:${token.value}$`;
    case "duration_min":
      return `$duration:${token.value}$`;
    case "duration_max":
      return `$-duration:${token.value}$`;
    case "rating_min":
      return `$rate:${token.value}$`;
    case "sales_min":
      return `$sell:${token.value}$`;
    case "age":
      return `$age:${token.value}$`;
    case "language":
      return `$lang:${token.value}$`;
    default:
      return formatSearchToken(token);
  }
}

function workMatchesSearch(work: Work, tokens: SearchToken[]) {
  if (tokens.length === 0) return true;
  return tokens.every((token) => workMatchesToken(work, token));
}

function workMatchesToken(work: Work, token: SearchToken) {
  const value = token.value.trim().toLowerCase();
  if (!value) return true;
  switch (token.kind) {
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
      return work.rating !== null && work.rating >= numericTokenValue(value);
    case "sales_min":
      return work.sales !== null && work.sales >= numericTokenValue(value);
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

function remoteWorkMatchesSearch(work: RemoteWork, tokens: SearchToken[]) {
  if (tokens.length === 0) return true;
  return tokens.every((token) => remoteWorkMatchesToken(work, token));
}

function remoteWorkMatchesToken(work: RemoteWork, token: SearchToken) {
  const value = token.value.trim().toLowerCase();
  if (!value) return true;
  switch (token.kind) {
    case "code":
      return work.primaryCode.toLowerCase().includes(value) || work.remoteId.toLowerCase().includes(value);
    case "circle":
      return work.circle.toLowerCase().includes(value);
    case "tag":
      return work.tags.some((tag) => tag.toLowerCase().includes(value));
    case "exclude_tag":
      return !work.tags.some((tag) => tag.toLowerCase().includes(value));
    case "rating_min":
      return work.rating !== null && work.rating >= numericTokenValue(value);
    case "sales_min":
      return work.sales !== null && work.sales >= numericTokenValue(value);
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

function numericTokenValue(value: string) {
  const number = Number(value.replace(/[^\d.]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function searchTokenLabel(token: SearchToken) {
  switch (token.kind) {
    case "code":
      return `Code: ${token.value}`;
    case "circle":
      return `Circle: ${token.value}`;
    case "voice_actor":
      return `VA: ${token.value}`;
    case "tag":
      return `Tag: ${token.value}`;
    case "exclude_tag":
      return `Exclude tag: ${token.value}`;
    case "rating_min":
      return `Rating >= ${token.value}`;
    case "sales_min":
      return `Sales >= ${token.value}`;
    case "duration_min":
      return `Duration >= ${token.value}`;
    case "duration_max":
      return `Duration <= ${token.value}`;
    case "age":
      return `Age: ${token.value}`;
    case "language":
      return `Language: ${token.value}`;
    case "text":
    default:
      return `Text: ${token.value}`;
  }
}

function searchQueryWithoutToken(tokens: SearchToken[], removeIndex: number) {
  return tokens.filter((_token, index) => index !== removeIndex).map(formatSearchToken).join(" ");
}

function formatSearchToken(token: SearchToken) {
  const value = formatSearchValue(token.value);
  switch (token.kind) {
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
      return `rating:${token.value}`;
    case "sales_min":
      return `sales:${token.value}`;
    case "duration_min":
      return `duration:${token.value}`;
    case "duration_max":
      return `-duration:${token.value}`;
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

function localScopeFromPath(path: string): LocalLibraryScope {
  if (path === "/tracked" || path === "/library/tracked") return "tracked";
  if (path === "/no-source" || path === "/library/no-source") return "no_source";
  return "local";
}

function sourceRouteKey(source: LibrarySource) {
  return source.code || source.displayName;
}

function remoteWorkRouteCode(work: RemoteWork) {
  return work.primaryCode || work.remoteId;
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
