import {
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  FileAudio,
  HardDriveDownload,
  ListChecks,
  NotebookPen,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Star,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RemoteFetchDialog, remoteFetchPaths } from "@/components/RemoteFetchDialog";
import { api, assetURL, type CircleCatalogWork, type CircleDetail, type CircleSourceStat, type CircleSummary, type ListeningStatus, type RemoteWorkDetail } from "@/lib/api";

const PLACEHOLDER_CIRCLE_ID = "RG012345";
const TRANSLATION_CIRCLE_ID = "RG60289";
const circlePageSizeOptions = [10, 20, 40];
const catalogWorkPageSizeOptions = [24, 48] as const;
type CatalogWorkPageSize = (typeof catalogWorkPageSizeOptions)[number];
const listeningStatusOptions: { value: ListeningStatus; label: string }[] = [
  { value: "none", label: "Unmarked" },
  { value: "want_to_listen", label: "Want" },
  { value: "listening", label: "Listening" },
  { value: "finished", label: "Finished" },
  { value: "relisten", label: "Relisten" },
  { value: "paused", label: "Paused" },
];
type CircleFilter = "all" | "available" | "local" | "remote" | "missing" | "stale" | "rated";
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
  const externalId = circleExternalIdFromPath(path);
  if (externalId) {
    return <CircleDetailPage externalId={externalId} />;
  }
  return <CircleListPage />;
}

export function openCircleRoute(externalId = PLACEHOLDER_CIRCLE_ID) {
  window.history.pushState({}, "", `/circles/${encodeURIComponent(externalId)}`);
  window.dispatchEvent(new Event("kikoto:navigation"));
}

