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
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Tags,
  Trash2,
} from "lucide-react";
import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { BrowseLoadingIndicator } from "@/components/collection/BrowseLoadingIndicator";
import { toastFromError, useToast } from "@/components/ui/toast";
import { Dialog, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/input";
import { UserTagRow } from "@/components/UserTagRow";
import { CollectionPagination } from "@/components/collection/CollectionPagination";
import {
  CreatorCard,
  CreatorCollectionSkeleton,
  creatorCardMinHeightClassName,
  creatorCollectionClassName,
} from "@/components/creator/CreatorCard";
import { CatalogSyncBadge } from "@/components/creator/CatalogSyncBadge";
import { CreatorDetailHeader } from "@/components/creator/CreatorDetailHeader";
import { CreatorListToolbar } from "@/components/creator/CreatorListToolbar";
import { CatalogWorkToolbar } from "@/components/creator/CatalogWorkToolbar";
import { WorkCollectionLoadingState } from "@/components/work-collection/WorkCollectionLoadingState";
import { WorkCollectionPagination } from "@/components/work-collection/WorkCollectionPagination";
import { VoiceWorkOptionsSheet, type VoiceWorkFilter } from "@/pages/VoiceWorkOptionsSheet";
import { VoiceAdvancedRefreshSheet, isVoiceCatalogSourceSelectable } from "@/pages/VoiceAdvancedRefreshSheet";
import { useAuth } from "@/auth/AuthProvider";
import { usePermissionGate } from "@/auth/usePermissionGate";
import { NotFoundPage } from "@/app/NotFoundPage";
import { usePageHeaderBack } from "@/app/pageHeader";
import { openWorkDetail } from "@/app/workDetailNavigation";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import { useStableCallback } from "@/hooks/useStableCallback";
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
import { DLSITE_ENDPOINTS } from "@/lib/official-links";
import {
  NAVIGATION_EVENT,
  currentInternalLocation,
  historyStateWithReturn,
  navigateToWorkspaceUp,
  normalizeInternalLocation,
} from "@/lib/browserHistory";
import { currentClientStorageScope } from "@/lib/clientStorageScope";
import { hasPlaybackHistory } from "@/lib/playbackHistory";
import { openCircleRoute, openCircleSeriesRoute } from "@/pages/circleNavigationState";
import { creatorBrowseSearch, creatorBrowseStateFromSearch } from "@/pages/creatorBrowseState";
import {
  currentVoiceReturnPath,
  isVoiceListLocation,
  openVoiceRoute,
  readLastVoiceListLocation,
  voiceReturnLabelForLocation,
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
function voiceWorkFilterOptions(t: TFunction): readonly { value: VoiceWorkFilter; label: string }[] {
  return [
    { value: "all", label: t("detailActions.allWorks") },
    { value: "available", label: t("content.available") },
    { value: "local", label: t("detailActions.local") },
    { value: "remote", label: t("detailActions.remote") },
    { value: "missing", label: t("detailActions.missing") },
  ];
}
const listeningStatusOptions: { value: ListeningStatus; label: string }[] = [
  { value: "none", label: "Unmarked" },
  { value: "want_to_listen", label: "Want" },
  { value: "listening", label: "Listening" },
  { value: "finished", label: "Finished" },
  { value: "relisten", label: "Relisten" },
  { value: "paused", label: "Shelved" },
];

export function CreatorWorksPage({ kind, active = true }: { kind: CreatorKind; active?: boolean }) {
  const { t } = useTranslation();
  if (kind !== "voice") {
    return (
      <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
        {t("creatorBrowse.circleViewMoved")}
      </div>
    );
  }
  return <VoiceCreatorWorksPage active={active} />;
}

function VoiceCreatorWorksPage({ active }: { active: boolean }) {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    if (!active) return;
    const syncPath = () => {
      if (!isVoiceWorkspaceLocation(currentInternalLocation())) return;
      setPath(window.location.pathname);
    };
    syncPath();
    window.addEventListener("popstate", syncPath);
    window.addEventListener("kikoto:navigation", syncPath);
    return () => {
      window.removeEventListener("popstate", syncPath);
      window.removeEventListener("kikoto:navigation", syncPath);
    };
  }, [active]);
  const personId = voicePersonIdFromPath(path);
  if (personId) return <VoiceDetailPage personId={personId} active={active} />;
  return <VoiceListPage active={active} />;
}

