import {
  ChevronLeft,
  ChevronRight,
  Cloud,
  Database,
  ExternalLink,
  HardDrive,
  Layers3,
  Loader2,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api, assetURL, type CircleSourceStat, type VoiceDetail, type VoiceKnownWork, type VoiceRemoteSourceSet, type VoiceRemoteWork, type VoiceSummary } from "@/lib/api";

type CreatorKind = "circle" | "voice";
type VoiceFilter = "all" | "available" | "local" | "remote" | "missing";
const voicePageSizeOptions = [20, 40, 80];
const workPageSizeOptions = [24, 48] as const;

export function CreatorWorksPage({ kind }: { kind: CreatorKind }) {
  if (kind !== "voice") {
    return <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">Circle creator view has moved to Circles.</div>;
  }
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
  const personId = voicePersonIdFromPath(path);
  if (personId) return <VoiceDetailPage personId={personId} />;
  return <VoiceListPage />;
}

function VoiceListPage() {
  const [voices, setVoices] = useState<VoiceSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<VoiceFilter>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(40);

  useEffect(() => {
    setIsLoading(true);
    api.listVoices().then((items) => {
      setVoices(items);
      setMessage(items.length === 0 ? "No voice actor credits have been derived from known work metadata yet." : "");
    }).catch((error) => {
      setVoices([]);
      setMessage(error instanceof Error ? error.message : "Voice actor API is unavailable.");
    }).finally(() => setIsLoading(false));
  }, []);

  const filteredVoices = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return voices.filter((voice) => {
      const matchesQuery = !needle || [voice.displayName, voice.personId, ...voice.aliases].some((value) => value.toLowerCase().includes(needle));
      if (!matchesQuery) return false;
      switch (filter) {
      case "available":
        return voice.playableWorks > 0;
      case "local":
        return voice.localWorks > 0;
      case "remote":
        return voice.remoteWorks > 0;
      case "missing":
        return voice.playableWorks === 0;
      default:
        return true;
      }
    });
  }, [filter, query, voices]);
  const totalPages = Math.max(1, Math.ceil(filteredVoices.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageVoices = filteredVoices.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  useEffect(() => setPage(1), [filter, pageSize, query]);

  return (
    <div className="space-y-5">
      <section className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-sm text-muted-foreground">Credits derived from known works, matched against configured sources</p>
          <h2 className="text-xl font-semibold">Voice Actors</h2>
        </div>
        <Badge variant="outline">{isLoading ? "Loading" : `${filteredVoices.length} voices`}</Badge>
      </section>

      {message && <div className="rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">{message}</div>}

      <section className="space-y-3">
        <div className="flex flex-col gap-3 rounded-lg border bg-card p-3 text-sm xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md border bg-background px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input className="min-w-0 flex-1 bg-transparent outline-none" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search voices" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select className="h-9 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring" value={filter} onChange={(event) => setFilter(event.target.value as VoiceFilter)} aria-label="Voice filter">
              <option value="all">All voices</option>
              <option value="available">Available</option>
              <option value="local">Local</option>
              <option value="remote">Remote</option>
              <option value="missing">Missing</option>
            </select>
            <select className="h-9 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring" value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))} aria-label="Voices per page">
              {voicePageSizeOptions.map((value) => <option key={value} value={value}>{value} / page</option>)}
            </select>
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {pageVoices.map((voice) => <VoiceCard key={voice.personId} voice={voice} />)}
          {pageVoices.length === 0 && <Card><CardContent className="p-5 text-sm text-muted-foreground">No voice actors match this view.</CardContent></Card>}
        </div>

        {totalPages > 1 && <Pagination currentPage={currentPage} totalPages={totalPages} onPage={setPage} />}
      </section>
    </div>
  );
}

function VoiceCard({ voice }: { voice: VoiceSummary }) {
  return (
    <Card>
      <CardContent className="p-4">
        <button className="grid w-full gap-3 text-left sm:grid-cols-[minmax(0,1fr)_auto]" onClick={() => openVoiceRoute(voice.personId)}>
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">Voice</Badge>
              {voice.playableWorks > 0 && <Badge variant="secondary">{voice.playableWorks} playable</Badge>}
            </div>
            <h3 className="truncate text-base font-semibold">{voice.displayName}</h3>
            <SourceTags sources={voice.sourceSummaries} />
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs sm:w-44">
            <MiniStat label="Known" value={voice.knownWorks} />
            <MiniStat label="Local" value={voice.localWorks} />
            <MiniStat label="Remote" value={voice.remoteWorks} />
            <MiniStat label="Cache" value={voice.cachedWorks} />
          </div>
        </button>
      </CardContent>
    </Card>
  );
}

