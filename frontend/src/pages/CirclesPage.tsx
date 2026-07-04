import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Database,
  ExternalLink,
  FileAudio,
  HardDrive,
  ListChecks,
  NotebookPen,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Star,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const PLACEHOLDER_CIRCLE_ID = "RG012345";

type CircleSummary = {
  externalId: string;
  name: string;
  aliases: string[];
  rating: number;
  note: string;
  localWorks: number;
  playableWorks: number;
  remoteWorks: number;
  missingWorks: number;
  lastSynced: string;
  syncState: "fresh" | "stale" | "pending";
};

type CircleCatalogWork = {
  code: string;
  title: string;
  releaseDate: string;
  dlsiteStatus: "catalog" | "imported";
  mark: "none" | "want" | "listening" | "finished";
  local: "available" | "missing";
  cache: "available" | "missing";
  remote: "available" | "missing" | "unavailable";
  userTags: string[];
};

const circles: CircleSummary[] = [
  {
    externalId: "RG012345",
    name: "Fake Circle 001",
    aliases: ["Demo Circle Alias 001"],
    rating: 4,
    note: "Fake note: review catalog refresh behavior.",
    localWorks: 12,
    playableWorks: 9,
    remoteWorks: 22,
    missingWorks: 5,
    lastSynced: "2099-01-01",
    syncState: "stale",
  },
  {
    externalId: "RG023456",
    name: "Fake Circle 002",
    aliases: ["Demo Circle Alias 002"],
    rating: 3,
    note: "Fake note: source match needs review.",
    localWorks: 4,
    playableWorks: 3,
    remoteWorks: 8,
    missingWorks: 2,
    lastSynced: "2099-02-02",
    syncState: "fresh",
  },
  {
    externalId: "RG034567",
    name: "Fake Circle 003",
    aliases: ["Demo Circle Alias 003"],
    rating: 0,
    note: "Fake note: first pull placeholder.",
    localWorks: 0,
    playableWorks: 0,
    remoteWorks: 3,
    missingWorks: 7,
    lastSynced: "never",
    syncState: "pending",
  },
];

const catalogWorks: CircleCatalogWork[] = [
  {
    code: "RJ0123456",
    title: "Demo Circle Catalog Work 001",
    releaseDate: "2099-01-01",
    dlsiteStatus: "imported",
    mark: "listening",
    local: "available",
    cache: "available",
    remote: "available",
    userTags: ["fake-user-tag-001", "fake-user-tag-002"],
  },
  {
    code: "RJ0234567",
    title: "Demo Circle Catalog Work 002",
    releaseDate: "2099-02-02",
    dlsiteStatus: "catalog",
    mark: "want",
    local: "missing",
    cache: "missing",
    remote: "available",
    userTags: ["fake-user-tag-003"],
  },
  {
    code: "RJ0345678",
    title: "Demo Circle Catalog Work 003",
    releaseDate: "2099-03-03",
    dlsiteStatus: "catalog",
    mark: "none",
    local: "missing",
    cache: "missing",
    remote: "unavailable",
    userTags: [],
  },
  {
    code: "RJ0456789",
    title: "Demo Circle Catalog Work 004",
    releaseDate: "2099-04-04",
    dlsiteStatus: "imported",
    mark: "finished",
    local: "available",
    cache: "missing",
    remote: "available",
    userTags: ["fake-user-tag-004"],
  },
];

const sourceRows = [
  { name: "Local library", status: "available", count: 12, icon: HardDrive },
  { name: "Fake Remote Source 001", status: "available", count: 22, icon: Cloud },
  { name: "Fake Remote Source 002", status: "unavailable", count: 0, icon: Database },
];