const VoiceCard = memo(function VoiceCard({
  voice,
  onFavoriteToggle,
  onTagsSave,
}: {
  voice: VoiceSummary;
  onFavoriteToggle: (voice: VoiceSummary) => Promise<void>;
  onTagsSave: (voice: VoiceSummary, tags: string[]) => Promise<void>;
}) {
  const { t } = useTranslation();
  return (
    <CreatorCard
      name={voice.displayName}
      identityLabel={voice.latestWork ? undefined : t("creatorBrowse.voiceActor")}
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
      onFavoriteToggle={() => void onFavoriteToggle(voice)}
      onTagsSave={(tags) => onTagsSave(voice, tags)}
    />
  );
});

function VoiceListPage({ active }: { active: boolean }) {
  const { t } = useTranslation();
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
  const [page, setPage] = useState(initialBrowseState.page);
  const [pageSize, setPageSize] = useState(initialBrowseState.pageSize);
  const [total, setTotal] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);
  const loadedRequestKey = useRef("");
  const localizedFilterOptions = voiceFilterOptions.map((option) => ({
    ...option,
    label:
      option.value === "all"
        ? t("creatorBrowse.allVoices")
        : option.value === "favorite"
          ? t("creatorBrowse.favorite")
          : option.value === "tagged"
            ? t("creatorBrowse.tagged")
            : option.value === "available"
              ? t("content.available")
              : option.value === "local"
                ? t("detailActions.local")
                : option.value === "remote"
                  ? t("detailActions.remote")
                  : t("detailActions.missing"),
  }));

  useEffect(() => {
    const timer = window.setTimeout(() => setRequestQuery(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!active || !isVoiceListLocation(currentInternalLocation())) return;
    const search = creatorBrowseSearch({ query, filter, tag: "", page, pageSize });
    const location = `/voices${search}`;
    window.history.replaceState(window.history.state ?? {}, "", location);
    writeLastVoiceListLocation(storageScope, location);
  }, [active, filter, page, pageSize, query, storageScope]);

  useEffect(() => {
    if (!active) return;
    const requestKey = JSON.stringify([page, pageSize, requestQuery, filter, reloadToken]);
    if (loadedRequestKey.current === requestKey) return;
    const controller = new AbortController();
    setIsLoading(true);
    setLoadError("");
    api
      .listVoices({ page, pageSize, query: requestQuery, filter, signal: controller.signal })
      .then((result) => {
        loadedRequestKey.current = requestKey;
        setVoices(result.voices);
        setTotal(result.total);
        setHasLoaded(true);
        setMessage(
          result.total === 0 && !requestQuery.trim() && filter === "all" ? t("creatorBrowse.noVoiceCredits") : "",
        );
        if (result.page !== page) setPage(result.page);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setLoadError(t("errors.unavailable"));
        toast.notify(toastFromError(error, t("errors.unavailable")));
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });
    return () => controller.abort();
  }, [active, filter, page, pageSize, reloadToken, requestQuery]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const changeFilter = (value: VoiceFilter) => {
    setFilter(value);
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
    itemLabel: t("creatorBrowse.voiceActors"),
    ariaLabel: t("creatorBrowse.voicePages"),
    compactMobile: true,
    compactTop: true,
    refreshing: isLoading && hasLoaded,
    refreshingLabel: t("creatorBrowse.refreshingVoices"),
    onPageChange: setPage,
  };

  const updateVoice = (next: VoiceSummary) => {
    setVoices((items) => items.map((item) => (item.personId === next.personId ? { ...item, ...next } : item)));
    if (filter !== "all" || requestQuery.trim()) setReloadToken((value) => value + 1);
  };

  const toggleFavorite = async (voice: VoiceSummary) => {
    try {
      updateVoice({ ...voice, ...(await api.updateVoiceUserState(voice.personId, { favorite: !voice.favorite })) });
    } catch (error) {
      toast.notify(toastFromError(error, t("creatorBrowse.favoriteUpdateFailed")));
    }
  };

  const saveTags = async (voice: VoiceSummary, tags: string[]) => {
    try {
      const result = await api.setVoiceUserTags(voice.personId, tags);
      updateVoice({ ...voice, userTags: result.userTags });
    } catch (error) {
      toast.notify(toastFromError(error, t("creatorBrowse.tagsUpdateFailed")));
    }
  };
  const toggleCardFavorite = useStableCallback(toggleFavorite);
  const saveCardTags = useStableCallback(saveTags);

  return (
    <div className="relative space-y-5">
      {message && <div className="rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">{message}</div>}

      <section className="space-y-3">
        <CreatorListToolbar
          label={t("creatorBrowse.voiceActors")}
          query={query}
          placeholder={t("creatorBrowse.searchVoices")}
          filter={filter}
          defaultFilter="all"
          filterOptions={localizedFilterOptions}
          pageSize={pageSize}
          pageSizeOptions={voicePageSizeOptions}
          onQueryChange={setQuery}
          onFilterChange={changeFilter}
          onPageSizeChange={changePageSize}
        />

        <CollectionPagination {...paginationProps} placement="top" />

        {isLoading && !hasLoaded ? (
          <CreatorCollectionSkeleton label={t("creatorBrowse.loadingVoices")} />
        ) : !hasLoaded && loadError ? (
          <Card className={creatorCardMinHeightClassName} role="alert">
            <CardContent
              className={`grid ${creatorCardMinHeightClassName} place-items-center gap-3 p-5 text-center text-sm text-destructive`}
            >
              <span>{loadError}</span>
              <Button size="sm" variant="outline" onClick={() => setReloadToken((value) => value + 1)}>
                {t("creatorBrowse.retry")}
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div
            className={creatorCollectionClassName}
            role="region"
            aria-label={t("creatorBrowse.voiceResults")}
            aria-busy={isLoading}
          >
            {voices.length > 0 ? (
              voices.map((voice) => (
                <VoiceCard
                  key={voice.personId}
                  voice={voice}
                  onFavoriteToggle={toggleCardFavorite}
                  onTagsSave={saveCardTags}
                />
              ))
            ) : (
              <Card className={creatorCardMinHeightClassName}>
                <CardContent
                  className={`grid ${creatorCardMinHeightClassName} place-items-center p-5 text-sm text-muted-foreground`}
                >
                  {t("creatorBrowse.noVoices")}
                </CardContent>
              </Card>
            )}
          </div>
        )}

        <CollectionPagination {...paginationProps} placement="bottom" />
      </section>
      <BrowseLoadingIndicator refreshing={isLoading && hasLoaded} label={t("creatorBrowse.refreshingVoices")} />
    </div>
  );
}

function EntitySkeletonLine({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className}`} />;
}

function VoiceDetailPage({ personId, active }: { personId: number; active: boolean }) {
  const { t } = useTranslation();
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
  usePageHeaderBack({
    label: voiceReturnLabel(mobileNavigationLayout),
    title: detail?.displayName,
    onBack: navigateToList,
    enabled: !notFound,
  });
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
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedActionRef = useRef<HTMLButtonElement | null>(null);
  const advancedPanelID = useId();
  const loadedPersonID = useRef<number | null>(null);
  const loadedCatalogPersonID = useRef<number | null>(null);

  useEffect(() => {
    if (!active || loadedPersonID.current === personId) return;
    const controller = new AbortController();
    setIsLoading(true);
    setAdvancedOpen(false);
    setWorkOptionsOpen(false);
    setRemoteMatches([]);
    setCatalogRefresh(null);
    setRemoteError("");
    setNotFound(false);
    void (async () => {
      try {
        const item = await api.getVoiceSummary(personId, controller.signal);
        if (controller.signal.aborted) return;
        setDetail(item);
        setMessage("");
        setIsLoading(false);
        setIsWorksLoading(true);
        try {
          const result = await api.getVoiceWorks(personId, controller.signal);
          if (controller.signal.aborted) return;
          setDetail((current) => (current?.personId === personId ? { ...current, works: result.works } : current));
          loadedPersonID.current = personId;
        } catch (error) {
          if (!controller.signal.aborted) {
            toast.notify(toastFromError(error, t("errors.unavailable")));
          }
        } finally {
          if (!controller.signal.aborted) setIsWorksLoading(false);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setDetail(null);
        if (error instanceof ApiError && error.status === 404) {
          loadedPersonID.current = personId;
          setNotFound(true);
          return;
        }
        toast.notify(toastFromError(error, t("errors.unavailable")));
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    })();
    return () => controller.abort();
  }, [active, personId, t]);

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
            ? timedOut
              ? t("creatorBrowse.remoteSourcesTimedOut", { count: failed.length })
              : t("creatorBrowse.remoteSourcesFailed", { count: failed.length })
            : t("creatorBrowse.voiceCatalogLoaded");
        if (failed.length > 0) toast.info(message);
        else toast.success(message);
      }
    } catch (error) {
      const fallback = t("errors.unavailable");
      setRemoteError(fallback);
      toast.notify(toastFromError(error, fallback));
    } finally {
      setIsRemoteLoading(false);
    }
  };

  const canForceRefreshCatalog = auth.hasPermission("metadata:sync") && !auth.demoMode;

  useEffect(() => {
    if (!active || !detail || loadedCatalogPersonID.current === personId) return;
    const controller = new AbortController();
    let cancelled = false;
    const loadPersistedCatalog = async () => {
      setIsRemoteLoading(true);
      setRemoteError("");
      try {
        const persisted = await api.getVoiceRemoteMatches(personId, controller.signal);
        if (cancelled) return;
        loadedCatalogPersonID.current = personId;
        setRemoteMatches(persisted.remoteMatches);
        setCatalogRefresh(persisted.refresh);
      } catch (error) {
        if (cancelled) return;
        const fallback = t("errors.unavailable");
        setRemoteError(fallback);
        toast.notify(toastFromError(error, t("errors.unavailable")));
      } finally {
        if (!cancelled) setIsRemoteLoading(false);
      }
    };
    void loadPersistedCatalog();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [active, detail?.personId, personId]);

  const catalogRefreshActive = catalogRefresh?.status === "queued" || catalogRefresh?.status === "running";
  useEffect(() => {
    if (!active || !catalogRefreshActive) return;
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
        if (!cancelled) setRemoteError(t("errors.unavailable"));
      } finally {
        requestRunning = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, catalogRefresh?.runId, catalogRefreshActive, personId]);

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
        refresh.status === "queued" || refresh.status === "running"
          ? queuedMessage
          : t("creatorBrowse.voiceCatalogCurrent"),
      );
    } catch (error) {
      setRemoteError(t("creatorBrowse.voiceCatalogRefreshFailed"));
      toast.notify(toastFromError(error, t("creatorBrowse.voiceCatalogRefreshFailed")));
    } finally {
      setIsRemoteLoading(false);
    }
  };

  const refreshVoiceMetadata = (mode: "incremental" | "full") =>
    void refreshVoiceCatalog(
      { scope: "metadata", mode },
      mode === "full" ? t("creatorBrowse.fullVoiceMetadataQueued") : t("creatorBrowse.voiceMetadataQueued"),
    );
  const retryVoiceMetadata = () => refreshVoiceMetadata("incremental");
  const refreshAllRemoteSources = () => {
    const sourceIds = remoteMatches.filter(isVoiceCatalogSourceSelectable).map((source) => source.sourceId);
    return void refreshVoiceCatalog(
      { scope: "remote", mode: "incremental", ...(sourceIds.length > 0 ? { sourceIds } : {}) },
      t("creatorBrowse.voiceRemoteRefreshQueued"),
    );
  };
  const firstPull = detail?.syncState === "never";
  const firstPullVoiceCatalog = () =>
    void refreshVoiceCatalog({ scope: "all", mode: "full" }, t("creatorBrowse.firstVoiceCatalogQueued"));

  const knownWorks = detail?.works ?? [];
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
      toast.notify(toastFromError(error, t("errors.unavailable")));
    }
  };

  const refreshDetail = async () => {
    const item = await api.getVoice(personId);
    setDetail((current) => (item ? { ...item, remoteMatches: current?.remoteMatches ?? [] } : item));
    void loadRemoteMatches(false);
  };

  useEffect(() => {
    if (!active) return;
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
  }, [active, mergedWorks]);
  const fetchWorkspace = useRemoteFetchWorkspace({ onWorksChanged: refreshDetail });

  const saveVoiceTags = async (tags: string[]) => {
    if (!detail) return;
    try {
      const result = await api.setVoiceUserTags(detail.personId, tags);
      setDetail((current) => (current ? { ...current, userTags: result.userTags } : current));
    } catch (error) {
      toast.notify(toastFromError(error, t("creatorBrowse.tagsUpdateFailed")));
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
      toast.notify(toastFromError(error, t("creatorBrowse.markUpdateFailed")));
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
      toast.success(t("creatorBrowse.savedAndMarked", { code: syncResult.primaryCode }));
      await refreshDetail();
    } catch (error) {
      toast.notify(toastFromError(error, t("creatorBrowse.markUpdateFailed")));
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
      toast.notify(toastFromError(error, t("creatorBrowse.saveForListFailed")));
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
      const message = t("creatorBrowse.bulkTrackFetchSummary", { runIds, synced, fetched, failed });
      if (failed > 0) toast.warning(message);
      else toast.success(message);
      await refreshDetail();
    } catch (error) {
      toast.notify(toastFromError(error, t("creatorBrowse.bulkTrackFetchFailed")));
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
      const message = t("creatorBrowse.bulkFetchSummary", { runIds, fetched, failed });
      if (failed > 0) toast.warning(message);
      else toast.success(message);
      await refreshDetail();
    } catch (error) {
      toast.notify(toastFromError(error, t("creatorBrowse.bulkFetchFailed")));
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
          ? t("creatorBrowse.trackAlreadyQueued", { id: result.runId })
          : t("creatorBrowse.trackQueued", { id: result.runId }),
      });
    } catch (error) {
      toast.notify(toastFromError(error, t("creatorBrowse.trackFailed")));
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
        title={t("creatorBrowse.voiceActorNotFound")}
        message={t("creatorBrowse.voiceActorUnavailable", { id: personId })}
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
        <div className="rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">{message}</div>
      </div>
    );
  }

  return (
    <div className="relative space-y-5">
      {message && <div className="rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">{message}</div>}

      <CreatorDetailHeader
        name={detail.displayName}
        coverUrl={detail.latestWork?.coverUrl}
        aliases={detail.aliases}
        eyebrow={
          <>
            <span className="font-mono tracking-tight">#{detail.personId}</span>
            <CatalogSyncBadge state={detail.syncState} appearance="dot" />
          </>
        }
        meta={
          <div
            className="mt-2.5 flex min-w-0 flex-wrap items-center gap-1.5"
            aria-label={t("detailActions.voiceActorStatistics")}
          >
            <Badge variant={detail.localWorks > 0 ? "success" : "outline"} className="tabular-nums">
              {t("detailActions.localCount", { count: detail.localWorks })}
            </Badge>
            <Badge variant="outline" className="tabular-nums">
              {t("detailActions.remoteCount", { count: detail.remoteWorks })}
            </Badge>
            <UserTagRow tags={detail.userTags} onSave={saveVoiceTags} className="min-w-0 flex-1" />
          </div>
        }
        actions={
          <div
            className="flex flex-nowrap shrink-0 gap-1.5 lg:gap-2"
            role="group"
            aria-label={t("detailActions.voiceActorActions")}
          >
            <Button
              variant={detail.favorite ? "default" : "outline"}
              size="icon"
              className="h-[var(--control-icon-size)] w-[var(--control-icon-size)] lg:h-[var(--control-height-sm)] lg:w-auto lg:px-[var(--control-padding-sm-x)] lg:text-xs"
              aria-label={detail.favorite ? t("creator.removeFavorite") : t("creator.addFavorite")}
              aria-pressed={detail.favorite}
              title={detail.favorite ? t("creator.removeFavorite") : t("creator.addFavorite")}
              onClick={() => void toggleFavorite()}
            >
              <Heart className={`h-4 w-4 ${detail.favorite ? "fill-current" : ""}`} />
              <span className="hidden lg:inline">{t("detailActions.favorite")}</span>
            </Button>
            {firstPull ? (
              <Button
                variant="default"
                size="sm"
                className="h-[var(--control-icon-size)] gap-1.5 px-2 lg:h-[var(--control-height-sm)] lg:gap-2 lg:px-[var(--control-padding-sm-x)]"
                aria-label={t("detailActions.firstPull")}
                disabled={!canForceRefreshCatalog || isRemoteLoading || catalogRefreshActive}
                onClick={firstPullVoiceCatalog}
              >
                {isRemoteLoading || catalogRefreshActive ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                <span>{t("detailActions.firstPull")}</span>
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-[var(--control-icon-size)] gap-1.5 px-2 lg:h-[var(--control-height-sm)] lg:gap-2 lg:px-[var(--control-padding-sm-x)] lg:text-xs"
                  aria-label={t("detailActions.retryMetadata")}
                  title={t("detailActions.retryMetadata")}
                  disabled={!canForceRefreshCatalog || isRemoteLoading || catalogRefreshActive}
                  onClick={retryVoiceMetadata}
                >
                  {isRemoteLoading || catalogRefreshActive ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  <span className="lg:hidden">{t("detailActions.metadata")}</span>
                  <span className="hidden lg:inline">{t("detailActions.retryMetadata")}</span>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-[var(--control-icon-size)] gap-1.5 px-2 lg:h-[var(--control-height-sm)] lg:gap-2 lg:px-[var(--control-padding-sm-x)] lg:text-xs"
                  aria-label={t("detailActions.refreshRemote")}
                  title={t("detailActions.refreshRemote")}
                  disabled={!canForceRefreshCatalog || isRemoteLoading || catalogRefreshActive}
                  onClick={refreshAllRemoteSources}
                >
                  {isRemoteLoading || catalogRefreshActive ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Cloud className="h-4 w-4" />
                  )}
                  <span className="lg:hidden">{t("detailActions.remote")}</span>
                  <span className="hidden lg:inline">{t("detailActions.refreshRemote")}</span>
                </Button>
              </>
            )}
            <Button
              ref={advancedActionRef}
              variant={advancedOpen ? "secondary" : "outline"}
              size="icon"
              className="relative h-[var(--control-icon-size)] w-[var(--control-icon-size)] lg:h-[var(--control-height-sm)] lg:w-auto lg:px-[var(--control-padding-sm-x)] lg:text-xs"
              aria-haspopup="dialog"
              aria-expanded={advancedOpen}
              aria-controls={advancedOpen ? advancedPanelID : undefined}
              aria-label={
                remoteSourceWarning
                  ? t("detailActions.openAdvancedRefreshActionsAttention")
                  : t("detailActions.openAdvancedRefreshActions")
              }
              title={t("detailActions.advancedRefresh")}
              onClick={() => setAdvancedOpen((open) => !open)}
            >
              {mobileNavigationLayout ? (
                <MoreHorizontal className="h-4 w-4" />
              ) : (
                <SlidersHorizontal className="h-4 w-4" />
              )}
              <span className="hidden lg:inline">{t("detailActions.advanced")}</span>
              {remoteSourceWarning && <span className="text-warning-foreground">!</span>}
            </Button>
          </div>
        }
      >
        <VoiceAdvancedRefreshSheet
          open={advancedOpen}
          mobile={mobileNavigationLayout}
          anchorRef={advancedActionRef}
          sources={remoteMatches}
          loading={isRemoteLoading}
          refreshing={catalogRefreshActive}
          activeScope={catalogRefreshActive ? catalogRefresh?.scope : null}
          error={remoteError}
          canRefresh={canForceRefreshCatalog}
          onManageAliases={
            auth.hasPermission("metadata:sync") ? () => openVoiceAliasMaintenance(detail.personId) : undefined
          }
          onClose={() => setAdvancedOpen(false)}
          onRefreshCatalog={(mode, sourceIds) =>
            void refreshVoiceCatalog({ scope: "remote", mode, sourceIds }, t("creatorBrowse.voiceRemoteRefreshQueued"))
          }
          onRefreshMetadata={refreshVoiceMetadata}
        />
      </CreatorDetailHeader>

      <section className="space-y-3">
        <CatalogWorkToolbar
          query={query}
          searchLabel={t("sheets.searchVoiceWorks")}
          onQueryChange={changeWorkQuery}
          filterLabel={t("sheets.voiceWorkAvailability")}
          filter={filter}
          defaultFilter="all"
          filterOptions={voiceWorkFilterOptions(t)}
          onFilterChange={changeWorkFilter}
          pageSize={pageSize}
          pageSizeOptions={workPageSizeOptions}
          onPageSizeChange={changeWorkPageSize}
          mobileColumns={mobileColumns}
          desktopColumns={desktopColumns}
          onMobileColumnsChange={setMobileColumns}
          onDesktopColumnsChange={setDesktopColumns}
          selectionMode={selectionMode}
          onSelectionModeChange={(value) => {
            setSelectionMode(value);
            if (!value) setSelectedWorkKeys(new Set());
          }}
        />
        <div>
          <WorkCollectionPagination
            placement="top"
            page={currentPage}
            pageSize={pageSize}
            totalItems={filteredWorks.length}
            totalPages={totalPages}
            compactMobile
            refreshing={isWorksLoading || isRemoteLoading || catalogRefreshActive}
            refreshingLabel={t("creatorBrowse.refreshingVoiceWorks")}
            leadingControls={
              <Button
                variant="outline"
                size="icon"
                className="relative h-11 w-11 lg:hidden"
                aria-label={t("creatorBrowse.openVoiceWorkOptions")}
                title={t("sheets.voiceWorkOptions")}
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
                aria-label={t("detailActions.select")}
              />
              {t("creatorBrowse.selectedWorks", { count: selectedWorks.length })}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => toggleVisibleSelection(true)}>
                {t("library.selectAll")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSelectedWorkKeys(new Set());
                  setSelectionMode(false);
                }}
              >
                {t("library.cancelSelection")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={isBulkBusy || selectedSyncable.length === 0}
                onClick={() => void bulkSyncAndSave()}
              >
                <GitBranchPlus className="h-4 w-4" />
                {t("library.trackCount", { count: selectedSyncable.length })} +{" "}
                {t("library.fetchCount", { count: selectedSyncable.length })}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={isBulkBusy || selectedSaveable.length === 0}
                onClick={() => void bulkSave()}
              >
                <HardDriveDownload className="h-4 w-4" />
                {t("library.fetchCount", { count: selectedSaveable.length })}
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
            label={t("creatorBrowse.loadingVoiceWorks")}
            mobileColumns={mobileColumns}
            desktopColumns={desktopColumns}
          />
        ) : (
          <Card className="min-h-72">
            <CardContent className="grid min-h-72 place-items-center p-5 text-sm text-muted-foreground">
              {t("creatorBrowse.noVoiceWorks")}
            </CardContent>
          </Card>
        )}
        <WorkCollectionPagination
          placement="bottom"
          page={currentPage}
          pageSize={pageSize}
          totalItems={filteredWorks.length}
          totalPages={totalPages}
          onPageChange={setPage}
        />
      </section>
      {saveConfirm && (
        <SaveConfirmModal
          count={saveConfirm.count}
          onClose={() => setSaveConfirm(null)}
          onConfirm={() => void saveConfirm.run()}
        />
      )}
      <RemoteFetchWorkspaceDialog workspace={fetchWorkspace} />
      <BrowseLoadingIndicator
        refreshing={isWorksLoading || isRemoteLoading || catalogRefreshActive}
        label={t("creatorBrowse.refreshingVoiceDetails")}
      />
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
  const { t } = useTranslation();
  const isKnown = "local" in work;
  const local = "local" in work ? work.local : work.hasLocal;
  const remote = voiceWorkHasRemoteAvailability(work);
  const cache = "cache" in work ? work.cache : work.hasCache;
  const workId = "workId" in work ? work.workId : null;
  const favorite = "favorite" in work ? work.favorite : false;
  const listeningMark = "listeningMark" in work ? work.listeningMark : "none";
  const isUnavailable = voiceWorkIsExplicitlyUnavailable(work);
  const canOpen = Boolean((isKnown && workId) || (!isKnown && work.primaryCode));
  const view = voiceWorkCardView(work, t);

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
                title={t("detailActions.track")}
                disabled={!voiceWorkRemoteTarget(work)}
                onClick={(event) => {
                  event.stopPropagation();
                  onSync();
                }}
              >
                <GitBranchPlus className="h-4 w-4" />
              </WorkCardActionButton>
              <WorkCardActionButton
                title={t("detailActions.fetch")}
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

function SaveConfirmModal({
  count,
  onClose,
  onConfirm,
}: {
  count: number;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog onClose={onClose} size="sm">
      <DialogHeader
        title={t("detailActions.fetchRemoteDirectory")}
        description={t("detailActions.fetchRemoteDirectoryDescription", { count })}
      />
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>
          {t("content.cancel")}
        </Button>
        <Button size="sm" onClick={onConfirm}>
          {t("detailActions.fetch")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function WorkProgressLine({ progress }: { progress: NonNullable<VoiceKnownWork["progress"]> }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1">
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${workProgressPercent(progress)}%` }} />
      </div>
      <div className="truncate text-xs text-muted-foreground">
        {progress.completed
          ? t("favorites.finished")
          : t("favorites.resumeAt", {
              title: progress.title || t("player.track"),
              time: formatTime(progress.positionSeconds),
            })}
      </div>
    </div>
  );
}

