import { ArrowUpRight, CircleAlert, Image, RefreshCw, Rss } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { Card, CardContent } from "@/components/ui/card";
import { BrowseLoadingIndicator } from "@/components/collection/BrowseLoadingIndicator";
import { useCollectionResultsScroll } from "@/components/collection/useCollectionResultsScroll";
import { toastFromError, useToast } from "@/components/ui/toast";
import { UserTagRow } from "@/components/UserTagRow";
import { CatalogStatStrip } from "@/components/creator/CatalogStatStrip";
import { CatalogSyncBadge } from "@/components/creator/CatalogSyncBadge";
import type { ActionMenuItem } from "@/components/ui/action-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { CreatorCoverDialog, type CreatorCoverWorksRequest } from "@/components/creator/CreatorCoverDialog";
import {
  CreatorActionRow,
  CreatorFavoriteButton,
  CreatorMoreMenu,
  CreatorRefreshButton,
} from "@/components/creator/CreatorDetailActions";
import { CreatorDetailHeader } from "@/components/creator/CreatorDetailHeader";
import { CreatorWorkCaption } from "@/components/creator/CreatorWorkResults";
import { CreatorWorkViewMenu } from "@/components/creator/CreatorWorkViewMenu";
import { CatalogWorkToolbar } from "@/components/creator/CatalogWorkToolbar";
import { WorkCollectionLoadingState } from "@/components/work-collection/WorkCollectionLoadingState";
import { WorkCollectionPagination } from "@/components/work-collection/WorkCollectionPagination";
import { formatDateTime } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import { CreatorWorkFetchConfirm, CreatorWorkSelectionBar } from "@/pages/creator/CreatorWorkSelectionBar";
import { useCreatorWorkSelection } from "@/pages/creator/useCreatorWorkSelection";
import { useCreatorWorksBrowse } from "@/pages/creator/useCreatorWorksBrowse";
import { LibrarySortButton } from "@/pages/library/LibrarySortButton";
import { creatorWorkPageSizeOptions } from "@/lib/creatorWorksBrowse";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import { CatalogSyncDialog } from "@/features/workflows/catalog-sync/CatalogSyncDialog";
import { SubscribeButton } from "@/features/subscriptions/SubscribeButton";
import { useAuth } from "@/auth/AuthProvider";
import { REMOTE_TRACK_PERMISSIONS, usePermissionGate } from "@/auth/usePermissionGate";
import { NotFoundPage } from "@/components/NotFoundPage";
import { PageHeaderBackAction, usePageHeaderBack } from "@/components/pageHeader";
import { useStableCallback } from "@/hooks/useStableCallback";
import {
  isMatchingRemoteTrack,
  REMOTE_TRACK_TERMINAL_EVENT,
  type RemoteTrackTerminalDetail,
} from "@/lib/remoteTrackWorkflows";
import { LazyRemoteFetchWorkspaceDialog } from "@/features/work-detail/workflows/LazyRemoteFetchWorkspaceDialog";
import { useRemoteFetchWorkspace } from "@/features/work-detail/workflows/useRemoteFetchWorkspace";
import {
  workCollectionClassName,
  workCardLayout,
  workCollectionStyle,
  useWorkCollectionLayout,
} from "@/components/work-collection/WorkCollectionLayout";
import {
  api,
  ApiError,
  type ListeningStatus,
  type VoiceCatalogRefreshState,
  type CreatorRefreshRequest,
  type VoiceDetail,
  type VoiceRemoteSourceSet,
} from "@/lib/api";
import { creatorCoverUrl } from "@/lib/creatorApi";
import { NAVIGATION_EVENT, navigateToHistoryReturn } from "@/lib/browserHistory";
import { currentClientStorageScope } from "@/lib/clientStorageScope";
import { createEffectScope, startLoad } from "@/lib/effectScope";
import { openWorkflowPath, openWorkflowRun } from "@/lib/workflowLinks";
import { useRemoteWorkActions } from "@/pages/useRemoteWorkActions";
import {
  readLastVoiceListLocation,
  replaceVoiceRouteKey,
  voiceReturnLabelForLocation,
} from "@/lib/voiceNavigationState";
import { voiceWorkRemoteTarget, type VoiceWorkFilter, type VoiceWorkView } from "@/pages/voiceWorkModel";
import {
  isVoiceBulkSelectable,
  isVoiceWorkFetchable,
  isVoiceWorkForkable,
  voiceRemoteTargets,
  voiceWorkSelectionKey,
} from "@/pages/voice/voiceWorkSelection";
import { VoiceWorkCard } from "@/pages/voice/VoiceWorkCard";

