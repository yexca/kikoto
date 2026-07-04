import {
  ChevronLeft,
  ChevronRight,
  Cloud,
  Database,
  DownloadCloud,
  ExternalLink,
  FileAudio,
  GitMerge,
  HardDriveDownload,
  HardDrive,
  Layers3,
  ListChecks,
  Loader2,
  NotebookPen,
  Plus,
  Search,
  SlidersHorizontal,
  Star,
  Tags,
  Trash2,
} from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api, assetURL, type CircleSourceStat, type ListeningStatus, type VoiceAlias, type VoiceAliasCandidate, type VoiceDetail, type VoiceKnownWork, type VoiceMergeReview, type VoiceRemoteSourceSet, type VoiceRemoteWork, type VoiceSummary } from "@/lib/api";
import { openCircleRoute } from "@/pages/CirclesPage";

type CreatorKind = "circle" | "voice";
type VoiceFilter = "all" | "favorite" | "tagged" | "rated" | "available" | "local" | "remote" | "missing";
type WorkFilter = "all" | "available" | "local" | "remote" | "missing";
const voicePageSizeOptions = [20, 40, 80];
const workPageSizeOptions = [24, 48] as const;
const aliasSuggestMinChars = 2;
const aliasSuggestMaxResults = 12;
const listeningStatusOptions: { value: ListeningStatus; label: string }[] = [
  { value: "none", label: "Unmarked" },
  { value: "want_to_listen", label: "Want" },
  { value: "listening", label: "Listening" },
  { value: "finished", label: "Finished" },
  { value: "relisten", label: "Relisten" },
  { value: "paused", label: "Paused" },
];

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
  const [selectedWorkKeys, setSelectedWorkKeys] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [isBulkBusy, setIsBulkBusy] = useState(false);
  const [saveConfirm, setSaveConfirm] = useState<{ count: number; run: () => Promise<void> } | null>(null);

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
  useEffect(() => {
    setSelectedWorkKeys((current) => new Set(Array.from(current).filter((key) => filteredWorks.some((work) => voiceWorkSelectionKey(work) === key))));
  }, [filteredWorks]);
  const selectedWorks = mergedWorks.filter((work) => selectedWorkKeys.has(voiceWorkSelectionKey(work)));
  const selectablePageWorks = pageWorks.filter(isVoiceBulkSelectable);
  const selectedSaveable = selectedWorks.filter(voiceWorkRemoteTarget);
  const selectedSyncable = selectedWorks.filter((work) => voiceWorkRemoteTarget(work) && !voiceWorkHasImportedRemote(work));

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

  const refreshDetail = async () => {
    const item = await api.getVoice(personId);
    setDetail(item);
    setRatingDraft(item.rating ?? 0);
    setNoteDraft(item.note);
    setTagDraft(item.userTags.map((tag) => tag.name).join(", "));
  };

  const updateWorkMark = async (work: VoiceKnownWork | VoiceRemoteWork, status: ListeningStatus) => {
    const workId = "workId" in work ? work.workId : null;
    if (!workId) return;
    try {
      const result = await api.updateWorkUserState(workId, { listeningStatus: status });
      setDetail((current) => current ? {
        ...current,
        works: current.works.map((item) => item.workId === workId ? { ...item, listeningMark: result.listeningStatus } : item),
      } : current);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Listening mark update failed.");
    }
  };

  const toggleWorkSelection = (work: VoiceKnownWork | VoiceRemoteWork, checked: boolean) => {
    const key = voiceWorkSelectionKey(work);
    setSelectedWorkKeys((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const toggleVisibleSelection = (checked: boolean) => {
    setSelectedWorkKeys((current) => {
      const next = new Set(current);
      selectablePageWorks.forEach((work) => {
        const key = voiceWorkSelectionKey(work);
        if (checked) next.add(key);
        else next.delete(key);
      });
      return next;
    });
  };

  const bulkSyncAndSave = async () => {
    if (selectedSyncable.length === 0) return;
    setIsBulkBusy(true);
    setMessage("");
    let completed = 0;
    try {
      const firstTarget = voiceWorkRemoteTarget(selectedSyncable[0]);
      if (firstTarget) {
        await api.recordRemoteBulkRun({ action: "sync_save", sourceId: firstTarget.sourceId, codes: selectedSyncable.map((work) => work.primaryCode) }).catch(() => null);
      }
      for (const work of selectedSyncable) {
        const target = voiceWorkRemoteTarget(work);
        if (!target) continue;
        await api.syncRemoteSourceWork(target.sourceId, target.code, "voice_bulk_sync_save");
        await api.saveRemoteSourceWork(target.sourceId, target.code, []);
        completed++;
      }
      setMessage(`Synced and saved ${completed} selected works.`);
      await refreshDetail();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Bulk sync/save failed.");
    } finally {
      setIsBulkBusy(false);
    }
  };

  const bulkSave = async () => {
    if (selectedSaveable.length === 0) return;
    setSaveConfirm({ count: selectedSaveable.length, run: runBulkSave });
  };

  const runBulkSave = async () => {
    setIsBulkBusy(true);
    setMessage("");
    let completed = 0;
    try {
      const firstTarget = voiceWorkRemoteTarget(selectedSaveable[0]);
      if (firstTarget) {
        await api.recordRemoteBulkRun({ action: "save", sourceId: firstTarget.sourceId, codes: selectedSaveable.map((work) => work.primaryCode) }).catch(() => null);
      }
      for (const work of selectedSaveable) {
        const target = voiceWorkRemoteTarget(work);
        if (!target) continue;
        await api.saveRemoteSourceWork(target.sourceId, target.code, []);
        completed++;
      }
      setMessage(`Saved ${completed} selected works.`);
      await refreshDetail();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Bulk save failed.");
    } finally {
      setIsBulkBusy(false);
      setSaveConfirm(null);
    }
  };

  const saveSingleWork = (work: VoiceKnownWork | VoiceRemoteWork) => {
    setSaveConfirm({
      count: 1,
      run: async () => {
        const target = voiceWorkRemoteTarget(work);
        if (!target) return;
        setIsBulkBusy(true);
        try {
          await api.saveRemoteSourceWork(target.sourceId, target.code, []);
          setMessage(`Saved ${target.code}.`);
          await refreshDetail();
        } catch (error) {
          setMessage(error instanceof Error ? error.message : "Save failed.");
        } finally {
          setIsBulkBusy(false);
          setSaveConfirm(null);
        }
      },
    });
  };

  const syncSingleWork = async (work: VoiceKnownWork | VoiceRemoteWork) => {
    const target = voiceWorkRemoteTarget(work);
    if (!target) return;
    setIsBulkBusy(true);
    try {
      const result = await api.syncRemoteSourceWork(target.sourceId, target.code, "voice_card_fetch");
      setMessage(`Synced ${result.primaryCode} through workflow run #${result.runId}.`);
      await refreshDetail();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sync failed.");
    } finally {
      setIsBulkBusy(false);
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

        <div className="space-y-5">
          <AliasReviewPanel
            personId={detail.personId}
            aliases={detail.aliasRecords ?? []}
            onAliasesChange={(aliases) => setDetail((current) => current ? { ...current, aliasRecords: aliases, aliases: aliases.map((alias) => alias.alias) } : current)}
            onMerged={() => void refreshDetail()}
            onMessage={setMessage}
          />
          <RemoteSourcePanel sources={detail.remoteMatches} />
        </div>
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
            <label className="flex items-center gap-2 rounded-md border bg-background px-2 text-sm text-muted-foreground">
              <input type="checkbox" checked={selectionMode} onChange={(event) => {
                setSelectionMode(event.target.checked);
                if (!event.target.checked) setSelectedWorkKeys(new Set());
              }} />
              Select
            </label>
          </div>
        </div>
        {selectionMode && <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2 text-sm">
          <label className="flex items-center gap-2 text-muted-foreground">
            <input
              type="checkbox"
              checked={selectablePageWorks.length > 0 && selectablePageWorks.every((work) => selectedWorkKeys.has(voiceWorkSelectionKey(work)))}
              onChange={(event) => toggleVisibleSelection(event.target.checked)}
            />
            {selectedWorks.length} selected
          </label>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => toggleVisibleSelection(true)}>Select all</Button>
            <Button variant="outline" size="sm" onClick={() => {
              setSelectedWorkKeys(new Set());
              setSelectionMode(false);
            }}>Cancel selection</Button>
            <Button variant="outline" size="sm" disabled={isBulkBusy || selectedSyncable.length === 0} onClick={() => void bulkSyncAndSave()}>
              <DownloadCloud className="h-4 w-4" />
              Sync + Save {selectedSyncable.length}
            </Button>
            <Button variant="outline" size="sm" disabled={isBulkBusy || selectedSaveable.length === 0} onClick={() => void bulkSave()}>
              <HardDriveDownload className="h-4 w-4" />
              Save {selectedSaveable.length}
            </Button>
          </div>
        </div>}
        <div className={voiceWorkGridClassName(mobileColumns, desktopColumns)}>
          {pageWorks.map((work) => (
            <VoiceWorkCard
              key={`${"sourceId" in work ? work.sourceId : "known"}:${work.primaryCode}`}
              work={work}
              selected={selectedWorkKeys.has(voiceWorkSelectionKey(work))}
              selectable={isVoiceBulkSelectable(work)}
              selectionActive={selectionMode}
              onSelectedChange={(checked) => toggleWorkSelection(work, checked)}
              onSync={() => void syncSingleWork(work)}
              onSave={() => saveSingleWork(work)}
              onStatusChange={(status) => void updateWorkMark(work, status)}
            />
          ))}
          {pageWorks.length === 0 && <Card><CardContent className="p-5 text-sm text-muted-foreground">No works match this view.</CardContent></Card>}
        </div>
        {totalPages > 1 && <CatalogPagination page={currentPage} pageSize={pageSize} totalItems={filteredWorks.length} totalPages={totalPages} onPageChange={setPage} onPageSizeChange={setPageSize} />}
      </section>
      {saveConfirm && <SaveConfirmModal count={saveConfirm.count} onClose={() => setSaveConfirm(null)} onConfirm={() => void saveConfirm.run()} />}
    </div>
  );
}

function VoiceWorkCard({ work, selected, selectable, selectionActive, onSelectedChange, onSync, onSave, onStatusChange }: { work: VoiceKnownWork | VoiceRemoteWork; selected: boolean; selectable: boolean; selectionActive: boolean; onSelectedChange: (checked: boolean) => void; onSync: () => void; onSave: () => void; onStatusChange: (status: ListeningStatus) => void }) {
  const isKnown = "local" in work;
  const status = "importStatus" in work ? work.importStatus : "Known";
  const local = "local" in work ? work.local : work.hasLocal;
  const remote = "remote" in work ? work.remote : work.hasRemote || work.remotePlayable;
  const cache = "cache" in work ? work.cache : work.hasCache;
  const cover = assetURL(work.coverUrl);
  const tags = "sourceTags" in work ? sourceTags(work.sourceTags) : [];
  const metadataTags = work.tags.slice(0, 4);
  const sourceName = "sourceName" in work ? work.sourceName : "";
  const workId = "workId" in work ? work.workId : null;
  const listeningMark = "listeningMark" in work ? work.listeningMark : "none";
  const isUnavailable = !local && !remote && !cache;
  const canOpen = Boolean((isKnown && workId) || (!isKnown && work.primaryCode));
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

  return (
    <Card className="group h-full overflow-hidden transition-colors hover:border-primary/50">
      <CardContent className="p-0">
        <button className={`block w-full text-left ${canOpen ? "cursor-pointer" : "cursor-default"}`} disabled={!canOpen} onClick={() => openWorkRoute(work)}>
          <div className="relative aspect-[4/3] overflow-hidden bg-muted">
            {selectionActive && (
              <label className="absolute right-3 top-3 z-10 rounded-md bg-background/90 px-2 py-1 text-xs" onClick={(event) => event.stopPropagation()}>
                <input type="checkbox" checked={selected} disabled={!selectable} onChange={(event) => onSelectedChange(event.target.checked)} />
              </label>
            )}
            {cover && <img src={cover} alt="" className="h-full w-full object-contain" loading="lazy" />}
            <div className="absolute left-3 top-3 rounded-md bg-background/90 px-2 py-1 text-xs font-semibold">{work.primaryCode || sourceName || "Source"}</div>
          </div>
          <div className="flex min-h-52 flex-col gap-3 p-4">
            <div className="space-y-1">
              <h3 className="line-clamp-2 min-h-10 text-base font-semibold leading-snug">{work.title}</h3>
              <button
                className="block max-w-full truncate text-left text-sm text-muted-foreground hover:text-primary"
                onClick={(event) => {
                  event.stopPropagation();
                  if ("circleExternalId" in work && work.circleExternalId) openCircleRoute(work.circleExternalId);
                }}
              >
                {work.circle || sourceName || "Unknown circle"}
              </button>
            </div>
            <div className="flex min-h-6 flex-wrap gap-1.5">
              {metadataTags.length > 0 ? metadataTags.map((tag) => <Badge key={tag} variant="outline">{tag}</Badge>) : <span className="text-xs text-muted-foreground">No tags</span>}
            </div>
            <div className="grid gap-1 text-xs text-muted-foreground">
              <div className="truncate">Release {voiceWorkReleaseDate(work) || "unknown"} · Updated {voiceWorkUpdatedAt(work) || "unknown"}</div>
              <div className="truncate">DLsite rate {work.rating === null ? "unknown" : work.rating.toFixed(2)} · Sales {voiceWorkSales(work) === null ? "unknown" : voiceWorkSales(work)?.toLocaleString()}</div>
            </div>
            <div className="mt-auto flex min-h-6 flex-wrap gap-1.5">
              <Badge variant={isKnown ? "secondary" : "outline"}>{status}</Badge>
              {cache && <Badge variant="secondary">Cache</Badge>}
              {tags.length > 0 ? tags.map((tag) => <Badge key={tag.key} variant={tag.key === "local" ? "secondary" : "outline"}>{tag.displayName}</Badge>) : (
                <>
                  {local && <Badge variant="secondary">Local</Badge>}
                  {remote && <Badge variant="outline">{sourceName || "Source"}</Badge>}
                  {!local && !remote && !cache && <Badge variant="warning">Unavailable</Badge>}
                </>
              )}
            </div>
          </div>
        </button>
        <div className="flex h-11 items-center justify-between gap-1 border-t px-3">
          <Button variant="ghost" size="icon" asChild title="Open DLsite">
            <a href={voiceWorkDLsiteURL(work)} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} aria-label="Open DLsite">
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" title="Fetch remote info" disabled={!voiceWorkRemoteTarget(work)} onClick={(event) => {
              event.stopPropagation();
              onSync();
            }}>
              <DownloadCloud className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" title="Save to library" disabled={!voiceWorkRemoteTarget(work)} onClick={(event) => {
              event.stopPropagation();
              onSave();
            }}>
              <HardDriveDownload className="h-4 w-4" />
            </Button>
            <div className="relative min-w-0" ref={markMenuRef}>
            <Button
              variant="ghost"
              size="icon"
              title={`Mark: ${listeningStatusLabel(listeningMark)}`}
              disabled={isUnavailable || workId === null}
              onClick={(event) => {
                event.stopPropagation();
                setIsMarkOpen((value) => !value);
              }}
            >
              <ListChecks className={listeningMark === "none" ? "h-4 w-4" : "h-4 w-4 text-primary"} />
            </Button>
            {isMarkOpen && (
              <MarkMenu
                value={normalizeListeningStatus(listeningMark)}
                onChange={(next) => {
                  setIsMarkOpen(false);
                  onStatusChange(next);
                }}
              />
            )}
          </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function AliasReviewPanel({
  personId,
  aliases,
  onAliasesChange,
  onMerged,
  onMessage,
}: {
  personId: number;
  aliases: VoiceAlias[];
  onAliasesChange: (aliases: VoiceAlias[]) => void;
  onMerged: () => void;
  onMessage: (message: string) => void;
}) {
  const [aliasDraft, setAliasDraft] = useState("");
  const [candidates, setCandidates] = useState<VoiceAliasCandidate[]>([]);
  const [mergeReviews, setMergeReviews] = useState<VoiceMergeReview[]>([]);
  const [mergeTarget, setMergeTarget] = useState<VoiceAliasCandidate | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSuggestOpen, setIsSuggestOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const suggestRef = useRef<HTMLDivElement | null>(null);
  const shouldShowSuggestions = isSuggestOpen && candidates.length > 0 && candidates.length <= aliasSuggestMaxResults;

  const loadCandidates = async () => {
    if (aliasDraft.trim().length < aliasSuggestMinChars) {
      setCandidates([]);
      return;
    }
    setIsLoading(true);
    try {
      setCandidates(await api.listVoiceAliasCandidates(personId, aliasDraft));
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "Alias candidate search failed.");
    } finally {
      setIsLoading(false);
    }
  };

  const loadMergeReviews = async () => {
    try {
      setMergeReviews(await api.listVoiceMergeReviews(personId));
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "Merge review history failed.");
    }
  };

  useEffect(() => {
    void loadMergeReviews();
  }, [personId]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadCandidates();
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [aliasDraft, personId]);

  useEffect(() => {
    if (!isSuggestOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (suggestRef.current?.contains(target)) return;
      setIsSuggestOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsSuggestOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isSuggestOpen]);

  const addAlias = async () => {
    if (!aliasDraft.trim()) return;
    try {
      const next = await api.createVoiceAlias(personId, aliasDraft);
      onAliasesChange(next);
      setAliasDraft("");
      onMessage("Alias saved.");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "Alias save failed.");
    }
  };

  const deleteAlias = async (alias: VoiceAlias) => {
    try {
      const result = await api.deleteVoiceAlias(personId, alias.id);
      onAliasesChange(result.aliases);
      onMessage(result.deleted > 0 ? "Alias deleted." : "Primary alias is kept.");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "Alias delete failed.");
    }
  };

  const mergeCandidate = async (candidate: VoiceAliasCandidate) => {
    try {
      const result = await api.mergeVoiceAliasCandidate(personId, candidate.personId);
      onMessage(`Merged ${result.mergedName} into ${result.targetName}.`);
      onMerged();
      setCandidates((items) => items.filter((item) => item.personId !== candidate.personId));
      setMergeTarget(null);
      void loadMergeReviews();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "Alias merge failed.");
    }
  };

  const undoMerge = async (review: VoiceMergeReview) => {
    try {
      const result = await api.undoVoiceMerge(personId, review.id);
      onMessage(`Restored ${result.restoredName}.`);
      onMerged();
      void loadMergeReviews();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "Merge undo failed.");
    }
  };

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div>
          <h3 className="font-semibold">Aliases</h3>
          <p className="text-sm text-muted-foreground">Review alternate names and merge duplicate voice actors.</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {aliases.length > 0 ? aliases.map((alias) => (
            <Badge key={alias.id} variant={alias.source === "primary_name" ? "secondary" : "outline"} className="gap-1">
              {alias.alias}
              {alias.source !== "primary_name" && (
                <button className="rounded-sm hover:text-destructive" aria-label={`Delete alias ${alias.alias}`} onClick={() => void deleteAlias(alias)}>
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </Badge>
          )) : <Badge variant="warning">No aliases</Badge>}
        </div>
        <div className="relative" ref={suggestRef}>
          <div className="flex gap-2">
            <div className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md border bg-background px-3">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input
                ref={inputRef}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                value={aliasDraft}
                onChange={(event) => {
                  setAliasDraft(event.target.value);
                  setIsSuggestOpen(true);
                }}
                placeholder="Add alias or search duplicate voice actor"
              />
            </div>
            <Button variant="outline" size="sm" onClick={() => void addAlias()}><Plus className="h-4 w-4" /> Add</Button>
          </div>
          {shouldShowSuggestions && (
            <div className="absolute left-0 right-0 top-11 z-30 max-h-72 overflow-auto rounded-md border bg-popover p-1 shadow-lg">
              {candidates.slice(0, aliasSuggestMaxResults).map((candidate) => (
                <button
                  key={candidate.personId}
                  className="flex w-full items-center justify-between gap-3 rounded-sm px-3 py-2 text-left text-sm hover:bg-muted"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setAliasDraft(candidate.displayName);
                    setIsSuggestOpen(false);
                    inputRef.current?.focus();
                  }}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{candidate.displayName}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {candidate.knownWorks} works · {[...new Set(candidate.aliases.map((alias) => alias.alias).filter((alias) => alias !== candidate.displayName))].join(", ") || "No extra aliases"}
                    </span>
                  </span>
                  <GitMerge className="h-4 w-4 shrink-0 text-muted-foreground" />
                </button>
              ))}
            </div>
          )}
        </div>
        {aliasDraft.trim().length >= aliasSuggestMinChars && candidates.length > aliasSuggestMaxResults && (
          <div className="rounded-md border bg-background p-3 text-sm text-muted-foreground">Too many matches. Keep typing to narrow candidates.</div>
        )}
        {candidates.length > 0 && candidates.length <= aliasSuggestMaxResults && (
          <div className="space-y-2">
            {candidates.slice(0, 4).map((candidate) => (
              <div key={candidate.personId} className="flex items-center justify-between gap-3 rounded-md border bg-background p-3 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-medium">{candidate.displayName}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {candidate.knownWorks} works · {[...new Set(candidate.aliases.map((alias) => alias.alias).filter((alias) => alias !== candidate.displayName))].join(", ") || "No extra aliases"}
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setMergeTarget(candidate)}>
                  <GitMerge className="h-4 w-4" />
                  Merge
                </Button>
              </div>
            ))}
          </div>
        )}
        {mergeReviews.length > 0 && (
          <div className="space-y-2 border-t pt-3">
            <div className="text-sm font-medium">Merge history</div>
            {mergeReviews.slice(0, 4).map((review) => (
              <div key={review.id} className="flex items-center justify-between gap-3 rounded-md border bg-background p-3 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-medium">{review.sourceName}</div>
                  <div className="truncate text-xs text-muted-foreground">{review.status === "undone" ? "Undone" : "Merged"} · {review.createdAt}</div>
                </div>
                <Button variant="ghost" size="sm" disabled={review.status !== "merged"} onClick={() => void undoMerge(review)}>
                  Undo
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
      {mergeTarget && (
        <FloatingConfirm
          title="Merge voice actor"
          description={`Merge ${mergeTarget.displayName} into this voice actor? You can undo it from merge history.`}
          confirmLabel="Merge"
          onClose={() => setMergeTarget(null)}
          onConfirm={() => void mergeCandidate(mergeTarget)}
        />
      )}
    </Card>
  );
}

function FloatingConfirm({ title, description, confirmLabel, onClose, onConfirm }: { title: string; description: string; confirmLabel: string; onClose: () => void; onConfirm: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/40 p-4" onMouseDown={onClose}>
      <div className="w-full max-w-sm rounded-lg border bg-card p-4 shadow-xl" onMouseDown={(event) => event.stopPropagation()}>
        <h3 className="text-base font-semibold">{title}</h3>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </div>
  );
}

function SaveConfirmModal({ count, onClose, onConfirm }: { count: number; onClose: () => void; onConfirm: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/50 p-4" onMouseDown={onClose}>
      <div className="w-full max-w-sm rounded-lg border bg-card p-4 shadow-xl" onMouseDown={(event) => event.stopPropagation()}>
        <h3 className="text-base font-semibold">Save remote directory</h3>
        <p className="mt-2 text-sm text-muted-foreground">This will download the full remote directory for {count} selected work{count === 1 ? "" : "s"}.</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={onConfirm}>Save</Button>
        </div>
      </div>
    </div>
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
  const available = sources.filter((source) => source.status === "available" || source.count > 0);
  const hasSpecificRemote = available.some((source) => source.sourceId !== null && source.sourceId !== undefined && source.key !== "cache");
  return hasSpecificRemote ? available.filter((source) => source.key !== "remote") : available;
}

function voiceWorkSelectionKey(work: VoiceKnownWork | VoiceRemoteWork) {
  return `${"sourceId" in work ? work.sourceId : "known"}:${work.primaryCode}`;
}

function isVoiceBulkSelectable(work: VoiceKnownWork | VoiceRemoteWork) {
  if ("local" in work && work.local) return false;
  return voiceWorkRemoteTarget(work) !== null;
}

function voiceWorkHasImportedRemote(work: VoiceKnownWork | VoiceRemoteWork) {
  if ("remote" in work) return work.remote;
  return work.hasRemote;
}

function voiceWorkReleaseDate(work: VoiceKnownWork | VoiceRemoteWork) {
  return "releaseDate" in work ? work.releaseDate || "" : "";
}

function voiceWorkUpdatedAt(work: VoiceKnownWork | VoiceRemoteWork) {
  return work.updatedAt || voiceWorkReleaseDate(work);
}

function voiceWorkSales(work: VoiceKnownWork | VoiceRemoteWork) {
  return work.sales ?? null;
}

function voiceWorkDLsiteURL(work: VoiceKnownWork | VoiceRemoteWork) {
  return "dlsiteUrl" in work && work.dlsiteUrl ? work.dlsiteUrl : `https://www.dlsite.com/maniax/work/=/product_id/${encodeURIComponent(work.primaryCode)}.html`;
}

function voiceWorkRemoteTarget(work: VoiceKnownWork | VoiceRemoteWork): { sourceId: number; code: string } | null {
  if (!work.primaryCode) return null;
  if ("sourceId" in work) return { sourceId: work.sourceId, code: work.primaryCode };
  const remoteSource = work.sourceTags.find((tag) => tag.sourceId !== null && tag.sourceId !== undefined && tag.key !== "cache");
  return remoteSource?.sourceId ? { sourceId: remoteSource.sourceId, code: work.primaryCode } : null;
}

function MarkMenu({ value, onChange }: { value: ListeningStatus; onChange: (status: ListeningStatus) => void }) {
  return (
    <div className="absolute bottom-10 left-0 z-20 w-44 overflow-hidden rounded-md border bg-popover p-1 shadow-lg">
      {listeningStatusOptions.map((option) => (
        <button
          key={option.value}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted"
          onClick={() => onChange(option.value)}
        >
          <ListChecks className={value === option.value && value !== "none" ? "h-3.5 w-3.5 text-primary" : "h-3.5 w-3.5"} />
          {option.label}
        </button>
      ))}
    </div>
  );
}

function normalizeListeningStatus(status: string): ListeningStatus {
  return listeningStatusOptions.some((option) => option.value === status) ? status as ListeningStatus : "none";
}

function listeningStatusLabel(status: string) {
  return listeningStatusOptions.find((option) => option.value === normalizeListeningStatus(status))?.label ?? "Unmarked";
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
