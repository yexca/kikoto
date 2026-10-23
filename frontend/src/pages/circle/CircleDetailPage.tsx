import { CircleAlert, ExternalLink, Heart, Image, Loader2, RefreshCw, Rss, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toastFromError, useToast } from "@/components/ui/toast";
import { UserTagRow } from "@/components/UserTagRow";
import { BrowseLoadingIndicator } from "@/components/collection/BrowseLoadingIndicator";
import { useCollectionResultsScroll } from "@/components/collection/useCollectionResultsScroll";
import { CatalogStatStrip } from "@/components/creator/CatalogStatStrip";
import { CatalogSyncBadge } from "@/components/creator/CatalogSyncBadge";
import { ActionMenu } from "@/components/ui/action-menu";
import { CreatorCoverDialog, type CreatorCoverWorksRequest } from "@/components/creator/CreatorCoverDialog";
import { CreatorDetailHeader } from "@/components/creator/CreatorDetailHeader";
import { CatalogWorkToolbar } from "@/components/creator/CatalogWorkToolbar";
import {
  workCardLayout,
  workCollectionClassName,
  workCollectionStyle,
  useWorkCollectionLayout,
} from "@/components/work-collection/WorkCollectionLayout";
import { WorkCollectionPagination } from "@/components/work-collection/WorkCollectionPagination";
import { LazyRemoteFetchWorkspaceDialog } from "@/features/work-detail/workflows/LazyRemoteFetchWorkspaceDialog";
import { useRemoteFetchWorkspace } from "@/features/work-detail/workflows/useRemoteFetchWorkspace";
import { openWorkflowPath, workflowActivityRunPath, workflowRunFormPath } from "@/features/workflows/workflowLinks";
import { SubscribeButton } from "@/features/subscriptions/SubscribeButton";
import {
  api,
  ApiError,
  type CircleCatalogWork,
  type CircleDetail,
  type CreatorRefreshRequest,
  type ListeningStatus,
} from "@/lib/api";
import { creatorCoverUrl } from "@/lib/creatorApi";
import { navigateToHistoryReturn } from "@/lib/browserHistory";
import { currentClientStorageScope } from "@/lib/clientStorageScope";
import { coalesceRuns } from "@/lib/inflightRequests";
import { useAuth } from "@/auth/AuthProvider";
import { REMOTE_TRACK_PERMISSIONS, usePermissionGate } from "@/auth/usePermissionGate";
import { NotFoundPage } from "@/app/NotFoundPage";
import { usePageHeaderBack } from "@/app/pageHeader";
import {
  isMatchingRemoteTrack,
  REMOTE_TRACK_TERMINAL_EVENT,
  type RemoteTrackTerminalDetail,
} from "@/app/remoteTrackWorkflows";
import {
  circleReturnLabelForLocation,
  openCircleRoute,
  openCircleSeriesRoute,
  readLastCircleListLocation,
} from "@/lib/circleNavigationState";
import { formatDateTime } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import { creatorWorkPageSizeOptions } from "@/lib/creatorWorksBrowse";
import { CircleCatalogOptionsSheet, type CircleAvailabilityFilter } from "@/pages/CircleDetailSheets";
import { circleRefreshSettledMessage, useCircleRefreshRun } from "@/pages/circleRefreshRun";
import { CreatorWorkFetchConfirm, CreatorWorkSelectionBar } from "@/pages/creator/CreatorWorkSelectionBar";
import { useCreatorWorkSelection } from "@/pages/creator/useCreatorWorkSelection";
import { useCreatorWorksBrowse } from "@/pages/creator/useCreatorWorksBrowse";
import { LibrarySortButton } from "@/pages/library/LibrarySortButton";
import { useRemoteWorkActions } from "@/pages/useRemoteWorkActions";
import {
  circleRemoteTargets,
  circleWorkKey,
  circleWorkRemoteTarget,
  dlsiteMakerURL,
  emptyCircleDetail,
  isCircleBulkSaveSelectable,
  seriesCodeForWork,
} from "@/pages/circle/circleWorkModel";
import { CircleSeriesSidebar, MobileCircleSeriesHeader, CircleSeriesSummaryCard } from "@/pages/circle/CircleSeries";
import { CatalogWorkCard, CatalogDeleteConfirmModal } from "@/pages/circle/CircleCatalogWorkCard";

function circleAvailabilityOptions(t: TFunction): readonly { value: CircleAvailabilityFilter; label: string }[] {
  return [
    { value: "all", label: t("detailActions.allWorks") },
    { value: "available", label: t("content.available") },
    { value: "unavailable", label: t("detailActions.unavailable") },
    { value: "local", label: t("detailActions.local") },
    { value: "remote", label: t("detailActions.remote") },
  ];
}

