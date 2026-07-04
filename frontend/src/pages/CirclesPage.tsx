import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileAudio,
  FolderTree,
  ListChecks,
  NotebookPen,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Star,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, assetURL, type CircleCatalogWork, type CircleDetail, type CircleSourceStat, type CircleSummary } from "@/lib/api";

const PLACEHOLDER_CIRCLE_ID = "RG012345";

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
    listeningMark: "want",
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
  const ratedCount = visibleCircles.filter((circle) => circle.rating !== null && circle.rating > 0).length;
  const needsRefresh = visibleCircles.filter((circle) => circle.syncState !== "fresh").length;
  const remoteMatches = visibleCircles.reduce((total, circle) => total + circle.remoteWorks, 0);

  return (
    <div className="space-y-5">
      <section className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-sm text-muted-foreground">Local party index with user rating and notes</p>
          <h2 className="text-xl font-semibold">Circles</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm">
            <Search className="h-4 w-4" />
            Search
          </Button>
          <Button variant="outline" size="sm">
            <SlidersHorizontal className="h-4 w-4" />
            Filters
          </Button>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Known circles" value={String(visibleCircles.length)} />
        <Stat label="Rated" value={String(ratedCount)} />
        <Stat label="Needs refresh" value={String(needsRefresh)} />
        <Stat label="Remote matches" value={String(remoteMatches)} />
      </section>

      {message && <div className="rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">{message}</div>}

      <section className="space-y-3">
        <div className="flex items-center justify-between rounded-lg border bg-card px-3 py-2 text-sm">
          <div className="text-muted-foreground">{isLoading ? "Loading circles..." : "Page 1 · local database result set"}</div>
          <div className="flex gap-2">
            <Button variant="outline" size="icon" aria-label="Previous page">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="icon" aria-label="Next page">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="grid gap-3 xl:grid-cols-2">
          {visibleCircles.map((circle) => (
            <CircleCard key={circle.externalId} circle={circle} />
          ))}
        </div>
      </section>
    </div>
  );
}

function CircleCard({ circle }: { circle: CircleSummary }) {
  return (
    <Card className="transition-colors hover:border-primary/50">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <button className="min-w-0 text-left" onClick={() => openCircleRoute(circle.externalId)}>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{circle.externalId}</Badge>
              <SyncBadge state={circle.syncState} />
            </div>
            <h3 className="mt-2 truncate text-base font-semibold">{circle.displayName}</h3>
            <p className="truncate text-sm text-muted-foreground">{circle.aliases.join(", ") || "No aliases"}</p>
          </button>
          <div className="flex items-center gap-1 text-sm font-medium">
            <Star className="h-4 w-4 fill-current text-primary" />
            {circle.rating !== null && circle.rating > 0 ? circle.rating : "Unrated"}
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-4">
          <MiniStat label="Local" value={circle.localWorks} />
          <MiniStat label="Playable" value={circle.playableWorks} />
          <MiniStat label="Remote" value={circle.remoteWorks} />
          <MiniStat label="Missing" value={circle.missingWorks} />
        </div>

        <div className="flex min-h-6 flex-wrap gap-1">
          {sourceTags(circle.sourceSummaries).map((source) => (
            <Badge key={source.key} variant={source.key === "local" ? "secondary" : "outline"}>
              {source.displayName}
              {source.count > 0 ? ` ${source.count}` : ""}
            </Badge>
          ))}
        </div>

        <div className="rounded-md border bg-background p-3 text-sm">
          <div className="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <NotebookPen className="h-3.5 w-3.5" />
            User note
          </div>
          <p className="text-muted-foreground">{circle.note || "No note yet."}</p>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>Last synced: {circle.lastSyncedAt ?? "never"}</span>
          <Button variant="outline" size="sm" onClick={() => openCircleRoute(circle.externalId)}>
            Open
          </Button>
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
  const [cardLayout, setCardLayout] = useState<"single" | "adaptive">("adaptive");

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
  const importedCount = circle.works.filter((work) => work.catalogStatus === "imported").length;
  const playableCount = circle.works.filter((work) => work.local || work.remote).length;

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
              <span>Search circle catalog works</span>
            </div>
            <div className="flex gap-2">
              <div className="flex rounded-md border bg-background p-1 sm:hidden" aria-label="Catalog card layout">
                <button
                  className={`h-7 rounded px-2 text-xs font-medium ${cardLayout === "single" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
                  onClick={() => setCardLayout("single")}
                >
                  1
                </button>
                <button
                  className={`h-7 rounded px-2 text-xs font-medium ${cardLayout === "adaptive" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
                  onClick={() => setCardLayout("adaptive")}
                >
                  2
                </button>
              </div>
              <Button variant="outline" size="sm">
                <SlidersHorizontal className="h-4 w-4" />
                Availability
              </Button>
              <Button variant="outline" size="sm" disabled>
                <ListChecks className="h-4 w-4" />
                Pull selected
              </Button>
            </div>
          </div>

          <div className={circleWorkGridClassName(cardLayout)}>
            {circle.works.length > 0 ? circle.works.map((work) => (
              <CatalogWorkCard key={work.primaryCode} work={work} />
            )) : (
              <Card>
                <CardContent className="p-5 text-sm text-muted-foreground">No catalog works have been derived yet.</CardContent>
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
    </div>
  );
}

function CatalogWorkCard({ work }: { work: CircleCatalogWork }) {
  const directoryTarget = preferredDirectoryTarget(work);
  const tags = sourceTags(work.sourceTags);
  return (
    <Card className="group h-full overflow-hidden transition-colors hover:border-primary/50">
      <CardContent className="p-0">
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
            {work.listeningMark !== "none" && <Badge variant="warning">{work.listeningMark}</Badge>}
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
        <div className="flex h-11 items-center justify-between border-t px-3">
          <Button variant="ghost" size="sm" disabled={!directoryTarget} onClick={() => directoryTarget && openWorkDirectoryRoute(directoryTarget)}>
            <FolderTree className="h-4 w-4" />
            Open files
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <a href={work.dlsiteUrl || dlsiteWorkURL(work.primaryCode)} target="_blank" rel="noreferrer">
              <ExternalLink className="h-4 w-4" />
              DLsite
            </a>
          </Button>
        </div>
      </CardContent>
    </Card>
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

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border bg-background p-2">
      <div className="text-base font-semibold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function fakeDetail(externalId: string): CircleDetail {
  return {
    ...fallbackCircles[0],
    externalId,
    works: fallbackWorks,
  };
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

function circleWorkGridClassName(mode: "single" | "adaptive") {
  return mode === "single"
    ? "grid grid-cols-1 gap-4"
    : "grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(100%,600px),1fr))]";
}
