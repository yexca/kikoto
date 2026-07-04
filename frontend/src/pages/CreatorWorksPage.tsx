import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Database,
  ExternalLink,
  HardDrive,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Tag,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type CreatorKind = "circle" | "voice";

type CreatorWork = {
  code: string;
  title: string;
  circle: string;
  release: string;
  rating: string;
  dlsiteTags: string[];
  local: "available" | "missing";
  cache: "available" | "missing";
  remote: "available" | "missing" | "unavailable";
  mark: "none" | "want" | "listening" | "finished";
};

const sourceRows = [
  { name: "Local library", status: "available", count: 12, icon: HardDrive },
  { name: "Fake Remote Source 001", status: "available", count: 28, icon: Cloud },
  { name: "Fake Remote Source 002", status: "unavailable", count: 0, icon: Database },
];

const circleWorks: CreatorWork[] = [
  {
    code: "RJ0123456",
    title: "Demo Circle Work 001",
    circle: "Fake Circle 001",
    release: "2099-01-01",
    rating: "0.0",
    dlsiteTags: ["fake-dlsite-tag-a", "fake-dlsite-tag-b", "fake-dlsite-tag-c"],
    local: "available",
    cache: "available",
    remote: "available",
    mark: "listening",
  },
  {
    code: "RJ0234567",
    title: "Demo Circle Work 002",
    circle: "Fake Circle 001",
    release: "2099-02-02",
    rating: "0.0",
    dlsiteTags: ["fake-dlsite-tag-d", "fake-dlsite-tag-e", "fake-dlsite-tag-f"],
    local: "missing",
    cache: "missing",
    remote: "available",
    mark: "want",
  },
  {
    code: "RJ0345678",
    title: "Demo Circle Work 003",
    circle: "Fake Circle 001",
    release: "2099-03-03",
    rating: "0.0",
    dlsiteTags: ["fake-dlsite-tag-g", "fake-dlsite-tag-h", "fake-dlsite-tag-i"],
    local: "missing",
    cache: "missing",
    remote: "unavailable",
    mark: "none",
  },
];

const voiceWorks: CreatorWork[] = [
  {
    code: "RJ0456789",
    title: "Demo Voice Work 001",
    circle: "Fake Circle 002",
    release: "2099-04-04",
    rating: "0.0",
    dlsiteTags: ["fake-dlsite-tag-j", "fake-dlsite-tag-k", "fake-dlsite-tag-l"],
    local: "available",
    cache: "available",
    remote: "available",
    mark: "finished",
  },
  {
    code: "RJ0567890",
    title: "Demo Voice Work 002",
    circle: "Fake Circle 003",
    release: "2099-05-05",
    rating: "0.0",
    dlsiteTags: ["fake-dlsite-tag-m", "fake-dlsite-tag-n", "fake-dlsite-tag-o"],
    local: "available",
    cache: "missing",
    remote: "available",
    mark: "listening",
  },
  {
    code: "RJ0678901",
    title: "Demo Voice Work 003",
    circle: "Fake Circle 004",
    release: "2099-06-06",
    rating: "0.0",
    dlsiteTags: ["fake-dlsite-tag-p", "fake-dlsite-tag-q", "fake-dlsite-tag-r"],
    local: "missing",
    cache: "missing",
    remote: "missing",
    mark: "want",
  },
];

export function CreatorWorksPage({ kind }: { kind: CreatorKind }) {
  const isCircle = kind === "circle";
  const creatorName = isCircle ? "Fake Circle 001" : "Fake Voice Actor 001";
  const works = isCircle ? circleWorks : voiceWorks;
  const subtitle = isCircle ? "Circle works from DLsite, matched against configured file sources" : "Voice actor works from DLsite, matched against configured file sources";
  const importedCount = works.filter((work) => work.local === "available" || work.cache === "available" || work.remote === "available").length;
  const playableCount = works.filter((work) => work.local === "available" || work.cache === "available").length;

  return (
    <div className="space-y-5">
      <section className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{isCircle ? "Circle" : "Voice actor"}</Badge>
            <Badge variant="secondary">DLsite page 1</Badge>
          </div>
          <h2 className="mt-2 truncate text-2xl font-semibold">{creatorName}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{subtitle}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm">
            <ExternalLink className="h-4 w-4" />
            DLsite
          </Button>
          <Button variant="outline" size="sm">
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="DLsite works" value="128" />
        <Stat label="Known in Kikoto" value={String(importedCount)} />
        <Stat label="Playable now" value={String(playableCount)} />
        <Stat label="Unavailable" value={String(works.filter((work) => work.remote === "unavailable").length)} />
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-3">
          <div className="flex flex-col gap-2 rounded-lg border bg-card p-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-h-10 flex-1 items-center gap-2 rounded-md border bg-background px-3 text-sm text-muted-foreground">
              <Search className="h-4 w-4" />
              <span>Search this creator's works</span>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm">
                <SlidersHorizontal className="h-4 w-4" />
                Availability
              </Button>
              <Button variant="outline" size="sm">
                <Tag className="h-4 w-4" />
                User tag
              </Button>
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
            {works.map((work) => (
              <CreatorWorkCard key={work.code} work={work} />
            ))}
          </div>

          <div className="flex items-center justify-between rounded-lg border bg-card px-3 py-2">
            <div className="text-sm text-muted-foreground">DLsite page 1 of 6</div>
            <div className="flex gap-2">
              <Button variant="outline" size="icon" aria-label="Previous page">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="icon" aria-label="Next page">
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
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
                    <div className="text-xs text-muted-foreground">{source.count} matching works</div>
                  </div>
                </div>
                <AvailabilityBadge status={source.status} />
              </div>
            ))}
            <div className="rounded-md border bg-background p-3 text-xs text-muted-foreground">
              The DLsite result set stays browse-only until a work is marked, fetched, played, or explicitly pulled into Kikoto.
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function CreatorWorkCard({ work }: { work: CreatorWork }) {
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="aspect-[4/3] rounded-md border bg-muted" />
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{work.code}</Badge>
            {work.mark !== "none" && <Badge>{work.mark}</Badge>}
          </div>
          <h3 className="line-clamp-2 min-h-10 text-sm font-semibold">{work.title}</h3>
          <div className="truncate text-xs text-muted-foreground">
            {work.circle} · {work.release} · {work.rating}
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          {work.dlsiteTags.map((tag) => (
            <Badge key={tag} variant="outline">
              {tag}
            </Badge>
          ))}
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
