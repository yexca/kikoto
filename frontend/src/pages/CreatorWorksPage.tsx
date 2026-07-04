import {
  ChevronLeft,
  ChevronRight,
  Cloud,
  Database,
  FileAudio,
  HardDrive,
  Layers3,
  Loader2,
  NotebookPen,
  Search,
  SlidersHorizontal,
  Star,
  Tags,
} from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api, assetURL, type CircleSourceStat, type ListeningStatus, type VoiceDetail, type VoiceKnownWork, type VoiceRemoteSourceSet, type VoiceRemoteWork, type VoiceSummary } from "@/lib/api";

type CreatorKind = "circle" | "voice";
type VoiceFilter = "all" | "favorite" | "tagged" | "rated" | "available" | "local" | "remote" | "missing";
type WorkFilter = "all" | "available" | "local" | "remote" | "missing";
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
  const [tagFilter, setTagFilter] = useState("");
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

  const tagOptions = useMemo(() => {
    const names = new Set<string>();
    voices.forEach((voice) => voice.userTags.forEach((tag) => names.add(tag.name)));
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [voices]);

  const filteredVoices = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return voices.filter((voice) => {
      const matchesQuery = !needle || [voice.displayName, String(voice.personId), ...voice.aliases, ...voice.userTags.map((tag) => tag.name)].some((value) => value.toLowerCase().includes(needle));
      if (!matchesQuery) return false;
      if (tagFilter && !voice.userTags.some((tag) => tag.name === tagFilter)) return false;
      switch (filter) {
      case "favorite":
        return voice.favorite;
      case "tagged":
        return voice.userTags.length > 0;
      case "rated":
        return voice.rating !== null && voice.rating > 0;
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
  }, [filter, query, tagFilter, voices]);
  const totalPages = Math.max(1, Math.ceil(filteredVoices.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageVoices = filteredVoices.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  useEffect(() => setPage(1), [filter, pageSize, query, tagFilter]);

  return (
    <div className="space-y-5">
      <section className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-sm text-muted-foreground">Persisted voice credits with personal favorites and tags</p>
          <h2 className="text-xl font-semibold">Voice Actors</h2>
        </div>
        <Badge variant="outline">{isLoading ? "Loading" : `${filteredVoices.length} voices`}</Badge>
      </section>

      {message && <div className="rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">{message}</div>}

      <section className="space-y-3">
        <div className="flex flex-col gap-3 rounded-lg border bg-card p-3 text-sm xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md border bg-background px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input className="min-w-0 flex-1 bg-transparent outline-none" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search voices or tags" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select className="h-9 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring" value={filter} onChange={(event) => setFilter(event.target.value as VoiceFilter)} aria-label="Voice filter">
              <option value="all">All voices</option>
              <option value="favorite">Favorite</option>
              <option value="tagged">Tagged</option>
              <option value="rated">Rated</option>
              <option value="available">Available</option>
              <option value="local">Local</option>
              <option value="remote">Remote</option>
              <option value="missing">Missing</option>
            </select>
            <select className="h-9 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring" value={tagFilter} onChange={(event) => setTagFilter(event.target.value)} aria-label="Voice tag filter">
              <option value="">All tags</option>
              {tagOptions.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
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
    <Card className="transition-colors hover:border-primary/50">
      <CardContent className="space-y-2 p-3">
        <button className="grid w-full gap-2 text-left lg:grid-cols-[minmax(0,1fr)_auto]" onClick={() => openVoiceRoute(voice.personId)}>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">#{voice.personId}</Badge>
              {voice.favorite && <Badge variant="secondary">Favorite</Badge>}
              {voice.userTags.map((tag) => <Badge key={tag.id} variant="outline">{tag.name}</Badge>)}
            </div>
            <div className="mt-1 flex min-w-0 items-center gap-2">
              <h3 className="truncate text-base font-semibold">{voice.displayName}</h3>
              <span className="shrink-0 text-xs text-muted-foreground">{voice.aliases.filter((alias) => alias !== voice.displayName).join(", ") || "No aliases"}</span>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs text-muted-foreground lg:justify-end">
            <span>{voice.knownWorks} works</span>
            <span>{voice.playableWorks} available</span>
            {voice.playableWorks === 0 && <Badge variant="warning">missing</Badge>}
            <span className="inline-flex items-center gap-1 font-medium text-foreground">
              <Star className={`h-3.5 w-3.5 ${voice.rating ? "fill-current text-primary" : ""}`} />
              {voice.rating ? `${voice.rating}/5` : "Unrated"}
            </span>
          </div>
        </button>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2">
          <SourceTags sources={voice.sourceSummaries} />
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <NotebookPen className="h-3.5 w-3.5" />
            <span className="max-w-80 truncate">{voice.note || `Last seen: ${voice.lastSeenAt ?? "never"}`}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function VoiceDetailPage({ personId }: { personId: number }) {
  const [detail, setDetail] = useState<VoiceDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [isEditingState, setIsEditingState] = useState(false);
  const [ratingDraft, setRatingDraft] = useState(0);
  const [noteDraft, setNoteDraft] = useState("");
  const [tagDraft, setTagDraft] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<WorkFilter>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof workPageSizeOptions)[number]>(24);
  const [mobileColumns, setMobileColumns] = useState<1 | 2>(2);
  const [desktopColumns, setDesktopColumns] = useState<4 | 6 | 8>(6);

  useEffect(() => {
    setIsLoading(true);
    api.getVoice(personId).then((item) => {
      setDetail(item);
      setRatingDraft(item.rating ?? 0);
      setNoteDraft(item.note);
      setTagDraft(item.userTags.map((tag) => tag.name).join(", "));
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
      const matchesQuery = !needle || [work.primaryCode, work.title, work.circle, ...work.tags].some((value) => value.toLowerCase().includes(needle));
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

  const saveUserState = async () => {
    if (!detail) return;
    try {
      const next = await api.updateVoiceUserState(detail.personId, {
        rating: ratingDraft > 0 ? ratingDraft : null,
        note: noteDraft,
        favorite: detail.favorite,
      });
      const tags = tagDraft.split(",").map((tag) => tag.trim()).filter(Boolean);
      const tagResult = await api.setVoiceUserTags(detail.personId, tags);
      setDetail((current) => current ? { ...current, ...next, userTags: tagResult.userTags, works: current.works, remoteMatches: current.remoteMatches } : current);
      setIsEditingState(false);
      setMessage("Voice preferences saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Voice preference save failed.");
    }
  };

  const toggleFavorite = async () => {
    if (!detail) return;
    try {
      const next = await api.updateVoiceUserState(detail.personId, {
        rating: detail.rating,
        note: detail.note,
        favorite: !detail.favorite,
      });
      setDetail((current) => current ? { ...current, ...next, works: current.works, remoteMatches: current.remoteMatches } : current);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Favorite update failed.");
    }
  };

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
      <Button variant="outline" size="sm" onClick={() => navigateToVoicesList()}>
        <ChevronLeft className="h-4 w-4" />
        Back to voices
      </Button>

      {message && <div className="rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">{message}</div>}

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardContent className="space-y-4 p-5">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">#{detail.personId}</Badge>
                  {detail.favorite && <Badge variant="secondary">Favorite</Badge>}
                  <Badge variant="secondary">person route</Badge>
                  {detail.userTags.map((tag) => <Badge key={tag.id} variant="outline">{tag.name}</Badge>)}
                </div>
                <h2 className="mt-3 truncate text-2xl font-semibold lg:text-3xl">{detail.displayName}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{detail.aliases.filter((alias) => alias !== detail.displayName).join(", ") || "No aliases"}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant={detail.favorite ? "default" : "outline"} size="sm" onClick={() => void toggleFavorite()}>
                  <Star className={`h-4 w-4 ${detail.favorite ? "fill-current" : ""}`} />
                  Favorite
                </Button>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-5">
              <Stat label="Known works" value={detail.knownWorks} icon={<Database className="h-4 w-4" />} />
              <Stat label="Playable" value={detail.playableWorks} icon={<Layers3 className="h-4 w-4" />} />
              <Stat label="Local" value={detail.localWorks} icon={<HardDrive className="h-4 w-4" />} />
              <Stat label="Remote" value={detail.remoteWorks} icon={<Cloud className="h-4 w-4" />} />
              <Stat label="Remote matches" value={remoteWorks.length} icon={<Search className="h-4 w-4" />} />
            </div>

            <div className="grid gap-3 lg:grid-cols-[180px_minmax(0,1fr)]">
              <Card>
                <CardContent className="space-y-2 p-4">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Star className="h-4 w-4 fill-current text-primary" />
                    User rating
                  </div>
                  {isEditingState ? (
                    <select className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring" value={ratingDraft} onChange={(event) => setRatingDraft(Number(event.target.value))}>
                      <option value={0}>Unrated</option>
                      {[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}/5</option>)}
                    </select>
                  ) : (
                    <div className="text-2xl font-semibold">{detail.rating ? `${detail.rating}/5` : "Unrated"}</div>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => {
                      setRatingDraft(detail.rating ?? 0);
                      setNoteDraft(detail.note);
                      setTagDraft(detail.userTags.map((tag) => tag.name).join(", "));
                      setIsEditingState((value) => !value);
                    }}
                  >
                    {isEditingState ? "Cancel" : "Edit"}
                  </Button>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="space-y-2 p-4">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <NotebookPen className="h-4 w-4 text-primary" />
                    User note and tags
                  </div>
                  {isEditingState ? (
                    <div className="space-y-2">
                      <textarea className="min-h-20 w-full resize-y rounded-md border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} />
                      <div className="flex min-h-10 items-center gap-2 rounded-md border bg-background px-3">
                        <Tags className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <input className="min-w-0 flex-1 bg-transparent text-sm outline-none" value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} placeholder="tag1, tag2" />
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">{detail.note || "No note yet."}</p>
                  )}
                  <Button variant="outline" size="sm" disabled={!isEditingState} onClick={() => void saveUserState()}>
                    Save preferences
                  </Button>
                </CardContent>
              </Card>
            </div>
          </CardContent>
        </Card>

        <RemoteSourcePanel sources={detail.remoteMatches} />
      </section>

      <section className="space-y-3">
        <div className="flex flex-col gap-2 rounded-lg border bg-card p-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-h-10 flex-1 items-center gap-2 rounded-md border bg-background px-3 text-sm text-muted-foreground">
            <Search className="h-4 w-4" />
            <input className="min-w-0 flex-1 bg-transparent outline-none" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search voice works" />
          </div>
          <div className="flex flex-wrap gap-2">
            <ColumnPicker mobileColumns={mobileColumns} desktopColumns={desktopColumns} onMobileChange={setMobileColumns} onDesktopChange={setDesktopColumns} />
            <select className="h-9 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring" value={filter} onChange={(event) => setFilter(event.target.value as WorkFilter)} aria-label="Work filter">
              <option value="all">All works</option>
              <option value="available">Available</option>
              <option value="local">Local</option>
              <option value="remote">Remote</option>
              <option value="missing">Missing</option>
            </select>
            <Button variant="outline" size="sm" disabled>
              <SlidersHorizontal className="h-4 w-4" />
              More
            </Button>
          </div>
        </div>
        <div className={voiceWorkGridClassName(mobileColumns, desktopColumns)}>
          {pageWorks.map((work) => <VoiceWorkCard key={`${"sourceId" in work ? work.sourceId : "known"}:${work.primaryCode}`} work={work} />)}
          {pageWorks.length === 0 && <Card><CardContent className="p-5 text-sm text-muted-foreground">No works match this view.</CardContent></Card>}
        </div>
        {totalPages > 1 && <CatalogPagination page={currentPage} pageSize={pageSize} totalItems={filteredWorks.length} totalPages={totalPages} onPageChange={setPage} onPageSizeChange={setPageSize} />}
      </section>
    </div>
  );
}

function VoiceWorkCard({ work }: { work: VoiceKnownWork | VoiceRemoteWork }) {
  const isKnown = "local" in work;
  const status = "importStatus" in work ? work.importStatus : "Known";
  const local = "local" in work ? work.local : work.hasLocal;
  const remote = "remote" in work ? work.remote : work.hasRemote || work.remotePlayable;
  const cache = "cache" in work ? work.cache : work.hasCache;
  const cover = assetURL(work.coverUrl);
  const tags = "sourceTags" in work ? sourceTags(work.sourceTags) : [];
  return (
    <Card className="group h-full overflow-hidden transition-colors hover:border-primary/50">
      <CardContent className="p-0">
        <button className="block w-full text-left" onClick={() => openWorkRoute(work)}>
          <div className="relative aspect-[4/3] overflow-hidden bg-muted">
            {cover && <img src={cover} alt="" className="h-full w-full object-contain" loading="lazy" />}
            <div className="absolute left-3 top-3 rounded-md bg-background/90 px-2 py-1 text-xs font-semibold">{work.primaryCode || "Remote"}</div>
          </div>
          <div className="flex min-h-52 flex-col gap-3 p-4">
            <div className="space-y-1">
              <h3 className="line-clamp-2 min-h-10 text-base font-semibold leading-snug">{work.title}</h3>
              <div className="truncate text-xs text-muted-foreground">{work.circle || "Unknown circle"}{work.rating ? ` · ${work.rating}` : ""}</div>
            </div>
            <div className="flex min-h-6 flex-wrap gap-1.5">
              <Badge variant={isKnown ? "secondary" : "outline"}>{status}</Badge>
              {cache && <Badge variant="secondary">Cache</Badge>}
            </div>
            <div className="grid gap-1 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <FileAudio className="h-3.5 w-3.5" />
                <span>{local || remote || cache ? "Matched file source" : "No playable source"}</span>
              </div>
            </div>
            <div className="mt-auto flex min-h-6 flex-wrap gap-1.5">
              {tags.length > 0 ? tags.map((tag) => <Badge key={tag.key} variant={tag.key === "local" ? "secondary" : "outline"}>{tag.displayName}</Badge>) : (
                <>
                  {local && <Badge variant="secondary">Local</Badge>}
                  {remote && <Badge variant="outline">Remote</Badge>}
                  {!local && !remote && !cache && <Badge variant="warning">Unavailable</Badge>}
                </>
              )}
            </div>
          </div>
        </button>
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
          <p className="text-sm text-muted-foreground">Queried with Kikoeru voice search syntax and recorded as workflow runs.</p>
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
  const tags = sourceTags(sources);
  if (tags.length === 0) return <Badge variant="warning">Unavailable</Badge>;
  return <div className="flex min-h-6 flex-wrap gap-1">{tags.map((source) => <Badge key={source.key} variant={source.key === "local" ? "secondary" : "outline"}>{source.displayName}{source.count > 0 ? ` ${source.count}` : ""}</Badge>)}</div>;
}

function sourceTags(sources: CircleSourceStat[]) {
  return sources.filter((source) => source.status === "available" || source.count > 0);
}

function ColumnPicker({ mobileColumns, desktopColumns, onMobileChange, onDesktopChange }: { mobileColumns: 1 | 2; desktopColumns: 4 | 6 | 8; onMobileChange: (value: 1 | 2) => void; onDesktopChange: (value: 4 | 6 | 8) => void }) {
  return (
    <div className="flex items-center gap-2">
      <select className="h-9 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring" value={mobileColumns} onChange={(event) => onMobileChange(Number(event.target.value) as 1 | 2)} aria-label="Mobile columns">
        <option value={1}>1 mobile</option>
        <option value={2}>2 mobile</option>
      </select>
      <select className="h-9 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring" value={desktopColumns} onChange={(event) => onDesktopChange(Number(event.target.value) as 4 | 6 | 8)} aria-label="Desktop columns">
        <option value={4}>4 desktop</option>
        <option value={6}>6 desktop</option>
        <option value={8}>8 desktop</option>
      </select>
    </div>
  );
}

function voiceWorkGridClassName(mobileColumns: 1 | 2, desktopColumns: 4 | 6 | 8) {
  const mobile = mobileColumns === 2 ? "grid-cols-2" : "grid-cols-1";
  const desktop = desktopColumns === 8 ? "xl:grid-cols-8" : desktopColumns === 6 ? "xl:grid-cols-6" : "xl:grid-cols-4";
  return `grid gap-3 ${mobile} md:grid-cols-3 ${desktop}`;
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

function CatalogPagination({ page, pageSize, totalItems, totalPages, onPageChange, onPageSizeChange }: { page: number; pageSize: 24 | 48; totalItems: number; totalPages: number; onPageChange: (page: number) => void; onPageSizeChange: (pageSize: 24 | 48) => void }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card px-3 py-2 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
      <div>{totalItems} works · page {page} of {totalPages}</div>
      <div className="flex items-center gap-2">
        <select className="h-9 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring" value={pageSize} onChange={(event) => onPageSizeChange(Number(event.target.value) as 24 | 48)} aria-label="Works per page">
          {workPageSizeOptions.map((value) => <option key={value} value={value}>{value} / page</option>)}
        </select>
        <Button variant="outline" size="icon" aria-label="Previous page" disabled={page <= 1} onClick={() => onPageChange(Math.max(1, page - 1))}><ChevronLeft className="h-4 w-4" /></Button>
        <Button variant="outline" size="icon" aria-label="Next page" disabled={page >= totalPages} onClick={() => onPageChange(Math.min(totalPages, page + 1))}><ChevronRight className="h-4 w-4" /></Button>
      </div>
    </div>
  );
}

function voicePersonIdFromPath(path: string) {
  const match = path.match(/^\/voices\/([^/]+)\/?$/i);
  if (!match) return 0;
  const value = Number(decodeURIComponent(match[1]));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function openVoiceRoute(personId: number) {
  window.history.pushState({}, "", `/voices/${personId}`);
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
