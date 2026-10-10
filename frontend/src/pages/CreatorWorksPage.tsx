import {
  ArrowUpRight,
  CircleAlert,
  GitFork,
  HardDriveDownload,
  Heart,
  Loader2,
  RefreshCw,
  Rss,
  SlidersHorizontal,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BrowseLoadingIndicator } from "@/components/collection/BrowseLoadingIndicator";
import { toastFromError, useToast } from "@/components/ui/toast";
import { UserTagRow } from "@/components/UserTagRow";
import { CreatorCard } from "@/components/creator/CreatorCard";
import { CatalogSyncBadge } from "@/components/creator/CatalogSyncBadge";
import { CreatorActionMenu } from "@/components/creator/CreatorActionMenu";
import { CreatorDetailHeader } from "@/components/creator/CreatorDetailHeader";
import { CatalogWorkToolbar } from "@/components/creator/CatalogWorkToolbar";
import { WorkCollectionLoadingState } from "@/components/work-collection/WorkCollectionLoadingState";
import { WorkCollectionPagination } from "@/components/work-collection/WorkCollectionPagination";
import { WorkSelectionAction, WorkSelectionBar } from "@/components/work-collection/WorkSelectionBar";
import { FetchConfirmDialog } from "@/components/work-collection/FetchConfirmDialog";
import { retainVisibleSelection, withSelection } from "@/components/work-collection/workSelectionModel";
import { VoiceWorkOptionsSheet, type VoiceWorkFilter } from "@/pages/VoiceWorkOptionsSheet";
import { openWorkflowPath, workflowActivityRunPath, workflowRunFormPath } from "@/features/workflows/workflowLinks";
import { useAuth } from "@/auth/AuthProvider";
import { DemoContentNotice } from "@/components/DemoReadOnlyNotice";
import {
  REMOTE_BULK_FETCH_PERMISSIONS,
  REMOTE_BULK_TRACK_PERMISSIONS,
  REMOTE_TRACK_PERMISSIONS,
  usePermissionGate,
} from "@/auth/usePermissionGate";
import { NotFoundPage } from "@/app/NotFoundPage";
import { usePageHeaderBack } from "@/app/pageHeader";
import { openWorkDetail } from "@/app/workDetailNavigation";
import { useStableCallback } from "@/hooks/useStableCallback";
import {
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
import { LazyRemoteFetchWorkspaceDialog } from "@/features/work-detail/workflows/LazyRemoteFetchWorkspaceDialog";
import { useRemoteFetchWorkspace } from "@/features/work-detail/workflows/useRemoteFetchWorkspace";
import {
  workCollectionClassName,
  workCollectionStyle,
  useWorkCollectionLayout,
} from "@/components/work-collection/WorkCollectionLayout";
import {
  api,
  ApiError,
  type CircleSourceStat,
  type ListeningStatus,
  type VoiceCatalogRefreshState,
  type CreatorRefreshRequest,
  type VoiceDetail,
  type VoiceKnownWork,
  type VoiceRemoteSourceSet,
  type VoiceSummary,
} from "@/lib/api";
import { DLSITE_ENDPOINTS } from "@/lib/official-links";
import {
  NAVIGATION_EVENT,
  currentInternalLocation,
  navigateToHistoryReturn,
  normalizeInternalLocation,
} from "@/lib/browserHistory";
import { currentClientStorageScope } from "@/lib/clientStorageScope";
import { hasPlaybackHistory } from "@/lib/playbackHistory";
import { openCircleRoute, openCircleSeriesRoute } from "@/lib/circleNavigationState";
import { CreatorListPage } from "@/pages/creator/CreatorListPage";
import { creatorBulkCopy, useRemoteWorkActions } from "@/pages/useRemoteWorkActions";
import {
  currentVoiceReturnPath,
  isVoiceListLocation,
  openVoiceRoute,
  readLastVoiceListLocation,
  voiceReturnLabelForLocation,
  writeLastVoiceListLocation,
} from "@/lib/voiceNavigationState";
import { openLibraryTagSearch } from "@/lib/libraryTagSearch";
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
// A stable fallback keeps the works-derived memos, and the selection sync
// effect that depends on them, from re-running while the detail is absent.
const emptyKnownWorks: VoiceKnownWork[] = [];
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
  const { demoMode } = useAuth();
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
  const [listVisited, setListVisited] = useState(personId === 0);
  useEffect(() => {
    if (!personId) setListVisited(true);
  }, [personId]);
  return (
    <>
      {demoMode && (
        <div className="mb-5">
          <DemoContentNotice surface="works" />
        </div>
      )}
      {personId > 0 && <VoiceDetailPage personId={personId} active={active} />}
      {(listVisited || personId === 0) && (
        <div hidden={personId > 0}>
          <VoiceListPage active={active && personId === 0} />
        </div>
      )}
    </>
  );
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
      tagScope="voice"
    />
  );
});