// A stable empty page keeps the selection sync effect from re-running while a
// voice actor's works are absent.
const emptyVoiceWorks: VoiceWorkView[] = [];

function voiceWorkFilterOptions(t: TFunction): readonly { value: VoiceWorkFilter; label: string }[] {
  return [
    { value: "all", label: t("detailActions.allWorks") },
    { value: "available", label: t("content.available") },
    { value: "local", label: t("detailActions.local") },
    { value: "remote", label: t("detailActions.remote") },
    { value: "missing", label: t("detailActions.missing") },
  ];
}

type VoiceRouteState =
  | { status: "loading" }
  | { status: "found"; keys: readonly string[]; personId: number; routeKey: string }
  | { status: "not-found" | "error"; keys: readonly string[] };

/**
 * Voice detail addressed by a route key. The key resolves to its person before
 * the page loads; a non-canonical key is then replaced in the URL by the
 * person's canonical one.
 */
export function VoiceDetailPage({ routeKey, active }: { routeKey: string; active: boolean }) {
  const { t } = useTranslation();
  const auth = useAuth();
  const toast = useToast();
  const [route, setRoute] = useState<VoiceRouteState>({ status: "loading" });
  const resolved = route.status !== "loading" && route.keys.includes(routeKey);
  useEffect(() => {
    if (!active || resolved) return;
    setRoute({ status: "loading" });
    return startLoad((signal) => api.resolveVoiceRoute(routeKey, signal), {
      onSuccess: (next) => {
        setRoute({
          status: "found",
          keys: [routeKey, next.routeKey],
          personId: next.personId,
          routeKey: next.routeKey,
        });
        replaceVoiceRouteKey(routeKey, next.routeKey);
      },
      onError: (error) => {
        const notFound = error instanceof ApiError && error.status === 404;
        setRoute({ status: notFound ? "not-found" : "error", keys: [routeKey] });
        if (!notFound) toast.notify(toastFromError(error, t("errors.unavailable")));
      },
    });
  }, [active, resolved, routeKey, t, toast]);

  if (route.status === "found" && resolved) {
    return <VoiceDetailView personId={route.personId} routeKey={route.routeKey} active={active} />;
  }
  if (route.status === "not-found" && resolved) return <VoiceNotFound routeKey={routeKey} />;
  const navigateToList = () => navigateToVoicesList(currentClientStorageScope(auth.user?.id ?? null));
  return (
    <>
      <PageHeaderBackAction label={voiceReturnLabel()} onBack={navigateToList} />
      {route.status === "error" && resolved ? (
        <div className="rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">
          {t("errors.unavailable")}
        </div>
      ) : (
        <VoiceDetailSkeleton />
      )}
    </>
  );
}

function VoiceNotFound({ routeKey }: { routeKey: string }) {
  const { t } = useTranslation();
  const auth = useAuth();
  const canSyncCatalog = auth.hasPermission("metadata:sync") && !auth.demoMode;
  return (
    <NotFoundPage
      title={t("creatorBrowse.voiceActorNotInDatabase")}
      // A voice actor page is created from a synced work's credits, so a
      // metadata user is told how to create one.
      message={
        canSyncCatalog
          ? t("creatorBrowse.voiceActorSyncPrompt", { id: routeKey })
          : t("creatorBrowse.voiceActorContactAdmin", { id: routeKey })
      }
      onBack={() => navigateToVoicesList(currentClientStorageScope(auth.user?.id ?? null))}
      onOpenLibrary={() => {
        window.history.pushState({}, "", "/");
        window.dispatchEvent(new Event(NAVIGATION_EVENT));
      }}
    />
  );
}