function voiceWorkCardView(work: VoiceWorkView, t: TFunction): WorkCardViewModel {
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
  const observedStatusBadges = voiceObservedStatusBadges(observedSourceTags, t);
  const sourceBadges =
    availableBadges.length > 0 || observedStatusBadges.length > 0
      ? [...availableBadges, ...observedStatusBadges]
      : [
          {
            key: "source:unknown",
            label: t("creatorBrowse.sourceNotChecked"),
            variant: "warning" as const,
            title: t("creatorBrowse.sourceNotCheckedDescription"),
          },
        ];
  return {
    code: work.primaryCode || sourceName || t("detailActions.source"),
    title: work.title,
    circle: work.circle || sourceName || t("workCard.unknownCircle"),
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
  const { t } = useTranslation();
  return (
    <div className="space-y-5">
      <EntitySkeletonLine className="h-8 w-32" />
      <section className="flex items-start gap-4 border-b pb-5">
        <EntitySkeletonLine className="h-16 w-16 shrink-0 rounded-xl lg:h-[5.5rem] lg:w-[5.5rem]" />
        <div className="min-w-0 flex-1 space-y-2">
          <EntitySkeletonLine className="h-4 w-24" />
          <EntitySkeletonLine className="h-8 w-64 max-w-full" />
          <div className="flex flex-wrap gap-1.5">
            {Array.from({ length: 3 }, (_, index) => (
              <EntitySkeletonLine key={index} className="h-5 w-16" />
            ))}
          </div>
        </div>
      </section>
      <WorkCollectionLoadingState label={t("creatorBrowse.loadingVoiceWorks")} />
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
  return "dlsiteUrl" in work && work.dlsiteUrl ? work.dlsiteUrl : DLSITE_ENDPOINTS.workURL("maniax", work.primaryCode);
}

function MarkMenu({ value, onChange }: { value: ListeningStatus; onChange: (status: ListeningStatus) => void }) {
  const { t } = useTranslation();
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
          {t(`library.status.${option.value}`, { defaultValue: option.label })}
        </button>
      ))}
    </div>
  );
}

