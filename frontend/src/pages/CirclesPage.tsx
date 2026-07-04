import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileAudio,
  ListChecks,
  NotebookPen,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Star,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, assetURL, type CircleCatalogWork, type CircleDetail, type CircleSourceStat, type CircleSummary, type ListeningStatus } from "@/lib/api";

const PLACEHOLDER_CIRCLE_ID = "RG012345";
const circlePageSizeOptions = [10, 20, 40];
const listeningStatusOptions: { value: ListeningStatus; label: string }[] = [
  { value: "none", label: "Unmarked" },
  { value: "want_to_listen", label: "Want" },
  { value: "listening", label: "Listening" },
  { value: "finished", label: "Finished" },
  { value: "relisten", label: "Relisten" },
  { value: "paused", label: "Paused" },
];
type CircleFilter = "all" | "available" | "local" | "remote" | "missing" | "stale" | "rated";

const fallbackCircles: CircleSummary[] = [
  {
    id: 0,
    externalId: "RG012345",
    displayName: "Fake Circle 001",
    aliases: ["Demo Circle Alias 001"],
    rating: 4,
    note: "Fake note: review catalog refresh behavior.",
    favorite: false,
    localWorks: 12,
    playableWorks: 9,
    remoteWorks: 22,
    missingWorks: 5,
    catalogWorks: 39,
    lastSyncedAt: "2099-01-01",
    syncState: "stale",
    sourceSummaries: [
      { key: "local", displayName: "Local", status: "available", count: 12 },
      { key: "remote", displayName: "Remote", status: "available", count: 22 },
      { key: "source:fake-001", displayName: "Fake Remote Source 001", status: "available", count: 22 },
    ],
  },
];

