import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  FileAudio,
  GitBranchPlus,
  HardDriveDownload,
  Heart,
  ListChecks,
  RefreshCw,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  workCollectionItemClassName,
  workCollectionStyle,
  useWorkCollectionLayout,
} from "@/components/work-collection/WorkCollectionLayout";
import { RemoteFetchWorkspaceDialog } from "@/features/work-detail/workflows/RemoteFetchWorkspaceDialog";
import { useRemoteFetchWorkspace } from "@/features/work-detail/workflows/useRemoteFetchWorkspace";
import {
  api,
  ApiError,
  assetURL,
  type CircleCatalogWork,
  type CircleDetail,
  type CircleSeries,
  type CircleSourceStat,
  type CircleSummary,
  type ListeningStatus,
} from "@/lib/api";
import { NAVIGATION_EVENT, historyStateWithReturn, navigateToHistoryReturn } from "@/lib/browserHistory";
import { dismissKeyboardOnEnter } from "@/lib/keyboard";
import { usePermissionGate } from "@/auth/usePermissionGate";
import { NotFoundPage } from "@/app/NotFoundPage";
import { openWorkDetail, type WorkDetailIntent } from "@/app/workDetailNavigation";
import {
  announceRemoteTrackCreated,
  isMatchingRemoteTrack,
  REMOTE_TRACK_TERMINAL_EVENT,
  type RemoteTrackTerminalDetail,
} from "@/app/remoteTrackWorkflows";
import { creatorBrowseSearch, creatorBrowseStateFromSearch } from "@/pages/creatorBrowseState";

const PLACEHOLDER_CIRCLE_ID = "RG012345";
const TRANSLATION_CIRCLE_ID = "RG60289";
const circlePageSizeOptions = [24, 48, 96] as const;
const catalogWorkPageSizeOptions = [24, 48] as const;
type CatalogWorkPageSize = (typeof catalogWorkPageSizeOptions)[number];
const listeningStatusOptions: { value: ListeningStatus; label: string }[] = [
  { value: "none", label: "Unmarked" },
  { value: "want_to_listen", label: "Want" },
  { value: "listening", label: "Listening" },
  { value: "finished", label: "Finished" },
  { value: "relisten", label: "Relisten" },
  { value: "paused", label: "Shelved" },
];
type CircleFilter = "all" | "favorite" | "tagged" | "available" | "local" | "remote" | "missing" | "stale";
const circleFilters: readonly CircleFilter[] = [
  "all",
  "favorite",
  "tagged",
  "available",
  "local",
  "remote",
  "missing",
  "stale",
];
type CircleRefreshScope = "all" | "catalog" | "work" | "source";
type CircleRefreshResultScope = CircleRefreshScope | "metadata";
type CircleRefreshMode = "incremental" | "full";

export function CirclesPage() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const syncPath = () => setPath(window.location.pathname);
    window.addEventListener("popstate", syncPath);
    window.addEventListener("kikoto:navigation", syncPath);
    return () => {
      window.removeEventListener("popstate", syncPath);
      window.removeEventListener("kikoto:navigation", syncPath);
    };
  }, []);
  const route = circleRouteFromPath(path);
  if (route) {
    return <CircleDetailPage externalId={route.externalId} seriesCode={route.seriesCode} />;
  }
  return <CircleListPage />;
}

