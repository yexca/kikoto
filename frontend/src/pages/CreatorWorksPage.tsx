import {
  ChevronLeft,
  ChevronRight,
  Cloud,
  ExternalLink,
  FileAudio,
  GitBranchPlus,
  GitMerge,
  HardDriveDownload,
  Heart,
  ListChecks,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Tags,
  Trash2,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { toastFromError, useToast } from "@/components/ui/toast";
import { UserTagRow } from "@/components/UserTagRow";
import { CollectionPagination } from "@/components/collection/CollectionPagination";
import {
  CreatorCard,
  CreatorCollectionSkeleton,
  creatorCardMinHeightClassName,
  creatorCollectionClassName,
} from "@/components/creator/CreatorCard";
import { CatalogSyncBadge } from "@/components/creator/CatalogSyncBadge";
import { CreatorListMobileOptions } from "@/components/creator/CreatorListMobileOptions";
import { WorkCollectionLoadingState } from "@/components/work-collection/WorkCollectionLoadingState";
import { WorkCollectionPagination } from "@/components/work-collection/WorkCollectionPagination";
import { VoiceWorkOptionsSheet, type VoiceWorkFilter } from "@/pages/VoiceWorkOptionsSheet";
import { VoiceAdvancedRefreshSheet, isVoiceCatalogSourceSelectable } from "@/pages/VoiceAdvancedRefreshSheet";
import { useAuth } from "@/auth/AuthProvider";
import { usePermissionGate } from "@/auth/usePermissionGate";
import { NotFoundPage } from "@/app/NotFoundPage";
import { openWorkDetail } from "@/app/workDetailNavigation";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import {
  announceRemoteTrackCreated,
  isMatchingRemoteTrack,
  REMOTE_TRACK_TERMINAL_EVENT,
  type RemoteTrackTerminalDetail,
} from "@/app/remoteTrackWorkflows";
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
  type WorkCardBadge,
  type WorkCardViewModel,
} from "@/components/work-card/WorkCardShell";
import { circleSourceBadges } from "@/components/work-card/sourceBadges";
import { RemoteFetchWorkspaceDialog } from "@/features/work-detail/workflows/RemoteFetchWorkspaceDialog";
import { useRemoteFetchWorkspace } from "@/features/work-detail/workflows/useRemoteFetchWorkspace";
import {
  WorkCollectionLayoutPicker,
  workCollectionClassName,
  workCollectionStyle,
  useWorkCollectionLayout,
} from "@/components/work-collection/WorkCollectionLayout";
import {
  api,
  ApiError,
  type CircleSourceStat,
  type ListeningStatus,
  type VoiceAlias,
  type VoiceAliasCandidate,
  type VoiceCatalogRefreshState,
  type VoiceCatalogRefreshRequest,
  type VoiceDetail,
  type VoiceKnownWork,
  type VoiceMergeReview,
  type VoiceRemoteSourceSet,
  type VoiceSummary,
} from "@/lib/api";
import { dismissKeyboardOnEnter } from "@/lib/keyboard";
import { NAVIGATION_EVENT, historyStateWithReturn, navigateToWorkspaceUp } from "@/lib/browserHistory";
import { currentClientStorageScope } from "@/lib/clientStorageScope";
import { hasPlaybackHistory } from "@/lib/playbackHistory";
import { openCircleRoute, openCircleSeriesRoute } from "@/pages/CirclesPage";
import { creatorBrowseSearch, creatorBrowseStateFromSearch } from "@/pages/creatorBrowseState";
import {
  isVoiceListLocation,
  readLastVoiceListLocation,
  writeLastVoiceListLocation,
} from "@/pages/voiceNavigationState";
import {
  mergeVoiceWorks,
  voiceWorkHasRemoteAvailability,
  voiceWorkObservedSourceTags,
  voiceWorkRemoteTarget,
  type VoiceWorkView,
} from "@/pages/voiceWorkModel";
import { voiceWorkIsExplicitlyUnavailable } from "@/pages/voiceWorkAvailabilityModel";

type CreatorKind = "circle" | "voice";
type VoiceFilter = "all" | "favorite" | "tagged" | "available" | "local" | "remote" | "missing";
const voicePageSizeOptions = [24, 48, 96] as const;
const voiceFilterOptions: readonly { value: VoiceFilter; label: string }[] = [
  { value: "all", label: "All voices" },
  { value: "favorite", label: "Favorite" },
  { value: "tagged", label: "Tagged" },
  { value: "available", label: "Available" },
  { value: "local", label: "Local" },
  { value: "remote", label: "Remote" },
  { value: "missing", label: "Missing" },
];
const voiceFilters: readonly VoiceFilter[] = voiceFilterOptions.map((option) => option.value);
const workPageSizeOptions = [24, 48] as const;
const aliasSuggestMinChars = 2;
const aliasSuggestMaxResults = 12;
const listeningStatusOptions: { value: ListeningStatus; label: string }[] = [
  { value: "none", label: "Unmarked" },
  { value: "want_to_listen", label: "Want" },
  { value: "listening", label: "Listening" },
  { value: "finished", label: "Finished" },
  { value: "relisten", label: "Relisten" },
  { value: "paused", label: "Shelved" },
];

export function CreatorWorksPage({ kind, active = true }: { kind: CreatorKind; active?: boolean }) {
  if (kind !== "voice") {
    return (
      <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
        Circle creator view has moved to Circles.
      </div>
    );
  }
  return <VoiceCreatorWorksPage active={active} />;
}

function VoiceCreatorWorksPage({ active }: { active: boolean }) {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    if (!active) return;
    const syncPath = () => setPath(window.location.pathname);
    syncPath();
    window.addEventListener("popstate", syncPath);
    window.addEventListener("kikoto:navigation", syncPath);
    return () => {
      window.removeEventListener("popstate", syncPath);
      window.removeEventListener("kikoto:navigation", syncPath);
    };
  }, [active]);
  const personId = voicePersonIdFromPath(path);
  if (personId) return <VoiceDetailPage personId={personId} />;
  return <VoiceListPage active={active} />;
}

