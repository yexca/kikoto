import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  FileAudio,
  GitFork,
  HardDriveDownload,
  Heart,
  ListChecks,
  Loader2,
  RefreshCw,
  Rss,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { MobileSheet } from "@/components/ui/mobile-sheet";
import { toastFromError, useToast } from "@/components/ui/toast";
import { Dialog, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input, NativeSelect } from "@/components/ui/input";
import { UserTagRow } from "@/components/UserTagRow";
import { BrowseLoadingIndicator } from "@/components/collection/BrowseLoadingIndicator";
import { CollectionPagination } from "@/components/collection/CollectionPagination";
import {
  CreatorCard,
  CreatorCollectionSkeleton,
  creatorCardMinHeightClassName,
  creatorCollectionClassName,
} from "@/components/creator/CreatorCard";
import { CatalogSyncBadge } from "@/components/creator/CatalogSyncBadge";
import { CreatorActionMenu } from "@/components/creator/CreatorActionMenu";
import { CreatorDetailHeader } from "@/components/creator/CreatorDetailHeader";
import { CreatorListToolbar } from "@/components/creator/CreatorListToolbar";
import { CatalogWorkToolbar } from "@/components/creator/CatalogWorkToolbar";
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
import { circleSourceBadges } from "@/components/work-card/sourceBadges";
import {
  WorkCollectionLayoutPicker,
  workCollectionClassName,
  workCollectionStyle,
  useWorkCollectionLayout,
} from "@/components/work-collection/WorkCollectionLayout";
import { WorkCollectionPagination } from "@/components/work-collection/WorkCollectionPagination";
import { WorkSelectionAction, WorkSelectionBar } from "@/components/work-collection/WorkSelectionBar";
import { RemoteFetchWorkspaceDialog } from "@/features/work-detail/workflows/RemoteFetchWorkspaceDialog";
import { useRemoteFetchWorkspace } from "@/features/work-detail/workflows/useRemoteFetchWorkspace";
import { openWorkflowPath, workflowActivityRunPath, workflowRunFormPath } from "@/features/workflows/workflowLinks";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import { useStableCallback } from "@/hooks/useStableCallback";
import {
  api,
  ApiError,
  assetURL,
  type CircleCatalogWork,
  type CircleDetail,
  type CreatorRefreshRequest,
  type CircleSeries,
  type CircleSourceStat,
  type CircleSummary,
  type ListeningStatus,
} from "@/lib/api";
import {
  NAVIGATION_EVENT,
  currentInternalLocation,
  historyStateWithReturn,
  navigateToWorkspaceUp,
  normalizeInternalLocation,
} from "@/lib/browserHistory";
import { currentClientStorageScope } from "@/lib/clientStorageScope";
import { dismissKeyboardOnEnter } from "@/lib/keyboard";
import { coalesceRuns } from "@/lib/inflightRequests";
import { DLSITE_ENDPOINTS } from "@/lib/official-links";
import { hasPlaybackHistory } from "@/lib/playbackHistory";
import { useAuth } from "@/auth/AuthProvider";
import { usePermissionGate } from "@/auth/usePermissionGate";
import { NotFoundPage } from "@/app/NotFoundPage";
import { usePageHeaderBack } from "@/app/pageHeader";
import { openWorkDetail, type WorkDetailIntent } from "@/app/workDetailNavigation";
import {
  announceRemoteTrackCreated,
  isMatchingRemoteTrack,
  REMOTE_TRACK_TERMINAL_EVENT,
  type RemoteTrackTerminalDetail,
} from "@/app/remoteTrackWorkflows";
import {
  circleReturnLabelForLocation,
  currentCircleReturnPath,
  openCircleRoute,
  openCircleSeriesRoute,
  isCircleListLocation,
  readLastCircleListLocation,
  writeLastCircleListLocation,
} from "@/pages/circleNavigationState";
import { CircleCatalogOptionsSheet, type CircleAvailabilityFilter } from "@/pages/CircleDetailSheets";
import { circleRefreshSettledMessage, useCircleRefreshRun } from "@/pages/circleRefreshRun";
import { creatorBrowseSearch, creatorBrowseStateFromSearch } from "@/pages/creatorBrowseState";