function VoiceListPage({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const filterOptions = voiceFilterOptions.map((option) => ({
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
  return (
    <CreatorListPage<VoiceSummary, VoiceFilter>
      active={active}
      path="/voices"
      filters={voiceFilters}
      filterOptions={filterOptions}
      pageSizeOptions={voicePageSizeOptions}
      isListLocation={isVoiceListLocation}
      writeLastListLocation={writeLastVoiceListLocation}
      load={async (request) => {
        const result = await api.listVoices(request);
        return { items: result.voices, total: result.total, page: result.page };
      }}
      itemKey={(voice) => voice.personId}
      toggleFavorite={(voice) => api.updateVoiceUserState(voice.personId, { favorite: !voice.favorite })}
      saveTags={async (voice, tags) => ({ userTags: (await api.setVoiceUserTags(voice.personId, tags)).userTags })}
      renderItem={(voice, handlers) => (
        <VoiceCard voice={voice} onFavoriteToggle={handlers.onFavoriteToggle} onTagsSave={handlers.onTagsSave} />
      )}
      unfilteredEmptyMessage={t("creatorBrowse.noVoiceCredits")}
      copy={{
        label: t("creatorBrowse.voiceActors"),
        searchPlaceholder: t("creatorBrowse.searchVoices"),
        loading: t("creatorBrowse.loadingVoices"),
        refreshing: t("creatorBrowse.refreshingVoices"),
        results: t("creatorBrowse.voiceResults"),
        empty: t("creatorBrowse.noVoices"),
        pages: t("creatorBrowse.voicePages"),
      }}
    />
  );
}

function EntitySkeletonLine({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className}`} />;
}

function VoiceDetailPage({ personId, active }: { personId: number; active: boolean }) {
  const { t } = useTranslation();
  const auth = useAuth();
  const toast = useToast();
  const requireBulkFetch = usePermissionGate(REMOTE_BULK_FETCH_PERMISSIONS);
  const requireBulkTrack = usePermissionGate(REMOTE_BULK_TRACK_PERMISSIONS, { deferDemo: true });
  const requireTrack = usePermissionGate(REMOTE_TRACK_PERMISSIONS, { deferDemo: true });
  /** A mark or list on a remote work not in the Library adds it there first, which is tracking. */
  const canStateVoiceWork = (work: VoiceWorkView) => Boolean("workId" in work && work.workId) || requireTrack();
  const voiceListStorageScope = currentClientStorageScope(auth.user?.id ?? null);
  const navigateToList = () => navigateToVoicesList(voiceListStorageScope);
  const [detail, setDetail] = useState<VoiceDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isWorksLoading, setIsWorksLoading] = useState(false);
  const [remoteMatches, setRemoteMatches] = useState<VoiceRemoteSourceSet[]>([]);
  const [catalogRefresh, setCatalogRefresh] = useState<VoiceCatalogRefreshState | null>(null);
  const [isRemoteLoading, setIsRemoteLoading] = useState(false);
  usePageHeaderBack({
    label: voiceReturnLabel(),
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
  const remoteWorkActions = useRemoteWorkActions();
  const loadedPersonID = useRef<number | null>(null);
  const loadedCatalogPersonID = useRef<number | null>(null);

  useEffect(() => {
    if (!active || loadedPersonID.current === personId) return;
    const controller = new AbortController();
    setIsLoading(true);
    setWorkOptionsOpen(false);
    setRemoteMatches([]);
    setCatalogRefresh(null);
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
  }, [active, personId, t, toast]);

  const loadRemoteMatches = async (notify = false) => {
    setIsRemoteLoading(true);
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
      toast.notify(toastFromError(error, t("errors.unavailable")));
    } finally {
      setIsRemoteLoading(false);
    }
  };

  const canForceRefreshCatalog = auth.hasPermission("metadata:sync") && !auth.demoMode;

  const hasDetail = Boolean(detail);
  useEffect(() => {
    // Loads once per voice; the ref makes re-runs for a new `t` no-ops.
    if (!active || !hasDetail || loadedCatalogPersonID.current === personId) return;
    const controller = new AbortController();
    let cancelled = false;
    const loadPersistedCatalog = async () => {
      setIsRemoteLoading(true);
      try {
        const persisted = await api.getVoiceRemoteMatches(personId, controller.signal);
        if (cancelled) return;
        loadedCatalogPersonID.current = personId;
        setRemoteMatches(persisted.remoteMatches);
        setCatalogRefresh(persisted.refresh);
      } catch (error) {
        if (cancelled) return;
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
  }, [active, hasDetail, personId, t, toast]);

  const canOpenWorkflows = auth.hasPermission("workflows:run") && !auth.demoMode;
  const openRefreshRun = (runId: number) => openWorkflowPath(workflowActivityRunPath(runId));
  const runAction = (runId?: number) =>
    canOpenWorkflows && runId ? { actionLabel: t("nav.activity"), onAction: () => openRefreshRun(runId) } : {};
  // Stable so the refresh poll does not restart on every render.
  const notifyRefreshSettled = useStableCallback((refresh: VoiceCatalogRefreshState) => {
    const failed = refresh.status === "failed";
    toast.notify({
      kind: failed ? "error" : refresh.status === "partial" ? "warning" : "success",
      message: failed ? t("creatorBrowse.voiceRefreshFailed") : t("creatorBrowse.voiceRefreshFinished"),
      ...runAction(refresh.runId),
    });
  });

  const catalogRefreshActive = catalogRefresh?.status === "queued" || catalogRefresh?.status === "running";
  useEffect(() => {
    if (!active || !catalogRefreshActive) return;
    let cancelled = false;
    let requestRunning = false;
    const poll = async () => {
      // A hidden tab skips ticks and catches up as soon as it is shown again.
      if (requestRunning || document.hidden) return;
      requestRunning = true;
      try {
        const result = await api.getVoiceRemoteMatches(personId);
        if (cancelled) return;
        setRemoteMatches(result.remoteMatches);
        const stillActive = result.refresh.status === "queued" || result.refresh.status === "running";
        if (!stillActive) {
          notifyRefreshSettled(result.refresh);
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
      } catch {
        // A failed poll keeps the known state; the next tick retries.
      } finally {
        requestRunning = false;
      }
    };
    const pollNow = () => void poll();
    const timer = window.setInterval(pollNow, 2_000);
    document.addEventListener("visibilitychange", pollNow);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", pollNow);
    };
  }, [active, catalogRefresh?.runId, catalogRefreshActive, notifyRefreshSettled, personId]);

  const refreshVoiceCatalog = async (request: CreatorRefreshRequest, queuedMessage: string) => {
    if (!canForceRefreshCatalog) {
      await loadRemoteMatches(true);
      return;
    }
    setIsRemoteLoading(true);
    try {
      const refresh = await api.refreshVoiceCatalog(personId, request);
      setCatalogRefresh(refresh);
      const queued = refresh.status === "queued" || refresh.status === "running";
      toast.notify({
        kind: "info",
        message: queued ? queuedMessage : t("creatorBrowse.voiceCatalogCurrent"),
        ...(queued ? runAction(refresh.runId) : {}),
      });
    } catch (error) {
      toast.notify(
        error instanceof ApiError && error.status === 409
          ? { kind: "error", message: t("creatorBrowse.refreshAlreadyRunning") }
          : toastFromError(error, t("creatorBrowse.voiceCatalogRefreshFailed")),
      );
    } finally {
      setIsRemoteLoading(false);
    }
  };

  // Detail refreshes search every compatible source; Follow picks sources per run.
  const retryVoiceMetadata = () =>
    void refreshVoiceCatalog(
      { catalogRefresh: "stored", metadataRefresh: "missing" },
      t("creatorBrowse.voiceMetadataQueued"),
    );
  const refreshVoice = () =>
    void refreshVoiceCatalog(
      { catalogRefresh: "incremental", metadataRefresh: "missing" },
      t("creatorBrowse.voiceRefreshQueued"),
    );
  const firstPull = detail?.syncState === "never";
  const firstPullVoiceCatalog = () =>
    void refreshVoiceCatalog(
      { catalogRefresh: "full", metadataRefresh: "missing" },
      t("creatorBrowse.firstVoiceCatalogQueued"),
    );

  const knownWorks = detail?.works ?? emptyKnownWorks;
  const failedRemoteSources = remoteMatches.filter(remoteSourceFailed).length;
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
    setSelectedWorkKeys((current) => retainVisibleSelection(current, filteredWorks, voiceWorkSelectionKey));
  }, [filteredWorks]);
  const selectedWorks = mergedWorks.filter((work) => selectedWorkKeys.has(voiceWorkSelectionKey(work)));
  const selectablePageWorks = pageWorks.filter(isVoiceBulkSelectable);
  const selectedSaveable = selectedWorks.filter(voiceWorkRemoteTarget);
  const selectedForkable = selectedWorks.filter(
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

  const refreshDetail = useStableCallback(async () => {
    const item = await api.getVoice(personId);
    setDetail((current) => (item ? { ...item, remoteMatches: current?.remoteMatches ?? [] } : item));
    void loadRemoteMatches(false);
  });

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
  }, [active, mergedWorks, refreshDetail]);
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
    if (!canStateVoiceWork(work)) return;
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
    if (!canStateVoiceWork(work)) return null;
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
    setSelectedWorkKeys((current) => withSelection(current, [voiceWorkSelectionKey(work)], checked));
  };

  const toggleSelectionMode = () => {
    setSelectionMode((value) => {
      if (value) setSelectedWorkKeys(new Set());
      return !value;
    });
  };

  const toggleVisibleSelection = (checked: boolean) => {
    setSelectedWorkKeys((current) => withSelection(current, selectablePageWorks.map(voiceWorkSelectionKey), checked));
  };

  const bulkFork = async () => {
    if (selectedForkable.length === 0 || !requireBulkTrack()) return;
    setIsBulkBusy(true);
    setMessage("");
    try {
      await remoteWorkActions.recordBulkRuns(
        "track",
        voiceRemoteTargets(selectedForkable),
        creatorBulkCopy,
        refreshDetail,
      );
    } finally {
      setIsBulkBusy(false);
    }
  };

  const bulkSave = async () => {
    if (selectedSaveable.length === 0) return;
    if (!requireBulkFetch()) return;
    setSaveConfirm({ count: selectedSaveable.length, run: runBulkSave });
  };

  const runBulkSave = async () => {
    if (!requireBulkFetch()) return;
    setIsBulkBusy(true);
    setMessage("");
    try {
      await remoteWorkActions.recordBulkRuns(
        "fetch",
        voiceRemoteTargets(selectedSaveable),
        creatorBulkCopy,
        refreshDetail,
      );
    } finally {
      setIsBulkBusy(false);
      setSaveConfirm(null);
    }
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

  const forkSingleWork = async (work: VoiceWorkView) => {
    const target = voiceWorkRemoteTarget(work);
    if (!target || !requireTrack()) return;
    setIsBulkBusy(true);
    try {
      await remoteWorkActions.queueFork(target, "voice_card_fork");
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
        title={t("creatorBrowse.voiceActorNotInDatabase")}
        // A voice actor page is created from a synced work's credits, so a
        // metadata user is told how to create one.
        message={
          canForceRefreshCatalog
            ? t("creatorBrowse.voiceActorSyncPrompt", { id: personId })
            : t("creatorBrowse.voiceActorContactAdmin", { id: personId })
        }
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
            {failedRemoteSources > 0 && (
              <RemoteSourceWarning
                count={failedRemoteSources}
                onOpen={
                  canOpenWorkflows && catalogRefresh?.runId ? () => openRefreshRun(catalogRefresh.runId!) : undefined
                }
              />
            )}
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
            <UserTagRow tags={detail.userTags} scope="voice" onSave={saveVoiceTags} className="min-w-0 flex-1" />
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
            {!firstPull && !catalogRefreshActive && (detail.metadataMissingWorks ?? 0) > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="h-[var(--control-icon-size)] gap-1.5 px-2 lg:h-[var(--control-height-sm)] lg:gap-2 lg:px-[var(--control-padding-sm-x)] lg:text-xs"
                aria-label={t("detailActions.retryMetadata")}
                title={t("detailActions.retryMetadataCount", { count: detail.metadataMissingWorks ?? 0 })}
                disabled={!canForceRefreshCatalog || isRemoteLoading}
                onClick={retryVoiceMetadata}
              >
                <RefreshCw className="h-4 w-4" />
                <span className="lg:hidden">{t("detailActions.metadata")}</span>
                <span className="hidden lg:inline">{t("detailActions.retryMetadata")}</span>
              </Button>
            )}
            {catalogRefreshActive ? (
              <Button
                variant="outline"
                size="sm"
                className="h-[var(--control-icon-size)] gap-1.5 px-2 lg:h-[var(--control-height-sm)] lg:gap-2 lg:px-[var(--control-padding-sm-x)] lg:text-xs"
                aria-label={t("detailActions.refreshRunning")}
                title={canOpenWorkflows ? t("detailActions.viewRefreshRun") : undefined}
                disabled={!canOpenWorkflows || !catalogRefresh?.runId}
                onClick={() => catalogRefresh?.runId && openRefreshRun(catalogRefresh.runId)}
              >
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>{t("detailActions.refreshRunning")}</span>
              </Button>
            ) : (
              <Button
                variant={firstPull ? "default" : "outline"}
                size="sm"
                className="h-[var(--control-icon-size)] gap-1.5 px-2 lg:h-[var(--control-height-sm)] lg:gap-2 lg:px-[var(--control-padding-sm-x)] lg:text-xs"
                aria-label={firstPull ? t("detailActions.firstPull") : t("detailActions.refreshVoice")}
                disabled={!canForceRefreshCatalog || isRemoteLoading}
                onClick={firstPull ? firstPullVoiceCatalog : refreshVoice}
              >
                {isRemoteLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                <span>{firstPull ? t("detailActions.firstPull") : t("detailActions.refreshVoice")}</span>
              </Button>
            )}
            <CreatorActionMenu
              label={t("detailActions.moreVoiceActions")}
              buttonLabel={t("detailActions.more")}
              items={[
                ...(canOpenWorkflows
                  ? [
                      {
                        key: "follow",
                        label: t("detailActions.followVoice"),
                        icon: <Rss className="h-4 w-4" />,
                        onSelect: () =>
                          openWorkflowPath(workflowRunFormPath("voice_follow", { personId: String(detail.personId) })),
                      },
                    ]
                  : []),
                ...(auth.demoMode || auth.hasPermission("metadata:sync")
                  ? [
                      {
                        key: "aliases",
                        label: t("detailActions.manageAliases"),
                        icon: <ArrowUpRight className="h-4 w-4" />,
                        onSelect: () => openVoiceAliasMaintenance(detail.personId),
                      },
                    ]
                  : []),
              ]}
            />
          </div>
        }
      ></CreatorDetailHeader>

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
          <WorkSelectionBar
            selectedCount={selectedWorks.length}
            scopeSelectableCount={selectablePageWorks.length}
            scopeSelectedCount={
              selectablePageWorks.filter((work) => selectedWorkKeys.has(voiceWorkSelectionKey(work))).length
            }
            onSelectScope={() => toggleVisibleSelection(true)}
            onClear={() => setSelectedWorkKeys(new Set())}
            onExit={() => {
              setSelectedWorkKeys(new Set());
              setSelectionMode(false);
            }}
          >
            <WorkSelectionAction
              icon={<GitFork className="h-4 w-4" />}
              label={t("detailActions.fork")}
              count={selectedForkable.length}
              disabled={isBulkBusy}
              onClick={() => void bulkFork()}
            />
            <WorkSelectionAction
              icon={<HardDriveDownload className="h-4 w-4" />}
              label={t("detailActions.fetch")}
              count={selectedSaveable.length}
              disabled={isBulkBusy}
              onClick={() => void bulkSave()}
            />
          </WorkSelectionBar>
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
                  onFork={() => void forkSingleWork(work)}
                  onSave={() => void saveSingleWork(work)}
                  onStatusChange={(status) => void updateWorkMark(work, status)}
                  canMark={() => canStateVoiceWork(work)}
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
        <FetchConfirmDialog
          count={saveConfirm.count}
          onClose={() => setSaveConfirm(null)}
          onConfirm={() => void saveConfirm.run()}
        />
      )}
      <LazyRemoteFetchWorkspaceDialog workspace={fetchWorkspace} />
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
  onFork,
  onSave,
  onStatusChange,
  canMark,
  onFavoriteSaved,
  onEnsureWork,
}: {
  work: VoiceWorkView;
  selected: boolean;
  selectable: boolean;
  selectionActive: boolean;
  onSelectedChange: (checked: boolean) => void;
  onFork: () => void;
  onSave: () => void;
  onStatusChange: (status: ListeningStatus) => void;
  /** Checked before the mark menu opens. */
  canMark: () => boolean;
  onFavoriteSaved: (favorite: boolean) => void;
  onEnsureWork: () => Promise<number | null>;
}) {
  const { t } = useTranslation();
  const isKnown = "local" in work;
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
      onTagOpen={(tag) => openLibraryTagSearch("tag", tag)}
      footer={
        <WorkCardFooter
          left={<WorkCardDLsiteAction href={voiceWorkDLsiteURL(work)} />}
          right={
            <>
              <WorkCardActionButton
                title={t("detailActions.fork")}
                disabled={!voiceWorkRemoteTarget(work)}
                onClick={(event) => {
                  event.stopPropagation();
                  onFork();
                }}
              >
                <GitFork className="h-4 w-4" />
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
                canOpen={canMark}
                onChange={onStatusChange}
              />
            </>
          }
        />
      }
    />
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
    hasLyrics: work.hasLyrics,
    hasPlaybackHistory: "progress" in work && hasPlaybackHistory(work.progress),
    dlsiteTags: dlsiteTagBadges(work.tags),
    userTags: isKnown ? userTagBadges(work.userTags ?? [], (tag) => openLibraryTagSearch("user_tag", tag)) : [],
    sourceBadges,
  };
}

function remoteSourceFailed(source: VoiceRemoteSourceSet) {
  return !["ok", "disabled", "unsupported", "refreshing", "pending"].includes(source.status);
}

/** Flags remote sources whose last voice catalog pass failed; opens that run when allowed. */
function RemoteSourceWarning({ count, onOpen }: { count: number; onOpen?: () => void }) {
  const { t } = useTranslation();
  const label = t("creatorBrowse.remoteSourcesFailed", { count });
  const content = (
    <>
      <CircleAlert className="h-3.5 w-3.5" />
      <span>{t("detailActions.sourcesFailedShort", { count })}</span>
    </>
  );
  const className =
    "inline-flex items-center gap-1 rounded-full border border-warning-border bg-warning-surface px-2 py-0.5 text-2xs font-medium text-warning-foreground";
  return onOpen ? (
    <button type="button" className={`${className} hover:opacity-80`} title={label} aria-label={label} onClick={onOpen}>
      {content}
    </button>
  ) : (
    <span className={className} title={label}>
      {content}
    </span>
  );
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

function voiceRemoteTargets(works: readonly VoiceWorkView[]) {
  return works.flatMap((work) => voiceWorkRemoteTarget(work) ?? []);
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

function voiceWorkDLsiteURL(work: VoiceWorkView) {
  return "dlsiteUrl" in work && work.dlsiteUrl ? work.dlsiteUrl : DLSITE_ENDPOINTS.workURL("maniax", work.primaryCode);
}

function normalizeListeningStatus(status: string): ListeningStatus {
  return listeningStatusOptions.some((option) => option.value === status) ? (status as ListeningStatus) : "none";
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

function openVoiceAliasMaintenance(personId: number) {
  window.history.pushState({}, "", `/metadata?view=aliases&voice=${personId}`);
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

function navigateToVoicesList(storageScope: string) {
  navigateToHistoryReturn({
    fallbackLocation: readLastVoiceListLocation(storageScope) ?? "/voices",
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

function voiceReturnLabel() {
  const state = window.history.state as { returnTo?: unknown } | null;
  return typeof state?.returnTo === "string" ? voiceReturnLabelForLocation(state.returnTo) : "Back to voices";
}