function VoiceListPage({ active }: { active: boolean }) {
  const auth = useAuth();
  const toast = useToast();
  const storageScope = currentClientStorageScope(auth.user?.id ?? null);
  const initialBrowseState = useMemo(
    () =>
      creatorBrowseStateFromSearch(
        window.location.search,
        { query: "", filter: "all" as VoiceFilter, tag: "", page: 1, pageSize: 24 },
        voiceFilters,
        voicePageSizeOptions,
      ),
    [],
  );
  const [voices, setVoices] = useState<VoiceSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState(initialBrowseState.query);
  const [requestQuery, setRequestQuery] = useState(initialBrowseState.query);
  const [filter, setFilter] = useState<VoiceFilter>(initialBrowseState.filter);
  const [tagFilter, setTagFilter] = useState(initialBrowseState.tag);
  const [tagOptions, setTagOptions] = useState<string[]>([]);
  const [page, setPage] = useState(initialBrowseState.page);
  const [pageSize, setPageSize] = useState(initialBrowseState.pageSize);
  const [total, setTotal] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setRequestQuery(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!active) return;
    const search = creatorBrowseSearch({ query, filter, tag: tagFilter, page, pageSize });
    const location = `/voices${search}`;
    window.history.replaceState(window.history.state ?? {}, "", location);
    writeLastVoiceListLocation(storageScope, location);
  }, [active, filter, page, pageSize, query, storageScope, tagFilter]);

  useEffect(() => {
    const controller = new AbortController();
    setIsLoading(true);
    setLoadError("");
    api
      .listVoices({ page, pageSize, query: requestQuery, filter, tag: tagFilter, signal: controller.signal })
      .then((result) => {
        setVoices(result.voices);
        setTotal(result.total);
        setTagOptions(result.tagOptions);
        setHasLoaded(true);
        setMessage(
          result.total === 0 && !requestQuery.trim() && filter === "all" && !tagFilter
            ? "No voice actor credits have been derived from known work metadata yet."
            : "",
        );
        if (result.page !== page) setPage(result.page);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setLoadError("Voice actors could not be loaded.");
        toast.notify(toastFromError(error, "Voice actor API is unavailable."));
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });
    return () => controller.abort();
  }, [filter, page, pageSize, reloadToken, requestQuery, tagFilter]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const changeFilter = (value: VoiceFilter) => {
    setFilter(value);
    setPage(1);
  };
  const changeTagFilter = (value: string) => {
    setTagFilter(value);
    setPage(1);
  };
  const changePageSize = (value: number) => {
    setPageSize(value);
    setPage(1);
  };
  const paginationProps = {
    page,
    pageSize,
    totalItems: total,
    totalPages,
    itemLabel: "voice actors",
    ariaLabel: "Voice actor pages",
    pageSizeOptions: voicePageSizeOptions,
    pageSizeControlClassName: "hidden lg:block",
    compactMobile: true,
    refreshing: isLoading && hasLoaded,
    refreshingLabel: "Refreshing voice actors",
    leadingControls: (
      <div className="lg:hidden">
        <CreatorListMobileOptions
          label="Voice actor"
          filter={filter}
          defaultFilter="all"
          filterOptions={voiceFilterOptions}
          tag={tagFilter}
          tagOptions={tagOptions}
          pageSize={pageSize}
          pageSizeOptions={voicePageSizeOptions}
          onFilterChange={changeFilter}
          onTagChange={changeTagFilter}
          onPageSizeChange={changePageSize}
        />
      </div>
    ),
    onPageChange: setPage,
    onPageSizeChange: changePageSize,
  };

  const updateVoice = (next: VoiceSummary) => {
    setVoices((items) => items.map((item) => (item.personId === next.personId ? { ...item, ...next } : item)));
    if (filter !== "all" || tagFilter || requestQuery.trim()) setReloadToken((value) => value + 1);
  };

  const toggleFavorite = async (voice: VoiceSummary) => {
    try {
      updateVoice({ ...voice, ...(await api.updateVoiceUserState(voice.personId, { favorite: !voice.favorite })) });
    } catch (error) {
      toast.notify(toastFromError(error, "Voice favorite update failed."));
    }
  };

  const saveTags = async (voice: VoiceSummary, tags: string[]) => {
    try {
      const result = await api.setVoiceUserTags(voice.personId, tags);
      updateVoice({ ...voice, userTags: result.userTags });
    } catch (error) {
      toast.notify(toastFromError(error, "Voice tags update failed."));
    }
  };

  return (
    <div className="space-y-5">
      {message && <div className="rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">{message}</div>}

      <section className="space-y-3">
        <div className="flex flex-col gap-3 rounded-lg border bg-card p-3 text-sm xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md border bg-background px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              className="min-w-0 flex-1 bg-transparent outline-none"
              value={query}
              onKeyDown={dismissKeyboardOnEnter}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search voices or tags"
            />
          </div>
          <div className="hidden flex-wrap items-center gap-2 lg:flex">
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={filter}
              onChange={(event) => changeFilter(event.target.value as VoiceFilter)}
              aria-label="Voice filter"
            >
              {voiceFilterOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={tagFilter}
              onChange={(event) => changeTagFilter(event.target.value)}
              aria-label="Voice tag filter"
            >
              <option value="">All tags</option>
              {tagOptions.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
          </div>
        </div>

        <CollectionPagination {...paginationProps} placement="top" />

        {isLoading && !hasLoaded ? (
          <CreatorCollectionSkeleton label="Loading voice actors" />
        ) : !hasLoaded && loadError ? (
          <Card className={creatorCardMinHeightClassName} role="alert">
            <CardContent
              className={`grid ${creatorCardMinHeightClassName} place-items-center gap-3 p-5 text-center text-sm text-destructive`}
            >
              <span>{loadError}</span>
              <Button size="sm" variant="outline" onClick={() => setReloadToken((value) => value + 1)}>
                Retry
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div
            className={creatorCollectionClassName}
            role="region"
            aria-label="Voice actor results"
            aria-busy={isLoading}
          >
            {voices.length > 0 ? (
              voices.map((voice) => (
                <CreatorCard
                  key={voice.personId}
                  name={voice.displayName}
                  identityLabel={voice.latestWork ? undefined : "Voice actor"}
                  aliases={voice.aliases}
                  latestWork={voice.latestWork}
                  favorite={voice.favorite}
                  userTags={voice.userTags}
                  syncState={voice.syncState}
                  workCount={voice.knownWorks}
                  availabilityCounts={{ local: voice.localWorks, remote: voice.remoteWorks }}
                  unavailableCount={Math.max(0, voice.knownWorks - voice.playableWorks)}
                  sources={voice.sourceSummaries}
                  onOpen={() => openVoiceRoute(voice.personId)}
                  onFavoriteToggle={() => void toggleFavorite(voice)}
                  onTagsSave={(tags) => saveTags(voice, tags)}
                />
              ))
            ) : (
              <Card className={creatorCardMinHeightClassName}>
                <CardContent
                  className={`grid ${creatorCardMinHeightClassName} place-items-center p-5 text-sm text-muted-foreground`}
                >
                  No voice actors match this view.
                </CardContent>
              </Card>
            )}
          </div>
        )}

        <CollectionPagination {...paginationProps} placement="bottom" />
      </section>
    </div>
  );
}

function EntitySkeletonLine({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className}`} />;
}

function VoiceDetailPage({ personId }: { personId: number }) {
  const auth = useAuth();
  const toast = useToast();
  const requireDownloadsManage = usePermissionGate("downloads:manage");
  const mobileNavigationLayout = useMobileNavigationLayout();
  const voiceListStorageScope = currentClientStorageScope(auth.user?.id ?? null);
  const navigateToList = () => navigateToVoicesList(voiceListStorageScope, mobileNavigationLayout);
  const [detail, setDetail] = useState<VoiceDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isWorksLoading, setIsWorksLoading] = useState(false);
  const [remoteMatches, setRemoteMatches] = useState<VoiceRemoteSourceSet[]>([]);
  const [catalogRefresh, setCatalogRefresh] = useState<VoiceCatalogRefreshState | null>(null);
  const [isRemoteLoading, setIsRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState("");
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<VoiceWorkFilter>("all");
  const [workOptionsOpen, setWorkOptionsOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof workPageSizeOptions)[number]>(24);
  const { mobileColumns, desktopColumns, setMobileColumns, setDesktopColumns } = useWorkCollectionLayout();
  const [selectedWorkKeys, setSelectedWorkKeys] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [isBulkBusy, setIsBulkBusy] = useState(false);
  const [saveConfirm, setSaveConfirm] = useState<{ count: number; run: () => Promise<void> } | null>(null);
  const [detailPanel, setDetailPanel] = useState<"aliases" | "advanced" | null>(null);
  const aliasActionRef = useRef<HTMLButtonElement | null>(null);
  const advancedActionRef = useRef<HTMLButtonElement | null>(null);
  const aliasPanelID = useId();
  const advancedPanelID = useId();

  useEffect(() => {
    setIsLoading(true);
    setDetailPanel(null);
    setWorkOptionsOpen(false);
    setRemoteMatches([]);
    setCatalogRefresh(null);
    setRemoteError("");
    setNotFound(false);
    api
      .getVoiceSummary(personId)
      .then((item) => {
        setDetail(item);
        setMessage("");
        setIsWorksLoading(true);
        api
          .getVoiceWorks(personId)
          .then((result) => {
            setDetail((current) => (current?.personId === personId ? { ...current, works: result.works } : current));
          })
          .catch((error) => {
            toast.notify(toastFromError(error, "Voice works are unavailable."));
          })
          .finally(() => setIsWorksLoading(false));
      })
      .catch((error) => {
        setDetail(null);
        if (error instanceof ApiError && error.status === 404) {
          setNotFound(true);
          return;
        }
        toast.notify(toastFromError(error, "Voice actor detail is unavailable."));
      })
      .finally(() => setIsLoading(false));
  }, [personId]);

  const loadRemoteMatches = async (notify = false) => {
    setIsRemoteLoading(true);
    setRemoteError("");
    try {
      const result = await api.getVoiceRemoteMatches(personId);
      setRemoteMatches(result.remoteMatches);
      setCatalogRefresh(result.refresh);
      const failed = result.remoteMatches.filter((source) => remoteSourceFailed(source));
      if (failed.length > 0 || notify) {
        const timedOut = failed.some((source) => source.status === "timeout");
        const message =
          failed.length > 0
            ? `${failed.length} remote source${failed.length === 1 ? "" : "s"} ${timedOut ? "timed out or failed" : "failed"}.`
            : "Voice catalog loaded.";
        if (failed.length > 0) toast.info(message);
        else toast.success(message);
      }
    } catch (error) {
      const fallback = error instanceof Error ? error.message : "Remote matches unavailable.";
      setRemoteError(fallback);
      toast.notify(toastFromError(error, "Remote matches unavailable."));
    } finally {
      setIsRemoteLoading(false);
    }
  };

  const canForceRefreshCatalog = auth.hasPermission("metadata:sync") && !auth.demoMode;

  useEffect(() => {
    if (!detail) return;
    let cancelled = false;
    const loadPersistedCatalog = async () => {
      setIsRemoteLoading(true);
      setRemoteError("");
      try {
        const persisted = await api.getVoiceRemoteMatches(personId);
        if (cancelled) return;
        setRemoteMatches(persisted.remoteMatches);
        setCatalogRefresh(persisted.refresh);
      } catch (error) {
        if (cancelled) return;
        const fallback = error instanceof Error ? error.message : "Voice catalog unavailable.";
        setRemoteError(fallback);
        toast.notify(toastFromError(error, "Voice catalog unavailable."));
      } finally {
        if (!cancelled) setIsRemoteLoading(false);
      }
    };
    void loadPersistedCatalog();
    return () => {
      cancelled = true;
    };
  }, [detail?.personId, personId]);

  const catalogRefreshActive = catalogRefresh?.status === "queued" || catalogRefresh?.status === "running";
  useEffect(() => {
    if (!catalogRefreshActive) return;
    let cancelled = false;
    let requestRunning = false;
    const poll = async () => {
      if (requestRunning) return;
      requestRunning = true;
      try {
        const result = await api.getVoiceRemoteMatches(personId);
        if (cancelled) return;
        setRemoteMatches(result.remoteMatches);
        const stillActive = result.refresh.status === "queued" || result.refresh.status === "running";
        if (!stillActive) {
          try {
            const summary = await api.getVoiceSummary(personId);
            if (!cancelled) {
              setDetail((current) => (current ? { ...summary, works: current.works, remoteMatches: [] } : current));
            }
          } catch {
            // The persisted catalog remains usable if only the summary refresh fails.
          }
        }
        if (!cancelled) setCatalogRefresh(result.refresh);
      } catch (error) {
        if (!cancelled) setRemoteError(error instanceof Error ? error.message : "Voice catalog unavailable.");
      } finally {
        requestRunning = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [catalogRefresh?.runId, catalogRefreshActive, personId]);

  const refreshVoiceCatalog = async (request: VoiceCatalogRefreshRequest, queuedMessage: string) => {
    if (!canForceRefreshCatalog) {
      await loadRemoteMatches(true);
      return;
    }
    setIsRemoteLoading(true);
    setRemoteError("");
    try {
      const refresh = await api.refreshVoiceCatalog(personId, request);
      setCatalogRefresh(refresh);
      toast.info(
        refresh.status === "queued" || refresh.status === "running" ? queuedMessage : "Voice catalog is current.",
      );
    } catch (error) {
      setRemoteError(error instanceof Error ? error.message : "Voice catalog refresh failed.");
      toast.notify(toastFromError(error, "Voice catalog refresh failed."));
    } finally {
      setIsRemoteLoading(false);
    }
  };

  const refreshVoiceMetadata = (mode: "incremental" | "full") =>
    void refreshVoiceCatalog(
      { scope: "metadata", mode },
      mode === "full" ? "Full voice metadata refresh queued." : "Voice metadata refresh queued.",
    );
  const retryVoiceMetadata = () => refreshVoiceMetadata("incremental");
  const refreshAllRemoteSources = () => {
    const sourceIds = remoteMatches.filter(isVoiceCatalogSourceSelectable).map((source) => source.sourceId);
    return void refreshVoiceCatalog(
      { scope: "remote", mode: "incremental", ...(sourceIds.length > 0 ? { sourceIds } : {}) },
      "Voice remote refresh queued.",
    );
  };
  const firstPull = detail?.syncState === "never";
  const firstPullVoiceCatalog = () =>
    void refreshVoiceCatalog({ scope: "all", mode: "full" }, "First voice catalog pull queued.");

  const knownWorks = detail?.works ?? [];
  const alternateAliasCount = useMemo(
    () =>
      (detail?.aliasRecords ?? []).filter(
        (alias) => alias.alias.trim() !== "" && alias.alias.trim() !== detail?.displayName.trim(),
      ).length,
    [detail?.aliasRecords, detail?.displayName],
  );
  const remoteSourceWarning = Boolean(remoteError) || remoteMatches.some(remoteSourceFailed);
  const mergedWorks = useMemo(() => mergeVoiceWorks(knownWorks, remoteMatches), [knownWorks, remoteMatches]);
  const filteredWorks = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return mergedWorks.filter((work) => {
      const userTagNames = "userTags" in work ? work.userTags.map((tag) => tag.name) : [];
      const matchesQuery =
        !needle ||
        [work.primaryCode, work.title, work.circle, ...work.tags, ...userTagNames].some((value) =>
          value.toLowerCase().includes(needle),
        );
      if (!matchesQuery) return false;
      const local = "local" in work ? work.local : work.hasLocal;
      const remote = voiceWorkHasRemoteAvailability(work);
      const cache = "cache" in work ? work.cache : work.hasCache;
      switch (filter) {
        case "available":
          return local || remote || cache;
        case "local":
          return local;
        case "remote":
          return remote;
        case "missing":
          return voiceWorkIsExplicitlyUnavailable(work);
        default:
          return true;
      }
    });
  }, [filter, mergedWorks, query]);
  const totalPages = Math.max(1, Math.ceil(filteredWorks.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageWorks = filteredWorks.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const changeWorkFilter = (value: VoiceWorkFilter) => {
    setFilter(value);
    setPage(1);
  };
  const changeWorkQuery = (value: string) => {
    setQuery(value);
    setPage(1);
  };
  const changeWorkPageSize = (value: number) => {
    setPageSize(value as (typeof workPageSizeOptions)[number]);
    setPage(1);
  };
  useEffect(() => setPage(1), [filter, pageSize, query]);
  useEffect(() => {
    setSelectedWorkKeys(
      (current) =>
        new Set(Array.from(current).filter((key) => filteredWorks.some((work) => voiceWorkSelectionKey(work) === key))),
    );
  }, [filteredWorks]);
  const selectedWorks = mergedWorks.filter((work) => selectedWorkKeys.has(voiceWorkSelectionKey(work)));
  const selectablePageWorks = pageWorks.filter(isVoiceBulkSelectable);
  const selectedSaveable = selectedWorks.filter(voiceWorkRemoteTarget);
  const selectedSyncable = selectedWorks.filter(
    (work) => voiceWorkRemoteTarget(work) && !voiceWorkHasImportedRemote(work),
  );

  const toggleFavorite = async () => {
    if (!detail) return;
    try {
      const next = await api.updateVoiceUserState(detail.personId, {
        favorite: !detail.favorite,
      });
      setDetail((current) =>
        current ? { ...current, ...next, works: current.works, remoteMatches: current.remoteMatches } : current,
      );
    } catch (error) {
      toast.notify(toastFromError(error, "Favorite update failed."));
    }
  };

  const refreshDetail = async () => {
    const item = await api.getVoice(personId);
    setDetail((current) => (item ? { ...item, remoteMatches: current?.remoteMatches ?? [] } : item));
    void loadRemoteMatches(false);
  };

  useEffect(() => {
    const refreshTrackedWork = (event: Event) => {
      const terminal = (event as CustomEvent<RemoteTrackTerminalDetail>).detail;
      if (
        !terminal ||
        (terminal.status !== "succeeded" && terminal.status !== "partial") ||
        !mergedWorks.some((work) => {
          const target = voiceWorkRemoteTarget(work);
          return target && isMatchingRemoteTrack(terminal, target.sourceId, target.code, work.primaryCode);
        })
      )
        return;
      void refreshDetail();
    };
    window.addEventListener(REMOTE_TRACK_TERMINAL_EVENT, refreshTrackedWork);
    return () => window.removeEventListener(REMOTE_TRACK_TERMINAL_EVENT, refreshTrackedWork);
  }, [mergedWorks]);
  const fetchWorkspace = useRemoteFetchWorkspace({ onWorksChanged: refreshDetail });

  const saveVoiceTags = async (tags: string[]) => {
    if (!detail) return;
    try {
      const result = await api.setVoiceUserTags(detail.personId, tags);
      setDetail((current) => (current ? { ...current, userTags: result.userTags } : current));
    } catch (error) {
      toast.notify(toastFromError(error, "Voice tags update failed."));
    }
  };

  const updateWorkMark = async (work: VoiceWorkView, status: ListeningStatus) => {
    const workId = "workId" in work ? work.workId : null;
    if (!workId) {
      await syncAndMarkVoiceWork(work, status);
      return;
    }
    try {
      const result = await api.updateWorkUserState(workId, { listeningStatus: status });
      setDetail((current) =>
        current
          ? {
              ...current,
              works: current.works.map((item) =>
                item.workId === workId ? { ...item, listeningMark: result.listeningStatus } : item,
              ),
            }
          : current,
      );
    } catch (error) {
      toast.notify(toastFromError(error, "Listening mark update failed."));
    }
  };

  const syncAndMarkVoiceWork = async (work: VoiceWorkView, status: ListeningStatus) => {
    const target = voiceWorkRemoteTarget(work);
    if (!target) return;
    setIsBulkBusy(true);
    setMessage("");
    try {
      const syncResult = await api.syncRemoteSourceWork(target.sourceId, target.code, "voice_mark_interest");
      await api.updateWorkUserState(syncResult.workId, { listeningStatus: status });
      toast.success(`Tracked and marked ${syncResult.primaryCode}.`);
      await refreshDetail();
    } catch (error) {
      toast.notify(toastFromError(error, "Listening mark update failed."));
    } finally {
      setIsBulkBusy(false);
    }
  };

  const trackVoiceWorkForState = async (work: VoiceWorkView, reason: string) => {
    const target = voiceWorkRemoteTarget(work);
    if (!target) return null;
    const syncResult = await api.syncRemoteSourceWork(target.sourceId, target.code, reason);
    return syncResult.workId;
  };

  const ensureVoiceWorkForList = async (work: VoiceWorkView) => {
    const workId = "workId" in work ? work.workId : null;
    if (workId) return workId;
    try {
      const nextWorkId = await trackVoiceWorkForState(work, "voice_list");
      if (!nextWorkId) return null;
      await refreshDetail();
      return nextWorkId;
    } catch (error) {
      toast.notify(toastFromError(error, "Track for list failed."));
      return null;
    }
  };

  const toggleWorkSelection = (work: VoiceWorkView, checked: boolean) => {
    const key = voiceWorkSelectionKey(work);
    setSelectedWorkKeys((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const toggleSelectionMode = () => {
    setSelectionMode((value) => {
      if (value) setSelectedWorkKeys(new Set());
      return !value;
    });
  };

  const toggleVisibleSelection = (checked: boolean) => {
    setSelectedWorkKeys((current) => {
      const next = new Set(current);
      selectablePageWorks.forEach((work) => {
        const key = voiceWorkSelectionKey(work);
        if (checked) next.add(key);
        else next.delete(key);
      });
      return next;
    });
  };

  const bulkSyncAndSave = async () => {
    if (selectedSyncable.length === 0) return;
    if (!requireDownloadsManage()) return;
    setIsBulkBusy(true);
    setMessage("");
    try {
      const results = await runVoiceBulkBySource(selectedSyncable, "track_fetch");
      const synced = results.reduce((total, result) => total + result.synced, 0);
      const fetched = results.reduce((total, result) => total + result.fetched, 0);
      const failed = results.reduce((total, result) => total + result.failed, 0);
      const runIds = results.map((result) => `#${result.runId}`).join(", ");
      const message = `Bulk workflow ${runIds}: tracked ${synced}, queued ${fetched} Fetch jobs, failed ${failed}.`;
      if (failed > 0) toast.warning(message);
      else toast.success(message);
      await refreshDetail();
    } catch (error) {
      toast.notify(toastFromError(error, "Bulk track/fetch failed."));
    } finally {
      setIsBulkBusy(false);
    }
  };

  const bulkSave = async () => {
    if (selectedSaveable.length === 0) return;
    if (!requireDownloadsManage()) return;
    setSaveConfirm({ count: selectedSaveable.length, run: runBulkSave });
  };

  const runBulkSave = async () => {
    if (!requireDownloadsManage()) return;
    setIsBulkBusy(true);
    setMessage("");
    try {
      const results = await runVoiceBulkBySource(selectedSaveable, "fetch");
      const fetched = results.reduce((total, result) => total + result.fetched, 0);
      const failed = results.reduce((total, result) => total + result.failed, 0);
      const runIds = results.map((result) => `#${result.runId}`).join(", ");
      const message = `Bulk workflow ${runIds}: queued ${fetched} Fetch jobs, failed ${failed}.`;
      if (failed > 0) toast.warning(message);
      else toast.success(message);
      await refreshDetail();
    } catch (error) {
      toast.notify(toastFromError(error, "Bulk fetch failed."));
    } finally {
      setIsBulkBusy(false);
      setSaveConfirm(null);
    }
  };

  const runVoiceBulkBySource = (works: VoiceWorkView[], action: "fetch" | "track_fetch") => {
    const groups = new Map<number, string[]>();
    works.forEach((work) => {
      const target = voiceWorkRemoteTarget(work);
      if (!target) return;
      groups.set(target.sourceId, [...(groups.get(target.sourceId) ?? []), target.code]);
    });
    return Promise.all(Array.from(groups, ([sourceId, codes]) => api.recordRemoteBulkRun({ action, sourceId, codes })));
  };

  const saveSingleWork = async (work: VoiceWorkView) => {
    const target = voiceWorkRemoteTarget(work);
    if (!target) return;
    await fetchWorkspace.open({
      sourceId: target.sourceId,
      remoteCode: target.code,
      canonicalCode: work.primaryCode,
      sourceDisplayName: "sourceName" in work ? work.sourceName : undefined,
    });
  };

  const syncSingleWork = async (work: VoiceWorkView) => {
    const target = voiceWorkRemoteTarget(work);
    if (!target) return;
    setIsBulkBusy(true);
    try {
      const result = await api.trackRemoteSourceWork(target.sourceId, target.code, "voice_card_fetch");
      announceRemoteTrackCreated(target.sourceId, target.code, result);
      toast.notify({
        kind: "info",
        message: result.deduplicated
          ? `Track workflow #${result.runId} is already queued.`
          : `Track workflow #${result.runId} queued.`,
      });
    } catch (error) {
      toast.notify(toastFromError(error, "Track failed."));
    } finally {
      setIsBulkBusy(false);
    }
  };

  if (isLoading) {
    return <VoiceDetailSkeleton />;
  }

  if (notFound) {
    return (
      <NotFoundPage
        title="Voice actor not found"
        message={`Voice actor ${personId} is not available in the current catalog.`}
        onBack={navigateToList}
        onOpenLibrary={() => {
          window.history.pushState({}, "", "/");
          window.dispatchEvent(new Event("kikoto:navigation"));
        }}
      />
    );
  }

  if (!detail) {
    return (
      <div className="space-y-3">
        <Button variant="outline" size="sm" onClick={navigateToList}>
          <ChevronLeft className="h-4 w-4" /> {voiceReturnLabel(mobileNavigationLayout)}
        </Button>
        <div className="rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">{message}</div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Button variant="outline" size="sm" onClick={navigateToList}>
        <ChevronLeft className="h-4 w-4" />
        {voiceReturnLabel(mobileNavigationLayout)}
      </Button>

      {message && <div className="rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">{message}</div>}

      <section>
        <Card>
          <CardContent className="space-y-4 p-5">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">#{detail.personId}</Badge>
                  <CatalogSyncBadge state={detail.syncState} />
                  {detail.favorite && <Badge variant="secondary">Favorite</Badge>}
                </div>
                <h2 className="mt-3 truncate text-2xl font-semibold lg:text-3xl">{detail.displayName}</h2>
                <div className="mt-3 flex min-w-0 flex-wrap items-center gap-1.5" aria-label="Voice actor statistics">
                  <Badge variant={detail.localWorks > 0 ? "secondary" : "outline"} className="tabular-nums">
                    Local {detail.localWorks}
                  </Badge>
                  <Badge variant="outline" className="tabular-nums">
                    Remote {detail.remoteWorks}
                  </Badge>
                  <UserTagRow tags={detail.userTags} onSave={saveVoiceTags} className="min-w-0 flex-1" />
                </div>
              </div>
              <div className="flex flex-nowrap shrink-0 gap-1.5 lg:gap-2" role="group" aria-label="Voice actor actions">
                <Button
                  variant={detail.favorite ? "default" : "outline"}
                  size="icon"
                  className="h-[var(--control-icon-size)] w-[var(--control-icon-size)] lg:h-[var(--control-height-sm)] lg:w-auto lg:px-[var(--control-padding-sm-x)] lg:text-xs"
                  aria-label={detail.favorite ? "Remove favorite" : "Add favorite"}
                  aria-pressed={detail.favorite}
                  title={detail.favorite ? "Remove favorite" : "Add favorite"}
                  onClick={() => void toggleFavorite()}
                >
                  <Heart className={`h-4 w-4 ${detail.favorite ? "fill-current" : ""}`} />
                  <span className="hidden lg:inline">Favorite</span>
                </Button>
                {!mobileNavigationLayout && (
                  <Button
                    ref={aliasActionRef}
                    variant={detailPanel === "aliases" ? "secondary" : "outline"}
                    size="sm"
                    className="h-[var(--control-height-sm)] gap-2 px-[var(--control-padding-sm-x)]"
                    aria-haspopup="dialog"
                    aria-expanded={detailPanel === "aliases"}
                    aria-controls={detailPanel === "aliases" ? aliasPanelID : undefined}
                    onClick={() => setDetailPanel((current) => (current === "aliases" ? null : "aliases"))}
                  >
                    <Tags className="h-4 w-4" />
                    Aliases
                    {alternateAliasCount > 0 && <span className="tabular-nums">{alternateAliasCount}</span>}
                  </Button>
                )}
                {firstPull ? (
                  <Button
                    variant="default"
                    size="sm"
                    className="h-[var(--control-icon-size)] gap-1.5 px-2 lg:h-[var(--control-height-sm)] lg:gap-2 lg:px-[var(--control-padding-sm-x)]"
                    aria-label="First pull voice catalog"
                    disabled={!canForceRefreshCatalog || isRemoteLoading || catalogRefreshActive}
                    onClick={firstPullVoiceCatalog}
                  >
                    {isRemoteLoading || catalogRefreshActive ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4" />
                    )}
                    <span>First pull</span>
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-[var(--control-icon-size)] gap-1.5 px-2 lg:h-[var(--control-height-sm)] lg:gap-2 lg:px-[var(--control-padding-sm-x)] lg:text-xs"
                      aria-label="Retry voice metadata"
                      title="Retry metadata"
                      disabled={!canForceRefreshCatalog || isRemoteLoading || catalogRefreshActive}
                      onClick={retryVoiceMetadata}
                    >
                      {isRemoteLoading || catalogRefreshActive ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="h-4 w-4" />
                      )}
                      <span className="lg:hidden">Metadata</span>
                      <span className="hidden lg:inline">Retry metadata</span>
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-[var(--control-icon-size)] gap-1.5 px-2 lg:h-[var(--control-height-sm)] lg:gap-2 lg:px-[var(--control-padding-sm-x)] lg:text-xs"
                      aria-label="Refresh voice remote sources"
                      title="Refresh remote"
                      disabled={!canForceRefreshCatalog || isRemoteLoading || catalogRefreshActive}
                      onClick={refreshAllRemoteSources}
                    >
                      {isRemoteLoading || catalogRefreshActive ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Cloud className="h-4 w-4" />
                      )}
                      <span className="lg:hidden">Remote</span>
                      <span className="hidden lg:inline">Refresh remote</span>
                    </Button>
                  </>
                )}
                <Button
                  ref={advancedActionRef}
                  variant={detailPanel === "advanced" ? "secondary" : "outline"}
                  size="icon"
                  className="relative h-[var(--control-icon-size)] w-[var(--control-icon-size)] lg:h-[var(--control-height-sm)] lg:w-auto lg:px-[var(--control-padding-sm-x)] lg:text-xs"
                  aria-haspopup="dialog"
                  aria-expanded={detailPanel === "advanced"}
                  aria-controls={detailPanel === "advanced" ? advancedPanelID : undefined}
                  aria-label={
                    remoteSourceWarning
                      ? "Open advanced refresh actions with attention"
                      : "Open advanced refresh actions"
                  }
                  title="Advanced refresh"
                  onClick={() => setDetailPanel((current) => (current === "advanced" ? null : "advanced"))}
                >
                  <SlidersHorizontal className="h-4 w-4" />
                  <span className="hidden lg:inline">Advanced</span>
                  {remoteSourceWarning && <span className="text-warning-foreground">!</span>}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {!mobileNavigationLayout && (
          <AnchoredPopover
            open={detailPanel === "aliases"}
            anchorRef={aliasActionRef}
            onOpenChange={(open) => setDetailPanel(open ? "aliases" : null)}
            className="w-[min(34rem,calc(100vw-1.5rem))] p-4"
            bottomCollisionPadding={96}
            zIndex={70}
          >
            <div id={aliasPanelID} role="dialog" aria-label="Aliases">
              <AliasReviewPanel
                personId={detail.personId}
                aliases={detail.aliasRecords ?? []}
                canManage={auth.hasPermission("metadata:sync")}
                onAliasesChange={(aliases) =>
                  setDetail((current) =>
                    current
                      ? {
                          ...current,
                          aliasRecords: aliases,
                          aliases: aliases.map((alias) => alias.alias),
                          ...(current.syncState === "never"
                            ? {}
                            : { syncState: "attention", syncReason: "aliases_changed" }),
                        }
                      : current,
                  )
                }
                onMerged={() => void refreshDetail()}
                onMessage={setMessage}
              />
            </div>
          </AnchoredPopover>
        )}

        <VoiceAdvancedRefreshSheet
          open={detailPanel === "advanced"}
          mobile={mobileNavigationLayout}
          anchorRef={advancedActionRef}
          sources={remoteMatches}
          loading={isRemoteLoading}
          refreshing={catalogRefreshActive}
          activeScope={catalogRefreshActive ? catalogRefresh?.scope : null}
          error={remoteError}
          canRefresh={canForceRefreshCatalog}
          aliasesPanel={
            <AliasReviewPanel
              personId={detail.personId}
              aliases={detail.aliasRecords ?? []}
              canManage={auth.hasPermission("metadata:sync")}
              onAliasesChange={(aliases) =>
                setDetail((current) =>
                  current
                    ? {
                        ...current,
                        aliasRecords: aliases,
                        aliases: aliases.map((alias) => alias.alias),
                        ...(current.syncState === "never"
                          ? {}
                          : { syncState: "attention", syncReason: "aliases_changed" }),
                      }
                    : current,
                )
              }
              onMerged={() => void refreshDetail()}
              onMessage={setMessage}
            />
          }
          onClose={() => setDetailPanel(null)}
          onRefreshCatalog={(mode, sourceIds) =>
            void refreshVoiceCatalog({ scope: "remote", mode, sourceIds }, "Voice remote refresh queued.")
          }
          onRefreshMetadata={refreshVoiceMetadata}
        />
      </section>

      <section className="space-y-3">
        <div className="hidden flex-col gap-2 rounded-lg border bg-card p-3 lg:flex lg:flex-row lg:items-center">
          <div className="flex min-h-10 flex-1 items-center gap-2 rounded-md border bg-background px-3 text-sm text-muted-foreground">
            <Search className="h-4 w-4" />
            <input
              className="min-w-0 flex-1 bg-transparent outline-none"
              value={query}
              onKeyDown={dismissKeyboardOnEnter}
              onChange={(event) => changeWorkQuery(event.target.value)}
              placeholder="Search voice works"
            />
          </div>
          <div className="hidden shrink-0 gap-2 lg:flex">
            <WorkCollectionLayoutPicker
              mobileColumns={mobileColumns}
              desktopColumns={desktopColumns}
              onMobileColumnsChange={setMobileColumns}
              onDesktopColumnsChange={setDesktopColumns}
            />
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={filter}
              onChange={(event) => changeWorkFilter(event.target.value as VoiceWorkFilter)}
              aria-label="Work filter"
            >
              <option value="all">All works</option>
              <option value="available">Available</option>
              <option value="local">Local</option>
              <option value="remote">Remote</option>
              <option value="missing">Missing</option>
            </select>
            <Button variant={selectionMode ? "default" : "outline"} size="sm" onClick={toggleSelectionMode}>
              Select
            </Button>
          </div>
        </div>
        <div className="lg:hidden">
          <WorkCollectionPagination
            placement="top"
            page={currentPage}
            pageSize={pageSize}
            totalItems={filteredWorks.length}
            totalPages={totalPages}
            compactMobile
            refreshing={isWorksLoading || isRemoteLoading || catalogRefreshActive}
            refreshingLabel="Refreshing voice works"
            leadingControls={
              <Button
                variant="outline"
                size="icon"
                className="relative h-11 w-11"
                aria-label={`Open voice work options${query.trim() || filter !== "all" || selectionMode ? ", filters active" : ""}`}
                title="Voice work options"
                aria-haspopup="dialog"
                aria-expanded={workOptionsOpen}
                onClick={() => setWorkOptionsOpen(true)}
              >
                <SlidersHorizontal className="h-4 w-4" />
                {(query.trim() || filter !== "all" || selectionMode) && (
                  <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-primary" aria-hidden="true" />
                )}
              </Button>
            }
            onPageChange={setPage}
          />
        </div>
        <VoiceWorkOptionsSheet
          open={workOptionsOpen}
          onClose={() => setWorkOptionsOpen(false)}
          filter={filter}
          onFilterChange={changeWorkFilter}
          query={query}
          onQueryChange={changeWorkQuery}
          pageSize={pageSize}
          pageSizeOptions={workPageSizeOptions}
          onPageSizeChange={changeWorkPageSize}
          mobileColumns={mobileColumns}
          onMobileColumnsChange={setMobileColumns}
          selectionMode={selectionMode}
          onSelectWorks={() => {
            setWorkOptionsOpen(false);
            toggleSelectionMode();
          }}
        />
        {selectionMode && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2 text-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Checkbox
                checked={
                  selectablePageWorks.length > 0 &&
                  selectablePageWorks.every((work) => selectedWorkKeys.has(voiceWorkSelectionKey(work)))
                }
                onCheckedChange={toggleVisibleSelection}
                aria-label="Select visible works"
              />
              {selectedWorks.length} selected
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => toggleVisibleSelection(true)}>
                Select all
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSelectedWorkKeys(new Set());
                  setSelectionMode(false);
                }}
              >
                Cancel selection
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={isBulkBusy || selectedSyncable.length === 0}
                onClick={() => void bulkSyncAndSave()}
              >
                <GitBranchPlus className="h-4 w-4" />
                Track + Fetch {selectedSyncable.length}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={isBulkBusy || selectedSaveable.length === 0}
                onClick={() => void bulkSave()}
              >
                <HardDriveDownload className="h-4 w-4" />
                Fetch {selectedSaveable.length}
              </Button>
            </div>
          </div>
        )}
        {pageWorks.length > 0 ? (
          <div
            className={workCollectionClassName()}
            style={workCollectionStyle(mobileColumns, desktopColumns)}
            aria-busy={isWorksLoading || isRemoteLoading || catalogRefreshActive}
          >
            {pageWorks.map((work) => (
              <div key={`${"sourceId" in work ? work.sourceId : "known"}:${work.primaryCode}`}>
                <VoiceWorkCard
                  work={work}
                  selected={selectedWorkKeys.has(voiceWorkSelectionKey(work))}
                  selectable={isVoiceBulkSelectable(work)}
                  selectionActive={selectionMode}
                  onSelectedChange={(checked) => toggleWorkSelection(work, checked)}
                  onSync={() => void syncSingleWork(work)}
                  onSave={() => void saveSingleWork(work)}
                  onStatusChange={(status) => void updateWorkMark(work, status)}
                  onFavoriteSaved={(favorite) => {
                    setDetail((current) =>
                      current
                        ? {
                            ...current,
                            works: current.works.map((item) =>
                              item.primaryCode === work.primaryCode ? { ...item, favorite } : item,
                            ),
                          }
                        : current,
                    );
                  }}
                  onEnsureWork={() => ensureVoiceWorkForList(work)}
                />
              </div>
            ))}
          </div>
        ) : isWorksLoading || isRemoteLoading || catalogRefreshActive ? (
          <WorkCollectionLoadingState
            label="Loading voice works"
            mobileColumns={mobileColumns}
            desktopColumns={desktopColumns}
          />
        ) : (
          <Card className="min-h-72">
            <CardContent className="grid min-h-72 place-items-center p-5 text-sm text-muted-foreground">
              No works match this view.
            </CardContent>
          </Card>
        )}
        {totalPages > 1 && (
          <div className="lg:hidden">
            <WorkCollectionPagination
              placement="bottom"
              page={currentPage}
              pageSize={pageSize}
              totalItems={filteredWorks.length}
              totalPages={totalPages}
              onPageChange={setPage}
            />
          </div>
        )}
        {totalPages > 1 && (
          <div className="hidden lg:block">
            <CatalogPagination
              page={currentPage}
              pageSize={pageSize}
              totalItems={filteredWorks.length}
              totalPages={totalPages}
              onPageChange={setPage}
              onPageSizeChange={changeWorkPageSize}
            />
          </div>
        )}
      </section>
      {saveConfirm && (
        <SaveConfirmModal
          count={saveConfirm.count}
          onClose={() => setSaveConfirm(null)}
          onConfirm={() => void saveConfirm.run()}
        />
      )}
      <RemoteFetchWorkspaceDialog workspace={fetchWorkspace} />
    </div>
  );
}