const circlePageSizeOptions = [24, 48, 96] as const;
const catalogWorkPageSizeOptions = [24, 48] as const;
type CatalogWorkPageSize = (typeof catalogWorkPageSizeOptions)[number];
function circleAvailabilityOptions(t: TFunction): readonly { value: CircleAvailabilityFilter; label: string }[] {
  return [
    { value: "all", label: t("detailActions.allWorks") },
    { value: "available", label: t("content.available") },
    { value: "unavailable", label: t("detailActions.unavailable") },
    { value: "local", label: t("detailActions.local") },
    { value: "remote", label: t("detailActions.remote") },
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
type CircleFilter =
  "all" | "favorite" | "tagged" | "available" | "local" | "remote" | "missing" | "attention" | "stale";
const circleFilterOptions: readonly { value: CircleFilter; label: string }[] = [
  { value: "all", label: "All circles" },
  { value: "favorite", label: "Favorite" },
  { value: "tagged", label: "Tagged" },
  { value: "available", label: "Available" },
  { value: "local", label: "Local" },
  { value: "remote", label: "Remote" },
  { value: "missing", label: "Missing" },
  { value: "attention", label: "Attention" },
];
const circleFilters: readonly CircleFilter[] = [...circleFilterOptions.map((option) => option.value), "stale"];

export function CirclesPage({ active = true }: { active?: boolean }) {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    if (!active) return;
    const syncPath = () => {
      if (!isCircleWorkspaceLocation(currentInternalLocation())) return;
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
  const route = circleRouteFromPath(path);
  if (route) {
    return <CircleDetailPage externalId={route.externalId} seriesCode={route.seriesCode} active={active} />;
  }
  return <CircleListPage active={active} />;
}

const CircleCard = memo(function CircleCard({
  circle,
  onFavoriteToggle,
  onTagsSave,
}: {
  circle: CircleSummary;
  onFavoriteToggle: (circle: CircleSummary) => Promise<void>;
  onTagsSave: (circle: CircleSummary, tags: string[]) => Promise<void>;
}) {
  return (
    <CreatorCard
      name={circle.displayName}
      identityLabel={circle.externalId}
      aliases={circle.aliases}
      showAliases={false}
      latestWork={circle.latestWork}
      favorite={circle.favorite}
      userTags={circle.userTags}
      syncState={circle.syncState}
      workCount={circle.catalogWorks}
      availabilitySummary={{ available: circle.playableWorks, total: circle.catalogWorks }}
      unavailableCount={circle.missingWorks}
      sources={circle.sourceSummaries}
      onOpen={() => openCircleRoute(circle.externalId)}
      onFavoriteToggle={() => void onFavoriteToggle(circle)}
      onTagsSave={(tags) => onTagsSave(circle, tags)}
      tagScope="circle"
    />
  );
});

function CircleListPage({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const auth = useAuth();
  const toast = useToast();
  const storageScope = currentClientStorageScope(auth.user?.id ?? null);
  const initialBrowseState = useMemo(
    () =>
      creatorBrowseStateFromSearch(
        window.location.search,
        { query: "", filter: "all" as CircleFilter, tag: "", page: 1, pageSize: 24 },
        circleFilters,
        circlePageSizeOptions,
      ),
    [],
  );
  const [circles, setCircles] = useState<CircleSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState(initialBrowseState.query);
  const [requestQuery, setRequestQuery] = useState(initialBrowseState.query);
  const [filter, setFilter] = useState<CircleFilter>(initialBrowseState.filter);
  const [page, setPage] = useState(initialBrowseState.page);
  const [pageSize, setPageSize] = useState(initialBrowseState.pageSize);
  const [total, setTotal] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);
  const loadedRequestKey = useRef("");
  const localizedFilterOptions = circleFilterOptions.map((option) => ({
    ...option,
    label:
      option.value === "all"
        ? t("creatorBrowse.allCircles")
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
                  : option.value === "missing"
                    ? t("detailActions.missing")
                    : t("sync.attention"),
  }));

  useEffect(() => {
    const timer = window.setTimeout(() => setRequestQuery(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!active || !isCircleListLocation(currentInternalLocation())) return;
    const search = creatorBrowseSearch({ query, filter, tag: "", page, pageSize });
    const location = `/circles${search}`;
    window.history.replaceState(window.history.state ?? {}, "", location);
    writeLastCircleListLocation(storageScope, location);
  }, [active, filter, page, pageSize, query, storageScope]);

  useEffect(() => {
    if (!active) return;
    const requestKey = JSON.stringify([page, pageSize, requestQuery, filter, reloadToken]);
    if (loadedRequestKey.current === requestKey) return;
    const controller = new AbortController();
    setIsLoading(true);
    setLoadError("");
    api
      .listCircles({ page, pageSize, query: requestQuery, filter, signal: controller.signal })
      .then((result) => {
        loadedRequestKey.current = requestKey;
        setCircles(result.circles);
        setTotal(result.total);
        setHasLoaded(true);
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
  const changeFilter = (value: CircleFilter) => {
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
    itemLabel: t("creatorBrowse.circles"),
    ariaLabel: t("creatorBrowse.circlePages"),
    compactMobile: true,
    compactTop: true,
    refreshing: isLoading && hasLoaded,
    refreshingLabel: t("creatorBrowse.refreshingCircles"),
    onPageChange: setPage,
  };

  const updateCircle = (next: CircleSummary) => {
    setCircles((items) => items.map((item) => (item.externalId === next.externalId ? { ...item, ...next } : item)));
    if (filter !== "all" || requestQuery.trim()) setReloadToken((value) => value + 1);
  };

  const toggleFavorite = async (circle: CircleSummary) => {
    try {
      updateCircle({
        ...circle,
        ...(await api.updateCircleUserState(circle.externalId, { favorite: !circle.favorite })),
      });
    } catch (error) {
      toast.notify(toastFromError(error, t("creatorBrowse.favoriteUpdateFailed")));
    }
  };

  const saveTags = async (circle: CircleSummary, tags: string[]) => {
    try {
      const result = await api.setCircleUserTags(circle.externalId, tags);
      updateCircle({ ...circle, userTags: result.userTags });
    } catch (error) {
      toast.notify(toastFromError(error, t("creatorBrowse.tagsUpdateFailed")));
    }
  };
  const toggleCardFavorite = useStableCallback(toggleFavorite);
  const saveCardTags = useStableCallback(saveTags);

  return (
    <div className="relative space-y-5">
      <section className="space-y-3">
        <CreatorListToolbar
          label={t("creatorBrowse.circles")}
          query={query}
          placeholder={t("creatorBrowse.searchCircles")}
          filter={filter}
          defaultFilter="all"
          filterOptions={localizedFilterOptions}
          pageSize={pageSize}
          pageSizeOptions={circlePageSizeOptions}
          onQueryChange={setQuery}
          onFilterChange={changeFilter}
          onPageSizeChange={changePageSize}
        />
        <CollectionPagination {...paginationProps} placement="top" />

        {isLoading && !hasLoaded ? (
          <CreatorCollectionSkeleton label={t("creatorBrowse.loadingCircles")} />
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
            aria-label={t("creatorBrowse.circleResults")}
            aria-busy={isLoading}
          >
            {circles.length > 0 ? (
              circles.map((circle) => (
                <CircleCard
                  key={circle.externalId}
                  circle={circle}
                  onFavoriteToggle={toggleCardFavorite}
                  onTagsSave={saveCardTags}
                />
              ))
            ) : (
              <Card className={creatorCardMinHeightClassName}>
                <CardContent
                  className={`grid ${creatorCardMinHeightClassName} place-items-center p-5 text-sm text-muted-foreground`}
                >
                  {t("creatorBrowse.noCircles")}
                </CardContent>
              </Card>
            )}
          </div>
        )}
        <CollectionPagination {...paginationProps} placement="bottom" />
      </section>
      <BrowseLoadingIndicator refreshing={isLoading && hasLoaded} label={t("creatorBrowse.refreshingCircles")} />
    </div>
  );
}
function CircleDetailPage({
  externalId,
  seriesCode,
  active,
}: {
  externalId: string;
  seriesCode?: string | null;
  active: boolean;
}) {
  const { t } = useTranslation();
  const auth = useAuth();
  const toast = useToast();
  const requireDownloadsManage = usePermissionGate("downloads:manage");
  const canRefreshCatalog = auth.hasPermission("metadata:sync") && !auth.demoMode;
  const compactLayout = useMobileNavigationLayout();
  const [detail, setDetail] = useState<CircleDetail | null>(null);
  // "missing" means the maker id is not in this site's database, which a
  // metadata:sync user may fetch; "hidden" is a known circle this page does not show.
  const [notFound, setNotFound] = useState<"missing" | "hidden" | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [queueingRefresh, setQueueingRefresh] = useState(false);
  const { mobileColumns, desktopColumns, setMobileColumns, setDesktopColumns } = useWorkCollectionLayout();
  const [deleteTarget, setDeleteTarget] = useState<CircleCatalogWork | null>(null);
  const [selectedWorkCodes, setSelectedWorkCodes] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [isBulkSaving, setIsBulkSaving] = useState(false);
  const [saveConfirm, setSaveConfirm] = useState<{ count: number; run: () => Promise<void> } | null>(null);
  const [catalogOptionsOpen, setCatalogOptionsOpen] = useState(false);
  const fetchWorkspace = useRemoteFetchWorkspace({
    onWorksChanged: async () => setDetail(await api.getCircle(externalId)),
  });
  const [workQuery, setWorkQuery] = useState("");
  const [availabilityFilter, setAvailabilityFilter] = useState<CircleAvailabilityFilter>("all");
  const [workPage, setWorkPage] = useState(1);
  const [workPageSize, setWorkPageSize] = useState<CatalogWorkPageSize>(24);
  const loadedExternalID = useRef("");

  const loadCircleDetail = useCallback(
    async (showLoading = false, signal?: AbortSignal) => {
      if (!active) return null;
      if (showLoading) {
        setIsLoading(true);
      }
      try {
        const next = await api.getCircle(externalId, signal);
        if (signal?.aborted) return null;
        loadedExternalID.current = externalId;
        setDetail(next);
        setNotFound(null);
        return next;
      } catch (error) {
        if (signal?.aborted) return null;
        setDetail(null);
        if (error instanceof ApiError && error.status === 404) {
          setNotFound(error.code === "circle_not_in_database" ? "missing" : "hidden");
          return null;
        }
        toast.notify(toastFromError(error, t("errors.unavailable")));
        return null;
      } finally {
        if (showLoading) {
          setIsLoading(false);
        }
      }
    },
    [active, externalId, t],
  );

  // Track completions can arrive in bursts; each one only needs the circle's
  // recomputed aggregates once, so collapse them into serialized reloads that
  // keep the known circle on failure.
  const reloadAfterTrack = useMemo(
    () =>
      coalesceRuns(async () => {
        try {
          const next = await api.getCircle(externalId);
          if (loadedExternalID.current === externalId) setDetail(next);
        } catch (error) {
          if (loadedExternalID.current === externalId) {
            toast.notify(toastFromError(error, t("errors.unavailable")));
          }
        }
      }),
    [externalId, t, toast],
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
    if (!active || loadedExternalID.current === externalId) return;
    const controller = new AbortController();
    void loadCircleDetail(true, controller.signal);
    return () => controller.abort();
  }, [active, externalId, loadCircleDetail]);

  const circle = detail ?? emptyCircleDetail(externalId);
  const filteredWorks = useMemo(() => {
    const needle = workQuery.trim().toLowerCase();
    return circle.works.filter((work) => {
      const matchesQuery =
        !needle ||
        [work.primaryCode, work.title, work.releaseDate ?? "", work.catalogStatus].some((value) =>
          value.toLowerCase().includes(needle),
        );
      if (!matchesQuery) return false;
      switch (availabilityFilter) {
        case "available":
          return work.local || work.remote;
        case "unavailable":
          return !work.local && !work.remote;
        case "local":
          return work.local;
        case "remote":
          return work.remote;
        default:
          return true;
      }
    });
  }, [availabilityFilter, circle.works, workQuery]);
  const catalogOnlyCount = circle.works.filter((work) => work.catalogStatus !== "imported").length;
  const availableWorkCount = circle.availableWorks ?? circle.works.filter((work) => work.local || work.remote).length;
  const totalWorkPages = Math.max(1, Math.ceil(filteredWorks.length / workPageSize));
  const currentWorkPage = Math.min(workPage, totalWorkPages);
  const pagedWorks = filteredWorks.slice((currentWorkPage - 1) * workPageSize, currentWorkPage * workPageSize);
  const selectablePagedWorks = pagedWorks.filter(isCircleBulkSaveSelectable);
  const selectedWorks = circle.works.filter((work) => selectedWorkCodes.has(work.primaryCode));
  const selectedForkableWorks = selectedWorks.filter((work) => work.workId === null);
  const circleListStorageScope = currentClientStorageScope(auth.user?.id ?? null);
  const navigateToList = () => navigateToCirclesList(circleListStorageScope, compactLayout);
  usePageHeaderBack({
    label: compactLayout ? t("creatorBrowse.backToCircles") : circleReturnLabel(),
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
  const changeWorkPageSize = (value: number) => {
    setWorkPageSize(value as CatalogWorkPageSize);
    setWorkPage(1);
  };

  useEffect(() => {
    setWorkPage(1);
  }, [availabilityFilter, externalId, workPageSize, workQuery]);

  useEffect(() => {
    setSelectedWorkCodes(
      (current) =>
        new Set(Array.from(current).filter((code) => filteredWorks.some((work) => work.primaryCode === code))),
    );
  }, [filteredWorks]);
  const selectedSeries = useMemo(() => {
    const code = seriesCode?.toUpperCase() ?? "";
    return code ? (circle.series.find((series) => series.titleId.toUpperCase() === code) ?? null) : null;
  }, [circle.series, seriesCode]);
  const isSeriesView = seriesCode !== undefined;
  const seriesWorks = useMemo(() => {
    if (!isSeriesView) return [];
    const codes = new Set((selectedSeries?.workCodes ?? []).map((code) => code.toUpperCase()));
    const base = selectedSeries
      ? circle.works.filter((work) => codes.has(work.primaryCode.toUpperCase()))
      : circle.works;
    const needle = workQuery.trim().toLowerCase();
    return base.filter((work) => {
      const matchesQuery =
        !needle ||
        [work.primaryCode, work.title, work.releaseDate ?? "", work.catalogStatus].some((value) =>
          value.toLowerCase().includes(needle),
        );
      if (!matchesQuery) return false;
      switch (availabilityFilter) {
        case "available":
          return work.local || work.remote;
        case "unavailable":
          return !work.local && !work.remote;
        case "local":
          return work.local;
        case "remote":
          return work.remote;
        default:
          return true;
      }
    });
  }, [availabilityFilter, circle.works, isSeriesView, selectedSeries, workQuery]);
  const activeSeriesCount = selectedSeries
    ? selectedSeries.works
    : circle.series.reduce((total, series) => total + series.works, 0);

  const canOpenWorkflows = auth.hasPermission("workflows:run") && !auth.demoMode;
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

  // An unknown circle is fetched by the circle follow workflow, which adds it
  // on success; the run form opens with this maker id filled in.
  const canFetchMissingCircle = canRefreshCatalog && canOpenWorkflows;
  const openFollowCircle = () =>
    openWorkflowPath(
      workflowRunFormPath("circle_follow", { circleId: detail?.externalId ?? externalId.toUpperCase() }),
    );

  const firstPull = circle.syncState === "never";
  // First pull reads the whole catalog and fills its metadata; Refresh also
  // matches the circle's works on the remote sources.
  const runPrimaryRefresh = () =>
    void queueRefresh(
      firstPull
        ? { catalogRefresh: "full", metadataRefresh: "missing" }
        : { catalogRefresh: "incremental", metadataRefresh: "missing", sourceCheck: true },
    );
  const workflowMenuItems = canOpenWorkflows
    ? [
        {
          key: "follow",
          label: t("detailActions.followCircle"),
          icon: <Rss className="h-4 w-4" />,
          onSelect: openFollowCircle,
        },
      ]
    : [];

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
      const next = await api.getCircle(externalId);
      setDetail(next);
      setDeleteTarget(null);
    } catch (error) {
      toast.notify(toastFromError(error, t("creatorBrowse.deleteWorkFailed")));
    }
  };

  const updateCatalogWorkStatus = async (work: CircleCatalogWork, status: ListeningStatus) => {
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
    setIsBulkSaving(true);
    try {
      const syncResult = await api.syncRemoteSourceWork(target.sourceId, target.code, "circle_mark_interest");
      const markResult = await api.updateWorkUserState(syncResult.workId, { listeningStatus: status });
      toast.success(t("creatorBrowse.savedAndMarked", { code: syncResult.primaryCode }));
      const next = await api.getCircle(externalId);
      setDetail({
        ...next,
        works: next.works.map((item) =>
          item.primaryCode === work.primaryCode ? { ...item, listeningMark: markResult.listeningStatus } : item,
        ),
      });
    } catch (error) {
      toast.notify(toastFromError(error, t("creatorBrowse.markUpdateFailed")));
    } finally {
      setIsBulkSaving(false);
    }
  };

  const trackCatalogWorkForState = async (work: CircleCatalogWork, reason: string) => {
    const target = circleWorkRemoteTarget(work);
    if (!target) return null;
    const syncResult = await api.syncRemoteSourceWork(target.sourceId, target.code, reason);
    return syncResult.workId;
  };

  const ensureCatalogWorkForList = async (work: CircleCatalogWork) => {
    if (work.workId) return work.workId;
    try {
      const workId = await trackCatalogWorkForState(work, "circle_list");
      if (!workId) return null;
      const next = await api.getCircle(externalId);
      setDetail(next);
      return workId;
    } catch (error) {
      toast.notify(toastFromError(error, t("creatorBrowse.saveForListFailed")));
      return null;
    }
  };

  const toggleWorkSelection = (work: CircleCatalogWork, checked: boolean) => {
    setSelectedWorkCodes((current) => {
      const next = new Set(current);
      if (checked) next.add(work.primaryCode);
      else next.delete(work.primaryCode);
      return next;
    });
  };

  const toggleVisibleSelection = (checked: boolean) => {
    setSelectedWorkCodes((current) => {
      const next = new Set(current);
      selectablePagedWorks.forEach((work) => {
        if (checked) next.add(work.primaryCode);
        else next.delete(work.primaryCode);
      });
      return next;
    });
  };

  const bulkSaveSelected = async () => {
    if (selectedWorks.length === 0) return;
    if (!requireDownloadsManage()) return;
    setSaveConfirm({ count: selectedWorks.length, run: runBulkSaveSelected });
  };

  const runBulkSaveSelected = async () => {
    if (!requireDownloadsManage()) return;
    setIsBulkSaving(true);
    try {
      const results = await runCircleBulkBySource(selectedWorks, "fetch");
      const fetched = results.reduce((total, result) => total + result.fetched, 0);
      const failed = results.reduce((total, result) => total + result.failed, 0);
      const runIds = results.map((result) => `#${result.runId}`).join(", ");
      const message = t("creatorBrowse.bulkFetchSummary", { runIds, fetched, failed });
      if (failed > 0) toast.warning(message);
      else toast.success(message);
      const next = await api.getCircle(externalId);
      setDetail(next);
    } catch (error) {
      toast.notify(toastFromError(error, t("creatorBrowse.bulkFetchFailed")));
    } finally {
      setIsBulkSaving(false);
      setSaveConfirm(null);
    }
  };

  const bulkForkSelected = async () => {
    if (selectedForkableWorks.length === 0) return;
    setIsBulkSaving(true);
    try {
      const results = await runCircleBulkBySource(selectedForkableWorks, "track");
      const synced = results.reduce((total, result) => total + result.synced, 0);
      const failed = results.reduce((total, result) => total + result.failed, 0);
      const runIds = results.map((result) => `#${result.runId}`).join(", ");
      const message = t("creatorBrowse.bulkForkSummary", { runIds, synced, failed });
      if (failed > 0) toast.warning(message);
      else toast.success(message);
      const next = await api.getCircle(externalId);
      setDetail(next);
    } catch (error) {
      toast.notify(toastFromError(error, t("creatorBrowse.bulkForkFailed")));
    } finally {
      setIsBulkSaving(false);
    }
  };

  const runCircleBulkBySource = (works: CircleCatalogWork[], action: "fetch" | "track") => {
    const groups = new Map<number, string[]>();
    works.forEach((work) => {
      const target = circleWorkRemoteTarget(work);
      if (!target) return;
      groups.set(target.sourceId, [...(groups.get(target.sourceId) ?? []), target.code]);
    });
    return Promise.all(Array.from(groups, ([sourceId, codes]) => api.recordRemoteBulkRun({ action, sourceId, codes })));
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
    if (!target) return;
    setIsBulkSaving(true);
    try {
      const result = await api.trackRemoteSourceWork(target.sourceId, target.code, "circle_card_fork");
      announceRemoteTrackCreated(target.sourceId, target.code, result);
      toast.notify({
        kind: "info",
        message: result.deduplicated
          ? t("libraryDetail.forkAlreadyQueued", { runId: result.runId })
          : t("libraryDetail.forkQueued", { runId: result.runId }),
      });
    } catch (error) {
      toast.notify(toastFromError(error, t("libraryDetail.forkQueueFailed")));
    } finally {
      setIsBulkSaving(false);
    }
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
            <Button onClick={openFollowCircle}>
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
        coverUrl={circle.latestWork?.coverUrl}
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
        meta={
          <div className="mt-2.5 flex min-w-0 flex-wrap items-center gap-1.5">
            <Badge variant={availableWorkCount > 0 ? "success" : "warning"} className="tabular-nums">
              {t("detailActions.availableCount", { count: availableWorkCount })}
            </Badge>
            <UserTagRow tags={circle.userTags} scope="circle" onSave={saveCircleTags} className="min-w-0 flex-1" />
          </div>
        }
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
                <span>{firstPull ? t("detailActions.firstPull") : t("detailActions.refreshCircle")}</span>
              </Button>
            )}
            <CreatorActionMenu
              label={t("detailActions.moreCircleActions")}
              buttonLabel={t("detailActions.more")}
              items={workflowMenuItems}
            />
          </div>
        }
      />

      <section className="space-y-3">
        <CatalogWorkToolbar
          leading={
            <div className={segmentedListClassName("shrink-0")} role="group">
              <button
                className={segmentedItemClassName(!isSeriesView)}
                aria-pressed={!isSeriesView}
                onClick={() => openCircleRoute(circle.externalId)}
              >
                {t("detailActions.works")} {circle.works.length}
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
                {(workQuery.trim() || availabilityFilter !== "all" || selectionMode) && (
                  <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
                )}
              </Button>
            ) : undefined
          }
          onQueryChange={changeWorkQuery}
          filterLabel={t("detailActions.catalogAvailabilityFilter")}
          filter={availabilityFilter}
          defaultFilter="all"
          filterOptions={circleAvailabilityOptions(t)}
          onFilterChange={changeAvailabilityFilter}
          pageSize={isSeriesView ? undefined : workPageSize}
          pageSizeOptions={catalogWorkPageSizeOptions}
          onPageSizeChange={isSeriesView ? undefined : changeWorkPageSize}
          mobileColumns={mobileColumns}
          desktopColumns={desktopColumns}
          onMobileColumnsChange={setMobileColumns}
          onDesktopColumnsChange={setDesktopColumns}
          selectionMode={isSeriesView ? undefined : selectionMode}
          onSelectionModeChange={
            isSeriesView
              ? undefined
              : (value) => {
                  setSelectionMode(value);
                  if (!value) setSelectedWorkCodes(new Set());
                }
          }
        />

        {!isSeriesView && (
          <div>
            <WorkCollectionPagination
              placement="top"
              page={currentWorkPage}
              pageSize={workPageSize}
              totalItems={filteredWorks.length}
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
                  {(workQuery.trim() || availabilityFilter !== "all" || selectionMode) && (
                    <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-primary" aria-hidden="true" />
                  )}
                </Button>
              }
              onPageChange={setWorkPage}
            />
          </div>
        )}

        <CircleCatalogOptionsSheet
          open={catalogOptionsOpen}
          onClose={() => setCatalogOptionsOpen(false)}
          isSeriesView={isSeriesView}
          selectionMode={selectionMode}
          availabilityFilter={availabilityFilter}
          onAvailabilityFilterChange={changeAvailabilityFilter}
          query={workQuery}
          onQueryChange={changeWorkQuery}
          pageSize={workPageSize}
          pageSizeOptions={catalogWorkPageSizeOptions}
          onPageSizeChange={changeWorkPageSize}
          mobileColumns={mobileColumns}
          onMobileColumnsChange={setMobileColumns}
          onSelectWorks={() => {
            setCatalogOptionsOpen(false);
            setSelectionMode((value) => {
              if (value) setSelectedWorkCodes(new Set());
              return !value;
            });
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
                {selectedSeries?.url && (
                  <Button variant="outline" size="sm" asChild>
                    <a href={selectedSeries.url} target="_blank" rel="noreferrer">
                      <ExternalLink className="h-4 w-4" />
                      {t("creatorBrowse.dlsiteSeries")}
                    </a>
                  </Button>
                )}
              </div>
              {selectedSeries ? (
                <div className={workCollectionClassName()} style={workCollectionStyle(mobileColumns, desktopColumns)}>
                  {seriesWorks.length > 0 ? (
                    seriesWorks.map((work) => (
                      <div key={work.primaryCode}>
                        <CatalogWorkCard
                          work={work}
                          busy={isBulkSaving || fetchWorkspace.isBusy}
                          selected={selectedWorkCodes.has(work.primaryCode)}
                          selectable={isCircleBulkSaveSelectable(work)}
                          selectionActive={false}
                          onSelectedChange={(checked) => toggleWorkSelection(work, checked)}
                          onFork={() => void forkSingleWork(work)}
                          onSave={() => void saveSingleWork(work)}
                          onDeleteMissing={() => setDeleteTarget(work)}
                          onStatusChange={(status) => void updateCatalogWorkStatus(work, status)}
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
            {selectionMode && (
              <WorkSelectionBar
                selectedCount={selectedWorks.length}
                scopeSelectableCount={selectablePagedWorks.length}
                scopeSelectedCount={
                  selectablePagedWorks.filter((work) => selectedWorkCodes.has(work.primaryCode)).length
                }
                onSelectScope={() => toggleVisibleSelection(true)}
                onClear={() => setSelectedWorkCodes(new Set())}
                onExit={() => {
                  setSelectedWorkCodes(new Set());
                  setSelectionMode(false);
                }}
              >
                <WorkSelectionAction
                  icon={<GitFork className="h-4 w-4" />}
                  label={t("detailActions.fork")}
                  count={selectedForkableWorks.length}
                  disabled={isBulkSaving}
                  onClick={() => void bulkForkSelected()}
                />
                <WorkSelectionAction
                  icon={<HardDriveDownload className="h-4 w-4" />}
                  label={t("detailActions.fetch")}
                  count={selectedWorks.length}
                  disabled={isBulkSaving}
                  onClick={() => void bulkSaveSelected()}
                />
              </WorkSelectionBar>
            )}

            <div className={workCollectionClassName()} style={workCollectionStyle(mobileColumns, desktopColumns)}>
              {filteredWorks.length > 0 ? (
                pagedWorks.map((work) => (
                  <div key={work.primaryCode}>
                    <CatalogWorkCard
                      work={work}
                      busy={isBulkSaving || fetchWorkspace.isBusy}
                      selected={selectedWorkCodes.has(work.primaryCode)}
                      selectable={isCircleBulkSaveSelectable(work)}
                      selectionActive={selectionMode}
                      onSelectedChange={(checked) => toggleWorkSelection(work, checked)}
                      onFork={() => void forkSingleWork(work)}
                      onSave={() => void saveSingleWork(work)}
                      onDeleteMissing={() => setDeleteTarget(work)}
                      onStatusChange={(status) => void updateCatalogWorkStatus(work, status)}
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
              totalItems={filteredWorks.length}
              totalPages={totalWorkPages}
              onPageChange={setWorkPage}
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
      {saveConfirm && (
        <SaveConfirmModal
          count={saveConfirm.count}
          onClose={() => setSaveConfirm(null)}
          onConfirm={() => void saveConfirm.run()}
        />
      )}
      <RemoteFetchWorkspaceDialog workspace={fetchWorkspace} />
      <BrowseLoadingIndicator refreshing={isLoading || queueingRefresh} label={t("creatorBrowse.loadingCircles")} />
    </div>
  );
}

function CatalogWorkCard({
  work,
  busy,
  selected,
  selectable,
  selectionActive,
  onSelectedChange,
  onFork,
  onSave,
  onDeleteMissing,
  onStatusChange,
  onFavoriteSaved,
  onEnsureWork,
  onSeriesOpen,
}: {
  work: CircleCatalogWork;
  busy: boolean;
  selected: boolean;
  selectable: boolean;
  selectionActive: boolean;
  onSelectedChange: (checked: boolean) => void;
  onFork: () => void;
  onSave: () => void;
  onDeleteMissing: () => void;
  onStatusChange: (status: ListeningStatus) => void;
  onFavoriteSaved: (favorite: boolean) => void;
  onEnsureWork: () => Promise<number | null>;
  onSeriesOpen?: () => void;
}) {
  const { t } = useTranslation();
  const directoryTarget = preferredDirectoryTarget(work);
  const isUnavailable = !work.local && !work.remote;
  const view = catalogWorkCardView(work, t);

  const openTarget = () => {
    if (directoryTarget) openWorkDirectoryRoute(directoryTarget, work);
  };

  return (
    <WorkCardShell
      work={view}
      selection={
        selectionActive ? (
          <WorkCardSelection checked={selected} disabled={!selectable} onChange={onSelectedChange} />
        ) : undefined
      }
      canOpen={Boolean(directoryTarget)}
      onOpen={openTarget}
      onCircleOpen={(externalId) => openCircleRoute(externalId)}
      onSeriesOpen={work.series ? onSeriesOpen : undefined}
      footer={
        <WorkCardFooter
          left={<WorkCardDLsiteAction href={work.dlsiteUrl || dlsiteWorkURL(work.primaryCode)} />}
          right={
            <>
              <WorkCardActionButton
                title={t("detailActions.fork")}
                disabled={busy || !circleWorkRemoteTarget(work)}
                onClick={(event) => {
                  event.stopPropagation();
                  onFork();
                }}
              >
                <GitFork className="h-4 w-4" />
              </WorkCardActionButton>
              <WorkCardActionButton
                title={t("detailActions.fetch")}
                disabled={busy || !circleWorkRemoteTarget(work)}
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
                disabled={!circleWorkRemoteTarget(work) && !work.workId}
                ensureWorkId={onEnsureWork}
                onSaved={onFavoriteSaved}
              />
              <WorkCardQuickMarkButton
                value={normalizeListeningStatus(work.listeningMark)}
                disabled={isUnavailable && !circleWorkRemoteTarget(work)}
                onChange={onStatusChange}
              />
              {!work.dlsiteAvailable && (
                <WorkCardActionButton
                  title={t("detailActions.deleteMissingCatalogItem")}
                  onClick={(event) => {
                    event.stopPropagation();
                    onDeleteMissing();
                  }}
                >
                  <CircleAlert className="h-4 w-4" />
                </WorkCardActionButton>
              )}
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

function CatalogDeleteConfirmModal({
  work,
  onClose,
  onConfirm,
}: {
  work: CircleCatalogWork;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog onClose={onClose} size="md" role="alertdialog">
      <DialogHeader
        title={t("detailActions.removeCatalogWork")}
        description={t("detailActions.removeCatalogWorkDescription", { code: work.primaryCode })}
      />
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>
          {t("content.cancel")}
        </Button>
        <Button variant="destructive" size="sm" onClick={onConfirm}>
          {t("admin.delete")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function catalogWorkCardView(work: CircleCatalogWork, t: TFunction): WorkCardViewModel {
  const sourceBadges = circleSourceBadges({ local: work.local, remote: work.remote, sourceTags: work.sourceTags });
  const statusBadges = [
    ...(work.catalogStatus !== "imported"
      ? [{ key: `catalog:${work.catalogStatus}`, label: work.catalogStatus, variant: "outline" as const }]
      : []),
    ...(!work.dlsiteAvailable
      ? [{ key: "dlsite:missing", label: t("workCard.dlsiteMissing"), variant: "warning" as const }]
      : []),
    ...sourceBadges,
  ];
  return {
    code: work.primaryCode,
    title: work.title,
    circle: work.circle || t("workCard.unknownCircle"),
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
    userTags: userTagBadges(work.userTags ?? []),
    sourceBadges: statusBadges,
  };
}

function seriesCodeForWork(series: CircleSeries[], workCode: string) {
  const normalizedCode = workCode.toUpperCase();
  return series.find((item) => item.workCodes.some((code) => code.toUpperCase() === normalizedCode))?.titleId ?? null;
}

function WorkProgressLine({ progress }: { progress: NonNullable<CircleCatalogWork["progress"]> }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1">
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${workProgressPercent(progress)}%` }} />
      </div>
      <div className="truncate text-xs text-muted-foreground">
        {progress.completed
          ? t("library.status.finished")
          : t("library.resumeAt", {
              title: progress.title || t("player.track"),
              time: formatTime(progress.positionSeconds),
            })}
      </div>
    </div>
  );
}

function emptyCircleDetail(externalId: string): CircleDetail {
  return {
    id: 0,
    externalId,
    displayName: externalId,
    aliases: [],
    rating: null,
    note: "",
    favorite: false,
    userTags: [],
    localWorks: 0,
    playableWorks: 0,
    remoteWorks: 0,
    missingWorks: 0,
    catalogWorks: 0,
    lastSyncedAt: null,
    syncState: "never",
    syncReason: "never",
    sourceSummaries: [],
    latestWork: null,
    availableWorks: 0,
    works: [],
    series: [],
  };
}

function CircleSeriesSidebar({
  externalId,
  series,
  selectedSeriesCode,
  allCount,
}: {
  externalId: string;
  series: CircleSeries[];
  selectedSeriesCode: string | null;
  allCount: number;
}) {
  return (
    <aside className="hidden self-start rounded-lg border bg-card p-1.5 lg:sticky lg:top-4 lg:block">
      <CircleSeriesOptions
        series={series}
        selectedSeriesCode={selectedSeriesCode}
        allCount={allCount}
        onSelect={openCircleSeriesRoute.bind(null, externalId)}
      />
    </aside>
  );
}

function MobileCircleSeriesHeader({
  externalId,
  series,
  selectedSeries,
  selectedSeriesCode,
  allCount,
}: {
  externalId: string;
  series: CircleSeries[];
  selectedSeries: CircleSeries | null;
  selectedSeriesCode: string | null;
  allCount: number;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const selectedName = selectedSeries?.name ?? t("detailActions.allSeries");
  const selectedCount = selectedSeries?.works ?? allCount;
  const selectSeries = (titleId?: string) => {
    setOpen(false);
    openCircleSeriesRoute(externalId, titleId);
  };
  return (
    <div className="flex min-h-12 items-center gap-1 rounded-lg border bg-card px-3 lg:hidden">
      <button
        className="flex min-w-0 flex-1 items-center justify-between gap-3 self-stretch text-left text-sm"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("detailActions.series")}
        onClick={() => setOpen(true)}
      >
        <span className="min-w-0 truncate font-semibold">{selectedName}</span>
        <span className="shrink-0 text-muted-foreground">{selectedCount}</span>
      </button>
      {selectedSeries?.url && (
        <Button variant="ghost" size="icon" className="shrink-0" asChild>
          <a
            href={selectedSeries.url}
            target="_blank"
            rel="noreferrer"
            aria-label={t("detailActions.openDlsite")}
            title={t("detailActions.openDlsite")}
          >
            <ExternalLink className="h-4 w-4" />
          </a>
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="shrink-0"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("detailActions.series")}
        title={t("detailActions.series")}
        onClick={() => setOpen(true)}
      >
        <ChevronDown className="h-4 w-4" />
      </Button>
      <MobileSheet open={open} onOpenChange={setOpen} ariaLabel={t("detailActions.series")} className="p-4">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold">{t("detailActions.series")}</h2>
          <Button variant="ghost" size="icon" aria-label={t("content.close")} onClick={() => setOpen(false)}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="mt-4 space-y-1">
          <CircleSeriesOptions
            series={series}
            selectedSeriesCode={selectedSeriesCode}
            allCount={allCount}
            onSelect={selectSeries}
          />
        </div>
      </MobileSheet>
    </div>
  );
}

function CircleSeriesOptions({
  series,
  selectedSeriesCode,
  allCount,
  onSelect,
}: {
  series: CircleSeries[];
  selectedSeriesCode: string | null;
  allCount: number;
  onSelect: (titleId?: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <button
        className={`flex min-h-12 w-full items-center justify-between gap-3 rounded-md px-3 text-left text-sm transition-colors hover:bg-muted ${selectedSeriesCode === null ? "bg-primary/10 text-primary hover:bg-primary/15" : ""}`}
        onClick={() => onSelect()}
      >
        <span className="min-w-0 truncate font-medium">{t("detailActions.allSeries")}</span>
        <span className={`tabular-nums ${selectedSeriesCode === null ? "text-primary/80" : "text-muted-foreground"}`}>
          {allCount}
        </span>
      </button>
      <div className="mt-2 space-y-1">
        {series.length > 0 ? (
          series.map((item) => {
            const selected = selectedSeriesCode === item.titleId;
            return (
              <button
                key={item.titleId}
                className={`grid min-h-14 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md px-3 text-left text-sm transition-colors hover:bg-muted ${selected ? "bg-primary/10 text-primary hover:bg-primary/15" : ""}`}
                onClick={() => onSelect(item.titleId)}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{item.name}</span>
                  <span
                    className={
                      selected
                        ? "block truncate font-mono text-xs text-primary/75"
                        : "block truncate font-mono text-xs text-muted-foreground"
                    }
                  >
                    {item.titleId}
                  </span>
                </span>
                <span className={`tabular-nums ${selected ? "text-primary/80" : "text-muted-foreground"}`}>
                  {item.works}
                </span>
              </button>
            );
          })
        ) : (
          <div className="px-3 py-2 text-sm text-muted-foreground">{t("detailActions.noSeries")}</div>
        )}
      </div>
    </>
  );
}

function CircleSeriesSummaryCard({ externalId, series }: { externalId: string; series: CircleSeries }) {
  const { t } = useTranslation();
  const stats = [
    { key: "works", value: series.works, label: t("detailActions.works"), className: "text-foreground" },
    { key: "local", value: series.localWorks, label: t("detailActions.local"), className: "" },
    { key: "remote", value: series.remoteWorks, label: t("detailActions.remote"), className: "" },
    {
      key: "missing",
      value: series.missingWorks,
      label: t("detailActions.missing"),
      className: series.missingWorks > 0 ? "text-warning-foreground" : "",
    },
  ];
  return (
    <Card className="h-full transition-colors hover:border-primary/40">
      <CardContent className="flex h-full flex-col gap-3 p-4">
        <button
          className="group block w-full rounded-sm text-left"
          onClick={() => openCircleSeriesRoute(externalId, series.titleId)}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="line-clamp-2 text-[0.95rem] font-semibold leading-snug">{series.name}</h3>
              <div className="mt-1 font-mono text-xs tracking-tight text-muted-foreground">{series.titleId}</div>
            </div>
            <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
          </div>
        </button>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {stats.map((stat) => (
            <span key={stat.key} className="flex items-baseline gap-1">
              <span className={`text-sm font-semibold tabular-nums ${stat.className || "text-foreground"}`}>
                {stat.value}
              </span>
              <span className={stat.className}>{stat.label}</span>
            </span>
          ))}
        </div>
        <div className="mt-auto flex flex-wrap gap-1">
          {series.workCodes.slice(0, 8).map((code) => (
            <Badge key={code} variant="outline" className="font-mono text-2xs font-normal text-muted-foreground">
              {code}
            </Badge>
          ))}
          {series.workCodes.length > 8 && (
            <Badge variant="secondary" className="text-2xs">
              +{series.workCodes.length - 8}
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
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

function normalizeListeningStatus(status: string): ListeningStatus {
  return listeningStatusOptions.some((option) => option.value === status) ? (status as ListeningStatus) : "none";
}

function listeningStatusLabel(status: string, t?: TFunction) {
  return t
    ? t(`library.status.${normalizeListeningStatus(status)}`)
    : (listeningStatusOptions.find((option) => option.value === normalizeListeningStatus(status))?.label ?? "Unmarked");
}

function availableSourceTags(sources: CircleSourceStat[] | null | undefined) {
  const seen = new Set<string>();
  return (sources ?? []).filter((source) => {
    if (source.status !== "available" && source.count <= 0) return false;
    if (source.key === "cache") return false;
    const key = source.key;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function preferredDirectoryTarget(work: CircleCatalogWork) {
  const tags = availableSourceTags(work.sourceTags);
  const local = tags.find((tag) => tag.key === "local");
  if (local && work.workId !== null) {
    return { kind: "known", canonicalCode: work.primaryCode } satisfies WorkDetailIntent;
  }
  const remote = tags.find((tag) => tag.sourceId !== undefined && tag.sourceId !== null);
  if (remote?.sourceId) {
    const remoteCode = work.remoteCode || work.primaryCode;
    return work.workId !== null
      ? ({
          kind: "known",
          canonicalCode: work.primaryCode,
          source: { sourceId: remote.sourceId, remoteCode },
        } satisfies WorkDetailIntent)
      : ({ kind: "remote-only", sourceId: remote.sourceId, remoteCode } satisfies WorkDetailIntent);
  }
  if (work.workId !== null) {
    return { kind: "known", canonicalCode: work.primaryCode } satisfies WorkDetailIntent;
  }
  return null;
}

function isCircleBulkSaveSelectable(work: CircleCatalogWork) {
  if (work.local) return false;
  return circleWorkRemoteTarget(work) !== null;
}

function circleWorkRemoteTarget(
  work: CircleCatalogWork,
): { sourceId: number; code: string; sourceDisplayName: string } | null {
  const remote = availableSourceTags(work.sourceTags).find(
    (tag) => tag.sourceId !== undefined && tag.sourceId !== null,
  );
  return remote?.sourceId
    ? { sourceId: remote.sourceId, code: work.remoteCode || work.primaryCode, sourceDisplayName: remote.displayName }
    : null;
}

function openWorkDirectoryRoute(target: WorkDetailIntent, work: CircleCatalogWork) {
  openWorkDetail(target, { returnTo: currentCircleReturnPath(), returnLabel: "Back to circle", workPreview: work });
}

function circleReturnLabel() {
  const state = window.history.state as { returnTo?: unknown; returnLabel?: unknown } | null;
  if (typeof state?.returnTo === "string") return circleReturnLabelForLocation(state.returnTo);
  return "Back to circles";
}

function dlsiteMakerURL(externalId: string) {
  const site = externalId.toUpperCase().startsWith("VG") ? "pro" : "maniax";
  return DLSITE_ENDPOINTS.makerURL(site, externalId);
}

function dlsiteWorkURL(code: string) {
  const site = code.toUpperCase().startsWith("VJ") ? "pro" : "maniax";
  return DLSITE_ENDPOINTS.workURL(site, code);
}

function formatTime(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function workProgressPercent(progress: NonNullable<CircleCatalogWork["progress"]>) {
  if (!progress.durationSeconds || progress.durationSeconds <= 0) return 0;
  return Math.min(100, Math.max(0, (progress.positionSeconds / progress.durationSeconds) * 100));
}

function circleRouteFromPath(path: string) {
  const match = path.match(/^\/circles\/([^/]+)(?:\/(series)(?:\/([^/]+))?)?\/?$/i);
  if (!match) return null;
  return {
    externalId: safeDecodePathSegment(match[1]),
    seriesCode: match[3] ? safeDecodePathSegment(match[3]) : match[2] ? null : undefined,
  };
}

function isCircleWorkspaceLocation(location: string) {
  const normalized = normalizeInternalLocation(location);
  if (!normalized) return false;
  if (isCircleListLocation(normalized)) return true;
  try {
    return circleRouteFromPath(new URL(normalized, "https://kikoto.invalid").pathname) !== null;
  } catch {
    return false;
  }
}

function navigateToCirclesList(storageScope: string, mobile: boolean) {
  navigateToWorkspaceUp({
    mobile,
    fallbackLocation: readLastCircleListLocation(storageScope) ?? "/circles",
    isWorkspaceListLocation: isCircleListLocation,
  });
}

function safeDecodePathSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