export function CirclesPage() {
  const externalId = circleExternalIdFromPath(window.location.pathname);
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
        <Stat label="Known circles" value="123" />
        <Stat label="Rated" value="45" />
        <Stat label="Needs refresh" value="8" />
        <Stat label="Remote matches" value="88" />
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between rounded-lg border bg-card px-3 py-2 text-sm">
          <div className="text-muted-foreground">Page 1 · fake local database result set</div>
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
          {circles.map((circle) => (
            <Card key={circle.externalId} className="transition-colors hover:border-primary/50">
              <CardContent className="space-y-3 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <button className="min-w-0 text-left" onClick={() => openCircleRoute(circle.externalId)}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{circle.externalId}</Badge>
                      <SyncBadge state={circle.syncState} />
                    </div>
                    <h3 className="mt-2 truncate text-base font-semibold">{circle.name}</h3>
                    <p className="truncate text-sm text-muted-foreground">{circle.aliases.join(", ")}</p>
                  </button>
                  <div className="flex items-center gap-1 text-sm font-medium">
                    <Star className="h-4 w-4 fill-current text-primary" />
                    {circle.rating > 0 ? circle.rating : "Unrated"}
                  </div>
                </div>

                <div className="grid gap-2 sm:grid-cols-4">
                  <MiniStat label="Local" value={circle.localWorks} />
                  <MiniStat label="Playable" value={circle.playableWorks} />
                  <MiniStat label="Remote" value={circle.remoteWorks} />
                  <MiniStat label="Missing" value={circle.missingWorks} />
                </div>

                <div className="rounded-md border bg-background p-3 text-sm">
                  <div className="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <NotebookPen className="h-3.5 w-3.5" />
                    User note
                  </div>
                  <p className="text-muted-foreground">{circle.note}</p>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>Last synced: {circle.lastSynced}</span>
                  <Button variant="outline" size="sm" onClick={() => openCircleRoute(circle.externalId)}>
                    Open
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}

function CircleDetailPage({ externalId }: { externalId: string }) {
  const circle = circles.find((item) => item.externalId.toLowerCase() === externalId.toLowerCase()) ?? {
    ...circles[0],
    externalId,
    name: "Fake Circle From First Pull",
    aliases: ["Demo Pending Alias"],
    rating: 0,
    note: "Fake note: this represents a first-time DLsite pull.",
    localWorks: 0,
    playableWorks: 0,
    remoteWorks: 0,
    missingWorks: 0,
    lastSynced: "never",
    syncState: "pending" as const,
  };
  const importedCount = catalogWorks.filter((work) => work.dlsiteStatus === "imported").length;
  const playableCount = catalogWorks.filter((work) => work.local === "available" || work.cache === "available").length;

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
                  <Badge variant="secondary">external ID route</Badge>
                </div>
                <h2 className="mt-3 truncate text-2xl font-semibold lg:text-3xl">{circle.name}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{circle.aliases.join(", ")}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm">
                  <ExternalLink className="h-4 w-4" />
                  DLsite
                </Button>
                <Button size="sm">
                  <RefreshCw className="h-4 w-4" />
                  Refresh circle
                </Button>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-4">
              <Stat label="Catalog works" value="128" />
              <Stat label="Imported" value={String(importedCount)} />
              <Stat label="Playable" value={String(playableCount)} />
              <Stat label="Unavailable" value={String(catalogWorks.filter((work) => work.remote === "unavailable").length)} />
            </div>

            <div className="grid gap-3 lg:grid-cols-[180px_minmax(0,1fr)]">
              <Card>
                <CardContent className="space-y-2 p-4">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Star className="h-4 w-4 fill-current text-primary" />
                    User rating
                  </div>
                  <div className="text-2xl font-semibold">{circle.rating > 0 ? `${circle.rating}/5` : "Unrated"}</div>
                  <Button variant="outline" size="sm" className="w-full">
                    Edit rating
                  </Button>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="space-y-2 p-4">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <NotebookPen className="h-4 w-4 text-primary" />
                    User note
                  </div>
                  <p className="text-sm text-muted-foreground">{circle.note}</p>
                  <Button variant="outline" size="sm">
                    Edit note
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
            <Shortcut title="Refresh circle info" description="Pull fake DLsite circle profile and aliases." />
            <Shortcut title="Refresh catalog" description="Pull fake DLsite work pages for this external ID." />
            <Shortcut title="Check sources" description="Match catalog works against all configured file sources." />
            <div className="rounded-md border bg-background p-3 text-xs text-muted-foreground">
              Auto refresh policy placeholder: refresh on page entry when last sync is older than 1 month.
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-3">
          <div className="flex flex-col gap-2 rounded-lg border bg-card p-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-h-10 flex-1 items-center gap-2 rounded-md border bg-background px-3 text-sm text-muted-foreground">
              <Search className="h-4 w-4" />
              <span>Search fake DLsite catalog works</span>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm">
                <SlidersHorizontal className="h-4 w-4" />
                Availability
              </Button>
              <Button variant="outline" size="sm">
                <ListChecks className="h-4 w-4" />
                Pull selected
              </Button>
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
            {catalogWorks.map((work) => (
              <CatalogWorkCard key={work.code} work={work} />
            ))}
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Source Match</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {sourceRows.map((source) => (
              <div key={source.name} className="flex items-center justify-between gap-3 rounded-md border bg-background p-3 text-sm">
                <div className="flex min-w-0 items-center gap-2">
                  <source.icon className="h-4 w-4 shrink-0 text-primary" />
                  <div className="min-w-0">
                    <div className="truncate font-medium">{source.name}</div>
                    <div className="text-xs text-muted-foreground">{source.count} fake matches</div>
                  </div>
                </div>
                <AvailabilityBadge status={source.status} />
              </div>
            ))}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function CatalogWorkCard({ work }: { work: CircleCatalogWork }) {
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="aspect-[4/3] rounded-md border bg-muted" />
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{work.code}</Badge>
            <Badge variant={work.dlsiteStatus === "imported" ? "secondary" : "outline"}>{work.dlsiteStatus}</Badge>
            {work.mark !== "none" && <Badge>{work.mark}</Badge>}
          </div>
          <h3 className="line-clamp-2 min-h-10 text-sm font-semibold">{work.title}</h3>
          <div className="truncate text-xs text-muted-foreground">{work.releaseDate}</div>
        </div>
        <div className="flex min-h-6 flex-wrap gap-1">
          {work.userTags.length > 0 ? (
            work.userTags.map((tag) => (
              <Badge key={tag} variant="outline">
                {tag}
              </Badge>
            ))
          ) : (
            <span className="text-xs text-muted-foreground">No fake user tags</span>
          )}
        </div>
        <div className="grid grid-cols-3 gap-1 text-xs">
          <SourcePill label="Local" status={work.local} />
          <SourcePill label="Cache" status={work.cache} />
          <SourcePill label="Remote" status={work.remote} />
        </div>
      </CardContent>
    </Card>
  );
}

function SourcePill({ label, status }: { label: string; status: "available" | "missing" | "unavailable" }) {
  const isGood = status === "available";
  const isUnavailable = status === "unavailable";
  return (
    <div className={`flex min-h-8 items-center justify-center gap-1 rounded-md border px-2 ${isGood ? "bg-secondary text-secondary-foreground" : "bg-background text-muted-foreground"}`}>
      {isGood ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
      <span className="truncate">{isUnavailable ? "N/A" : label}</span>
    </div>
  );
}

function Shortcut({ title, description }: { title: string; description: string }) {
  return (
    <button className="flex w-full items-center justify-between gap-3 rounded-md border bg-background p-3 text-left text-sm hover:bg-muted">
      <span>
        <span className="block font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
      <RefreshCw className="h-4 w-4 shrink-0 text-primary" />
    </button>
  );
}

function SyncBadge({ state }: { state: CircleSummary["syncState"] }) {
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