function VoiceWorkCard({
  work,
  selected,
  selectable,
  selectionActive,
  onSelectedChange,
  onSync,
  onSave,
  onStatusChange,
  onFavoriteSaved,
  onEnsureWork,
}: {
  work: VoiceWorkView;
  selected: boolean;
  selectable: boolean;
  selectionActive: boolean;
  onSelectedChange: (checked: boolean) => void;
  onSync: () => void;
  onSave: () => void;
  onStatusChange: (status: ListeningStatus) => void;
  onFavoriteSaved: (favorite: boolean) => void;
  onEnsureWork: () => Promise<number | null>;
}) {
  const isKnown = "local" in work;
  const local = "local" in work ? work.local : work.hasLocal;
  const remote = voiceWorkHasRemoteAvailability(work);
  const cache = "cache" in work ? work.cache : work.hasCache;
  const workId = "workId" in work ? work.workId : null;
  const favorite = "favorite" in work ? work.favorite : false;
  const listeningMark = "listeningMark" in work ? work.listeningMark : "none";
  const isUnavailable = voiceWorkIsExplicitlyUnavailable(work);
  const canOpen = Boolean((isKnown && workId) || (!isKnown && work.primaryCode));
  const view = voiceWorkCardView(work);

  return (
    <WorkCardShell
      work={view}
      selection={
        selectionActive ? (
          <WorkCardSelection checked={selected} disabled={!selectable} onChange={onSelectedChange} />
        ) : undefined
      }
      canOpen={canOpen}
      onOpen={() => openWorkRoute(work)}
      onCircleOpen={(externalId) => openCircleRoute(externalId)}
      onSeriesOpen={
        "seriesTitleId" in work && work.seriesTitleId && "circleExternalId" in work && work.circleExternalId
          ? () => openCircleSeriesRoute(work.circleExternalId, work.seriesTitleId)
          : undefined
      }
      footer={
        <WorkCardFooter
          left={<WorkCardDLsiteAction href={voiceWorkDLsiteURL(work)} />}
          right={
            <>
              <WorkCardActionButton
                title="Track"
                disabled={!voiceWorkRemoteTarget(work)}
                onClick={(event) => {
                  event.stopPropagation();
                  onSync();
                }}
              >
                <GitBranchPlus className="h-4 w-4" />
              </WorkCardActionButton>
              <WorkCardActionButton
                title="Fetch"
                disabled={!voiceWorkRemoteTarget(work)}
                onClick={(event) => {
                  event.stopPropagation();
                  onSave();
                }}
              >
                <HardDriveDownload className="h-4 w-4" />
              </WorkCardActionButton>
              <WorkCardListButton
                workId={workId}
                active={favorite}
                disabled={!workId && !voiceWorkRemoteTarget(work)}
                ensureWorkId={onEnsureWork}
                onSaved={onFavoriteSaved}
              />
              <WorkCardQuickMarkButton
                value={normalizeListeningStatus(listeningMark)}
                disabled={isUnavailable && !voiceWorkRemoteTarget(work)}
                onChange={onStatusChange}
              />
            </>
          }
        />
      }
    />
  );
}