function CircleListPage() {
  const [circles, setCircles] = useState<CircleSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CircleFilter>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [mobileColumns, setMobileColumns] = useState<1 | 2 | 3>(1);
  const [desktopColumns, setDesktopColumns] = useState<1 | 2 | 3>(2);

  useEffect(() => {
    setIsLoading(true);
    api.listCircles().then((items) => {
      setCircles(items);
    }).catch((error) => {
      setCircles([]);
      setToast(toastFromError(error, "Circle API is unavailable."));
    }).finally(() => setIsLoading(false));
  }, []);

  const filteredCircles = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return circles.filter((circle) => {
      const matchesQuery = !needle || [circle.externalId, circle.displayName, ...circle.aliases].some((value) => value.toLowerCase().includes(needle));
      if (!matchesQuery) return false;
      switch (filter) {
      case "available":
        return circle.playableWorks > 0 || circle.localWorks > 0 || circle.remoteWorks > 0;
      case "local":
        return circle.localWorks > 0;
      case "remote":
        return circle.remoteWorks > 0;
      case "missing":
        return circle.missingWorks > 0;
      case "stale":
        return circle.syncState !== "fresh";
      case "rated":
        return circle.rating !== null && circle.rating > 0;
      default:
        return true;
      }
    });
  }, [circles, filter, query]);
  const totalPages = Math.max(1, Math.ceil(filteredCircles.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageCircles = filteredCircles.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const totalCatalogWorks = filteredCircles.reduce((total, circle) => total + circle.catalogWorks, 0);
  const totalPlayableWorks = filteredCircles.reduce((total, circle) => total + Math.max(circle.playableWorks, circle.localWorks + circle.remoteWorks), 0);
  useEffect(() => {
    setPage(1);
  }, [filter, pageSize, query]);

  return (
    <div className="space-y-5">
      <section className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-sm text-muted-foreground">Local party index with user rating and notes</p>
          <h2 className="text-xl font-semibold">Circles</h2>
        </div>
      </section>

      <ToastNotice toast={toast} onClose={() => setToast(null)} />

      <section className="space-y-3">
        <div className="flex flex-col gap-3 rounded-lg border bg-card p-3 text-sm xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md border bg-background px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              className="min-w-0 flex-1 bg-transparent outline-none"
              value={query}
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
              <option value="available">Available</option>
              <option value="local">Local</option>
              <option value="remote">Remote</option>
              <option value="missing">Missing</option>
              <option value="stale">Needs refresh</option>
              <option value="rated">Rated</option>
            </select>
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={pageSize}
              onChange={(event) => setPageSize(Number(event.target.value))}
              aria-label="Circle page size"
            >
              {circlePageSizeOptions.map((value) => (
                <option key={value} value={value}>{value} / page</option>
              ))}
            </select>
            <ColumnPicker
              mobileColumns={mobileColumns}
              desktopColumns={desktopColumns}
              mobileOptions={[1, 2, 3]}
              desktopOptions={[1, 2, 3]}
              onMobileChange={setMobileColumns}
              onDesktopChange={setDesktopColumns}
            />
            <Button variant="outline" size="icon" aria-label="Previous page" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="icon" aria-label="Next page" disabled={currentPage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="secondary">{isLoading ? "Loading" : `${filteredCircles.length} circles`}</Badge>
          <Badge variant="outline">{totalCatalogWorks} catalog works</Badge>
          <Badge variant="outline">{totalPlayableWorks} available works</Badge>
          <span>Page {currentPage} / {totalPages}</span>
        </div>

        <div className={circleListGridClassName(mobileColumns, desktopColumns)}>
          {pageCircles.map((circle) => (
            <CircleCard key={circle.externalId} circle={circle} />
          ))}
          {pageCircles.length === 0 && (
            <Card>
              <CardContent className="p-5 text-sm text-muted-foreground">{isLoading ? "Loading circles." : "No circles match this view."}</CardContent>
            </Card>
          )}
        </div>
      </section>
    </div>
  );
}

function CircleCard({ circle }: { circle: CircleSummary }) {
  const availableWorks = Math.max(circle.playableWorks, circle.localWorks + circle.remoteWorks);
  return (
    <Card className="transition-colors hover:border-primary/50">
      <CardContent className="space-y-2 p-3">
        <button className="grid w-full gap-2 text-left lg:grid-cols-[minmax(0,1fr)_auto]" onClick={() => openCircleRoute(circle.externalId)}>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{circle.externalId}</Badge>
              <SyncBadge state={circle.syncState} />
            </div>
            <div className="mt-1 flex min-w-0 items-center gap-2">
              <h3 className="truncate text-base font-semibold">{circle.displayName}</h3>
              <span className="shrink-0 text-xs text-muted-foreground">{circle.aliases.join(", ") || "No aliases"}</span>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs text-muted-foreground lg:justify-end">
            <span>{circle.catalogWorks} works</span>
            <span>{availableWorks} available</span>
            {circle.missingWorks > 0 && <Badge variant="warning">{circle.missingWorks} missing</Badge>}
            <span className="inline-flex items-center gap-1 font-medium text-foreground">
              <Star className="h-3.5 w-3.5 fill-current text-primary" />
              {circle.rating !== null && circle.rating > 0 ? circle.rating : "Unrated"}
            </span>
          </div>
        </button>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2">
          <div className="flex min-h-6 flex-wrap gap-1">
            {sourceTags(circle.sourceSummaries).map((source) => (
              <Badge key={source.key} variant={source.key === "local" ? "secondary" : "outline"}>
                {source.displayName}
                {source.count > 0 ? ` ${source.count}` : ""}
              </Badge>
            ))}
            {sourceTags(circle.sourceSummaries).length === 0 && <Badge variant="warning">Unavailable</Badge>}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <NotebookPen className="h-3.5 w-3.5" />
            <span className="max-w-80 truncate">{circle.note || `Last synced: ${circle.lastSyncedAt ?? "never"}`}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function CircleDetailPage({ externalId }: { externalId: string }) {
  const [detail, setDetail] = useState<CircleDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [isEditingState, setIsEditingState] = useState(false);
  const [ratingDraft, setRatingDraft] = useState(0);
  const [noteDraft, setNoteDraft] = useState("");
  const [refreshingScope, setRefreshingScope] = useState<CircleRefreshScope | null>(null);
  const [mobileColumns, setMobileColumns] = useState<1 | 2>(2);
  const [desktopColumns, setDesktopColumns] = useState<4 | 6 | 8>(6);
  const [deleteTarget, setDeleteTarget] = useState<CircleCatalogWork | null>(null);
  const [selectedWorkCodes, setSelectedWorkCodes] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [isBulkSaving, setIsBulkSaving] = useState(false);
  const [saveConfirm, setSaveConfirm] = useState<{ count: number; run: () => Promise<void> } | null>(null);
  const [markConfirm, setMarkConfirm] = useState<{ work: CircleCatalogWork; status: ListeningStatus } | null>(null);
  const [fetchSelection, setFetchSelection] = useState<{ work: CircleCatalogWork; sourceId: number; detail: RemoteWorkDetail; selectedPaths: Set<string> } | null>(null);
  const [autoSyncRemote, setAutoSyncRemote] = useState(false);
  const [workQuery, setWorkQuery] = useState("");
  const [availabilityFilter, setAvailabilityFilter] = useState<"all" | "available" | "unavailable" | "local" | "remote">("all");
  const [workPage, setWorkPage] = useState(1);
  const [workPageSize, setWorkPageSize] = useState<CatalogWorkPageSize>(24);

  const loadCircleDetail = useCallback(async (showLoading = false) => {
    if (showLoading) {
      setIsLoading(true);
      setToast(null);
    }
    try {
      const next = await api.getCircle(externalId);
      setDetail(next);
      setRatingDraft(next.rating ?? 0);
      setNoteDraft(next.note);
      return next;
    } catch (error) {
      setDetail(null);
      setToast(toastFromError(error, "Circle detail is unavailable."));
      return null;
    } finally {
      if (showLoading) {
        setIsLoading(false);
      }
    }
  }, [externalId]);

  useEffect(() => {
    let cancelled = false;
    let timeoutID: number | undefined;
    const pollAutoRefresh = async (attempt = 0) => {
      const next = await loadCircleDetail(attempt === 0);
      if (cancelled || !next) return;
      const autoRefresh = attempt === 0 ? await api.autoRefreshCircle(externalId).catch(() => next.autoRefresh) : next.autoRefresh;
      if (cancelled) return;
      if (autoRefresh.status === "queued") {
        setToast({ kind: "info", message: `Auto refresh queued: ${autoRefresh.mode} crawl for ${autoRefresh.reason}.` });
      } else if (autoRefresh.status === "running") {
        setToast({ kind: "info", message: `Auto refresh is already running: ${autoRefresh.mode} crawl.` });
      } else if (attempt > 0 && autoRefresh.status === "skipped" && autoRefresh.reason === "fresh") {
        setToast({ kind: "success", message: "Auto refresh completed." });
      }
      if ((autoRefresh.status === "queued" || autoRefresh.status === "running") && attempt < 30) {
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

  useEffect(() => {
    api.getRuntimeSettings().then((settings) => setAutoSyncRemote(settings.autoSyncRemote || settings.cacheEnabled)).catch(() => setAutoSyncRemote(false));
  }, []);

  const circle = detail ?? emptyCircleDetail(externalId);
  const filteredWorks = useMemo(() => {
    const needle = workQuery.trim().toLowerCase();
    return circle.works.filter((work) => {
      const matchesQuery = !needle || [work.primaryCode, work.title, work.releaseDate ?? "", work.catalogStatus].some((value) => value.toLowerCase().includes(needle));
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
    setSelectedWorkCodes((current) => new Set(Array.from(current).filter((code) => filteredWorks.some((work) => work.primaryCode === code))));
  }, [filteredWorks]);

  const refresh = async (scope: CircleRefreshScope, mode: CircleRefreshMode) => {
    setRefreshingScope(scope);
    try {
      const result = await api.refreshCircle(externalId, { scope, mode, productMode: workProductMode(scope, mode) });
      setToast({ kind: "success", message: refreshMessage(result) });
      const next = await api.getCircle(externalId);
      setDetail(next);
    } catch (error) {
      setToast(toastFromError(error, "Refresh workflow failed."));
    } finally {
      setRefreshingScope(null);
    }
  };

  const saveUserState = async () => {
    try {
      const next = await api.updateCircleUserState(externalId, {
        rating: ratingDraft > 0 ? ratingDraft : null,
        note: noteDraft,
        favorite: circle.favorite,
      });
      setDetail((current) => current ? { ...current, ...next, works: current.works } : current);
      setIsEditingState(false);
      setToast({ kind: "success", message: "Circle note saved." });
    } catch (error) {
      setToast(toastFromError(error, "Circle note save failed."));
    }
  };

  const deleteCatalogWork = async () => {
    if (!deleteTarget) return;
    try {
      const result = await api.deleteCircleCatalogWork(externalId, deleteTarget.primaryCode);
      setToast({ kind: "success", message: result.deleted > 0 ? `${deleteTarget.primaryCode} removed from this circle catalog.` : `${deleteTarget.primaryCode} was already removed.` });
      const next = await api.getCircle(externalId);
      setDetail(next);
      setDeleteTarget(null);
    } catch (error) {
      setToast(toastFromError(error, "Catalog work delete failed."));
    }
  };

  const updateCatalogWorkStatus = async (work: CircleCatalogWork, status: ListeningStatus) => {
    if (work.workId === null) {
      if (!circleWorkRemoteTarget(work)) return;
      if (!autoSyncRemote) {
        setMarkConfirm({ work, status });
        return;
      }
      await syncAndMarkCatalogWork(work, status);
      return;
    }
    if (!work.local && !work.remote) return;
    try {
      const result = await api.updateWorkUserState(work.workId, { listeningStatus: status });
      setDetail((current) => current ? {
        ...current,
        works: current.works.map((item) => item.primaryCode === work.primaryCode ? { ...item, listeningMark: result.listeningStatus } : item),
      } : current);
    } catch (error) {
      setToast(toastFromError(error, "Mark update failed."));
    }
  };

  const syncAndMarkCatalogWork = async (work: CircleCatalogWork, status: ListeningStatus) => {
    const target = circleWorkRemoteTarget(work);
    if (!target) return;
    setIsBulkSaving(true);
    setToast(null);
    try {
      const syncResult = await api.syncRemoteSourceWork(target.sourceId, work.primaryCode, "circle_mark_interest");
      const markResult = await api.updateWorkUserState(syncResult.workId, { listeningStatus: status });
      setToast({ kind: "success", message: `Synced and marked ${syncResult.primaryCode}.` });
      const next = await api.getCircle(externalId);
      setDetail({
        ...next,
        works: next.works.map((item) => item.primaryCode === work.primaryCode ? { ...item, listeningMark: markResult.listeningStatus } : item),
      });
      setMarkConfirm(null);
    } catch (error) {
      setToast(toastFromError(error, "Mark update failed."));
    } finally {
      setIsBulkSaving(false);
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
    setSaveConfirm({ count: selectedWorks.length, run: runBulkSaveSelected });
  };

  const runBulkSaveSelected = async () => {
    setIsBulkSaving(true);
    setToast(null);
    try {
      const results = await runCircleBulkBySource(selectedWorks, "save");
      const fetched = results.reduce((total, result) => total + result.fetched, 0);
      const runIds = results.map((result) => `#${result.runId}`).join(", ");
      setToast({ kind: "success", message: `Bulk workflow ${runIds}: fetched ${fetched} selected works.` });
      const next = await api.getCircle(externalId);
      setDetail(next);
    } catch (error) {
      setToast(toastFromError(error, "Bulk fetch failed."));
    } finally {
      setIsBulkSaving(false);
      setSaveConfirm(null);
    }
  };

  const bulkSyncAndSaveSelected = async () => {
    if (selectedSyncableWorks.length === 0) return;
    setIsBulkSaving(true);
    setToast(null);
    try {
      const results = await runCircleBulkBySource(selectedSyncableWorks, "sync_save");
      const synced = results.reduce((total, result) => total + result.synced, 0);
      const fetched = results.reduce((total, result) => total + result.fetched, 0);
      const runIds = results.map((result) => `#${result.runId}`).join(", ");
      setToast({ kind: "success", message: `Bulk workflow ${runIds}: synced ${synced} and fetched ${fetched} selected works.` });
      const next = await api.getCircle(externalId);
      setDetail(next);
    } catch (error) {
      setToast(toastFromError(error, "Bulk sync/fetch failed."));
    } finally {
      setIsBulkSaving(false);
    }
  };

  const runCircleBulkBySource = (works: CircleCatalogWork[], action: "save" | "sync_save") => {
    const groups = new Map<number, string[]>();
    works.forEach((work) => {
      const target = circleWorkRemoteTarget(work);
      if (!target) return;
      groups.set(target.sourceId, [...(groups.get(target.sourceId) ?? []), work.primaryCode]);
    });
    return Promise.all(Array.from(groups, ([sourceId, codes]) => api.recordRemoteBulkRun({ action, sourceId, codes })));
  };

  const saveSingleWork = async (work: CircleCatalogWork) => {
    const target = circleWorkRemoteTarget(work);
    if (!target) return;
    setIsBulkSaving(true);
    setToast(null);
    try {
      const detail = await api.getRemoteSourceWork(target.sourceId, work.primaryCode);
      setFetchSelection({ work, sourceId: target.sourceId, detail, selectedPaths: new Set(remoteFetchPaths(detail.tracks)) });
    } catch (error) {
      setToast(toastFromError(error, "Remote directory failed."));
    } finally {
      setIsBulkSaving(false);
    }
  };

  const fetchSingleSelection = async () => {
    if (!fetchSelection) return;
    setIsBulkSaving(true);
    setToast(null);
    try {
      const result = await api.saveRemoteSourceWork(fetchSelection.sourceId, fetchSelection.detail.primaryCode, Array.from(fetchSelection.selectedPaths));
      setToast({ kind: "success", message: `Fetched ${result.primaryCode} through workflow run #${result.runId}.` });
      setFetchSelection(null);
      setDetail(await api.getCircle(externalId));
    } catch (error) {
      setToast(toastFromError(error, "Fetch failed."));
    } finally {
      setIsBulkSaving(false);
    }
  };

  const syncSingleWork = async (work: CircleCatalogWork) => {
    const target = circleWorkRemoteTarget(work);
    if (!target) return;
    setIsBulkSaving(true);
    try {
      const result = await api.syncRemoteSourceWork(target.sourceId, work.primaryCode, "circle_card_fetch");
      setToast({ kind: "success", message: `Synced ${result.primaryCode} through workflow run #${result.runId}.` });
      setDetail(await api.getCircle(externalId));
    } catch (error) {
      setToast(toastFromError(error, "Sync failed."));
    } finally {
      setIsBulkSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <Button variant="outline" size="sm" onClick={() => navigateToCirclesList()}>
        <ChevronLeft className="h-4 w-4" />
        Back to circles
      </Button>

      <ToastNotice toast={toast} onClose={() => setToast(null)} />

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardContent className="space-y-4 p-5">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{circle.externalId}</Badge>
                  <SyncBadge state={circle.syncState} />
                </div>
                <h2 className="mt-3 truncate text-2xl font-semibold lg:text-3xl">{circle.displayName}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{circle.aliases.join(", ") || "No aliases"}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" asChild>
                  <a href={dlsiteMakerURL(circle.externalId)} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-4 w-4" />
                    DLsite
                  </a>
                </Button>
                <Button variant="outline" size="sm" disabled={isLoading || refreshingScope !== null} onClick={() => void refresh("work", "full")}>
                  <RefreshCw className="h-4 w-4" />
                  Retry metadata
                </Button>
                <Button size="sm" disabled={isLoading || refreshingScope !== null || isTranslationCircle(circle.externalId)} onClick={() => void refresh("all", "incremental")}>
                  <RefreshCw className="h-4 w-4" />
                  Refresh circle
                </Button>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-4">
              <Stat label="Catalog works" value={String(circle.catalogWorks || circle.works.length)} />
              <Stat label="Catalog only" value={String(catalogOnlyCount)} />
              <Stat label="Playable" value={String(playableCount)} />
              <Stat label="Unavailable" value={String(circle.works.filter((work) => !work.local && !work.remote).length)} />
            </div>

            <div className="grid gap-3 lg:grid-cols-[180px_minmax(0,1fr)]">
              <Card>
                <CardContent className="space-y-2 p-4">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Star className="h-4 w-4 fill-current text-primary" />
                    User rating
                  </div>
                  {isEditingState ? (
                    <select
                      className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                      value={ratingDraft}
                      onChange={(event) => setRatingDraft(Number(event.target.value))}
                    >
                      <option value={0}>Unrated</option>
                      {[1, 2, 3, 4, 5].map((value) => (
                        <option key={value} value={value}>
                          {value}/5
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div className="text-2xl font-semibold">{circle.rating !== null && circle.rating > 0 ? `${circle.rating}/5` : "Unrated"}</div>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => {
                      setRatingDraft(circle.rating ?? 0);
                      setNoteDraft(circle.note);
                      setIsEditingState((value) => !value);
                    }}
                  >
                    {isEditingState ? "Cancel" : "Edit rating"}
                  </Button>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="space-y-2 p-4">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <NotebookPen className="h-4 w-4 text-primary" />
                    User note
                  </div>
                  {isEditingState ? (
                    <textarea
                      className="min-h-24 w-full resize-y rounded-md border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                      value={noteDraft}
                      onChange={(event) => setNoteDraft(event.target.value)}
                    />
                  ) : (
                    <p className="text-sm text-muted-foreground">{circle.note || "No note yet."}</p>
                  )}
                  <Button variant="outline" size="sm" disabled={!isEditingState} onClick={() => void saveUserState()}>
                    Save note
                  </Button>
                </CardContent>
              </Card>
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
            {isTranslationCircle(circle.externalId) && <div className="text-xs text-muted-foreground">Catalog and source refresh are disabled for translation umbrella circles.</div>}
          </CardContent>
        </Card>
      </section>

      <section className="space-y-3">
        <div className="flex flex-col gap-2 rounded-lg border bg-card p-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-h-10 flex-1 items-center gap-2 rounded-md border bg-background px-3 text-sm text-muted-foreground">
              <Search className="h-4 w-4" />
              <input
                className="min-w-0 flex-1 bg-transparent outline-none"
                value={workQuery}
                onChange={(event) => setWorkQuery(event.target.value)}
                placeholder="Search circle catalog works"
              />
            </div>
            <div className="flex gap-2">
              <ColumnPicker
                mobileColumns={mobileColumns}
                desktopColumns={desktopColumns}
                mobileOptions={[1, 2]}
                desktopOptions={[4, 6, 8]}
                onMobileChange={setMobileColumns}
                onDesktopChange={setDesktopColumns}
              />
              <select
                className="h-9 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                value={availabilityFilter}
                onChange={(event) => setAvailabilityFilter(event.target.value as "all" | "available" | "unavailable" | "local" | "remote")}
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
              <Button variant={selectionMode ? "default" : "outline"} size="sm" onClick={() => {
                setSelectionMode((value) => {
                  if (value) setSelectedWorkCodes(new Set());
                  return !value;
                });
              }}>
                Select
              </Button>
            </div>
          </div>

          {selectionMode && <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2 text-sm">
            <label className="flex items-center gap-2 text-muted-foreground">
              <input
                type="checkbox"
                checked={selectablePagedWorks.length > 0 && selectablePagedWorks.every((work) => selectedWorkCodes.has(work.primaryCode))}
                onChange={(event) => toggleVisibleSelection(event.target.checked)}
              />
              {selectedWorks.length} selected
            </label>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => toggleVisibleSelection(true)}>Select all</Button>
              <Button variant="outline" size="sm" onClick={() => {
                setSelectedWorkCodes(new Set());
                setSelectionMode(false);
              }}>Cancel selection</Button>
              <Button variant="outline" size="sm" disabled={isBulkSaving || selectedSyncableWorks.length === 0} onClick={() => void bulkSyncAndSaveSelected()}>
                <RefreshCw className="h-4 w-4" />
                Sync + Fetch {selectedSyncableWorks.length}
              </Button>
              <Button variant="outline" size="sm" disabled={isBulkSaving || selectedWorks.length === 0} onClick={() => void bulkSaveSelected()}>
                <HardDriveDownload className="h-4 w-4" />
                Fetch {selectedWorks.length}
              </Button>
            </div>
          </div>}

          <div className={circleWorkGridClassName(mobileColumns, desktopColumns)}>
            {filteredWorks.length > 0 ? pagedWorks.map((work) => (
              <CatalogWorkCard
                key={work.primaryCode}
                work={work}
                selected={selectedWorkCodes.has(work.primaryCode)}
                selectable={isCircleBulkSaveSelectable(work)}
                selectionActive={selectionMode}
                onSelectedChange={(checked) => toggleWorkSelection(work, checked)}
                onSync={() => void syncSingleWork(work)}
                onSave={() => void saveSingleWork(work)}
                onDeleteMissing={() => setDeleteTarget(work)}
                onStatusChange={(status) => void updateCatalogWorkStatus(work, status)}
              />
            )) : (
              <Card>
                <CardContent className="p-5 text-sm text-muted-foreground">No catalog works match this view.</CardContent>
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
      </section>
      {deleteTarget && (
        <CatalogDeleteConfirmModal
          work={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => void deleteCatalogWork()}
        />
      )}
      {saveConfirm && (
        <SaveConfirmModal count={saveConfirm.count} onClose={() => setSaveConfirm(null)} onConfirm={() => void saveConfirm.run()} />
      )}
      {markConfirm && (
        <RemoteMarkConfirmModal
          workCode={markConfirm.work.primaryCode}
          onClose={() => setMarkConfirm(null)}
          onConfirm={() => void syncAndMarkCatalogWork(markConfirm.work, markConfirm.status)}
        />
      )}
      {fetchSelection && (
        <RemoteFetchDialog
          title={`${fetchSelection.work.primaryCode} · ${fetchSelection.work.title}`}
          tracks={fetchSelection.detail.tracks}
          selectedPaths={fetchSelection.selectedPaths}
          disabled={isBulkSaving}
          onChange={(paths) => setFetchSelection((current) => current ? { ...current, selectedPaths: paths } : current)}
          onClose={() => setFetchSelection(null)}
          onFetch={() => void fetchSingleSelection()}
        />
      )}
    </div>
  );
}

function CatalogWorkCard({
  work,
  selected,
  selectable,
  selectionActive,
  onSelectedChange,
  onSync,
  onSave,
  onDeleteMissing,
  onStatusChange,
}: {
  work: CircleCatalogWork;
  selected: boolean;
  selectable: boolean;
  selectionActive: boolean;
  onSelectedChange: (checked: boolean) => void;
  onSync: () => void;
  onSave: () => void;
  onDeleteMissing: () => void;
  onStatusChange: (status: ListeningStatus) => void;
}) {
  const directoryTarget = preferredDirectoryTarget(work);
  const tags = sourceTags(work.sourceTags);
  const isUnavailable = !work.local && !work.remote;
  const [isMarkOpen, setIsMarkOpen] = useState(false);
  const markMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isMarkOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (markMenuRef.current?.contains(target)) return;
      setIsMarkOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsMarkOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isMarkOpen]);

  const openTarget = () => {
    if (directoryTarget) openWorkDirectoryRoute(directoryTarget);
  };

  return (
    <Card className="group h-full transition-colors hover:border-primary/50">
      <CardContent className="p-0">
        <button
          className={`block w-full text-left ${directoryTarget ? "cursor-pointer" : "cursor-default"}`}
          disabled={!directoryTarget}
          onClick={openTarget}
        >
          <div className="relative aspect-[4/3] overflow-hidden bg-muted">
            {selectionActive && (
              <label className="absolute right-3 top-3 z-10 rounded-md bg-background/90 px-2 py-1 text-xs" onClick={(event) => event.stopPropagation()}>
                <input type="checkbox" checked={selected} disabled={!selectable} onChange={(event) => onSelectedChange(event.target.checked)} />
              </label>
            )}
            {work.coverUrl ? <img src={assetURL(work.coverUrl)} alt="" className="h-full w-full object-contain" /> : null}
            <div className="absolute left-3 top-3 rounded-md bg-background/90 px-2 py-1 text-xs font-semibold">{work.primaryCode}</div>
          </div>
          <div className="flex min-h-52 flex-col gap-3 p-4">
            <div className="space-y-1">
              <h3 className="line-clamp-2 min-h-10 text-base font-semibold leading-snug">{work.title}</h3>
              <button
                className="block max-w-full truncate text-left text-sm text-muted-foreground hover:text-primary"
                onClick={(event) => {
                  event.stopPropagation();
                  openCircleRoute(work.circleExternalId || undefined);
                }}
              >
                {work.circle || "Unknown circle"}
              </button>
            </div>
            <div className="flex min-h-6 flex-wrap gap-1.5">
              {work.tags.slice(0, 4).length > 0 ? work.tags.slice(0, 4).map((tag) => (
                <Badge key={tag} variant="outline">{tag}</Badge>
              )) : <span className="text-xs text-muted-foreground">No tags</span>}
            </div>
            <div className="grid gap-1 text-xs text-muted-foreground">
              <div className="truncate">Release {work.releaseDate ?? "unknown"} · Updated {work.updatedAt || "unknown"}</div>
              <div className="truncate">DLsite rate {work.rating === null ? "unknown" : work.rating.toFixed(2)} · Sales {work.sales === null ? "unknown" : work.sales.toLocaleString()}</div>
            </div>
            {work.progress?.mediaItemId && (
              <WorkProgressLine progress={work.progress} />
            )}
            <div className="mt-auto flex min-h-6 flex-wrap gap-1.5">
              {work.catalogStatus !== "imported" && <Badge variant="outline">{work.catalogStatus}</Badge>}
              {!work.dlsiteAvailable && <Badge variant="warning">DLsite missing</Badge>}
              {tags.length > 0 ? tags.map((tag) => (
                <Badge key={tag.key} variant={tag.key === "local" ? "secondary" : "outline"}>
                  {tag.displayName}
                </Badge>
              )) : <Badge variant="warning">Unavailable</Badge>}
            </div>
          </div>
        </button>
        <div className="flex h-11 items-center justify-between gap-1 border-t px-3">
          <Button variant="ghost" size="icon" asChild title="Open DLsite">
            <a href={work.dlsiteUrl || dlsiteWorkURL(work.primaryCode)} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} aria-label="Open DLsite">
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" title="Sync" disabled={!circleWorkRemoteTarget(work)} onClick={(event) => {
              event.stopPropagation();
              onSync();
            }}>
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" title="Fetch" disabled={!circleWorkRemoteTarget(work)} onClick={(event) => {
              event.stopPropagation();
              onSave();
            }}>
              <HardDriveDownload className="h-4 w-4" />
            </Button>
            <div className="relative" ref={markMenuRef}>
            <Button
              variant="ghost"
              size="icon"
              title={`Mark: ${listeningStatusLabel(work.listeningMark)}`}
              disabled={isUnavailable && !circleWorkRemoteTarget(work)}
              onClick={(event) => {
                event.stopPropagation();
                setIsMarkOpen((value) => !value);
              }}
            >
              <ListChecks className={work.listeningMark === "none" ? "h-4 w-4" : "h-4 w-4 text-primary"} />
            </Button>
            {isMarkOpen && (
              <MarkMenu
                value={normalizeListeningStatus(work.listeningMark)}
                onChange={(status) => {
                  setIsMarkOpen(false);
                  onStatusChange(status);
                }}
              />
            )}
          </div>
          </div>
          <div className="hidden items-center gap-1">
            {!work.dlsiteAvailable && (
              <Button variant="ghost" size="sm" onClick={onDeleteMissing}>
                Delete
              </Button>
            )}
            <Button variant="ghost" size="sm" asChild>
              <a href={work.dlsiteUrl || dlsiteWorkURL(work.primaryCode)} target="_blank" rel="noreferrer">
                <ExternalLink className="h-4 w-4" />
                DLsite
              </a>
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
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

function RemoteMarkConfirmModal({ workCode, onClose, onConfirm }: { workCode: string; onClose: () => void; onConfirm: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/50 p-4" onMouseDown={onClose}>
      <div className="w-full max-w-sm rounded-lg border bg-card p-4 shadow-xl" onMouseDown={(event) => event.stopPropagation()}>
        <h3 className="text-base font-semibold">Sync before mark</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          {workCode} will be synced into Remote metadata before the mark is saved. You can enable Auto sync in Settings to skip this prompt.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={onConfirm}>Sync and mark</Button>
        </div>
      </div>
    </div>
  );
}

function CatalogDeleteConfirmModal({ work, onClose, onConfirm }: { work: CircleCatalogWork; onClose: () => void; onConfirm: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/70 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div className="w-full max-w-md rounded-lg border bg-card p-5 shadow-xl" onMouseDown={(event) => event.stopPropagation()}>
        <h3 className="text-base font-semibold">Remove catalog work</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          DLsite did not return {work.primaryCode} in the latest full scan. Remove it from this circle catalog?
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button className="bg-destructive text-destructive-foreground hover:bg-destructive/90" size="sm" onClick={onConfirm}>Delete</Button>
        </div>
      </div>
    </div>
  );
}

function WorkProgressLine({ progress }: { progress: NonNullable<CircleCatalogWork["progress"]> }) {
  return (
    <div className="space-y-1">
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${workProgressPercent(progress)}%` }} />
      </div>
      <div className="truncate text-xs text-muted-foreground">
        {progress.completed ? "Finished" : `Resume ${progress.title || "track"} at ${formatTime(progress.positionSeconds)}`}
      </div>
    </div>
  );
}

function RefreshActionRow({ title, description, disabled, active, onRun }: { title: string; description: string; disabled?: boolean; active?: boolean; onRun: (mode: CircleRefreshMode) => void }) {
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

function refreshMessage(result: { runId: number; scope: CircleRefreshResultScope; pagesFetched: number; catalogWorks: number; productSynced: number; productSkipped?: number; productFailed?: number; sourceSynced: number }) {
  const scopeLabel = result.scope === "all" ? "recommended" : result.scope === "metadata" ? "metadata" : result.scope;
  const failed = result.productFailed ? `, ${result.productFailed} failed` : "";
  const skipped = result.productSkipped ? `, ${result.productSkipped} skipped` : "";
  return `Refresh workflow #${result.runId} (${scopeLabel}): ${result.pagesFetched} pages, ${result.catalogWorks} catalog works, ${result.productSynced} product JSON${skipped}${failed}, ${result.sourceSynced} source matches.`;
}

function SyncBadge({ state }: { state: string }) {
  const label = state === "fresh" ? "fresh" : state === "stale" ? "needs refresh" : state === "excluded" ? "excluded" : "first pull";
  return <Badge variant={state === "fresh" || state === "excluded" ? "secondary" : "warning"}>{label}</Badge>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-2xl font-semibold">{value}</div>
        <div className="text-sm text-muted-foreground">{label}</div>
      </CardContent>
    </Card>
  );
}

type ToastState = { kind: "success" | "error" | "info"; message: string };

function ToastNotice({ toast, onClose }: { toast: ToastState | null; onClose: () => void }) {
  if (!toast) return null;
  return (
    <div className="fixed right-4 top-4 z-50 flex max-w-sm items-start gap-2 rounded-md border bg-card px-3 py-2 text-sm shadow-lg">
      {toast.kind === "error" ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />}
      <div className="min-w-0 flex-1 text-foreground">{toast.message}</div>
      <button className="text-muted-foreground hover:text-foreground" onClick={onClose} aria-label="Close notification">x</button>
    </div>
  );
}

function toastFromError(error: unknown, fallback: string): ToastState {
  return { kind: "error", message: error instanceof Error ? error.message : fallback };
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
    localWorks: 0,
    playableWorks: 0,
    remoteWorks: 0,
    missingWorks: 0,
    catalogWorks: 0,
    lastSyncedAt: null,
    syncState: "pending",
    autoRefresh: { status: "skipped", reason: "", mode: "" },
    sourceSummaries: [],
    works: [],
  };
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

function normalizeListeningStatus(status: string): ListeningStatus {
  return listeningStatusOptions.some((option) => option.value === status) ? (status as ListeningStatus) : "none";
}

function listeningStatusLabel(status: string) {
  return listeningStatusOptions.find((option) => option.value === normalizeListeningStatus(status))?.label ?? "Unmarked";
}

function sourceTags(sources: CircleSourceStat[] | null | undefined) {
  const seen = new Set<string>();
  return (sources ?? []).filter((source) => {
    if (source.key === "cache") return false;
    const key = source.key;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function preferredDirectoryTarget(work: CircleCatalogWork) {
  const tags = sourceTags(work.sourceTags);
  const local = tags.find((tag) => tag.key === "local");
  if (local && work.workId !== null) {
    return { code: work.primaryCode, sourceId: null };
  }
  const remote = tags.find((tag) => tag.sourceId !== undefined && tag.sourceId !== null);
  if (remote?.sourceId) {
    return { code: work.primaryCode, sourceId: remote.sourceId };
  }
  return null;
}

function isCircleBulkSaveSelectable(work: CircleCatalogWork) {
  if (work.local) return false;
  return circleWorkRemoteTarget(work) !== null;
}

function circleWorkRemoteTarget(work: CircleCatalogWork): { sourceId: number } | null {
  const remote = sourceTags(work.sourceTags).find((tag) => tag.sourceId !== undefined && tag.sourceId !== null);
  return remote?.sourceId ? { sourceId: remote.sourceId } : null;
}

function isTranslationCircle(externalId: string) {
  return externalId.toUpperCase() === TRANSLATION_CIRCLE_ID;
}

function openWorkDirectoryRoute(target: { code: string; sourceId: number | null }) {
  const path = target.sourceId ? `/${encodeURIComponent(target.code)}?source=${target.sourceId}` : `/${encodeURIComponent(target.code)}`;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new Event("kikoto:navigation"));
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

function circleExternalIdFromPath(path: string) {
  const match = path.match(/^\/circles\/([^/]+)\/?$/i);
  return match ? safeDecodePathSegment(match[1]) : null;
}

function navigateToCirclesList() {
  window.history.pushState({}, "", "/circles");
  window.dispatchEvent(new Event("kikoto:navigation"));
}

function safeDecodePathSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function ColumnPicker({
  mobileColumns,
  desktopColumns,
  mobileOptions,
  desktopOptions,
  onMobileChange,
  onDesktopChange,
}: {
  mobileColumns: number;
  desktopColumns: number;
  mobileOptions: number[];
  desktopOptions: number[];
  onMobileChange: (value: any) => void;
  onDesktopChange: (value: any) => void;
}) {
  return (
    <>
      <div className="flex rounded-md border bg-background p-1 sm:hidden" aria-label="Mobile catalog columns">
        {mobileOptions.map((value) => (
          <button
            key={value}
            className={`h-7 rounded px-2 text-xs font-medium ${mobileColumns === value ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
            onClick={() => onMobileChange(value)}
          >
            {value}
          </button>
        ))}
      </div>
      <div className="hidden rounded-md border bg-background p-1 sm:flex" aria-label="Desktop catalog columns">
        {desktopOptions.map((value) => (
          <button
            key={value}
            className={`h-7 rounded px-2 text-xs font-medium ${desktopColumns === value ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
            onClick={() => onDesktopChange(value)}
          >
            {value}
          </button>
        ))}
      </div>
    </>
  );
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

function circleListGridClassName(mobileColumns: 1 | 2 | 3, desktopColumns: 1 | 2 | 3) {
  const mobileClass = mobileColumns === 1 ? "grid-cols-1" : mobileColumns === 2 ? "grid-cols-2" : "grid-cols-3";
  const desktopClass = desktopColumns === 1 ? "sm:grid-cols-1" : desktopColumns === 2 ? "sm:grid-cols-2" : "sm:grid-cols-3";
  return `grid gap-2 ${mobileClass} ${desktopClass}`;
}

function circleWorkGridClassName(mobileColumns: 1 | 2, desktopColumns: 4 | 6 | 8) {
  const mobileClass = mobileColumns === 1 ? "grid-cols-1" : "grid-cols-2";
  const desktopClass = desktopColumns === 4 ? "sm:grid-cols-4" : desktopColumns === 6 ? "sm:grid-cols-6" : "sm:grid-cols-8";
  return `grid gap-4 ${mobileClass} ${desktopClass}`;
}