export function openCircleRoute(externalId = PLACEHOLDER_CIRCLE_ID) {
  const returnTo = currentCircleReturnPath();
  window.history.pushState(historyStateWithReturn(returnTo, "Back"), "", `/circles/${encodeURIComponent(externalId)}`);
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

export function openCircleSeriesRoute(externalId: string, seriesCode?: string | null) {
  const suffix = seriesCode ? `/series/${encodeURIComponent(seriesCode)}` : "/series";
  const returnTo = currentCircleReturnPath();
  window.history.pushState(
    historyStateWithReturn(returnTo, "Back"),
    "",
    `/circles/${encodeURIComponent(externalId)}${suffix}`,
  );
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

function CircleListPage() {
  const toast = useToast();
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
  const [catalogWorks, setCatalogWorks] = useState(0);
  const [availableWorks, setAvailableWorks] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setRequestQuery(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const search = creatorBrowseSearch({ query, filter, tag: "", page, pageSize });
    window.history.replaceState(window.history.state ?? {}, "", `/circles${search}`);
  }, [filter, page, pageSize, query]);

  useEffect(() => {
    const controller = new AbortController();
    setIsLoading(true);
    setLoadError("");
    api
      .listCircles({ page, pageSize, query: requestQuery, filter, signal: controller.signal })
      .then((result) => {
        setCircles(result.circles);
        setTotal(result.total);
        setCatalogWorks(result.catalogWorks);
        setAvailableWorks(result.availableWorks);
        setHasLoaded(true);
        if (result.page !== page) setPage(result.page);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setLoadError("Circles could not be loaded.");
        toast.notify(toastFromError(error, "Circle API is unavailable."));
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });
    return () => controller.abort();
  }, [filter, page, pageSize, reloadToken, requestQuery]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const paginationProps = {
    page,
    pageSize,
    totalItems: total,
    totalPages,
    itemLabel: "circles",
    ariaLabel: "Circle pages",
    pageSizeOptions: circlePageSizeOptions,
    onPageChange: setPage,
    onPageSizeChange: (value: number) => {
      setPage(1);
      setPageSize(value);
    },
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
      toast.notify(toastFromError(error, "Circle favorite update failed."));
    }
  };

  const saveTags = async (circle: CircleSummary, tags: string[]) => {
    try {
      const result = await api.setCircleUserTags(circle.externalId, tags);
      updateCircle({ ...circle, userTags: result.userTags });
    } catch (error) {
      toast.notify(toastFromError(error, "Circle tags update failed."));
    }
  };

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <div className="flex flex-col gap-3 rounded-lg border bg-card p-3 text-sm xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md border bg-background px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              className="min-w-0 flex-1 bg-transparent outline-none"
              value={query}
              onKeyDown={dismissKeyboardOnEnter}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search circles"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={filter}
              onChange={(event) => setFilter(event.target.value as CircleFilter)}
              aria-label="Circle filter"
            >
              <option value="all">All circles</option>
              <option value="favorite">Favorite</option>
              <option value="tagged">Tagged</option>
              <option value="available">Available</option>
              <option value="local">Local</option>
              <option value="remote">Remote</option>
              <option value="missing">Missing</option>
              <option value="stale">Needs refresh</option>
            </select>
          </div>
        </div>
        <CollectionPagination {...paginationProps} placement="top" />
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" aria-label="Circle totals">
          <Badge variant="outline">{catalogWorks} catalog works</Badge>
          <Badge variant="outline">{availableWorks} available works</Badge>
          <span className="grid h-4 w-4 place-items-center">
            {isLoading && hasLoaded && (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-label="Refreshing circles" />
            )}
          </span>
        </div>

        {isLoading && !hasLoaded ? (
          <CreatorCollectionSkeleton label="Loading circles" />
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
          <div className={creatorCollectionClassName} role="region" aria-label="Circle results" aria-busy={isLoading}>
            {circles.length > 0 ? (
              circles.map((circle) => (
                <CreatorCard
                  key={circle.externalId}
                  name={circle.displayName}
                  identityLabel={circle.externalId}
                  aliases={circle.aliases}
                  latestWork={circle.latestWork}
                  favorite={circle.favorite}
                  userTags={circle.userTags}
                  syncState={circle.syncState}
                  workCount={circle.catalogWorks}
                  unavailableCount={circle.missingWorks}
                  sources={circle.sourceSummaries}
                  onOpen={() => openCircleRoute(circle.externalId)}
                  onFavoriteToggle={() => void toggleFavorite(circle)}
                  onTagsSave={(tags) => saveTags(circle, tags)}
                />
              ))
            ) : (
              <Card className={creatorCardMinHeightClassName}>
                <CardContent
                  className={`grid ${creatorCardMinHeightClassName} place-items-center p-5 text-sm text-muted-foreground`}
                >
                  No circles match this view.
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
function CircleDetailPage({ externalId, seriesCode }: { externalId: string; seriesCode?: string | null }) {
  const toast = useToast();
  const requireDownloadsManage = usePermissionGate("downloads:manage");
  const [detail, setDetail] = useState<CircleDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshingScope, setRefreshingScope] = useState<CircleRefreshScope | null>(null);
  const { mobileColumns, desktopColumns, viewMode, setMobileColumns, setDesktopColumns, setViewMode } =
    useWorkCollectionLayout();
  const [deleteTarget, setDeleteTarget] = useState<CircleCatalogWork | null>(null);
  const [selectedWorkCodes, setSelectedWorkCodes] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [isBulkSaving, setIsBulkSaving] = useState(false);
  const [saveConfirm, setSaveConfirm] = useState<{ count: number; run: () => Promise<void> } | null>(null);
  const fetchWorkspace = useRemoteFetchWorkspace({
    onWorksChanged: async () => setDetail(await api.getCircle(externalId)),
  });
  const [workQuery, setWorkQuery] = useState("");
  const [availabilityFilter, setAvailabilityFilter] = useState<
    "all" | "available" | "unavailable" | "local" | "remote"
  >("all");
  const [workPage, setWorkPage] = useState(1);
  const [workPageSize, setWorkPageSize] = useState<CatalogWorkPageSize>(24);

  const loadCircleDetail = useCallback(
    async (showLoading = false) => {
      if (showLoading) {
        setIsLoading(true);
      }
      try {
        const next = await api.getCircle(externalId);
        setDetail(next);
        setNotFound(false);
        return next;
      } catch (error) {
        setDetail(null);
        if (error instanceof ApiError && error.status === 404) {
          setNotFound(true);
          return null;
        }
        toast.notify(toastFromError(error, "Circle detail is unavailable."));
        return null;
      } finally {
        if (showLoading) {
          setIsLoading(false);
        }
      }
    },
    [externalId],
  );

  useEffect(() => {
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
      void loadCircleDetail();
    };
    window.addEventListener(REMOTE_TRACK_TERMINAL_EVENT, refreshTrackedWork);
    return () => window.removeEventListener(REMOTE_TRACK_TERMINAL_EVENT, refreshTrackedWork);
  }, [detail?.works, loadCircleDetail]);

  useEffect(() => {
    let cancelled = false;
    let timeoutID: number | undefined;
    let refreshStarted = false;
    let metadataSyncToastShown = false;
    const pollAutoRefresh = async (attempt = 0) => {
      const next = await loadCircleDetail(attempt === 0);
      if (cancelled || !next) return;
      const autoRefresh =
        attempt === 0 ? await api.autoRefreshCircle(externalId).catch(() => next.autoRefresh) : next.autoRefresh;
      if (cancelled) return;
      if (autoRefresh.status === "queued") {
        refreshStarted = true;
        toast.info(`Auto refresh queued: ${autoRefresh.mode} crawl for ${autoRefresh.reason}.`);
      } else if (autoRefresh.status === "running") {
        refreshStarted = true;
        toast.info(`Auto refresh is already running: ${autoRefresh.mode} crawl.`);
      } else if (attempt > 0 && autoRefresh.status === "skipped" && autoRefresh.reason === "fresh") {
        toast.success("Auto refresh completed.");
      }
      if (refreshStarted && !metadataSyncToastShown && circleCatalogNeedsMetadataRefresh(next)) {
        metadataSyncToastShown = true;
        toast.info("Catalog fetched. Work metadata is still syncing and will appear here automatically.");
      }
      const metadataPending = refreshStarted && circleCatalogNeedsMetadataRefresh(next);
      if ((autoRefresh.status === "queued" || autoRefresh.status === "running" || metadataPending) && attempt < 60) {
        timeoutID = window.setTimeout(() => void pollAutoRefresh(attempt + 1), 2000);
      }
    };
    void pollAutoRefresh();
    return () => {
      cancelled = true;
      if (timeoutID !== undefined) {
        window.clearTimeout(timeoutID);
      }
    };
  }, [externalId, loadCircleDetail]);

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
  const catalogOnlyCount = filteredWorks.filter((work) => work.catalogStatus !== "imported").length;
  const playableCount = filteredWorks.filter((work) => work.local || work.remote).length;
  const totalWorkPages = Math.max(1, Math.ceil(filteredWorks.length / workPageSize));
  const currentWorkPage = Math.min(workPage, totalWorkPages);
  const pagedWorks = filteredWorks.slice((currentWorkPage - 1) * workPageSize, currentWorkPage * workPageSize);
  const selectablePagedWorks = pagedWorks.filter(isCircleBulkSaveSelectable);
  const selectedWorks = circle.works.filter((work) => selectedWorkCodes.has(work.primaryCode));
  const selectedSyncableWorks = selectedWorks.filter((work) => work.workId === null);

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

  const refresh = async (scope: CircleRefreshScope, mode: CircleRefreshMode) => {
    setRefreshingScope(scope);
    try {
      const result = await api.refreshCircle(externalId, { scope, mode, productMode: workProductMode(scope, mode) });
      toast.success(refreshMessage(result));
      const next = await api.getCircle(externalId);
      setDetail(next);
    } catch (error) {
      toast.notify(toastFromError(error, "Refresh workflow failed."));
    } finally {
      setRefreshingScope(null);
    }
  };

  const toggleCircleFavorite = async () => {
    try {
      const next = await api.updateCircleUserState(externalId, { favorite: !circle.favorite });
      setDetail((current) =>
        current ? { ...current, ...next, works: current.works, series: current.series } : current,
      );
    } catch (error) {
      toast.notify(toastFromError(error, "Circle favorite update failed."));
    }
  };

  const saveCircleTags = async (tags: string[]) => {
    try {
      const result = await api.setCircleUserTags(externalId, tags);
      setDetail((current) => (current ? { ...current, userTags: result.userTags } : current));
    } catch (error) {
      toast.notify(toastFromError(error, "Circle tags update failed."));
    }
  };

  const deleteCatalogWork = async () => {
    if (!deleteTarget) return;
    try {
      const result = await api.deleteCircleCatalogWork(externalId, deleteTarget.primaryCode);
      toast.success(
        result.deleted > 0
          ? `${deleteTarget.primaryCode} removed from this circle catalog.`
          : `${deleteTarget.primaryCode} was already removed.`,
      );
      const next = await api.getCircle(externalId);
      setDetail(next);
      setDeleteTarget(null);
    } catch (error) {
      toast.notify(toastFromError(error, "Catalog work delete failed."));
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
      toast.notify(toastFromError(error, "Mark update failed."));
    }
  };

  const syncAndMarkCatalogWork = async (work: CircleCatalogWork, status: ListeningStatus) => {
    const target = circleWorkRemoteTarget(work);
    if (!target) return;
    setIsBulkSaving(true);
    try {
      const syncResult = await api.syncRemoteSourceWork(target.sourceId, target.code, "circle_mark_interest");
      const markResult = await api.updateWorkUserState(syncResult.workId, { listeningStatus: status });
      toast.success(`Tracked and marked ${syncResult.primaryCode}.`);
      const next = await api.getCircle(externalId);
      setDetail({
        ...next,
        works: next.works.map((item) =>
          item.primaryCode === work.primaryCode ? { ...item, listeningMark: markResult.listeningStatus } : item,
        ),
      });
    } catch (error) {
      toast.notify(toastFromError(error, "Mark update failed."));
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
      toast.notify(toastFromError(error, "Track for list failed."));
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
      const message = `Bulk workflow ${runIds}: queued ${fetched} Fetch jobs, failed ${failed}.`;
      if (failed > 0) toast.warning(message);
      else toast.success(message);
      const next = await api.getCircle(externalId);
      setDetail(next);
    } catch (error) {
      toast.notify(toastFromError(error, "Bulk fetch failed."));
    } finally {
      setIsBulkSaving(false);
      setSaveConfirm(null);
    }
  };

  const bulkSyncAndSaveSelected = async () => {
    if (selectedSyncableWorks.length === 0) return;
    if (!requireDownloadsManage()) return;
    setIsBulkSaving(true);
    try {
      const results = await runCircleBulkBySource(selectedSyncableWorks, "track_fetch");
      const synced = results.reduce((total, result) => total + result.synced, 0);
      const fetched = results.reduce((total, result) => total + result.fetched, 0);
      const failed = results.reduce((total, result) => total + result.failed, 0);
      const runIds = results.map((result) => `#${result.runId}`).join(", ");
      const message = `Bulk workflow ${runIds}: tracked ${synced}, queued ${fetched} Fetch jobs, failed ${failed}.`;
      if (failed > 0) toast.warning(message);
      else toast.success(message);
      const next = await api.getCircle(externalId);
      setDetail(next);
    } catch (error) {
      toast.notify(toastFromError(error, "Bulk track/fetch failed."));
    } finally {
      setIsBulkSaving(false);
    }
  };

  const runCircleBulkBySource = (works: CircleCatalogWork[], action: "fetch" | "track_fetch") => {
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

  const syncSingleWork = async (work: CircleCatalogWork) => {
    const target = circleWorkRemoteTarget(work);
    if (!target) return;
    setIsBulkSaving(true);
    try {
      const result = await api.trackRemoteSourceWork(target.sourceId, target.code, "circle_card_fetch");
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
      setIsBulkSaving(false);
    }
  };

  if (notFound) {
    return (
      <NotFoundPage
        title="Circle not found"
        message={`${externalId} is not available in the current catalog.`}
        onBack={() => navigateToCirclesList()}
        onOpenLibrary={() => {
          window.history.pushState({}, "", "/");
          window.dispatchEvent(new Event("kikoto:navigation"));
        }}
      />
    );
  }

  return (
    <div className="space-y-5">
      <Button variant="outline" size="sm" onClick={() => navigateToCirclesList()}>
        <ChevronLeft className="h-4 w-4" />
        Back to circles
      </Button>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardContent className="space-y-4 p-5">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{circle.externalId}</Badge>
                  <SyncBadge state={circle.syncState} />
                  {circle.favorite && <Badge variant="secondary">Favorite</Badge>}
                </div>
                <h2 className="mt-3 truncate text-2xl font-semibold lg:text-3xl">{circle.displayName}</h2>
                <p className="mt-1 hidden text-sm text-muted-foreground sm:block">
                  {circle.aliases.join(", ") || "No aliases"}
                </p>
                {circle.aliases.length > 0 ? (
                  <details className="mt-2 text-sm sm:hidden">
                    <summary className="cursor-pointer font-medium text-muted-foreground">
                      Aliases · {circle.aliases.length}
                    </summary>
                    <p className="mt-1 text-muted-foreground">{circle.aliases.join(", ")}</p>
                  </details>
                ) : (
                  <p className="mt-1 text-sm text-muted-foreground sm:hidden">No aliases</p>
                )}
                <UserTagRow tags={circle.userTags} onSave={saveCircleTags} className="mt-3" />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant={circle.favorite ? "default" : "outline"}
                  size="sm"
                  onClick={() => void toggleCircleFavorite()}
                >
                  <Heart className={`h-4 w-4 ${circle.favorite ? "fill-current" : ""}`} />
                  Favorite
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <a href={dlsiteMakerURL(circle.externalId)} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-4 w-4" />
                    DLsite
                  </a>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isLoading || refreshingScope !== null}
                  onClick={() => void refresh("work", "full")}
                >
                  <RefreshCw className="h-4 w-4" />
                  Retry metadata
                </Button>
                <Button
                  size="sm"
                  disabled={isLoading || refreshingScope !== null || isTranslationCircle(circle.externalId)}
                  onClick={() => void refresh("all", "incremental")}
                >
                  <RefreshCw className="h-4 w-4" />
                  Refresh circle
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-4 gap-px overflow-hidden rounded-md border bg-border sm:gap-3 sm:overflow-visible sm:border-0 sm:bg-transparent">
              <Stat label="Catalog works" value={String(circle.catalogWorks || circle.works.length)} />
              <Stat label="Series" value={String(circle.series.length)} />
              <Stat label="Catalog only" value={String(catalogOnlyCount)} />
              <Stat label="Playable" value={String(playableCount)} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Workflow Shortcuts</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <RefreshActionRow
              title="Catalog"
              description={`${circle.catalogWorks} works · ${circle.lastSyncedAt ? `last ${circle.lastSyncedAt}` : "never synced"}`}
              disabled={refreshingScope !== null || isTranslationCircle(circle.externalId)}
              active={refreshingScope === "catalog" || refreshingScope === "all"}
              onRun={(mode) => void refresh("catalog", mode)}
            />
            <RefreshActionRow
              title="Work metadata"
              description={`${catalogOnlyCount} catalog only · ${playableCount} playable in current filter`}
              disabled={refreshingScope !== null}
              active={refreshingScope === "work" || refreshingScope === "all"}
              onRun={(mode) => void refresh("work", mode)}
            />
            <RefreshActionRow
              title="Sources"
              description={`${circle.localWorks} local · ${circle.remoteWorks} remote · ${circle.missingWorks} missing`}
              disabled={refreshingScope !== null || isTranslationCircle(circle.externalId)}
              active={refreshingScope === "source" || refreshingScope === "all"}
              onRun={(mode) => void refresh("source", mode)}
            />
            {isTranslationCircle(circle.externalId) && (
              <div className="text-xs text-muted-foreground">
                Catalog and source refresh are disabled for translation umbrella circles.
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      <section className="space-y-3">
        <div className="flex flex-col gap-2 rounded-lg border bg-card p-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex h-9 rounded-md border bg-background p-1 text-sm">
            <button
              className={`rounded px-3 ${!isSeriesView ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
              onClick={() => openCircleRoute(circle.externalId)}
            >
              Works {circle.works.length}
            </button>
            <button
              className={`rounded px-3 ${isSeriesView ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
              onClick={() => openCircleSeriesRoute(circle.externalId)}
            >
              Series {circle.series.length}
            </button>
          </div>
          <div className="flex min-h-10 flex-1 items-center gap-2 rounded-md border bg-background px-3 text-sm text-muted-foreground">
            <Search className="h-4 w-4" />
            <input
              className="min-w-0 flex-1 bg-transparent outline-none"
              value={workQuery}
              onKeyDown={dismissKeyboardOnEnter}
              onChange={(event) => setWorkQuery(event.target.value)}
              placeholder="Search circle catalog works"
            />
          </div>
          <div className="flex gap-2">
            <WorkCollectionLayoutPicker
              viewMode={viewMode}
              mobileColumns={mobileColumns}
              desktopColumns={desktopColumns}
              onViewModeChange={setViewMode}
              onMobileColumnsChange={setMobileColumns}
              onDesktopColumnsChange={setDesktopColumns}
            />
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={availabilityFilter}
              onChange={(event) =>
                setAvailabilityFilter(event.target.value as "all" | "available" | "unavailable" | "local" | "remote")
              }
              aria-label="Catalog availability filter"
            >
              <option value="all">All works</option>
              <option value="available">Available</option>
              <option value="unavailable">Unavailable</option>
              <option value="local">Local</option>
              <option value="remote">Remote</option>
            </select>
            <Button variant="outline" size="sm" disabled>
              <SlidersHorizontal className="h-4 w-4" />
              More
            </Button>
            {!isSeriesView && (
              <Button
                variant={selectionMode ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  setSelectionMode((value) => {
                    if (value) setSelectedWorkCodes(new Set());
                    return !value;
                  });
                }}
              >
                Select
              </Button>
            )}
          </div>
        </div>

        {isSeriesView ? (
          <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
            <CircleSeriesSidebar
              externalId={circle.externalId}
              series={circle.series}
              selectedSeriesCode={selectedSeries?.titleId ?? null}
              allCount={activeSeriesCount}
            />
            <div className="space-y-3">
              <div className="flex flex-col gap-2 rounded-lg border bg-card px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <h3 className="truncate text-base font-semibold">
                    {selectedSeries ? selectedSeries.name : "All series"}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {selectedSeries
                      ? `${selectedSeries.titleId} · ${selectedSeries.works} works`
                      : `${circle.series.length} series · ${activeSeriesCount} listed works`}
                  </p>
                </div>
                {selectedSeries?.url && (
                  <Button variant="outline" size="sm" asChild>
                    <a href={selectedSeries.url} target="_blank" rel="noreferrer">
                      <ExternalLink className="h-4 w-4" />
                      DLsite series
                    </a>
                  </Button>
                )}
              </div>
              {selectedSeries ? (
                <div
                  className={workCollectionClassName(viewMode)}
                  style={workCollectionStyle(mobileColumns, desktopColumns)}
                >
                  {seriesWorks.length > 0 ? (
                    seriesWorks.map((work) => (
                      <div key={work.primaryCode} className={workCollectionItemClassName(viewMode)}>
                        <CatalogWorkCard
                          work={work}
                          busy={isBulkSaving || fetchWorkspace.isBusy}
                          selected={selectedWorkCodes.has(work.primaryCode)}
                          selectable={isCircleBulkSaveSelectable(work)}
                          selectionActive={false}
                          onSelectedChange={(checked) => toggleWorkSelection(work, checked)}
                          onSync={() => void syncSingleWork(work)}
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
                        No works match this series view.
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
                        No series found for this circle.
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
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2 text-sm">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Checkbox
                    checked={
                      selectablePagedWorks.length > 0 &&
                      selectablePagedWorks.every((work) => selectedWorkCodes.has(work.primaryCode))
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
                      setSelectedWorkCodes(new Set());
                      setSelectionMode(false);
                    }}
                  >
                    Cancel selection
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isBulkSaving || selectedSyncableWorks.length === 0}
                    onClick={() => void bulkSyncAndSaveSelected()}
                  >
                    <GitBranchPlus className="h-4 w-4" />
                    Track + Fetch {selectedSyncableWorks.length}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isBulkSaving || selectedWorks.length === 0}
                    onClick={() => void bulkSaveSelected()}
                  >
                    <HardDriveDownload className="h-4 w-4" />
                    Fetch {selectedWorks.length}
                  </Button>
                </div>
              </div>
            )}

            <div
              className={workCollectionClassName(viewMode)}
              style={workCollectionStyle(mobileColumns, desktopColumns)}
            >
              {filteredWorks.length > 0 ? (
                pagedWorks.map((work) => (
                  <div key={work.primaryCode} className={workCollectionItemClassName(viewMode)}>
                    <CatalogWorkCard
                      work={work}
                      busy={isBulkSaving || fetchWorkspace.isBusy}
                      selected={selectedWorkCodes.has(work.primaryCode)}
                      selectable={isCircleBulkSaveSelectable(work)}
                      selectionActive={selectionMode}
                      onSelectedChange={(checked) => toggleWorkSelection(work, checked)}
                      onSync={() => void syncSingleWork(work)}
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
                    No catalog works match this view.
                  </CardContent>
                </Card>
              )}
            </div>
            {totalWorkPages > 1 && (
              <CatalogWorkPagination
                page={currentWorkPage}
                pageSize={workPageSize}
                totalItems={filteredWorks.length}
                totalPages={totalWorkPages}
                onPageChange={setWorkPage}
                onPageSizeChange={setWorkPageSize}
              />
            )}
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
  onSync,
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
  onSync: () => void;
  onSave: () => void;
  onDeleteMissing: () => void;
  onStatusChange: (status: ListeningStatus) => void;
  onFavoriteSaved: (favorite: boolean) => void;
  onEnsureWork: () => Promise<number | null>;
  onSeriesOpen?: () => void;
}) {
  const directoryTarget = preferredDirectoryTarget(work);
  const isUnavailable = !work.local && !work.remote;
  const view = catalogWorkCardView(work);

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
                title="Track"
                disabled={busy || !circleWorkRemoteTarget(work)}
                onClick={(event) => {
                  event.stopPropagation();
                  onSync();
                }}
              >
                <GitBranchPlus className="h-4 w-4" />
              </WorkCardActionButton>
              <WorkCardActionButton
                title="Fetch"
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
                  title="Delete missing catalog item"
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

function CatalogDeleteConfirmModal({
  work,
  onClose,
  onConfirm,
}: {
  work: CircleCatalogWork;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-background/70 p-4 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border bg-card p-5 shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h3 className="text-base font-semibold">Remove catalog work</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          DLsite did not return {work.primaryCode} in the latest full scan. Remove it from this circle catalog?
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            size="sm"
            onClick={onConfirm}
          >
            Delete
          </Button>
        </div>
      </div>
    </div>
  );
}

function catalogWorkCardView(work: CircleCatalogWork): WorkCardViewModel {
  const sourceBadges = circleSourceBadges({ local: work.local, remote: work.remote, sourceTags: work.sourceTags });
  const statusBadges = [
    ...(work.catalogStatus !== "imported"
      ? [{ key: `catalog:${work.catalogStatus}`, label: work.catalogStatus, variant: "outline" as const }]
      : []),
    ...(!work.dlsiteAvailable ? [{ key: "dlsite:missing", label: "DLsite missing", variant: "warning" as const }] : []),
    ...sourceBadges,
  ];
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

function RefreshActionRow({
  title,
  description,
  disabled,
  active,
  onRun,
}: {
  title: string;
  description: string;
  disabled?: boolean;
  active?: boolean;
  onRun: (mode: CircleRefreshMode) => void;
}) {
  return (
    <div className="rounded-md border bg-background px-3 py-2">
      <div className="mb-1.5 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{title}</div>
          <div className="truncate text-xs text-muted-foreground">{description}</div>
        </div>
        {active && <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-primary" />}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button className="h-8" variant="outline" size="sm" disabled={disabled} onClick={() => onRun("incremental")}>
          Incremental
        </Button>
        <Button className="h-8" variant="outline" size="sm" disabled={disabled} onClick={() => onRun("full")}>
          Full
        </Button>
      </div>
    </div>
  );
}

function workProductMode(scope: CircleRefreshScope, mode: CircleRefreshMode): "available" | "all" {
  if (scope === "work" && mode === "full") {
    return "all";
  }
  return "available";
}

function refreshMessage(result: {
  runId: number;
  scope: CircleRefreshResultScope;
  pagesFetched: number;
  catalogWorks: number;
  productSynced: number;
  productSkipped?: number;
  productFailed?: number;
  sourceSynced: number;
}) {
  const scopeLabel = result.scope === "all" ? "recommended" : result.scope === "metadata" ? "metadata" : result.scope;
  const failed = result.productFailed ? `, ${result.productFailed} failed` : "";
  const skipped = result.productSkipped ? `, ${result.productSkipped} skipped` : "";
  return `Refresh workflow #${result.runId} (${scopeLabel}): ${result.pagesFetched} pages, ${result.catalogWorks} catalog works, ${result.productSynced} product JSON${skipped}${failed}, ${result.sourceSynced} source matches.`;
}

function circleCatalogNeedsMetadataRefresh(circle: CircleDetail) {
  return (
    circle.catalogWorks > 0 && circle.works.some((work) => work.workId === null || work.title === work.primaryCode)
  );
}

function SyncBadge({ state }: { state: string }) {
  const label =
    state === "fresh"
      ? "Synced"
      : state === "stale"
        ? "Needs refresh"
        : state === "excluded"
          ? "Excluded"
          : "Never synced";
  return <Badge variant={state === "fresh" || state === "excluded" ? "secondary" : "warning"}>{label}</Badge>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="min-w-0 rounded-none border-0 sm:rounded-lg sm:border">
      <CardContent className="p-2 text-center sm:p-4 sm:text-left">
        <div className="text-lg font-semibold tabular-nums sm:text-2xl">{value}</div>
        <div className="break-words text-[10px] leading-tight text-muted-foreground sm:text-sm">{label}</div>
      </CardContent>
    </Card>
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
    syncState: "pending",
    autoRefresh: { status: "skipped", reason: "", mode: "" },
    sourceSummaries: [],
    latestWork: null,
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
    <aside className="rounded-lg border bg-card p-2">
      <button
        className={`flex min-h-12 w-full items-center justify-between gap-3 rounded-md px-3 text-left text-sm hover:bg-muted ${selectedSeriesCode === null ? "bg-primary text-primary-foreground hover:bg-primary" : ""}`}
        onClick={() => openCircleSeriesRoute(externalId)}
      >
        <span className="min-w-0 truncate font-medium">All series</span>
        <span className={selectedSeriesCode === null ? "text-primary-foreground/80" : "text-muted-foreground"}>
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
                className={`grid min-h-14 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md px-3 text-left text-sm hover:bg-muted ${selected ? "bg-primary text-primary-foreground hover:bg-primary" : ""}`}
                onClick={() => openCircleSeriesRoute(externalId, item.titleId)}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{item.name}</span>
                  <span
                    className={
                      selected
                        ? "block truncate text-xs text-primary-foreground/75"
                        : "block truncate text-xs text-muted-foreground"
                    }
                  >
                    {item.titleId}
                  </span>
                </span>
                <span className={selected ? "text-primary-foreground/80" : "text-muted-foreground"}>{item.works}</span>
              </button>
            );
          })
        ) : (
          <div className="px-3 py-2 text-sm text-muted-foreground">No series</div>
        )}
      </div>
    </aside>
  );
}

function CircleSeriesSummaryCard({ externalId, series }: { externalId: string; series: CircleSeries }) {
  return (
    <Card className="h-full transition-colors hover:border-primary/50">
      <CardContent className="space-y-3 p-4">
        <button className="block w-full text-left" onClick={() => openCircleSeriesRoute(externalId, series.titleId)}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="truncate text-base font-semibold">{series.name}</h3>
              <div className="mt-1 text-xs text-muted-foreground">{series.titleId}</div>
            </div>
            <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
          </div>
        </button>
        <div className="grid grid-cols-4 gap-2 text-center text-xs">
          <div className="rounded-md border bg-background p-2">
            <div className="text-sm font-semibold">{series.works}</div>
            <div className="text-muted-foreground">Works</div>
          </div>
          <div className="rounded-md border bg-background p-2">
            <div className="text-sm font-semibold">{series.localWorks}</div>
            <div className="text-muted-foreground">Local</div>
          </div>
          <div className="rounded-md border bg-background p-2">
            <div className="text-sm font-semibold">{series.remoteWorks}</div>
            <div className="text-muted-foreground">Remote</div>
          </div>
          <div className="rounded-md border bg-background p-2">
            <div className="text-sm font-semibold">{series.missingWorks}</div>
            <div className="text-muted-foreground">Missing</div>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {series.workCodes.slice(0, 12).map((code) => (
            <Badge key={code} variant="outline">
              {code}
            </Badge>
          ))}
          {series.workCodes.length > 12 && <Badge variant="secondary">+{series.workCodes.length - 12}</Badge>}
        </div>
      </CardContent>
    </Card>
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

function isTranslationCircle(externalId: string) {
  return externalId.toUpperCase() === TRANSLATION_CIRCLE_ID;
}

function openWorkDirectoryRoute(target: WorkDetailIntent, work: CircleCatalogWork) {
  openWorkDetail(target, { returnTo: currentCircleReturnPath(), returnLabel: "Back to circle", workPreview: work });
}

function currentCircleReturnPath() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function dlsiteMakerURL(externalId: string) {
  const site = externalId.toUpperCase().startsWith("VG") ? "pro" : "maniax";
  return `https://www.dlsite.com/${site}/circle/profile/=/maker_id/${encodeURIComponent(externalId)}.html`;
}

function dlsiteWorkURL(code: string) {
  const site = code.toUpperCase().startsWith("VJ") ? "pro" : "maniax";
  return `https://www.dlsite.com/${site}/work/=/product_id/${encodeURIComponent(code)}.html`;
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

function navigateToCirclesList() {
  navigateToHistoryReturn({ fallbackLocation: "/circles" });
}

function safeDecodePathSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function CatalogWorkPagination({
  page,
  pageSize,
  totalItems,
  totalPages,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageSize: CatalogWorkPageSize;
  totalItems: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: CatalogWorkPageSize) => void;
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
          onChange={(event) => onPageSizeChange(Number(event.target.value) as CatalogWorkPageSize)}
          aria-label="Catalog works per page"
        >
          {catalogWorkPageSizeOptions.map((value) => (
            <option key={value} value={value}>
              {value} / page
            </option>
          ))}
        </select>
        <button
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border bg-background text-muted-foreground disabled:opacity-50"
          disabled={page <= 1}
          onClick={() => onPageChange(Math.max(1, page - 1))}
          aria-label="Previous page"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border bg-background text-muted-foreground disabled:opacity-50"
          disabled={page >= totalPages}
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          aria-label="Next page"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
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