const fallbackWorks: CircleCatalogWork[] = [
  {
    workId: 0,
    primaryCode: "RJ0123456",
    title: "Demo Circle Catalog Work 001",
    releaseDate: "2099-01-01",
    coverUrl: "",
    dlsiteUrl: "",
    catalogStatus: "imported",
    dlsiteAvailable: true,
    listeningMark: "listening",
    local: true,
    remote: true,
    sourceTags: [
      { key: "local", displayName: "Local", status: "available", count: 1 },
      { key: "remote", displayName: "Remote", status: "available", count: 1 },
      { key: "source:fake-001", displayName: "Fake Remote Source 001", status: "available", count: 1 },
    ],
  },
  {
    workId: null,
    primaryCode: "RJ0234567",
    title: "Demo Circle Catalog Work 002",
    releaseDate: "2099-02-02",
    coverUrl: "",
    dlsiteUrl: "",
    catalogStatus: "catalog",
    dlsiteAvailable: true,
    listeningMark: "want_to_listen",
    local: false,
    remote: true,
    sourceTags: [
      { key: "remote", displayName: "Remote", status: "available", count: 1 },
      { key: "source:fake-001", displayName: "Fake Remote Source 001", status: "available", count: 1 },
    ],
  },
  {
    workId: null,
    primaryCode: "RJ0345678",
    title: "Demo Circle Catalog Work 003",
    releaseDate: "2099-03-03",
    coverUrl: "",
    dlsiteUrl: "",
    catalogStatus: "catalog",
    dlsiteAvailable: false,
    listeningMark: "none",
    local: false,
    remote: false,
    sourceTags: [],
  },
];

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
  const [message, setMessage] = useState("");
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
      setMessage(items.length === 0 ? "No circles have been derived from local DLsite metadata yet. Showing fake placeholders." : "");
    }).catch((error) => {
      setCircles([]);
      setMessage(error instanceof Error ? error.message : "Circle API is unavailable. Showing fake placeholders.");
    }).finally(() => setIsLoading(false));
  }, []);

  const visibleCircles = circles.length > 0 ? circles : fallbackCircles;
  const filteredCircles = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return visibleCircles.filter((circle) => {
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
  }, [filter, query, visibleCircles]);
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

      {message && <div className="rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">{message}</div>}

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
              <CardContent className="p-5 text-sm text-muted-foreground">No circles match this view.</CardContent>
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
  const [message, setMessage] = useState("");
  const [isEditingState, setIsEditingState] = useState(false);
  const [ratingDraft, setRatingDraft] = useState(0);
  const [noteDraft, setNoteDraft] = useState("");
  const [refreshMode, setRefreshMode] = useState<"incremental" | "full">("incremental");
  const [productMode, setProductMode] = useState<"available" | "all">("available");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [mobileColumns, setMobileColumns] = useState<1 | 2>(2);
  const [desktopColumns, setDesktopColumns] = useState<4 | 6 | 8>(6);
  const [deleteTarget, setDeleteTarget] = useState<CircleCatalogWork | null>(null);
  const [workQuery, setWorkQuery] = useState("");
  const [availabilityFilter, setAvailabilityFilter] = useState<"all" | "available" | "unavailable" | "local" | "remote">("all");

  useEffect(() => {
    setIsLoading(true);
    setMessage("");
    api.getCircle(externalId).then((next) => {
      setDetail(next);
      setRatingDraft(next.rating ?? 0);
      setNoteDraft(next.note);
    }).catch((error) => {
      const fallback = fakeDetail(externalId);
      setDetail(fallback);
      setRatingDraft(fallback.rating ?? 0);
      setNoteDraft(fallback.note);
      setMessage(error instanceof Error ? error.message : "Circle API is unavailable. Showing fake placeholder.");
    }).finally(() => setIsLoading(false));
  }, [externalId]);

  const circle = detail ?? fakeDetail(externalId);
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
  const importedCount = filteredWorks.filter((work) => work.catalogStatus === "imported").length;
  const playableCount = filteredWorks.filter((work) => work.local || work.remote).length;

  const refresh = async () => {
    setIsRefreshing(true);
    try {
      const result = await api.refreshCircle(externalId, { mode: refreshMode, productMode });
      setMessage(`Refresh workflow #${result.runId}: ${result.pagesFetched} pages, ${result.catalogWorks} catalog works, ${result.productSynced} product JSON.`);
      const next = await api.getCircle(externalId);
      setDetail(next);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Refresh workflow failed.");
    } finally {
      setIsRefreshing(false);
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
      setMessage("Circle note saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Circle note save failed.");
    }
  };

  const deleteCatalogWork = async () => {
    if (!deleteTarget) return;
    try {
      const result = await api.deleteCircleCatalogWork(externalId, deleteTarget.primaryCode);
      setMessage(result.deleted > 0 ? `${deleteTarget.primaryCode} removed from this circle catalog.` : `${deleteTarget.primaryCode} was already removed.`);
      const next = await api.getCircle(externalId);
      setDetail(next);
      setDeleteTarget(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Catalog work delete failed.");
    }
  };

  const updateCatalogWorkStatus = async (work: CircleCatalogWork, status: ListeningStatus) => {
    if (work.workId === null || (!work.local && !work.remote)) return;
    try {
      const result = await api.updateWorkUserState(work.workId, { listeningStatus: status });
      setDetail((current) => current ? {
        ...current,
        works: current.works.map((item) => item.primaryCode === work.primaryCode ? { ...item, listeningMark: result.listeningStatus } : item),
      } : current);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Mark update failed.");
    }
  };

  return (
    <div className="space-y-5">
      <Button variant="outline" size="sm" onClick={() => navigateToCirclesList()}>
        <ChevronLeft className="h-4 w-4" />
        Back to circles
      </Button>

      {message && <div className="rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">{message}</div>}

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardContent className="space-y-4 p-5">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{circle.externalId}</Badge>
                  <SyncBadge state={circle.syncState} />
                  <Badge variant="secondary">external ID route</Badge>
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
                <Button size="sm" disabled={isLoading || isRefreshing} onClick={() => void refresh()}>
                  <RefreshCw className="h-4 w-4" />
                  Refresh circle
                </Button>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-4">
              <Stat label="Catalog works" value={String(circle.catalogWorks || circle.works.length)} />
              <Stat label="Imported" value={String(importedCount)} />
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
            <div className="grid gap-2">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="circle-refresh-mode">Catalog crawl</label>
              <select
                id="circle-refresh-mode"
                className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                value={refreshMode}
                onChange={(event) => setRefreshMode(event.target.value as "incremental" | "full")}
              >
                <option value="incremental">Incremental pages</option>
                <option value="full">Full catalog pages</option>
              </select>
            </div>
            <div className="grid gap-2">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="circle-product-mode">Product JSON</label>
              <select
                id="circle-product-mode"
                className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                value={productMode}
                onChange={(event) => setProductMode(event.target.value as "available" | "all")}
              >
                <option value="available">Available source only</option>
                <option value="all">All catalog works</option>
              </select>
            </div>
            <Shortcut
              title={refreshMode === "full" ? "Run full catalog crawl" : "Run incremental crawl"}
              description={productMode === "all" ? "Fetch paged catalog and product JSON for every catalog work." : "Fetch paged catalog and JSON only for works with sources."}
              disabled={isRefreshing}
              onClick={() => void refresh()}
            />
            <div className="rounded-md border bg-background p-3 text-xs text-muted-foreground">
              Auto refresh policy: use incremental crawl when the last circle sync is older than the configured threshold.
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-3">
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
              <Button variant="outline" size="sm" disabled>
                <ListChecks className="h-4 w-4" />
                Pull selected
              </Button>
            </div>
          </div>

          <div className={circleWorkGridClassName(mobileColumns, desktopColumns)}>
            {filteredWorks.length > 0 ? filteredWorks.map((work) => (
              <CatalogWorkCard
                key={work.primaryCode}
                work={work}
                onDeleteMissing={() => setDeleteTarget(work)}
                onStatusChange={(status) => void updateCatalogWorkStatus(work, status)}
              />
            )) : (
              <Card>
                <CardContent className="p-5 text-sm text-muted-foreground">No catalog works match this view.</CardContent>
              </Card>
            )}
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Source Match</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {sourceTags(circle.sourceSummaries).length > 0 ? sourceTags(circle.sourceSummaries).map((source) => (
              <div key={source.key} className="flex items-center justify-between gap-3 rounded-md border bg-background p-3 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-medium">{source.displayName}</div>
                  <div className="text-xs text-muted-foreground">{source.count} matches</div>
                </div>
                <AvailabilityBadge status={source.status} />
              </div>
            )) : (
              <div className="rounded-md border bg-background p-3 text-sm text-muted-foreground">No source matches yet.</div>
            )}
          </CardContent>
        </Card>
      </section>
      {deleteTarget && (
        <CatalogDeleteConfirmModal
          work={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => void deleteCatalogWork()}
        />
      )}
    </div>
  );
}