function VoiceDetailPage({ personId }: { personId: string }) {
  const [detail, setDetail] = useState<VoiceDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<VoiceFilter>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof workPageSizeOptions)[number]>(24);

  useEffect(() => {
    setIsLoading(true);
    api.getVoice(personId).then((item) => {
      setDetail(item);
      setMessage("");
    }).catch((error) => {
      setDetail(null);
      setMessage(error instanceof Error ? error.message : "Voice actor detail is unavailable.");
    }).finally(() => setIsLoading(false));
  }, [personId]);

  const knownWorks = detail?.works ?? [];
  const remoteWorks = useMemo(() => (detail?.remoteMatches ?? []).flatMap((source) => source.works), [detail]);
  const mergedWorks = useMemo(() => {
    const map = new Map<string, VoiceKnownWork | VoiceRemoteWork>();
    knownWorks.forEach((work) => map.set(work.primaryCode, work));
    remoteWorks.forEach((work) => {
      if (!map.has(work.primaryCode)) map.set(work.primaryCode, work);
    });
    return Array.from(map.values());
  }, [knownWorks, remoteWorks]);
  const filteredWorks = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return mergedWorks.filter((work) => {
      const matchesQuery = !needle || [work.primaryCode, work.title, work.circle].some((value) => value.toLowerCase().includes(needle));
      if (!matchesQuery) return false;
      const local = "local" in work ? work.local : work.hasLocal;
      const remote = "remote" in work ? work.remote : work.hasRemote || work.remotePlayable;
      const cache = "cache" in work ? work.cache : work.hasCache;
      switch (filter) {
      case "available":
        return local || remote || cache;
      case "local":
        return local;
      case "remote":
        return remote;
      case "missing":
        return !local && !remote && !cache;
      default:
        return true;
      }
    });
  }, [filter, mergedWorks, query]);
  const totalPages = Math.max(1, Math.ceil(filteredWorks.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageWorks = filteredWorks.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  useEffect(() => setPage(1), [filter, pageSize, query]);

  if (isLoading) {
    return <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading voice actor</div>;
  }

  if (!detail) {
    return (
      <div className="space-y-3">
        <Button variant="outline" size="sm" onClick={() => navigateToVoicesList()}><ChevronLeft className="h-4 w-4" /> Back to voices</Button>
        <div className="rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">{message}</div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <section className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <Button variant="outline" size="sm" onClick={() => navigateToVoicesList()}><ChevronLeft className="h-4 w-4" /> Back to voices</Button>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge variant="outline">Voice</Badge>
            <Badge variant="secondary">/voices/{detail.personId}</Badge>
          </div>
          <h2 className="mt-2 truncate text-2xl font-semibold">{detail.displayName}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Known work credits plus Kikoeru-compatible remote matches. DLsite voice keyword crawling is not used.</p>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Stat label="Known works" value={detail.knownWorks} icon={<Database className="h-4 w-4" />} />
        <Stat label="Playable" value={detail.playableWorks} icon={<Layers3 className="h-4 w-4" />} />
        <Stat label="Local" value={detail.localWorks} icon={<HardDrive className="h-4 w-4" />} />
        <Stat label="Remote" value={detail.remoteWorks} icon={<Cloud className="h-4 w-4" />} />
        <Stat label="Remote matches" value={remoteWorks.length} icon={<Search className="h-4 w-4" />} />
      </section>

      {message && <div className="rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">{message}</div>}

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_330px]">
        <div className="space-y-3">
          <div className="flex flex-col gap-3 rounded-lg border bg-card p-3 text-sm xl:flex-row xl:items-center xl:justify-between">
            <div className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md border bg-background px-3">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input className="min-w-0 flex-1 bg-transparent outline-none" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search works" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
              <select className="h-9 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring" value={filter} onChange={(event) => setFilter(event.target.value as VoiceFilter)} aria-label="Work filter">
                <option value="all">All works</option>
                <option value="available">Available</option>
                <option value="local">Local</option>
                <option value="remote">Remote</option>
                <option value="missing">Missing</option>
              </select>
              <select className="h-9 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring" value={pageSize} onChange={(event) => setPageSize(Number(event.target.value) as 24 | 48)} aria-label="Works per page">
                {workPageSizeOptions.map((value) => <option key={value} value={value}>{value} / page</option>)}
              </select>
            </div>
          </div>
          <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
            {pageWorks.map((work) => <VoiceWorkCard key={`${"sourceId" in work ? work.sourceId : "known"}:${work.primaryCode}`} work={work} />)}
            {pageWorks.length === 0 && <Card><CardContent className="p-5 text-sm text-muted-foreground">No works match this view.</CardContent></Card>}
          </div>
          {totalPages > 1 && <Pagination currentPage={currentPage} totalPages={totalPages} onPage={setPage} />}
        </div>
        <RemoteSourcePanel sources={detail.remoteMatches} />
      </section>
    </div>
  );
}

function VoiceWorkCard({ work }: { work: VoiceKnownWork | VoiceRemoteWork }) {
  const isKnown = "workId" in work && work.workId !== null && "local" in work;
  const status = "importStatus" in work ? work.importStatus : "Known";
  const local = "local" in work ? work.local : work.hasLocal;
  const remote = "remote" in work ? work.remote : work.hasRemote || work.remotePlayable;
  const cache = "cache" in work ? work.cache : work.hasCache;
  const cover = assetURL(work.coverUrl);
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <button className="block w-full text-left" onClick={() => openWorkRoute(work)}>
          <div className="aspect-[4/3] overflow-hidden rounded-md border bg-muted">
            {cover && <img src={cover} alt="" className="h-full w-full object-cover" loading="lazy" />}
          </div>
          <div className="mt-3 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{work.primaryCode || "Remote"}</Badge>
              <Badge variant={isKnown ? "secondary" : "outline"}>{status}</Badge>
            </div>
            <h3 className="line-clamp-2 min-h-10 text-sm font-semibold">{work.title}</h3>
            <div className="truncate text-xs text-muted-foreground">{work.circle || "Unknown circle"}{work.rating ? ` · ${work.rating}` : ""}</div>
          </div>
        </button>
        <div className="flex flex-wrap gap-1">
          {work.tags.slice(0, 5).map((tag) => <Badge key={tag} variant="outline">{tag}</Badge>)}
        </div>
        <div className="grid grid-cols-3 gap-1 text-xs">
          <AvailabilityPill label="Local" active={local} />
          <AvailabilityPill label="Cache" active={cache} />
          <AvailabilityPill label="Remote" active={remote} />
        </div>
      </CardContent>
    </Card>
  );
}