function VoiceDetailView({ personId, routeKey, active }: { personId: number; routeKey: string; active: boolean }) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const auth = useAuth();
  const toast = useToast();
  const requireTrack = usePermissionGate(REMOTE_TRACK_PERMISSIONS, { deferDemo: true });
  /** A mark or list on a remote work not in the Library adds it there first, which is tracking. */
  const canStateVoiceWork = (work: VoiceWorkView) => Boolean("workId" in work && work.workId) || requireTrack();
  const voiceListStorageScope = currentClientStorageScope(auth.user?.id ?? null);
  const navigateToList = () => navigateToVoicesList(voiceListStorageScope);
  const [detail, setDetail] = useState<VoiceDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  // One server page of the works; the server merges, filters, and orders them.
  const [works, setWorks] = useState<VoiceWorkView[]>(emptyVoiceWorks);
  const [totalWorks, setTotalWorks] = useState(0);
  const [worksReloadToken, setWorksReloadToken] = useState(0);
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
  const [requestQuery, setRequestQuery] = useState("");
  const [filter, setFilter] = useState<VoiceWorkFilter>("all");
  const [page, setPage] = useState(1);
  const resultsScroll = useCollectionResultsScroll<HTMLElement>();
  const completeResultsScroll = resultsScroll.complete;
  const cancelResultsScroll = resultsScroll.cancel;
  const changePage = (value: number) => {
    resultsScroll.queue();
    setPage(value);
  };
  // The order and page size are one stored choice shared by every voice actor.
  const {
    sort: workSort,
    direction: workSortDirection,
    pageSize,
    sortProps,
    changePageSize: changeWorkPageSize,
  } = useCreatorWorksBrowse("voice", voiceListStorageScope, () => setPage(1));
  const {
    mobileColumns,
    desktopColumns,
    mobileCardMode,
    desktopCardMode,
    setMobileColumns,
    setDesktopColumns,
    setMobileCardMode,
    setDesktopCardMode,
  } = useWorkCollectionLayout();
  const mobileNavigationLayout = useMobileNavigationLayout();
  const cardLayout = workCardLayout(
    mobileNavigationLayout ? mobileCardMode : desktopCardMode,
    !mobileNavigationLayout,
    mobileColumns,
  );
  const remoteWorkActions = useRemoteWorkActions();
  const loadedPersonID = useRef<number | null>(null);
  const loadedCatalogPersonID = useRef<number | null>(null);
  const loadedWorksKey = useRef("");
  const reloadWorks = () => setWorksReloadToken((value) => value + 1);

  useEffect(() => {
    if (!active || loadedPersonID.current === personId) return;
    setIsLoading(true);
    setRemoteMatches([]);
    setCatalogRefresh(null);
    setNotFound(false);
    setWorks(emptyVoiceWorks);
    setTotalWorks(0);
    setPage(1);
    loadedWorksKey.current = "";
    return startLoad((signal) => api.getVoiceSummary(personId, signal), {
      onSuccess: (item) => {
        loadedPersonID.current = personId;
        setDetail(item);
        setMessage("");
        // The works load starts once the summary is shown.
        setIsWorksLoading(true);
      },
      onError: (error) => {
        setDetail(null);
        if (error instanceof ApiError && error.status === 404) {
          loadedPersonID.current = personId;
          setNotFound(true);
          return;
        }
        toast.notify(toastFromError(error, t("errors.unavailable")));
      },
      onSettled: () => setIsLoading(false),
    });
  }, [active, personId, t, toast]);

  useEffect(() => {
    if (query === requestQuery) return;
    const timer = window.setTimeout(() => {
      setRequestQuery(query);
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, requestQuery]);

  const detailPersonID = detail?.personId ?? 0;
  useEffect(() => {
    if (!active || detailPersonID !== personId) return;
    const requestKey = (requestPage: number) =>
      JSON.stringify([
        personId,
        requestPage,
        pageSize,
        requestQuery,
        filter,
        workSort,
        workSortDirection,
        worksReloadToken,
      ]);
    // A re-run for a new `t` finds the page already loaded.
    if (loadedWorksKey.current === requestKey(page)) {
      completeResultsScroll();
      return;
    }
    setIsWorksLoading(true);
    return startLoad(
      (signal) =>
        api.getVoiceWorks(personId, {
          page,
          pageSize,
          query: requestQuery,
          availability: filter,
          sort: workSort,
          direction: workSortDirection,
          signal,
        }),
      {
        onSuccess: (result) => {
          // A page past the end resolves to the last page.
          loadedWorksKey.current = requestKey(result.page);
          setWorks(result.works);
          setTotalWorks(result.total);
          if (result.page !== page) setPage(result.page);
          completeResultsScroll();
        },
        onError: (error) => {
          cancelResultsScroll();
          toast.notify(toastFromError(error, t("errors.unavailable")));
        },
        onSettled: () => setIsWorksLoading(false),
      },
    );
  }, [
    active,
    cancelResultsScroll,
    completeResultsScroll,
    detailPersonID,
    filter,
    page,
    pageSize,
    personId,
    requestQuery,
    t,
    toast,
    workSort,
    workSortDirection,
    worksReloadToken,
  ]);

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
    setIsRemoteLoading(true);
    return startLoad((signal) => api.getVoiceRemoteMatches(personId, signal), {
      onSuccess: (persisted) => {
        loadedCatalogPersonID.current = personId;
        setRemoteMatches(persisted.remoteMatches);
        setCatalogRefresh(persisted.refresh);
      },
      onError: (error) => toast.notify(toastFromError(error, t("errors.unavailable"))),
      onSettled: () => setIsRemoteLoading(false),
    });
  }, [active, hasDetail, personId, t, toast]);

  const canOpenWorkflows = auth.hasPermission("workflows:run") && !auth.demoMode;
  // Demo lists the covers and the catalog sync form for inspection and saves or runs neither.
  const canChangeCover = auth.demoMode || auth.hasPermission("favorites:write");
  const canOpenCatalogSync = auth.demoMode || canOpenWorkflows;
  const [coverDialogOpen, setCoverDialogOpen] = useState(false);
  const [catalogSyncOpen, setCatalogSyncOpen] = useState(false);
  const openRefreshRun = openWorkflowRun;
  const runAction = (runId?: number) =>
    canOpenWorkflows && runId ? { actionLabel: t("workflowPage.viewRun"), onAction: () => openRefreshRun(runId) } : {};
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
    const scope = createEffectScope();
    let requestRunning = false;
    let catalogSignature: string | null = null;
    const poll = () => {
      // A hidden tab skips ticks and catches up as soon as it is shown again.
      if (requestRunning || document.hidden) return;
      requestRunning = true;
      scope.load(
        async (signal) => {
          const result = await api.getVoiceRemoteMatches(personId, signal);
          setRemoteMatches(result.remoteMatches);
          const stillActive = result.refresh.status === "queued" || result.refresh.status === "running";
          // The works page follows the catalog as each source's pass lands.
          const signature = voiceCatalogSignature(result.remoteMatches);
          if (!stillActive || (catalogSignature !== null && catalogSignature !== signature)) reloadWorks();
          catalogSignature = signature;
          if (!stillActive) {
            notifyRefreshSettled(result.refresh);
            try {
              const summary = await api.getVoiceSummary(personId, signal);
              setDetail((current) => (current ? summary : current));
            } catch {
              // The persisted catalog remains usable if only the summary refresh fails.
            }
          }
          return result.refresh;
        },
        {
          onSuccess: setCatalogRefresh,
          // A failed poll keeps the known state; the next tick retries.
          onSettled: () => {
            requestRunning = false;
          },
        },
      );
    };
    const timer = window.setInterval(poll, 2_000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      scope.cancel();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
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

  // Detail refreshes search every compatible source; catalog sync picks sources per run.
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

  const failedRemoteSources = remoteMatches.filter(remoteSourceFailed).length;
  const totalPages = Math.max(1, Math.ceil(totalWorks / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageWorks = works;
  const changeWorkFilter = (value: VoiceWorkFilter) => {
    setFilter(value);
    setPage(1);
  };
  const toggleFavorite = async () => {
    if (!detail) return;
    try {
      const next = await api.updateVoiceUserState(detail.personId, {
        favorite: !detail.favorite,
      });
      setDetail((current) => (current ? { ...current, ...next } : current));
    } catch (error) {
      toast.notify(toastFromError(error, t("errors.unavailable")));
    }
  };

  const refreshDetail = useStableCallback(async () => {
    setDetail(await api.getVoiceSummary(personId));
    reloadWorks();
    void loadRemoteMatches(false);
  });
  // Bulk selection covers the loaded page.
  const selection = useCreatorWorkSelection({
    works,
    keyOf: voiceWorkSelectionKey,
    selectable: isVoiceBulkSelectable,
    fetchable: isVoiceWorkFetchable,
    forkable: isVoiceWorkForkable,
    remoteTargets: voiceRemoteTargets,
    reload: refreshDetail,
    onBulkStart: () => setMessage(""),
  });

  useEffect(() => {
    if (!active) return;
    const refreshTrackedWork = (event: Event) => {
      const terminal = (event as CustomEvent<RemoteTrackTerminalDetail>).detail;
      if (
        !terminal ||
        (terminal.status !== "succeeded" && terminal.status !== "partial") ||
        !works.some((work) => {
          const target = voiceWorkRemoteTarget(work);
          return target && isMatchingRemoteTrack(terminal, target.sourceId, target.code, work.primaryCode);
        })
      )
        return;
      void refreshDetail();
    };
    window.addEventListener(REMOTE_TRACK_TERMINAL_EVENT, refreshTrackedWork);
    return () => window.removeEventListener(REMOTE_TRACK_TERMINAL_EVENT, refreshTrackedWork);
  }, [active, works, refreshDetail]);
  const fetchWorkspace = useRemoteFetchWorkspace({ onWorksChanged: refreshDetail });

  const loadCoverWorks = async ({ page, pageSize, query, signal }: CreatorCoverWorksRequest) => {
    const result = await api.getVoiceWorks(personId, { page, pageSize, query, signal });
    return { works: result.works, total: result.total };
  };

  const saveVoiceCover = async (primaryCode: string) => {
    if (auth.demoMode) {
      toast.warning(t("permissions.demoReadOnly"));
      return;
    }
    try {
      const next = await api.updateVoiceUserState(personId, { coverPrimaryCode: primaryCode });
      setDetail((current) => (current ? { ...current, ...next } : current));
      setCoverDialogOpen(false);
    } catch (error) {
      toast.notify(toastFromError(error, t("creatorBrowse.coverUpdateFailed")));
    }
  };

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
      setWorks((current) =>
        current.map((item) =>
          "listeningMark" in item && item.workId === workId ? { ...item, listeningMark: result.listeningStatus } : item,
        ),
      );
    } catch (error) {
      toast.notify(toastFromError(error, t("creatorBrowse.markUpdateFailed")));
    }
  };

  const syncAndMarkVoiceWork = async (work: VoiceWorkView, status: ListeningStatus) => {
    const target = voiceWorkRemoteTarget(work);
    if (!target) return;
    await selection.runBusy(async () => {
      setMessage("");
      try {
        const syncResult = await api.syncRemoteSourceWork(target.sourceId, target.code, "voice_mark_interest", status);
        toast.success(t("creatorBrowse.savedAndMarked", { code: syncResult.primaryCode }));
        await refreshDetail();
      } catch (error) {
        toast.notify(toastFromError(error, t("creatorBrowse.markUpdateFailed")));
      }
    });
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
    await selection.runBusy(() => remoteWorkActions.queueFork(target, "voice_card_fork"));
  };

  if (isLoading) {
    return <VoiceDetailSkeleton />;
  }

  if (notFound) return <VoiceNotFound routeKey={routeKey} />;

  if (!detail) {
    return (
      <div className="space-y-3">
        <div className="rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">{message}</div>
      </div>
    );
  }

  const canManageAliases = auth.demoMode || auth.hasPermission("metadata:sync");
  const voiceSyncedTime = detail.lastSyncedAt ? formatDateTime(detail.lastSyncedAt, resolvedLocale) : "";
  const metadataMissingWorks = detail.metadataMissingWorks ?? 0;
  // First pull and Refresh stand beside More; the rest of catalog management
  // waits in More, each entry only for a viewer allowed to run it.
  const moreMenuItems: ActionMenuItem[] = [
    ...(canChangeCover
      ? [
          {
            key: "cover",
            label: t("detailActions.changeCover"),
            icon: <Image className="h-4 w-4" />,
            onSelect: () => setCoverDialogOpen(true),
          },
        ]
      : []),
    ...(canForceRefreshCatalog && !firstPull && metadataMissingWorks > 0
      ? [
          {
            key: "retryMetadata",
            label: t("detailActions.retryMetadata"),
            icon: <RefreshCw className="h-4 w-4" />,
            disabled: isRemoteLoading || catalogRefreshActive,
            hint: t("detailActions.retryMetadataCount", { count: metadataMissingWorks }),
            onSelect: retryVoiceMetadata,
          },
        ]
      : []),
    ...(canOpenCatalogSync
      ? [
          {
            key: "catalogSync",
            label: t("detailActions.syncCatalog"),
            icon: <Rss className="h-4 w-4" />,
            onSelect: () => setCatalogSyncOpen(true),
          },
        ]
      : []),
    ...(canManageAliases
      ? [
          {
            key: "aliases",
            label: t("detailActions.manageAliases"),
            icon: <ArrowUpRight className="h-4 w-4" />,
            onSelect: () => openVoiceAliasMaintenance(detail.personId),
          },
        ]
      : []),
  ];
  const worksBusy = isWorksLoading || isRemoteLoading || catalogRefreshActive;

  return (
    <div className="relative space-y-5">
      {message && <div className="rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">{message}</div>}

      <CreatorDetailHeader
        label={t("detailActions.voiceActorSummary")}
        name={detail.displayName}
        coverUrl={creatorCoverUrl(detail)}
        aliases={detail.aliases}
        eyebrow={
          <>
            <CatalogStatStrip
              label={t("detailActions.voiceActorStatistics")}
              stats={[
                { key: "works", label: t("detailActions.works"), count: detail.knownWorks },
                { key: "local", label: t("detailActions.local"), count: detail.localWorks },
                { key: "remote", label: t("detailActions.remote"), count: detail.remoteWorks },
                {
                  key: "missing",
                  label: t("detailActions.missing"),
                  count: Math.max(0, detail.knownWorks - detail.playableWorks),
                },
              ]}
            />
            {/* Sync attention and failed sources only matter to someone who can refresh the catalog. */}
            {canForceRefreshCatalog && detail.syncState === "attention" && (
              <CatalogSyncBadge state={detail.syncState} appearance="dot" />
            )}
            {canForceRefreshCatalog && failedRemoteSources > 0 && (
              <RemoteSourceWarning
                count={failedRemoteSources}
                onOpen={
                  canOpenWorkflows && catalogRefresh?.runId ? () => openRefreshRun(catalogRefresh.runId!) : undefined
                }
              />
            )}
          </>
        }
        actions={
          <CreatorActionRow label={t("detailActions.voiceActorActions")}>
            <CreatorFavoriteButton favorite={detail.favorite} onToggle={() => void toggleFavorite()} />
            <SubscribeButton
              target={{ kind: "voice", personId: detail.personId }}
              subjectName={detail.displayName}
              canSubscribe={!auth.demoMode && auth.hasPermission("favorites:write")}
              canPullNow={canForceRefreshCatalog}
              onOpenSubscriptions={() => openWorkflowPath("/discover?panel=subscriptions")}
            />
            {canForceRefreshCatalog && (
              <CreatorRefreshButton
                firstPull={firstPull}
                refreshing={catalogRefreshActive}
                disabled={isRemoteLoading}
                syncedAt={voiceSyncedTime}
                onRefresh={firstPull ? firstPullVoiceCatalog : refreshVoice}
                onOpenRun={
                  canOpenWorkflows && catalogRefresh?.runId ? () => openRefreshRun(catalogRefresh.runId!) : undefined
                }
              />
            )}
            <CreatorMoreMenu label={t("detailActions.moreVoiceActions")} items={moreMenuItems} />
          </CreatorActionRow>
        }
      >
        <UserTagRow tags={detail.userTags} scope="voice" onSave={saveVoiceTags} variant="chip" />
      </CreatorDetailHeader>

      <section ref={resultsScroll.anchorRef} className="scroll-mt-24 space-y-3">
        <CatalogWorkToolbar
          query={query}
          searchLabel={t("sheets.searchVoiceWorks")}
          onQueryChange={setQuery}
          sort={<LibrarySortButton {...sortProps} />}
          filterLabel={t("sheets.voiceWorkAvailability")}
          filter={filter}
          defaultFilter="all"
          filterOptions={voiceWorkFilterOptions(t)}
          onFilterChange={changeWorkFilter}
          // The summary's Works count states the size, so the caption keeps only the page.
          caption={<CreatorWorkCaption page={currentPage} totalPages={totalPages} />}
          view={
            <CreatorWorkViewMenu
              display={{
                cardModes: {
                  mobile: mobileCardMode,
                  desktop: desktopCardMode,
                  onMobileChange: setMobileCardMode,
                  onDesktopChange: setDesktopCardMode,
                },
                mobileColumns,
                desktopColumns,
                onMobileColumnsChange: setMobileColumns,
                onDesktopColumnsChange: setDesktopColumns,
                pageSize,
                pageSizeOptions: creatorWorkPageSizeOptions,
                onPageSizeChange: changeWorkPageSize,
              }}
              selection={{ active: selection.selectionMode, onToggle: selection.toggleSelectionMode }}
            />
          }
        />
        <CreatorWorkSelectionBar selection={selection} />
        {pageWorks.length > 0 ? (
          <div
            className={workCollectionClassName()}
            style={workCollectionStyle(mobileColumns, desktopColumns, cardLayout)}
            aria-busy={worksBusy}
          >
            {pageWorks.map((work) => (
              <div key={`${"sourceId" in work ? work.sourceId : "known"}:${work.primaryCode}`}>
                <VoiceWorkCard
                  work={work}
                  layout={cardLayout}
                  selected={selection.isSelected(work)}
                  selectable={isVoiceBulkSelectable(work)}
                  selectionActive={selection.selectionMode}
                  onSelectedChange={(checked) => selection.toggle(work, checked)}
                  onFork={() => void forkSingleWork(work)}
                  onSave={() => void saveSingleWork(work)}
                  onStatusChange={(status) => void updateWorkMark(work, status)}
                  canMark={() => canStateVoiceWork(work)}
                  onFavoriteSaved={(favorite) => {
                    setWorks((current) =>
                      current.map((item) =>
                        "favorite" in item && item.primaryCode === work.primaryCode ? { ...item, favorite } : item,
                      ),
                    );
                  }}
                  onEnsureWork={() => ensureVoiceWorkForList(work)}
                />
              </div>
            ))}
          </div>
        ) : worksBusy ? (
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
          totalItems={totalWorks}
          totalPages={totalPages}
          onPageChange={changePage}
        />
      </section>
      <CreatorWorkFetchConfirm selection={selection} />
      {coverDialogOpen && (
        <CreatorCoverDialog
          name={detail.displayName}
          cover={detail.cover ?? null}
          latestWork={detail.latestWork}
          loadWorks={loadCoverWorks}
          onSelect={saveVoiceCover}
          onClose={() => setCoverDialogOpen(false)}
        />
      )}
      {catalogSyncOpen && (
        <CatalogSyncDialog
          code="voice_catalog_sync"
          target={{ personId: String(detail.personId) }}
          readOnly={auth.demoMode}
          canTag={auth.hasPermission("tags:write")}
          canOpenActivity={canOpenWorkflows}
          onClose={() => setCatalogSyncOpen(false)}
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
      <Skeleton reveal className="h-8 w-32" />
      <section className="flex items-start gap-4 border-b pb-5">
        <Skeleton reveal className="h-16 w-16 shrink-0 rounded-xl lg:h-[5.5rem] lg:w-[5.5rem]" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton reveal className="h-4 w-24" />
          <Skeleton reveal className="h-8 w-64 max-w-full" />
          <div className="flex flex-wrap gap-1.5">
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton reveal key={index} className="h-5 w-16" />
            ))}
          </div>
        </div>
      </section>
      <WorkCollectionLoadingState label={t("creatorBrowse.loadingVoiceWorks")} />
    </div>
  );
}

/** Changes when a source's catalog pass lands, so the works page reloads with it. */
function voiceCatalogSignature(sources: readonly VoiceRemoteSourceSet[]) {
  return sources.map((source) => `${source.sourceId}:${source.status}:${source.total}`).join("|");
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

function voiceReturnLabel() {
  const state = window.history.state as { returnTo?: unknown } | null;
  return typeof state?.returnTo === "string" ? voiceReturnLabelForLocation(state.returnTo) : "Back to voices";
}