function CatalogWorkCard({
  work,
  onDeleteMissing,
  onStatusChange,
}: {
  work: CircleCatalogWork;
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
    <Card className="group h-full overflow-hidden transition-colors hover:border-primary/50">
      <CardContent className="p-0">
        <button
          className={`block w-full text-left ${directoryTarget ? "cursor-pointer" : "cursor-default"}`}
          disabled={!directoryTarget}
          onClick={openTarget}
        >
          <div className="relative aspect-[4/3] overflow-hidden bg-muted">
            {work.coverUrl ? <img src={assetURL(work.coverUrl)} alt="" className="h-full w-full object-contain" /> : null}
            <div className="absolute left-3 top-3 rounded-md bg-background/90 px-2 py-1 text-xs font-semibold">{work.primaryCode}</div>
          </div>
          <div className="flex min-h-52 flex-col gap-3 p-4">
            <div className="space-y-1">
              <h3 className="line-clamp-2 min-h-10 text-base font-semibold leading-snug">{work.title}</h3>
              <div className="truncate text-xs text-muted-foreground">{work.releaseDate ?? "Unknown release"}</div>
            </div>
            <div className="flex min-h-6 flex-wrap gap-1.5">
              <Badge variant={work.catalogStatus === "imported" ? "secondary" : "outline"}>{work.catalogStatus}</Badge>
              {!work.dlsiteAvailable && <Badge variant="warning">DLsite missing</Badge>}
              {work.listeningMark !== "none" && <Badge variant="warning">{listeningStatusLabel(work.listeningMark)}</Badge>}
            </div>
            <div className="grid gap-1 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <FileAudio className="h-3.5 w-3.5" />
                <span>{work.local || work.remote ? "Matched file source" : "No playable source"}</span>
              </div>
            </div>
            <div className="mt-auto flex min-h-6 flex-wrap gap-1.5">
              {tags.length > 0 ? tags.map((tag) => (
                <Badge key={tag.key} variant={tag.key === "local" ? "secondary" : "outline"}>
                  {tag.displayName}
                </Badge>
              )) : <Badge variant="warning">Unavailable</Badge>}
            </div>
          </div>
        </button>
        <div className="flex h-11 items-center justify-between gap-1 border-t px-3">
          <div className="relative" ref={markMenuRef}>
            <Button
              variant="ghost"
              size="sm"
              disabled={isUnavailable || work.workId === null}
              onClick={(event) => {
                event.stopPropagation();
                setIsMarkOpen((value) => !value);
              }}
            >
              <ListChecks className={work.listeningMark === "none" ? "h-4 w-4" : "h-4 w-4 text-primary"} />
              {listeningStatusLabel(work.listeningMark)}
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
          <div className="flex items-center gap-1">
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

function Shortcut({ title, description, disabled, onClick }: { title: string; description: string; disabled?: boolean; onClick?: () => void }) {
  return (
    <button
      className="flex w-full items-center justify-between gap-3 rounded-md border bg-background p-3 text-left text-sm hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
      disabled={disabled}
      onClick={onClick}
    >
      <span>
        <span className="block font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
      <RefreshCw className="h-4 w-4 shrink-0 text-primary" />
    </button>
  );
}

function SyncBadge({ state }: { state: string }) {
  const label = state === "fresh" ? "fresh" : state === "stale" ? "needs refresh" : "first pull";
  return <Badge variant={state === "fresh" ? "secondary" : "warning"}>{label}</Badge>;
}

function AvailabilityBadge({ status }: { status: string }) {
  return <Badge variant={status === "available" ? "outline" : "warning"}>{status}</Badge>;
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

function fakeDetail(externalId: string): CircleDetail {
  return {
    ...fallbackCircles[0],
    externalId,
    works: fallbackWorks,
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

function sourceTags(sources: CircleSourceStat[]) {
  const seen = new Set<string>();
  return sources.filter((source) => {
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
