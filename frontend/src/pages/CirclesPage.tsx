import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  FileAudio,
  GitBranchPlus,
  HardDriveDownload,
  Heart,
  ListChecks,
  MoreHorizontal,
  RefreshCw,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge, badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { MobileSheet } from "@/components/ui/mobile-sheet";
import { toastFromError, useToast } from "@/components/ui/toast";
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
import { CreatorListToolbar } from "@/components/creator/CreatorListToolbar";
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
import { RemoteFetchWorkspaceDialog } from "@/features/work-detail/workflows/RemoteFetchWorkspaceDialog";
import { useRemoteFetchWorkspace } from "@/features/work-detail/workflows/useRemoteFetchWorkspace";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
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
import {
  NAVIGATION_EVENT,
  currentInternalLocation,
  historyStateWithReturn,
  navigateToWorkspaceUp,
  normalizeInternalLocation,
} from "@/lib/browserHistory";
import { currentClientStorageScope } from "@/lib/clientStorageScope";
import { dismissKeyboardOnEnter } from "@/lib/keyboard";
import { DLSITE_ENDPOINTS } from "@/lib/official-links";
import { hasPlaybackHistory } from "@/lib/playbackHistory";
import { useAuth } from "@/auth/AuthProvider";
import { usePermissionGate } from "@/auth/usePermissionGate";
import { NotFoundPage } from "@/app/NotFoundPage";
import { openWorkDetail, type WorkDetailIntent } from "@/app/workDetailNavigation";
import {
  announceRemoteTrackCreated,
  isMatchingRemoteTrack,
  REMOTE_TRACK_TERMINAL_EVENT,
  type RemoteTrackTerminalDetail,
} from "@/app/remoteTrackWorkflows";
import {
  isCircleListLocation,
  readLastCircleListLocation,
  writeLastCircleListLocation,
} from "@/pages/circleNavigationState";
import {
  CircleAdvancedRefreshSheet,
  CircleCatalogOptionsSheet,
  type CircleAvailabilityFilter,
  type CircleRefreshMode,
  type CircleRefreshScope,
} from "@/pages/CircleDetailSheets";
import { creatorBrowseSearch, creatorBrowseStateFromSearch } from "@/pages/creatorBrowseState";

const PLACEHOLDER_CIRCLE_ID = "RG012345";
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