function AliasReviewPanel({
  personId,
  aliases,
  canManage,
  onAliasesChange,
  onMerged,
  onMessage,
}: {
  personId: number;
  aliases: VoiceAlias[];
  canManage: boolean;
  onAliasesChange: (aliases: VoiceAlias[]) => void;
  onMerged: () => void;
  onMessage: (message: string) => void;
}) {
  const [aliasDraft, setAliasDraft] = useState("");
  const [candidates, setCandidates] = useState<VoiceAliasCandidate[]>([]);
  const [mergeReviews, setMergeReviews] = useState<VoiceMergeReview[]>([]);
  const [mergeTarget, setMergeTarget] = useState<VoiceAliasCandidate | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSuggestOpen, setIsSuggestOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const suggestRef = useRef<HTMLDivElement | null>(null);
  const shouldShowSuggestions = isSuggestOpen && candidates.length > 0 && candidates.length <= aliasSuggestMaxResults;

  const loadCandidates = async () => {
    if (!canManage) return;
    if (aliasDraft.trim().length < aliasSuggestMinChars) {
      setCandidates([]);
      return;
    }
    setIsLoading(true);
    try {
      setCandidates(await api.listVoiceAliasCandidates(personId, aliasDraft));
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "Alias candidate search failed.");
    } finally {
      setIsLoading(false);
    }
  };

  const loadMergeReviews = async () => {
    if (!canManage) {
      setMergeReviews([]);
      return;
    }
    try {
      setMergeReviews(await api.listVoiceMergeReviews(personId));
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "Merge review history failed.");
    }
  };

  useEffect(() => {
    void loadMergeReviews();
  }, [canManage, personId]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadCandidates();
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [aliasDraft, canManage, personId]);

  useEffect(() => {
    if (!isSuggestOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (suggestRef.current?.contains(target)) return;
      setIsSuggestOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsSuggestOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isSuggestOpen]);

  const addAlias = async () => {
    if (!aliasDraft.trim()) return;
    try {
      const next = await api.createVoiceAlias(personId, aliasDraft);
      onAliasesChange(next);
      setAliasDraft("");
      onMessage("Alias saved.");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "Alias save failed.");
    }
  };

  const deleteAlias = async (alias: VoiceAlias) => {
    try {
      const result = await api.deleteVoiceAlias(personId, alias.id);
      onAliasesChange(result.aliases);
      onMessage(result.deleted > 0 ? "Alias deleted." : "Primary alias is kept.");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "Alias delete failed.");
    }
  };

  const mergeCandidate = async (candidate: VoiceAliasCandidate) => {
    try {
      const result = await api.mergeVoiceAliasCandidate(personId, candidate.personId);
      onMessage(`Merged ${result.mergedName} into ${result.targetName}.`);
      onMerged();
      setCandidates((items) => items.filter((item) => item.personId !== candidate.personId));
      setMergeTarget(null);
      void loadMergeReviews();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "Alias merge failed.");
    }
  };

  const undoMerge = async (review: VoiceMergeReview) => {
    try {
      const result = await api.undoVoiceMerge(personId, review.id);
      onMessage(`Restored ${result.restoredName}.`);
      onMerged();
      void loadMergeReviews();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "Merge undo failed.");
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <h3 className="font-semibold">Aliases</h3>
        <p className="text-sm text-muted-foreground">Review alternate names and merge duplicate voice actors.</p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {aliases.length > 0 ? (
          aliases.map((alias) => (
            <Badge key={alias.id} variant={alias.source === "primary_name" ? "secondary" : "outline"} className="gap-1">
              {alias.alias}
              {canManage && alias.source !== "primary_name" && (
                <button
                  className="rounded-sm hover:text-destructive"
                  aria-label={`Delete alias ${alias.alias}`}
                  onClick={() => void deleteAlias(alias)}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </Badge>
          ))
        ) : (
          <Badge variant="warning">No aliases</Badge>
        )}
      </div>
      {canManage && (
        <>
          <div className="relative" ref={suggestRef}>
            <div className="flex gap-2">
              <div className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md border bg-background px-3">
                <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
                <input
                  ref={inputRef}
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                  value={aliasDraft}
                  onKeyDown={dismissKeyboardOnEnter}
                  onChange={(event) => {
                    setAliasDraft(event.target.value);
                    setIsSuggestOpen(true);
                  }}
                  placeholder="Add alias or search duplicate voice actor"
                />
              </div>
              <Button variant="outline" size="sm" onClick={() => void addAlias()}>
                <Plus className="h-4 w-4" /> Add
              </Button>
            </div>
            {shouldShowSuggestions && (
              <div className="app-scroll absolute left-0 right-0 top-11 z-30 max-h-72 overflow-auto rounded-md border bg-popover p-1 shadow-lg">
                {candidates.slice(0, aliasSuggestMaxResults).map((candidate) => (
                  <button
                    key={candidate.personId}
                    className="flex w-full items-center justify-between gap-3 rounded-sm px-3 py-2 text-left text-sm hover:bg-muted"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      setAliasDraft(candidate.displayName);
                      setIsSuggestOpen(false);
                      inputRef.current?.focus();
                    }}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{candidate.displayName}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {candidate.knownWorks} works ·{" "}
                        {[
                          ...new Set(
                            candidate.aliases
                              .map((alias) => alias.alias)
                              .filter((alias) => alias !== candidate.displayName),
                          ),
                        ].join(", ") || "No extra aliases"}
                      </span>
                    </span>
                    <GitMerge className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </div>
            )}
          </div>
          {aliasDraft.trim().length >= aliasSuggestMinChars && candidates.length > aliasSuggestMaxResults && (
            <div className="rounded-md border bg-background p-3 text-sm text-muted-foreground">
              Too many matches. Keep typing to narrow candidates.
            </div>
          )}
          {candidates.length > 0 && candidates.length <= aliasSuggestMaxResults && (
            <div className="space-y-2">
              {candidates.slice(0, 4).map((candidate) => (
                <div
                  key={candidate.personId}
                  className="flex items-center justify-between gap-3 rounded-md border bg-background p-3 text-sm"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{candidate.displayName}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {candidate.knownWorks} works ·{" "}
                      {[
                        ...new Set(
                          candidate.aliases
                            .map((alias) => alias.alias)
                            .filter((alias) => alias !== candidate.displayName),
                        ),
                      ].join(", ") || "No extra aliases"}
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setMergeTarget(candidate)}>
                    <GitMerge className="h-4 w-4" />
                    Merge
                  </Button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {mergeReviews.length > 0 && (
        <div className="space-y-2 border-t pt-3">
          <div className="text-sm font-medium">Merge history</div>
          {mergeReviews.slice(0, 4).map((review) => (
            <div
              key={review.id}
              className="flex items-center justify-between gap-3 rounded-md border bg-background p-3 text-sm"
            >
              <div className="min-w-0">
                <div className="truncate font-medium">{review.sourceName}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {review.status === "undone" ? "Undone" : "Merged"} · {review.createdAt}
                </div>
              </div>
              {canManage && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={review.status !== "merged"}
                  onClick={() => void undoMerge(review)}
                >
                  Undo
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      {mergeTarget && (
        <FloatingConfirm
          title="Merge voice actor"
          description={`Merge ${mergeTarget.displayName} into this voice actor? You can undo it from merge history.`}
          confirmLabel="Merge"
          onClose={() => setMergeTarget(null)}
          onConfirm={() => void mergeCandidate(mergeTarget)}
        />
      )}
    </div>
  );
}

function FloatingConfirm({
  title,
  description,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/40 p-4" onMouseDown={onClose}>
      <div
        className="w-full max-w-sm rounded-lg border bg-card p-4 shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h3 className="text-base font-semibold">{title}</h3>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
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

function WorkProgressLine({ progress }: { progress: NonNullable<VoiceKnownWork["progress"]> }) {
  return (
    <div className="space-y-1">
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${workProgressPercent(progress)}%` }} />
      </div>
      <div className="truncate text-xs text-muted-foreground">
        {progress.completed
          ? "Finished"
          : `Resume ${progress.title || "track"} at ${formatTime(progress.positionSeconds)}`}
      </div>
    </div>
  );
}

function voiceWorkCardView(work: VoiceWorkView): WorkCardViewModel {
  const isKnown = "local" in work;
  const sourceName = "sourceName" in work ? work.sourceName : "";
  const observedSourceTags = voiceWorkObservedSourceTags(work);
  const availableBadges = isKnown
    ? circleSourceBadges({ local: work.local, remote: work.remote, cache: work.cache, sourceTags: observedSourceTags })
    : circleSourceBadges({
        local: work.hasLocal,
        remote: work.hasRemote || work.remotePlayable,
        cache: work.hasCache,
        sourceTags: observedSourceTags,
      });
  const observedStatusBadges = voiceObservedStatusBadges(observedSourceTags);
  const sourceBadges =
    availableBadges.length > 0 || observedStatusBadges.length > 0
      ? [...availableBadges, ...observedStatusBadges]
      : [
          {
            key: "source:unknown",
            label: "Not checked",
            variant: "warning" as const,
            title: "No source availability observation has been recorded.",
          },
        ];
  return {
    code: work.primaryCode || sourceName || "Source",
    title: work.title,
    circle: work.circle || sourceName || "Unknown circle",
    circleExternalId: "circleExternalId" in work ? work.circleExternalId : undefined,
    ageRating: work.ageRating,
    voiceActors: work.voiceActors,
    voiceCredits: "voiceCredits" in work ? work.voiceCredits : undefined,
    coverUrl: work.coverUrl,
    rating: work.rating,
    ratingCount: work.ratingCount,
    sales: work.sales,
    regularPrice: "regularPrice" in work ? work.regularPrice : null,
    price: work.price,
    priceCurrency: "priceCurrency" in work ? work.priceCurrency : "JPY",
    series: "series" in work ? work.series || null : null,
    hasAvailableNonOriginEdition: work.hasAvailableNonOriginEdition,
    hasPlaybackHistory: "progress" in work && hasPlaybackHistory(work.progress),
    dlsiteTags: dlsiteTagBadges(work.tags),
    userTags: isKnown ? userTagBadges(work.userTags ?? []) : [],
    sourceBadges,
  };
}

function remoteSourceFailed(source: VoiceRemoteSourceSet) {
  return !["ok", "disabled", "unsupported", "refreshing", "pending"].includes(source.status);
}

function VoiceDetailSkeleton() {
  return (
    <div className="space-y-5">
      <EntitySkeletonLine className="h-9 w-32" />
      <section>
        <Card>
          <CardContent className="space-y-4 p-5">
            <EntitySkeletonLine className="h-5 w-24" />
            <EntitySkeletonLine className="h-9 w-64" />
            <EntitySkeletonLine className="h-5 w-80" />
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {Array.from({ length: 4 }, (_, index) => (
                <EntitySkeletonLine key={index} className="h-4 w-20" />
              ))}
            </div>
          </CardContent>
        </Card>
      </section>
      <WorkCollectionLoadingState label="Loading voice works" />
    </div>
  );
}

function voiceWorkSelectionKey(work: VoiceWorkView) {
  return `${"sourceId" in work ? work.sourceId : "known"}:${work.primaryCode}`;
}

function isVoiceBulkSelectable(work: VoiceWorkView) {
  if ("local" in work && work.local) return false;
  return voiceWorkRemoteTarget(work) !== null;
}

function voiceWorkHasImportedRemote(work: VoiceWorkView) {
  if ("remote" in work) return work.remote;
  return work.hasRemote;
}

function voiceWorkReleaseDate(work: VoiceWorkView) {
  return "releaseDate" in work ? work.releaseDate || "" : "";
}

function voiceWorkUpdatedAt(work: VoiceWorkView) {
  return work.updatedAt || voiceWorkReleaseDate(work);
}

function voiceWorkSales(work: VoiceWorkView) {
  return work.sales ?? null;
}

function voiceWorkDLsiteURL(work: VoiceWorkView) {
  return "dlsiteUrl" in work && work.dlsiteUrl
    ? work.dlsiteUrl
    : `https://www.dlsite.com/maniax/work/=/product_id/${encodeURIComponent(work.primaryCode)}.html`;
}

function MarkMenu({ value, onChange }: { value: ListeningStatus; onChange: (status: ListeningStatus) => void }) {
  return (
    <div className="absolute bottom-10 left-0 z-20 w-44 overflow-hidden rounded-md border bg-popover p-1 shadow-lg">
      {listeningStatusOptions.map((option) => (
        <button
          key={option.value}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted"
          onClick={() => onChange(option.value)}
        >
          <ListChecks
            className={value === option.value && value !== "none" ? "h-3.5 w-3.5 text-primary" : "h-3.5 w-3.5"}
          />
          {option.label}
        </button>
      ))}
    </div>
  );
}

function normalizeListeningStatus(status: string): ListeningStatus {
  return listeningStatusOptions.some((option) => option.value === status) ? (status as ListeningStatus) : "none";
}

function listeningStatusLabel(status: string) {
  return (
    listeningStatusOptions.find((option) => option.value === normalizeListeningStatus(status))?.label ?? "Unmarked"
  );
}

function voiceObservedStatusBadges(sourceTags: CircleSourceStat[]): WorkCardBadge[] {
  return sourceTags
    .filter((source) => source.sourceId && source.key !== "cache" && source.status !== "available" && source.count <= 0)
    .map((source) => {
      const status = voiceSourceStatusLabel(source.status);
      return {
        key: `source:observed:${source.sourceId}`,
        label: `${source.displayName || "Remote source"}: ${status}`,
        variant: "warning" as const,
        title: `Observed source status: ${status}`,
      };
    });
}

function voiceSourceStatusLabel(status: string) {
  switch (status) {
    case "not_found":
      return "Not found";
    case "unavailable":
      return "Unavailable";
    case "disabled":
      return "Disabled";
    case "error":
      return "Error";
    default:
      return "Not checked";
  }
}

function CatalogPagination({
  page,
  pageSize,
  totalItems,
  totalPages,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageSize: 24 | 48;
  totalItems: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: 24 | 48) => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card px-3 py-2 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
      <div>
        {totalItems} works · page {page} of {totalPages}
      </div>
      <div className="flex items-center gap-2">
        <select
          className="h-9 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          value={pageSize}
          onChange={(event) => onPageSizeChange(Number(event.target.value) as 24 | 48)}
          aria-label="Works per page"
        >
          {workPageSizeOptions.map((value) => (
            <option key={value} value={value}>
              {value} / page
            </option>
          ))}
        </select>
        <Button
          variant="outline"
          size="icon"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => onPageChange(Math.max(1, page - 1))}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label="Next page"
          disabled={page >= totalPages}
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function voicePersonIdFromPath(path: string) {
  const match = path.match(/^\/voices\/([^/]+)\/?$/i);
  if (!match) return 0;
  const value = Number(decodeURIComponent(match[1]));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function formatTime(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function workProgressPercent(progress: NonNullable<VoiceKnownWork["progress"]>) {
  if (!progress.durationSeconds || progress.durationSeconds <= 0) return 0;
  return Math.min(100, Math.max(0, (progress.positionSeconds / progress.durationSeconds) * 100));
}

export function openVoiceRoute(personId: number) {
  const returnTo = currentVoiceReturnPath();
  window.history.pushState(
    historyStateWithReturn(returnTo, voiceReturnLabelForLocation(returnTo)),
    "",
    `/voices/${personId}`,
  );
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

function navigateToVoicesList(storageScope: string, mobile: boolean) {
  navigateToWorkspaceUp({
    mobile,
    fallbackLocation: readLastVoiceListLocation(storageScope) ?? "/voices",
    isWorkspaceListLocation: isVoiceListLocation,
  });
}

function openWorkRoute(work: VoiceWorkView) {
  const remoteTarget = voiceWorkRemoteTarget(work);
  const options = { returnTo: currentVoiceReturnPath(), returnLabel: "Back to voices", workPreview: work };
  if (work.workId) {
    openWorkDetail(
      {
        kind: "known",
        canonicalCode: work.primaryCode,
        source: remoteTarget ? { sourceId: remoteTarget.sourceId, remoteCode: remoteTarget.code } : null,
      },
      options,
    );
    return;
  }
  if (remoteTarget) {
    openWorkDetail({ kind: "remote-only", sourceId: remoteTarget.sourceId, remoteCode: remoteTarget.code }, options);
  }
}

function currentVoiceReturnPath() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function voiceReturnLabel(mobile: boolean) {
  if (mobile) return "Back to voices";
  const state = window.history.state as { returnTo?: unknown } | null;
  return typeof state?.returnTo === "string" ? voiceReturnLabelForLocation(state.returnTo) : "Back to voices";
}

function voiceReturnLabelForLocation(location: string) {
  try {
    const pathname = new URL(location, window.location.origin).pathname;
    if (pathname === "/" || pathname === "") return "Back to library";
    if (/^\/favorites\/?$/i.test(pathname)) return "Back to favorites";
    if (/^\/circles(?:\/|$)/i.test(pathname)) return "Back to circles";
    if (/^\/voices\/?$/i.test(pathname)) return "Back to voices";
    if (/^\/settings\/?$/i.test(pathname)) return "Back to settings";
    if (/^\/(?:RJ|BJ|VJ|CC)/i.test(pathname)) return "Back to work";
  } catch {
    // Fall through to the generic label for malformed history state.
  }
  return "Back";
}