function normalizeListeningStatus(status: string): ListeningStatus {
  return listeningStatusOptions.some((option) => option.value === status) ? (status as ListeningStatus) : "none";
}

function listeningStatusLabel(status: string, t?: TFunction) {
  return t
    ? t(`library.status.${normalizeListeningStatus(status)}`)
    : (listeningStatusOptions.find((option) => option.value === normalizeListeningStatus(status))?.label ?? "Unmarked");
}

function voiceObservedStatusBadges(sourceTags: CircleSourceStat[], t: TFunction): WorkCardBadge[] {
  return sourceTags
    .filter((source) => source.sourceId && source.key !== "cache" && source.status !== "available" && source.count <= 0)
    .map((source) => {
      const status = voiceSourceStatusLabel(source.status, t);
      return {
        key: `source:observed:${source.sourceId}`,
        label: `${source.displayName || t("detailActions.remote")}: ${status}`,
        variant: "warning" as const,
        title: t("creatorBrowse.observedSourceStatus", { status }),
      };
    });
}

function voiceSourceStatusLabel(status: string, t: TFunction) {
  switch (status) {
    case "not_found":
      return t("errors.notFound");
    case "unavailable":
      return t("detailActions.unavailable");
    case "disabled":
      return t("sources.disabled");
    case "error":
      return t("creatorBrowse.sourceError");
    default:
      return t("creatorBrowse.sourceNotChecked");
  }
}

function voicePersonIdFromPath(path: string) {
  const match = path.match(/^\/voices\/([^/]+)\/?$/i);
  if (!match) return 0;
  const value = Number(decodeURIComponent(match[1]));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function isVoiceWorkspaceLocation(location: string) {
  const normalized = normalizeInternalLocation(location);
  if (!normalized) return false;
  if (isVoiceListLocation(normalized)) return true;
  try {
    return voicePersonIdFromPath(new URL(normalized, "https://kikoto.invalid").pathname) > 0;
  } catch {
    return false;
  }
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

function openVoiceAliasMaintenance(personId: number) {
  window.history.pushState({}, "", `/metadata?view=aliases&voice=${personId}`);
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

function voiceReturnLabel(mobile: boolean) {
  if (mobile) return "Back to voices";
  const state = window.history.state as { returnTo?: unknown } | null;
  return typeof state?.returnTo === "string" ? voiceReturnLabelForLocation(state.returnTo) : "Back to voices";
}