export function openCircleRoute(externalId = PLACEHOLDER_CIRCLE_ID) {
  const returnTo = currentCircleReturnPath();
  window.history.pushState(
    historyStateWithReturn(returnTo, circleReturnLabelForLocation(returnTo)),
    "",
    `/circles/${encodeURIComponent(externalId)}`,
  );
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

export function openCircleSeriesRoute(externalId: string, seriesCode?: string | null) {
  const suffix = seriesCode ? `/series/${encodeURIComponent(seriesCode)}` : "/series";
  const returnTo = currentCircleReturnPath();
  window.history.pushState(
    historyStateWithReturn(returnTo, circleReturnLabelForLocation(returnTo)),
    "",
    `/circles/${encodeURIComponent(externalId)}${suffix}`,
  );
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

function CircleListPage({ active }: { active: boolean }) {
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
        setLoadError("Circles could not be loaded.");
        toast.notify(toastFromError(error, "Circle API is unavailable."));
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
    itemLabel: "circles",
    ariaLabel: "Circle pages",
    compactMobile: true,
    compactTop: true,
    refreshing: isLoading && hasLoaded,
    refreshingLabel: "Refreshing circles",
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
    <div className="relative space-y-5">
      <section className="space-y-3">
        <CreatorListToolbar
          label="Circles"
          query={query}
          placeholder="Search circles"
          filter={filter}
          defaultFilter="all"
          filterOptions={circleFilterOptions}
          pageSize={pageSize}
          pageSizeOptions={circlePageSizeOptions}
          onQueryChange={setQuery}
          onFilterChange={changeFilter}
          onPageSizeChange={changePageSize}
        />
        <CollectionPagination {...paginationProps} placement="top" />

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
      <BrowseLoadingIndicator refreshing={isLoading && hasLoaded} label="Refreshing circles" />
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
  const auth = useAuth();
  const toast = useToast();
  const requireDownloadsManage = usePermissionGate("downloads:manage");
  const canRefreshCatalog = auth.hasPermission("metadata:sync") && !auth.demoMode;
  const compactLayout = useMobileNavigationLayout();
  const [detail, setDetail] = useState<CircleDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshingScope, setRefreshingScope] = useState<CircleRefreshScope | null>(null);
  const { mobileColumns, desktopColumns, setMobileColumns, setDesktopColumns } = useWorkCollectionLayout();
  const [deleteTarget, setDeleteTarget] = useState<CircleCatalogWork | null>(null);
  const [selectedWorkCodes, setSelectedWorkCodes] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [isBulkSaving, setIsBulkSaving] = useState(false);
  const [saveConfirm, setSaveConfirm] = useState<{ count: number; run: () => Promise<void> } | null>(null);
  const [advancedRefreshOpen, setAdvancedRefreshOpen] = useState(false);
  const advancedRefreshAnchorRef = useRef<HTMLButtonElement | null>(null);
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
        setNotFound(false);
        return next;
      } catch (error) {
        if (signal?.aborted) return null;
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
    [active, externalId],
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
      void loadCircleDetail();
    };
    window.addEventListener(REMOTE_TRACK_TERMINAL_EVENT, refreshTrackedWork);
    return () => window.removeEventListener(REMOTE_TRACK_TERMINAL_EVENT, refreshTrackedWork);
  }, [active, detail?.works, loadCircleDetail]);

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
  const selectedSyncableWorks = selectedWorks.filter((work) => work.workId === null);
  const circleListStorageScope = currentClientStorageScope(auth.user?.id ?? null);
  const navigateToList = () => navigateToCirclesList(circleListStorageScope, compactLayout);

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

  const refresh = async (scope: CircleRefreshScope, mode: CircleRefreshMode) => {
    if (!canRefreshCatalog) return;
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

  const firstPull = circle.syncState === "never";
  const runPrimaryRefresh = () => void refresh(firstPull ? "metadata" : "all", firstPull ? "full" : "incremental");

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
      toast.success(`Saved and marked ${syncResult.primaryCode}.`);
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
      toast.notify(toastFromError(error, "Save for list failed."));
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
      <Button variant="outline" size="sm" onClick={navigateToList}>
        <ChevronLeft className="h-4 w-4" />
        {compactLayout ? "Back to circles" : circleReturnLabel()}
      </Button>

      <section aria-label="Circle summary">
        <Card>
          <CardContent className="space-y-4 p-5">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <a
                    href={dlsiteMakerURL(circle.externalId)}
                    target="_blank"
                    rel="noreferrer"
                    className={badgeVariants({
                      variant: "outline",
                      className:
                        "w-fit gap-1.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    })}
                    aria-label={`Open DLsite for ${circle.externalId}`}
                    title="Open DLsite"
                  >
                    <span>{circle.externalId}</span>
                    <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
                  </a>
                  <CatalogSyncBadge state={circle.syncState} />
                  {circle.favorite && <Badge variant="secondary">Favorite</Badge>}
                </div>
                <div className="mt-3 flex min-w-0 items-center gap-1.5">
                  <h2 className="min-w-0 flex-1 truncate text-2xl font-semibold lg:text-3xl">{circle.displayName}</h2>
                </div>
                <div className="mt-3 flex min-w-0 flex-wrap items-center gap-1.5">
                  <Badge variant={availableWorkCount > 0 ? "success" : "warning"}>Available {availableWorkCount}</Badge>
                  <UserTagRow tags={circle.userTags} onSave={saveCircleTags} className="min-w-0 flex-1" />
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5 lg:gap-2" role="group" aria-label="Circle actions">
                <Button
                  variant={circle.favorite ? "default" : "outline"}
                  size="icon"
                  className="lg:h-[var(--control-height-sm)] lg:w-auto lg:px-[var(--control-padding-sm-x)] lg:text-xs"
                  aria-label={circle.favorite ? "Remove favorite" : "Add favorite"}
                  aria-pressed={circle.favorite}
                  title={circle.favorite ? "Remove favorite" : "Add favorite"}
                  onClick={() => void toggleCircleFavorite()}
                >
                  <Heart className={`h-4 w-4 ${circle.favorite ? "fill-current" : ""}`} />
                  <span className="hidden lg:inline">Favorite</span>
                </Button>
                {!firstPull && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-[var(--control-icon-size)] gap-1.5 px-2 lg:h-[var(--control-height-sm)] lg:gap-2 lg:px-[var(--control-padding-sm-x)]"
                    aria-label="Retry circle metadata"
                    disabled={!canRefreshCatalog || isLoading || refreshingScope !== null}
                    onClick={() => void refresh("work", "full")}
                  >
                    <RefreshCw className="h-4 w-4" />
                    <span className="lg:hidden">Metadata</span>
                    <span className="hidden lg:inline">Retry metadata</span>
                  </Button>
                )}
                <Button
                  variant={firstPull ? "default" : "outline"}
                  size="sm"
                  className="h-[var(--control-icon-size)] gap-1.5 px-2 lg:h-[var(--control-height-sm)] lg:gap-2 lg:px-[var(--control-padding-sm-x)]"
                  aria-label={firstPull ? "First pull circle catalog" : "Refresh circle"}
                  disabled={!canRefreshCatalog || isLoading || refreshingScope !== null}
                  onClick={runPrimaryRefresh}
                >
                  <RefreshCw className="h-4 w-4" />
                  <span className="lg:hidden">{firstPull ? "First pull" : "Circle"}</span>
                  <span className="hidden lg:inline">{firstPull ? "First pull" : "Refresh circle"}</span>
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="lg:h-9 lg:w-auto lg:gap-2 lg:px-3 lg:text-xs"
                  ref={advancedRefreshAnchorRef}
                  aria-label="Open advanced refresh actions"
                  aria-haspopup="dialog"
                  aria-expanded={advancedRefreshOpen}
                  aria-controls={advancedRefreshOpen ? "circle-advanced-refresh" : undefined}
                  title="Advanced refresh actions"
                  onClick={() => setAdvancedRefreshOpen((open) => !open)}
                >
                  <MoreHorizontal className="h-4 w-4" />
                  <span className="hidden lg:inline">Advanced</span>
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="space-y-3">
        <div className="flex flex-col gap-2 rounded-lg border bg-card p-3 lg:flex-row lg:items-center">
          <div className="flex h-10 shrink-0 rounded-md border bg-background p-1 text-sm">
            <button
              className={`min-h-8 rounded px-3 ${!isSeriesView ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
              onClick={() => openCircleRoute(circle.externalId)}
            >
              Works {circle.works.length}
            </button>
            <button
              className={`min-h-8 rounded px-3 ${isSeriesView ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
              onClick={() => openCircleSeriesRoute(circle.externalId)}
            >
              Series {circle.series.length}
            </button>
          </div>
          <div
            className={`flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md border bg-background px-3 text-sm text-muted-foreground ${isSeriesView ? "" : "hidden lg:flex"}`}
          >
            <Search className="h-4 w-4" />
            <input
              className="min-w-0 flex-1 bg-transparent outline-none"
              value={workQuery}
              onKeyDown={dismissKeyboardOnEnter}
              onChange={(event) => changeWorkQuery(event.target.value)}
              placeholder="Search circle catalog works"
            />
            {isSeriesView && (
              <Button
                variant="outline"
                size="icon"
                className="relative shrink-0 lg:hidden"
                aria-label="Open catalog options"
                title="Catalog options"
                onClick={() => setCatalogOptionsOpen(true)}
              >
                <SlidersHorizontal className="h-4 w-4" />
                {(workQuery.trim() || availabilityFilter !== "all" || selectionMode) && (
                  <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
                )}
              </Button>
            )}
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
              value={availabilityFilter}
              onChange={(event) => changeAvailabilityFilter(event.target.value as CircleAvailabilityFilter)}
              aria-label="Catalog availability filter"
            >
              <option value="all">All works</option>
              <option value="available">Available</option>
              <option value="unavailable">Unavailable</option>
              <option value="local">Local</option>
              <option value="remote">Remote</option>
            </select>
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

        {!isSeriesView && (
          <div className="lg:hidden">
            <WorkCollectionPagination
              placement="top"
              page={currentWorkPage}
              pageSize={workPageSize}
              totalItems={filteredWorks.length}
              totalPages={totalWorkPages}
              compactMobile
              refreshing={isLoading}
              refreshingLabel="Refreshing circle works"
              leadingControls={
                <Button
                  variant="outline"
                  size="icon"
                  className="relative h-11 w-11"
                  aria-label={`Open catalog options${workQuery.trim() || availabilityFilter !== "all" || selectionMode ? ", filters active" : ""}`}
                  title="Catalog options"
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
              <div className="hidden flex-col gap-2 rounded-lg border bg-card px-3 py-2 lg:flex lg:flex-row lg:items-center lg:justify-between">
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
              <div className="lg:hidden">
                <WorkCollectionPagination
                  placement="bottom"
                  page={currentWorkPage}
                  pageSize={workPageSize}
                  totalItems={filteredWorks.length}
                  totalPages={totalWorkPages}
                  onPageChange={setWorkPage}
                />
              </div>
            )}
            {totalWorkPages > 1 && (
              <div className="hidden lg:block">
                <CatalogWorkPagination
                  page={currentWorkPage}
                  pageSize={workPageSize}
                  totalItems={filteredWorks.length}
                  totalPages={totalWorkPages}
                  onPageChange={setWorkPage}
                  onPageSizeChange={changeWorkPageSize}
                />
              </div>
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
      <CircleAdvancedRefreshSheet
        open={advancedRefreshOpen}
        mobile={compactLayout}
        anchorRef={advancedRefreshAnchorRef}
        circle={circle}
        catalogOnlyCount={catalogOnlyCount}
        availableCount={availableWorkCount}
        refreshingScope={refreshingScope}
        canRefresh={canRefreshCatalog}
        onClose={() => setAdvancedRefreshOpen(false)}
        onRun={(scope, mode) => void refresh(scope, mode)}
      />
      <RemoteFetchWorkspaceDialog workspace={fetchWorkspace} />
      <BrowseLoadingIndicator refreshing={isLoading || refreshingScope !== null} label="Loading circle details" />
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

function workProductMode(scope: CircleRefreshScope, mode: CircleRefreshMode): "available" | "all" {
  if (scope === "work" && mode === "full") {
    return "all";
  }
  return "available";
}

function refreshMessage(result: {
  runId: number;
  scope: CircleRefreshScope;
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
    <aside className="hidden rounded-lg border bg-card p-2 lg:block">
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
  const [open, setOpen] = useState(false);
  const selectedName = selectedSeries?.name ?? "All series";
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
        aria-label="Choose circle series"
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
            aria-label="Open DLsite series"
            title="Open DLsite series"
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
        aria-label="Expand circle series"
        title="Expand circle series"
        onClick={() => setOpen(true)}
      >
        <ChevronDown className="h-4 w-4" />
      </Button>
      <MobileSheet open={open} onOpenChange={setOpen} ariaLabel="Circle series" className="p-4">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold">Series</h2>
          <Button variant="ghost" size="icon" aria-label="Close circle series" onClick={() => setOpen(false)}>
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
  return (
    <>
      <button
        className={`flex min-h-12 w-full items-center justify-between gap-3 rounded-md px-3 text-left text-sm hover:bg-muted ${selectedSeriesCode === null ? "bg-primary text-primary-foreground hover:bg-primary" : ""}`}
        onClick={() => onSelect()}
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
                onClick={() => onSelect(item.titleId)}
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
    </>
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

function openWorkDirectoryRoute(target: WorkDetailIntent, work: CircleCatalogWork) {
  openWorkDetail(target, { returnTo: currentCircleReturnPath(), returnLabel: "Back to circle", workPreview: work });
}

function currentCircleReturnPath() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function circleReturnLabel() {
  const state = window.history.state as { returnTo?: unknown; returnLabel?: unknown } | null;
  if (typeof state?.returnTo === "string") return circleReturnLabelForLocation(state.returnTo);
  return "Back to circles";
}

function circleReturnLabelForLocation(location: string) {
  try {
    const pathname = new URL(location, window.location.origin).pathname;
    if (pathname === "/" || pathname === "") return "Back to library";
    if (/^\/favorites\/?$/i.test(pathname)) return "Back to favorites";
    if (/^\/circles\/?$/i.test(pathname)) return "Back to circles";
    if (/^\/voices(?:\/|$)/i.test(pathname)) return "Back to voice actors";
    if (/^\/settings\/?$/i.test(pathname)) return "Back to settings";
    if (/^\/RJ|^\/BJ|^\/VJ|^\/CC/i.test(pathname)) return "Back to work";
  } catch {
    // Fall through to the generic label for malformed history state.
  }
  return "Back";
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