function RemoteSourcePanel({ sources }: { sources: VoiceRemoteSourceSet[] }) {
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div>
          <h3 className="font-semibold">Remote Sources</h3>
          <p className="text-sm text-muted-foreground">Queried with Kikoeru voice search syntax.</p>
        </div>
        {sources.map((source) => (
          <div key={source.sourceId} className="rounded-md border bg-background p-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate font-medium">{source.displayName}</div>
                <div className="text-xs text-muted-foreground">{source.total || source.works.length} matches · {source.elapsedMs} ms</div>
              </div>
              <Badge variant={source.status === "ok" ? "outline" : "warning"}>{source.status}</Badge>
            </div>
            {source.error && <div className="mt-2 text-xs text-destructive">{source.error}</div>}
          </div>
        ))}
        {sources.length === 0 && <div className="rounded-md border bg-background p-3 text-sm text-muted-foreground">No Kikoeru-compatible sources are configured.</div>}
      </CardContent>
    </Card>
  );
}

function SourceTags({ sources }: { sources: CircleSourceStat[] }) {
  if (sources.length === 0) return <div className="text-xs text-muted-foreground">No playable source yet</div>;
  return <div className="flex flex-wrap gap-1">{sources.map((source) => <Badge key={source.key} variant="outline">{source.displayName} {source.count}</Badge>)}</div>;
}

function AvailabilityPill({ label, active }: { label: string; active: boolean }) {
  return <div className={`flex min-h-8 items-center justify-center rounded-md border px-2 ${active ? "bg-secondary text-secondary-foreground" : "bg-background text-muted-foreground"}`}>{label}</div>;
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return <div className="rounded-md border bg-background p-2"><div className="font-semibold">{value}</div><div className="text-muted-foreground">{label}</div></div>;
}

function Stat({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return <Card><CardContent className="flex items-center justify-between gap-3 p-4"><div><div className="text-2xl font-semibold">{value}</div><div className="text-sm text-muted-foreground">{label}</div></div><div className="text-primary">{icon}</div></CardContent></Card>;
}

function Pagination({ currentPage, totalPages, onPage }: { currentPage: number; totalPages: number; onPage: (page: number) => void }) {
  return (
    <div className="flex items-center justify-between rounded-lg border bg-card px-3 py-2">
      <div className="text-sm text-muted-foreground">Page {currentPage} of {totalPages}</div>
      <div className="flex gap-2">
        <Button variant="outline" size="icon" aria-label="Previous page" disabled={currentPage <= 1} onClick={() => onPage(Math.max(1, currentPage - 1))}><ChevronLeft className="h-4 w-4" /></Button>
        <Button variant="outline" size="icon" aria-label="Next page" disabled={currentPage >= totalPages} onClick={() => onPage(Math.min(totalPages, currentPage + 1))}><ChevronRight className="h-4 w-4" /></Button>
      </div>
    </div>
  );
}

function voicePersonIdFromPath(path: string) {
  const match = path.match(/^\/voices\/([^/]+)\/?$/i);
  return match ? decodeURIComponent(match[1]) : "";
}

function openVoiceRoute(personId: string) {
  window.history.pushState({}, "", `/voices/${encodeURIComponent(personId)}`);
  window.dispatchEvent(new Event("kikoto:navigation"));
}

function navigateToVoicesList() {
  window.history.pushState({}, "", "/voices");
  window.dispatchEvent(new Event("kikoto:navigation"));
}

function openWorkRoute(work: VoiceKnownWork | VoiceRemoteWork) {
  if ("workId" in work && work.workId) {
    window.history.pushState({}, "", `/${encodeURIComponent(work.primaryCode)}`);
    window.dispatchEvent(new Event("kikoto:navigation"));
    return;
  }
  if ("sourceId" in work && work.primaryCode) {
    window.history.pushState({}, "", `/${encodeURIComponent(work.primaryCode)}?source=${work.sourceId}`);
    window.dispatchEvent(new Event("kikoto:navigation"));
  }
}