export function CircleDetailPage({
  externalId,
  seriesCode,
  active,
}: {
  externalId: string;
  seriesCode?: string | null;
  active: boolean;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const auth = useAuth();
  const toast = useToast();
  const requireTrack = usePermissionGate(REMOTE_TRACK_PERMISSIONS, { deferDemo: true });
  /** A mark or list on a catalog work not in the Library adds it there first, which is tracking. */
  const canStateCatalogWork = (work: CircleCatalogWork) => work.workId !== null || requireTrack();
  const canRefreshCatalog = auth.hasPermission("metadata:sync") && !auth.demoMode;
  const [detail, setDetail] = useState<CircleDetail | null>(null);
  // "missing" means the maker id is not in this site's database, which a
  // metadata:sync user may fetch; "hidden" is a known circle this page does not show.
  const [notFound, setNotFound] = useState<"missing" | "hidden" | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [queueingRefresh, setQueueingRefresh] = useState(false);
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
  const storageScope = currentClientStorageScope(auth.user?.id ?? null);
  const [deleteTarget, setDeleteTarget] = useState<CircleCatalogWork | null>(null);
  const [coverDialogOpen, setCoverDialogOpen] = useState(false);
  const remoteWorkActions = useRemoteWorkActions();
  const [catalogOptionsOpen, setCatalogOptionsOpen] = useState(false);
  const [workQuery, setWorkQuery] = useState("");
  const [availabilityFilter, setAvailabilityFilter] = useState<CircleAvailabilityFilter>("all");
  const [workPage, setWorkPage] = useState(1);
  const resultsScroll = useCollectionResultsScroll<HTMLElement>();
  const completeResultsScroll = resultsScroll.complete;
  const cancelResultsScroll = resultsScroll.cancel;
  // The order and page size are one stored choice shared by every circle catalog.
  const {
    sort: workSort,
    direction: workSortDirection,
    pageSize: workPageSize,
    sortProps,
    changePageSize: changeWorkPageSize,
  } = useCreatorWorksBrowse("circle", storageScope, () => setWorkPage(1));
  const loadedExternalID = useRef("");
  const detailQuery = useMemo(
    () => ({
      page: workPage,
      pageSize: workPageSize,
      query: workQuery,
      availability: availabilityFilter,
      series: seriesCode ?? "",
      sort: workSort,
      direction: workSortDirection,
    }),
    [availabilityFilter, seriesCode, workPage, workPageSize, workQuery, workSort, workSortDirection],
  );
  const fetchWorkspace = useRemoteFetchWorkspace({
    onWorksChanged: async () => setDetail(await api.getCircle(externalId, detailQuery)),
  });

  const loadCircleDetail = useCallback(
    async (showLoading = false, signal?: AbortSignal) => {
      if (!active) return null;
      if (showLoading) {
        setIsLoading(true);
      }
      try {
        const next = await api.getCircle(externalId, { ...detailQuery, signal });
        if (signal?.aborted) return null;
        loadedExternalID.current = externalId;
        setDetail(next);
        setNotFound(null);
        return next;
      } catch (error) {
        if (signal?.aborted) return null;
        if (error instanceof ApiError && error.status === 404) {
          setDetail(null);
          setNotFound(error.code === "circle_not_in_database" ? "missing" : "hidden");
          return null;
        }
        toast.notify(toastFromError(error, t("errors.unavailable")));
        return null;
      } finally {
        if (showLoading && !signal?.aborted) {
          setIsLoading(false);
        }
      }
    },
    [active, detailQuery, externalId, t, toast],
  );

  // Track completions can arrive in bursts; each one only needs the circle's
  // recomputed aggregates once, so collapse them into serialized reloads that
  // keep the known circle on failure.
  const reloadAfterTrack = useMemo(
    () =>
      coalesceRuns(async () => {
        try {
          const next = await api.getCircle(externalId, detailQuery);
          if (loadedExternalID.current === externalId) setDetail(next);
        } catch (error) {
          if (loadedExternalID.current === externalId) {
            toast.notify(toastFromError(error, t("errors.unavailable")));
          }
        }
      }),
    [detailQuery, externalId, t, toast],
  );

  useEffect(() => {
    if (!active) return;
    const refreshTrackedWork = (event: Event) => {
      const terminal = (event as CustomEvent<RemoteTrackTerminalDetail>).detail;
      if (
        !terminal ||
        (terminal.status !== "succeeded" && terminal.status !== "partial") ||
        !detail?.works.some((work) => {
          const target = circleWorkRemoteTarget(work);
          return target && isMatchingRemoteTrack(terminal, target.sourceId, target.code, work.primaryCode);
        })
      )
        return;
      void reloadAfterTrack();
    };
    window.addEventListener(REMOTE_TRACK_TERMINAL_EVENT, refreshTrackedWork);
    return () => window.removeEventListener(REMOTE_TRACK_TERMINAL_EVENT, refreshTrackedWork);
  }, [active, detail?.works, reloadAfterTrack]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void loadCircleDetail(true, controller.signal).then((next) => {
      if (controller.signal.aborted) return;
      if (next) completeResultsScroll();
      else cancelResultsScroll();
    });
    return () => controller.abort();
  }, [active, cancelResultsScroll, completeResultsScroll, externalId, loadCircleDetail]);

  // The fallback must keep its identity across renders: works-derived memos
  // feed the selection sync effect below.
  const circle = useMemo(() => detail ?? emptyCircleDetail(externalId), [detail, externalId]);
  const filteredWorks = useMemo(() => {
    return circle.works;
  }, [circle.works]);
  const catalogOnlyCount = circle.works.filter((work) => work.catalogStatus !== "imported").length;
  const availableWorkCount = circle.availableWorks ?? circle.works.filter((work) => work.local || work.remote).length;
  const totalWorkPages = Math.max(1, Math.ceil(circle.worksMeta.total / workPageSize));
  const currentWorkPage = Math.min(circle.worksMeta.page || workPage, totalWorkPages);
  const pagedWorks = filteredWorks;
  const reloadDetail = async () => setDetail(await api.getCircle(externalId, detailQuery));
  const selection = useCreatorWorkSelection({
    works: filteredWorks,
    keyOf: circleWorkKey,
    selectable: isCircleBulkSaveSelectable,
    forkable: (work) => work.workId === null,
    remoteTargets: circleRemoteTargets,
    reload: reloadDetail,
  });
  const navigateToList = () => navigateToCirclesList(storageScope);
  usePageHeaderBack({
    label: circleReturnLabel(),
    title: detail?.displayName,
    onBack: navigateToList,
    enabled: notFound === null,
  });

  const changeAvailabilityFilter = (value: CircleAvailabilityFilter) => {
    setAvailabilityFilter(value);
    setWorkPage(1);
  };
  const changeWorkQuery = (value: string) => {
    setWorkQuery(value);
    setWorkPage(1);
  };
  const changeWorkPage = (page: number) => {
    resultsScroll.queue();
    setWorkPage(page);
  };
  const cardModes = {
    mobile: mobileCardMode,
    desktop: desktopCardMode,
    onMobileChange: setMobileCardMode,
    onDesktopChange: setDesktopCardMode,
  };

  useEffect(() => {
    setWorkPage(1);
  }, [availabilityFilter, externalId, seriesCode, workPageSize, workQuery, workSort, workSortDirection]);

  const selectedSeries = useMemo(() => {
    const code = seriesCode?.toUpperCase() ?? "";
    return code ? (circle.series.find((series) => series.titleId.toUpperCase() === code) ?? null) : null;
  }, [circle.series, seriesCode]);
  const isSeriesView = seriesCode !== undefined;
  // The series overview lists series, so it has no order or page of works.
  const showsWorks = !isSeriesView || selectedSeries !== null;
  const seriesWorks = useMemo(() => {
    if (!isSeriesView) return [];
    return filteredWorks;
  }, [filteredWorks, isSeriesView]);
  const activeSeriesCount = selectedSeries
    ? selectedSeries.works
    : circle.series.reduce((total, series) => total + series.works, 0);

  const canOpenWorkflows = auth.hasPermission("workflows:run") && !auth.demoMode;
  const canChangeCover = auth.hasPermission("favorites:write");
  const canSubscribe = auth.hasPermission("favorites:write") && !auth.demoMode;
  const openSubscriptions = () => openWorkflowPath("/subscriptions?panel=subscriptions");
  const openRefreshRun = (runId: number) => openWorkflowPath(workflowActivityRunPath(runId));
  const refreshRun = useCircleRefreshRun({
    run: detail?.refresh,
    canWatchRuns: canOpenWorkflows,
    onPoll: () => void reloadAfterTrack(),
    onSettled: (run) => {
      void reloadAfterTrack();
      const message = circleRefreshSettledMessage(run, t);
      toast.notify({
        kind: run.status === "failed" ? "error" : run.status === "partial" ? "warning" : "success",
        message,
        actionLabel: canOpenWorkflows ? t("nav.activity") : undefined,
        onAction: canOpenWorkflows ? () => openRefreshRun(run.runId) : undefined,
      });
    },
  });
  const refreshBusy = queueingRefresh || refreshRun.active;

  // Refreshes run as queued workflows; the request only returns the run to follow.
  const queueRefresh = async (request: CreatorRefreshRequest) => {
    if (!canRefreshCatalog || refreshBusy) return;
    setQueueingRefresh(true);
    try {
      const queued = await api.refreshCircle(externalId, request);
      setDetail((current) =>
        current && loadedExternalID.current === externalId
          ? { ...current, refresh: { runId: queued.runId, status: queued.status } }
          : current,
      );
      toast.notify({
        kind: "info",
        message: t("creatorBrowse.circleRefreshQueued", { id: queued.runId }),
        actionLabel: canOpenWorkflows ? t("nav.activity") : undefined,
        onAction: canOpenWorkflows ? () => openRefreshRun(queued.runId) : undefined,
      });
    } catch (error) {
      toast.notify(
        error instanceof ApiError && error.status === 409
          ? { kind: "error", message: t("creatorBrowse.refreshAlreadyRunning") }
          : toastFromError(error, t("creatorBrowse.refreshWorkflowFailed")),
      );
    } finally {
      setQueueingRefresh(false);
    }
  };

  // An unknown circle is fetched by the circle catalog sync workflow, which adds it
  // on success; the run form opens with this maker id filled in.
  const canFetchMissingCircle = canRefreshCatalog && canOpenWorkflows;
  const openCatalogSyncCircle = () =>
    openWorkflowPath(
      workflowRunFormPath("circle_catalog_sync", { circleId: detail?.externalId ?? externalId.toUpperCase() }),
    );

  const firstPull = circle.syncState === "never";
  const catalogSyncedTime = circle.lastSyncedAt ? formatDateTime(circle.lastSyncedAt, resolvedLocale) : "";
  const catalogNote = firstPull
    ? t("detailActions.catalogNotPulledHint")
    : catalogSyncedTime
      ? t("detailActions.catalogSyncedAt", { time: catalogSyncedTime })
      : "";
  // First pull reads the whole catalog and fills its metadata; Refresh also
  // matches the circle's works on the remote sources.
  const runPrimaryRefresh = () =>
    void queueRefresh(
      firstPull
        ? { catalogRefresh: "full", metadataRefresh: "missing" }
        : { catalogRefresh: "incremental", metadataRefresh: "missing", sourceCheck: true },
    );
  const moreMenuItems = [
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
    ...(canOpenWorkflows
      ? [
          {
            key: "catalogSync",
            label: t("detailActions.syncCircleCatalog"),
            icon: <Rss className="h-4 w-4" />,
            onSelect: openCatalogSyncCircle,
          },
        ]
      : []),
  ];

  const loadCoverWorks = async ({ page, pageSize, query, signal }: CreatorCoverWorksRequest) => {
    const result = await api.getCircle(externalId, { page, pageSize, query, signal });
    return { works: result.works, total: result.worksMeta.total };
  };

  const saveCircleCover = async (primaryCode: string) => {
    try {
      const next = await api.updateCircleUserState(externalId, { coverPrimaryCode: primaryCode });
      setDetail((current) =>
        current ? { ...current, ...next, works: current.works, series: current.series } : current,
      );
      setCoverDialogOpen(false);
    } catch (error) {
      toast.notify(toastFromError(error, t("creatorBrowse.coverUpdateFailed")));
    }
  };

  const toggleCircleFavorite = async () => {
    try {
      const next = await api.updateCircleUserState(externalId, { favorite: !circle.favorite });
      setDetail((current) =>
        current ? { ...current, ...next, works: current.works, series: current.series } : current,
      );
    } catch (error) {
      toast.notify(toastFromError(error, t("creatorBrowse.favoriteUpdateFailed")));
    }
  };

  const saveCircleTags = async (tags: string[]) => {
    try {
      const result = await api.setCircleUserTags(externalId, tags);
      setDetail((current) => (current ? { ...current, userTags: result.userTags } : current));
    } catch (error) {
      toast.notify(toastFromError(error, t("creatorBrowse.tagsUpdateFailed")));
    }
  };

  const deleteCatalogWork = async () => {
    if (!deleteTarget) return;
    try {
      const result = await api.deleteCircleCatalogWork(externalId, deleteTarget.primaryCode);
      toast.success(
        result.deleted > 0
          ? t("creatorBrowse.catalogWorkRemoved", { code: deleteTarget.primaryCode })
          : t("creatorBrowse.catalogWorkAlreadyRemoved", { code: deleteTarget.primaryCode }),
      );
      const next = await api.getCircle(externalId, detailQuery);
      setDetail(next);
      setDeleteTarget(null);
    } catch (error) {
      toast.notify(toastFromError(error, t("creatorBrowse.deleteWorkFailed")));
    }
  };

  const updateCatalogWorkStatus = async (work: CircleCatalogWork, status: ListeningStatus) => {
    if (!canStateCatalogWork(work)) return;
    if (work.workId === null) {
      await syncAndMarkCatalogWork(work, status);
      return;
    }
    try {
      const result = await api.updateWorkUserState(work.workId, { listeningStatus: status });
      setDetail((current) =>
        current
          ? {
              ...current,
              works: current.works.map((item) =>
                item.primaryCode === work.primaryCode ? { ...item, listeningMark: result.listeningStatus } : item,
              ),
            }
          : current,
      );
    } catch (error) {
      toast.notify(toastFromError(error, t("creatorBrowse.markUpdateFailed")));
    }
  };

  const syncAndMarkCatalogWork = async (work: CircleCatalogWork, status: ListeningStatus) => {
    const target = circleWorkRemoteTarget(work);
    if (!target) return;
    await selection.runBusy(async () => {
      try {
        const syncResult = await api.syncRemoteSourceWork(target.sourceId, target.code, "circle_mark_interest");
        const markResult = await api.updateWorkUserState(syncResult.workId, { listeningStatus: status });
        toast.success(t("creatorBrowse.savedAndMarked", { code: syncResult.primaryCode }));
        const next = await api.getCircle(externalId, detailQuery);
        setDetail({
          ...next,
          works: next.works.map((item) =>
            item.primaryCode === work.primaryCode ? { ...item, listeningMark: markResult.listeningStatus } : item,
          ),
        });
      } catch (error) {
        toast.notify(toastFromError(error, t("creatorBrowse.markUpdateFailed")));
      }
    });
  };

  const trackCatalogWorkForState = async (work: CircleCatalogWork, reason: string) => {
    const target = circleWorkRemoteTarget(work);
    if (!target) return null;
    const syncResult = await api.syncRemoteSourceWork(target.sourceId, target.code, reason);
    return syncResult.workId;
  };

  const ensureCatalogWorkForList = async (work: CircleCatalogWork) => {
    if (work.workId) return work.workId;
    if (!canStateCatalogWork(work)) return null;
    try {
      const workId = await trackCatalogWorkForState(work, "circle_list");
      if (!workId) return null;
      const next = await api.getCircle(externalId, detailQuery);
      setDetail(next);
      return workId;
    } catch (error) {
      toast.notify(toastFromError(error, t("creatorBrowse.saveForListFailed")));
      return null;
    }
  };

  const saveSingleWork = (work: CircleCatalogWork) => {
    const target = circleWorkRemoteTarget(work);
    if (!target) return;
    void fetchWorkspace.open({
      sourceId: target.sourceId,
      remoteCode: target.code,
      canonicalCode: work.primaryCode,
      sourceDisplayName: target.sourceDisplayName,
    });
  };

  const forkSingleWork = async (work: CircleCatalogWork) => {
    const target = circleWorkRemoteTarget(work);
    if (!target || !requireTrack()) return;
    await selection.runBusy(() => remoteWorkActions.queueFork(target, "circle_card_fork"));
  };

  if (notFound) {
    const missing = notFound === "missing";
    return (
      <NotFoundPage
        title={missing ? t("creatorBrowse.circleNotInDatabase") : t("creatorBrowse.circleNotFound")}
        message={
          !missing
            ? t("creatorBrowse.circleUnavailable", { id: externalId })
            : canFetchMissingCircle
              ? t("creatorBrowse.circleFetchPrompt", { id: externalId })
              : t("creatorBrowse.circleContactAdmin", { id: externalId })
        }
        primaryAction={
          missing && canFetchMissingCircle ? (
            <Button onClick={openCatalogSyncCircle}>
              <Rss className="h-4 w-4" />
              {t("creatorBrowse.circleFetch")}
            </Button>
          ) : undefined
        }
        onBack={navigateToList}
        onOpenLibrary={() => {
          window.history.pushState({}, "", "/");
          window.dispatchEvent(new Event("kikoto:navigation"));
        }}
      />
    );
  }

  return (
    <div className="relative space-y-5">
      <CreatorDetailHeader
        label={t("detailActions.circleSummary")}
        name={circle.displayName}
        coverUrl={creatorCoverUrl(circle)}
        aliases={circle.aliases}
        eyebrow={
          <>
            <a
              href={dlsiteMakerURL(circle.externalId)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-sm font-mono tracking-tight transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t("detailActions.openDlsiteFor", { id: circle.externalId })}
              title={t("detailActions.openDlsite")}
            >
              <span>{circle.externalId}</span>
              <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
            </a>
            <CatalogSyncBadge state={circle.syncState} appearance="dot" />
          </>
        }
        meta={<UserTagRow tags={circle.userTags} scope="circle" onSave={saveCircleTags} className="mt-2.5" />}
        actions={
          <div
            className="flex shrink-0 flex-wrap gap-1.5 lg:gap-2"
            role="group"
            aria-label={t("detailActions.circleActions")}
          >
            <Button
              variant={circle.favorite ? "default" : "outline"}
              size="icon"
              className="lg:h-[var(--control-height-sm)] lg:w-auto lg:px-[var(--control-padding-sm-x)] lg:text-xs"
              aria-label={circle.favorite ? t("creator.removeFavorite") : t("creator.addFavorite")}
              aria-pressed={circle.favorite}
              title={circle.favorite ? t("creator.removeFavorite") : t("creator.addFavorite")}
              onClick={() => void toggleCircleFavorite()}
            >
              <Heart className={`h-4 w-4 ${circle.favorite ? "fill-current" : ""}`} />
              <span className="hidden lg:inline">{t("detailActions.favorite")}</span>
            </Button>
            <SubscribeButton
              target={{ kind: "circle", circleId: circle.externalId }}
              subjectName={circle.displayName}
              canSubscribe={canSubscribe}
              canPullNow={canRefreshCatalog}
              onOpenSubscriptions={openSubscriptions}
            />
            {!firstPull && !refreshRun.active && catalogOnlyCount > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="h-[var(--control-icon-size)] gap-1.5 px-2 lg:h-[var(--control-height-sm)] lg:gap-2 lg:px-[var(--control-padding-sm-x)]"
                aria-label={t("detailActions.retryMetadata")}
                title={t("detailActions.retryMetadataCount", { count: catalogOnlyCount })}
                disabled={!canRefreshCatalog || isLoading || refreshBusy}
                onClick={() => void queueRefresh({ catalogRefresh: "stored", metadataRefresh: "missing" })}
              >
                <RefreshCw className="h-4 w-4" />
                <span className="lg:hidden">{t("detailActions.metadata")}</span>
                <span className="hidden lg:inline">{t("detailActions.retryMetadata")}</span>
              </Button>
            )}
            {refreshRun.active && detail?.refresh ? (
              <Button
                variant="outline"
                size="sm"
                className="h-[var(--control-icon-size)] gap-1.5 px-2 lg:h-[var(--control-height-sm)] lg:gap-2 lg:px-[var(--control-padding-sm-x)]"
                aria-label={t("detailActions.refreshRunning")}
                title={canOpenWorkflows ? t("detailActions.viewRefreshRun") : undefined}
                disabled={!canOpenWorkflows}
                onClick={() => detail.refresh && openRefreshRun(detail.refresh.runId)}
              >
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>{t("detailActions.refreshRunning")}</span>
              </Button>
            ) : (
              <Button
                variant={firstPull ? "default" : "outline"}
                size="sm"
                className="h-[var(--control-icon-size)] gap-1.5 px-2 lg:h-[var(--control-height-sm)] lg:gap-2 lg:px-[var(--control-padding-sm-x)]"
                aria-label={firstPull ? t("detailActions.firstPull") : t("detailActions.refreshCircle")}
                disabled={!canRefreshCatalog || isLoading || refreshBusy}
                onClick={runPrimaryRefresh}
              >
                {queueingRefresh ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                {firstPull ? (
                  <span>{t("detailActions.firstPull")}</span>
                ) : (
                  <>
                    <span className="lg:hidden">{t("detailActions.refreshShort")}</span>
                    <span className="hidden lg:inline">{t("detailActions.refreshCircle")}</span>
                  </>
                )}
              </Button>
            )}
            <ActionMenu
              label={t("detailActions.moreCircleActions")}
              buttonLabel={t("detailActions.more")}
              items={moreMenuItems}
            />
          </div>
        }
      >
        <CatalogStatStrip
          label={t("sheets.catalogAvailability")}
          stats={[
            { key: "available", label: t("content.available"), count: availableWorkCount },
            { key: "local", label: t("detailActions.local"), count: circle.localWorks },
            { key: "remote", label: t("detailActions.remote"), count: circle.remoteWorks },
            { key: "unavailable", label: t("detailActions.unavailable"), count: circle.missingWorks },
          ]}
          availability={{ total: circle.catalogWorks, local: circle.localWorks, available: availableWorkCount }}
          availabilityLabel={t("creator.availabilityBreakdown", {
            local: circle.localWorks,
            remote: Math.max(0, availableWorkCount - circle.localWorks),
            missing: circle.missingWorks,
          })}
          note={catalogNote}
        />
      </CreatorDetailHeader>

      <section ref={resultsScroll.anchorRef} className="scroll-mt-24 space-y-3">
        <CatalogWorkToolbar
          leading={
            <div className={segmentedListClassName("shrink-0")} role="group">
              <button
                className={segmentedItemClassName(!isSeriesView)}
                aria-pressed={!isSeriesView}
                onClick={() => openCircleRoute(circle.externalId)}
              >
                {t("detailActions.works")} {circle.catalogWorks}
              </button>
              <button
                className={segmentedItemClassName(isSeriesView)}
                aria-pressed={isSeriesView}
                onClick={() => openCircleSeriesRoute(circle.externalId)}
              >
                {t("detailActions.series")} {circle.series.length}
              </button>
            </div>
          }
          query={workQuery}
          searchLabel={t("detailActions.searchCatalogWorks")}
          mobileSearch={isSeriesView}
          mobileSearchAction={
            isSeriesView ? (
              <Button
                variant="ghost"
                size="icon-sm"
                className="relative"
                aria-label={t("detailActions.catalogOptions")}
                title={t("detailActions.catalogOptions")}
                aria-haspopup="dialog"
                aria-expanded={catalogOptionsOpen}
                onClick={() => setCatalogOptionsOpen(true)}
              >
                <SlidersHorizontal className="h-4 w-4" />
                {(workQuery.trim() || availabilityFilter !== "all" || selection.selectionMode) && (
                  <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
                )}
              </Button>
            ) : undefined
          }
          onQueryChange={changeWorkQuery}
          sort={showsWorks ? <LibrarySortButton {...sortProps} variant="toolbar" /> : undefined}
          mobileSort={showsWorks ? <LibrarySortButton {...sortProps} /> : undefined}
          cardModes={cardModes}
          filterLabel={t("detailActions.catalogAvailabilityFilter")}
          filter={availabilityFilter}
          defaultFilter="all"
          filterOptions={circleAvailabilityOptions(t)}
          onFilterChange={changeAvailabilityFilter}
          pageSize={showsWorks ? workPageSize : undefined}
          pageSizeOptions={creatorWorkPageSizeOptions}
          onPageSizeChange={showsWorks ? changeWorkPageSize : undefined}
          mobileColumns={mobileColumns}
          desktopColumns={desktopColumns}
          onMobileColumnsChange={setMobileColumns}
          onDesktopColumnsChange={setDesktopColumns}
          selectionMode={isSeriesView ? undefined : selection.selectionMode}
          onSelectionModeChange={isSeriesView ? undefined : selection.setSelectionMode}
        />

        {circle.worksMeta.truncated && (
          <div className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-sm text-warning-foreground">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              {t("creatorBrowse.catalogWorksPartial", {
                loaded: circle.worksMeta.loaded,
                total: circle.worksMeta.total,
              })}
            </span>
          </div>
        )}

        {(!isSeriesView || selectedSeries) && (
          <div>
            <WorkCollectionPagination
              placement="top"
              page={currentWorkPage}
              pageSize={workPageSize}
              totalItems={circle.worksMeta.total}
              totalPages={totalWorkPages}
              compactMobile
              refreshing={isLoading}
              refreshingLabel={t("creatorBrowse.refreshingCircles")}
              leadingControls={
                <Button
                  variant="outline"
                  size="icon"
                  className="relative h-11 w-11 lg:hidden"
                  aria-label={t("detailActions.catalogOptions")}
                  title={t("detailActions.catalogOptions")}
                  aria-haspopup="dialog"
                  aria-expanded={catalogOptionsOpen}
                  onClick={() => setCatalogOptionsOpen(true)}
                >
                  <SlidersHorizontal className="h-4 w-4" />
                  {(workQuery.trim() || availabilityFilter !== "all" || selection.selectionMode) && (
                    <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-primary" aria-hidden="true" />
                  )}
                </Button>
              }
              onPageChange={changeWorkPage}
            />
          </div>
        )}

        <CircleCatalogOptionsSheet
          open={catalogOptionsOpen}
          onClose={() => setCatalogOptionsOpen(false)}
          isSeriesView={isSeriesView}
          selectionMode={selection.selectionMode}
          availabilityFilter={availabilityFilter}
          onAvailabilityFilterChange={changeAvailabilityFilter}
          query={workQuery}
          onQueryChange={changeWorkQuery}
          pageSize={workPageSize}
          pageSizeOptions={creatorWorkPageSizeOptions}
          onPageSizeChange={changeWorkPageSize}
          mobileColumns={mobileColumns}
          onMobileColumnsChange={setMobileColumns}
          cardMode={mobileCardMode}
          onCardModeChange={setMobileCardMode}
          onSelectWorks={() => {
            setCatalogOptionsOpen(false);
            selection.toggleSelectionMode();
          }}
        />

        {isSeriesView ? (
          <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
            <CircleSeriesSidebar
              externalId={circle.externalId}
              series={circle.series}
              selectedSeriesCode={selectedSeries?.titleId ?? null}
              allCount={activeSeriesCount}
            />
            <div className="space-y-3">
              <MobileCircleSeriesHeader
                externalId={circle.externalId}
                series={circle.series}
                selectedSeries={selectedSeries}
                selectedSeriesCode={selectedSeries?.titleId ?? null}
                allCount={activeSeriesCount}
                subscribe={
                  selectedSeries && (
                    <SubscribeButton
                      target={{ kind: "series", circleId: circle.externalId, seriesId: selectedSeries.titleId }}
                      subjectName={selectedSeries.name}
                      canSubscribe={canSubscribe}
                      canPullNow={canRefreshCatalog}
                      onOpenSubscriptions={openSubscriptions}
                      className="shrink-0"
                    />
                  )
                }
              />
              <div className="hidden flex-col gap-2 px-1 py-1 lg:flex lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0">
                  <h3 className="truncate text-lg font-semibold">
                    {selectedSeries ? selectedSeries.name : t("detailActions.allSeries")}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {selectedSeries
                      ? t("creatorBrowse.seriesWorksSummary", {
                          id: selectedSeries.titleId,
                          count: selectedSeries.works,
                        })
                      : t("creatorBrowse.seriesListSummary", {
                          series: circle.series.length,
                          works: activeSeriesCount,
                        })}
                  </p>
                </div>
                {selectedSeries && (
                  <div className="flex shrink-0 gap-2">
                    <SubscribeButton
                      target={{ kind: "series", circleId: circle.externalId, seriesId: selectedSeries.titleId }}
                      subjectName={selectedSeries.name}
                      canSubscribe={canSubscribe}
                      canPullNow={canRefreshCatalog}
                      onOpenSubscriptions={openSubscriptions}
                    />
                    {selectedSeries.url && (
                      <Button variant="outline" size="sm" asChild>
                        <a href={selectedSeries.url} target="_blank" rel="noreferrer">
                          <ExternalLink className="h-4 w-4" />
                          {t("creatorBrowse.dlsiteSeries")}
                        </a>
                      </Button>
                    )}
                  </div>
                )}
              </div>
              {selectedSeries ? (
                <>
                  <div
                    className={workCollectionClassName()}
                    style={workCollectionStyle(mobileColumns, desktopColumns, cardLayout)}
                  >
                    {seriesWorks.length > 0 ? (
                      seriesWorks.map((work) => (
                        <div key={work.primaryCode}>
                          <CatalogWorkCard
                            work={work}
                            layout={cardLayout}
                            busy={selection.busy || fetchWorkspace.isBusy}
                            selected={selection.isSelected(work)}
                            selectable={isCircleBulkSaveSelectable(work)}
                            selectionActive={false}
                            onSelectedChange={(checked) => selection.toggle(work, checked)}
                            onFork={() => void forkSingleWork(work)}
                            onSave={() => void saveSingleWork(work)}
                            onDeleteMissing={() => setDeleteTarget(work)}
                            onStatusChange={(status) => void updateCatalogWorkStatus(work, status)}
                            canMark={() => canStateCatalogWork(work)}
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
                            onEnsureWork={() => ensureCatalogWorkForList(work)}
                            onSeriesOpen={
                              work.seriesTitleId || seriesCodeForWork(circle.series, work.primaryCode)
                                ? () =>
                                    openCircleSeriesRoute(
                                      circle.externalId,
                                      work.seriesTitleId || seriesCodeForWork(circle.series, work.primaryCode),
                                    )
                                : undefined
                            }
                          />
                        </div>
                      ))
                    ) : (
                      <Card>
                        <CardContent className="p-5 text-sm text-muted-foreground">
                          {t("creatorBrowse.noSeriesWorks")}
                        </CardContent>
                      </Card>
                    )}
                  </div>
                  <WorkCollectionPagination
                    placement="bottom"
                    page={currentWorkPage}
                    pageSize={workPageSize}
                    totalItems={circle.worksMeta.total}
                    totalPages={totalWorkPages}
                    onPageChange={changeWorkPage}
                  />
                </>
              ) : (
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {circle.series.length > 0 ? (
                    circle.series.map((series) => (
                      <CircleSeriesSummaryCard key={series.titleId} externalId={circle.externalId} series={series} />
                    ))
                  ) : (
                    <Card>
                      <CardContent className="p-5 text-sm text-muted-foreground">
                        {t("creatorBrowse.noSeriesForCircle")}
                      </CardContent>
                    </Card>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            <CreatorWorkSelectionBar selection={selection} />

            <div
              className={workCollectionClassName()}
              style={workCollectionStyle(mobileColumns, desktopColumns, cardLayout)}
            >
              {filteredWorks.length > 0 ? (
                pagedWorks.map((work) => (
                  <div key={work.primaryCode}>
                    <CatalogWorkCard
                      work={work}
                      layout={cardLayout}
                      busy={selection.busy || fetchWorkspace.isBusy}
                      selected={selection.isSelected(work)}
                      selectable={isCircleBulkSaveSelectable(work)}
                      selectionActive={selection.selectionMode}
                      onSelectedChange={(checked) => selection.toggle(work, checked)}
                      onFork={() => void forkSingleWork(work)}
                      onSave={() => void saveSingleWork(work)}
                      onDeleteMissing={() => setDeleteTarget(work)}
                      onStatusChange={(status) => void updateCatalogWorkStatus(work, status)}
                      canMark={() => canStateCatalogWork(work)}
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
                      onEnsureWork={() => ensureCatalogWorkForList(work)}
                      onSeriesOpen={
                        work.seriesTitleId || seriesCodeForWork(circle.series, work.primaryCode)
                          ? () =>
                              openCircleSeriesRoute(
                                circle.externalId,
                                work.seriesTitleId || seriesCodeForWork(circle.series, work.primaryCode),
                              )
                          : undefined
                      }
                    />
                  </div>
                ))
              ) : (
                <Card>
                  <CardContent className="p-5 text-sm text-muted-foreground">
                    {t("creatorBrowse.noCatalogWorks")}
                  </CardContent>
                </Card>
              )}
            </div>
            <WorkCollectionPagination
              placement="bottom"
              page={currentWorkPage}
              pageSize={workPageSize}
              totalItems={circle.worksMeta.total}
              totalPages={totalWorkPages}
              onPageChange={changeWorkPage}
            />
          </>
        )}
      </section>
      {deleteTarget && (
        <CatalogDeleteConfirmModal
          work={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => void deleteCatalogWork()}
        />
      )}
      <CreatorWorkFetchConfirm selection={selection} />
      {coverDialogOpen && (
        <CreatorCoverDialog
          name={circle.displayName}
          cover={circle.cover ?? null}
          latestWork={circle.latestWork}
          loadWorks={loadCoverWorks}
          onSelect={saveCircleCover}
          onClose={() => setCoverDialogOpen(false)}
        />
      )}
      <LazyRemoteFetchWorkspaceDialog workspace={fetchWorkspace} />
      <BrowseLoadingIndicator refreshing={isLoading || queueingRefresh} label={t("creatorBrowse.loadingCircles")} />
    </div>
  );
}

function circleReturnLabel() {
  const state = window.history.state as { returnTo?: unknown; returnLabel?: unknown } | null;
  if (typeof state?.returnTo === "string") return circleReturnLabelForLocation(state.returnTo);
  return "Back to circles";
}

function navigateToCirclesList(storageScope: string) {
  navigateToHistoryReturn({
    fallbackLocation: readLastCircleListLocation(storageScope) ?? "/circles",
  });
}
