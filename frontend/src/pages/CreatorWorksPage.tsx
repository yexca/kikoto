import {
  ChevronLeft,
  ChevronRight,
  Cloud,
  Database,
  ExternalLink,
  FileAudio,
  GitBranchPlus,
  GitMerge,
  HardDriveDownload,
  HardDrive,
  Heart,
  Layers3,
  ListChecks,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toastFromError, useToast } from "@/components/ui/toast";
import { RemoteFetchDialog, remoteFetchPaths } from "@/components/RemoteFetchDialog";
import { UserTagRow } from "@/components/UserTagRow";
import { useAuth } from "@/auth/AuthProvider";
import {
  WorkCardActionButton,
  WorkCardDLsiteAction,
  WorkCardFooter,
  WorkCardListButton,
  WorkCardQuickMarkButton,
  WorkCardSelection,
  WorkCardShell,
  cardDate,
  dlsiteTagBadges,
  type WorkCardViewModel,
} from "@/components/work-card/WorkCardShell";
import { circleSourceBadges } from "@/components/work-card/sourceBadges";
import { api, assetURL, type CircleSourceStat, type ListeningStatus, type RemoteWorkDetail, type RemoteWorkSavePlan, type VoiceAlias, type VoiceAliasCandidate, type VoiceDetail, type VoiceKnownWork, type VoiceMergeReview, type VoiceRemoteSourceSet, type VoiceRemoteWork, type VoiceSummary } from "@/lib/api";
import { formatRemoteFetchPlanConflict, hasRemoteFetchConflicts } from "@/lib/remoteFetchPlan";
import { openCircleRoute, openCircleSeriesRoute } from "@/pages/CirclesPage";

type CreatorKind = "circle" | "voice";
type VoiceFilter = "all" | "favorite" | "tagged" | "available" | "local" | "remote" | "missing";
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
  const toast = useToast();
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
      toast.notify(toastFromError(error, "Voice actor API is unavailable."));
      setMessage("");
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
        {isLoading ? <EntityBadgeSkeleton /> : <Badge variant="outline">{filteredVoices.length} voices</Badge>}
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
          {isLoading ? (
            <EntityCardSkeletonGrid count={Math.min(pageSize, 9)} />
          ) : pageVoices.length > 0 ? (
            pageVoices.map((voice) => (
              <VoiceCard
                key={voice.personId}
                voice={voice}
                onChange={(next) => setVoices((items) => items.map((item) => item.personId === next.personId ? { ...item, ...next } : item))}
              />
            ))
          ) : (
            <Card><CardContent className="p-5 text-sm text-muted-foreground">No voice actors match this view.</CardContent></Card>
          )}
        </div>

        {totalPages > 1 && <Pagination currentPage={currentPage} totalPages={totalPages} onPage={setPage} />}
      </section>
    </div>
  );
}

function EntitySkeletonLine({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className}`} />;
}

function EntityBadgeSkeleton() {
  return <EntitySkeletonLine className="h-5 w-24 rounded-full" />;
}

function EntityCardSkeletonGrid({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <Card key={index}>
          <CardContent className="space-y-3 p-3">
            <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto]">
              <div className="space-y-2">
                <div className="flex gap-2">
                  <EntitySkeletonLine className="h-5 w-16 rounded-full" />
                  <EntitySkeletonLine className="h-5 w-20 rounded-full" />
                </div>
                <div className="flex items-center gap-2">
                  <EntitySkeletonLine className="h-5 w-36" />
                  <EntitySkeletonLine className="h-3 w-24" />
                </div>
              </div>
              <div className="flex flex-wrap gap-2 lg:justify-end">
                <EntitySkeletonLine className="h-4 w-16" />
                <EntitySkeletonLine className="h-4 w-20" />
                <EntitySkeletonLine className="h-4 w-14" />
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2">
              <div className="flex gap-1">
                <EntitySkeletonLine className="h-6 w-16 rounded-full" />
                <EntitySkeletonLine className="h-6 w-20 rounded-full" />
              </div>
              <EntitySkeletonLine className="h-4 w-44" />
            </div>
          </CardContent>
        </Card>
      ))}
    </>
  );
}

function VoiceCard({ voice, onChange }: { voice: VoiceSummary; onChange: (voice: VoiceSummary) => void }) {
  const toast = useToast();
  const toggleFavorite = async () => {
    try {
      const next = await api.updateVoiceUserState(voice.personId, { favorite: !voice.favorite });
      onChange({ ...voice, ...next });
    } catch (error) {
      toast.notify(toastFromError(error, "Voice favorite update failed."));
    }
  };
  const saveTags = async (tags: string[]) => {
    try {
      const result = await api.setVoiceUserTags(voice.personId, tags);
      onChange({ ...voice, userTags: result.userTags });
    } catch (error) {
      toast.notify(toastFromError(error, "Voice tags update failed."));
    }
  };
  return (
    <Card className="transition-colors hover:border-primary/50">
      <CardContent className="space-y-2 p-3">
        <div className="grid w-full gap-2 lg:grid-cols-[minmax(0,1fr)_auto]">
          <button className="min-w-0 text-left" onClick={() => openVoiceRoute(voice.personId)}>
            <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">#{voice.personId}</Badge>
              {voice.favorite && <Badge variant="secondary">Favorite</Badge>}
            </div>
            <div className="mt-1 flex min-w-0 items-center gap-2">
              <h3 className="truncate text-base font-semibold">{voice.displayName}</h3>
              <span className="shrink-0 text-xs text-muted-foreground">{voice.aliases.filter((alias) => alias !== voice.displayName).join(", ") || "No aliases"}</span>
            </div>
          </div>
          </button>
          <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs text-muted-foreground lg:justify-end">
            <span>{voice.knownWorks} works</span>
            <span>{voice.playableWorks} available</span>
            {voice.playableWorks === 0 && <Badge variant="warning">missing</Badge>}
            <Button
              variant={voice.favorite ? "default" : "outline"}
              size="icon"
              className="h-8 w-8"
              aria-label={voice.favorite ? "Remove favorite" : "Add favorite"}
              title={voice.favorite ? "Remove favorite" : "Add favorite"}
              onClick={() => void toggleFavorite()}
            >
              <Heart className={`h-4 w-4 ${voice.favorite ? "fill-current" : ""}`} />
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2">
          <SourceTags sources={voice.sourceSummaries} />
          <UserTagRow tags={voice.userTags} compact onSave={saveTags} className="justify-end" />
        </div>
      </CardContent>
    </Card>
  );
}

function VoiceDetailPage({ personId }: { personId: number }) {
  const auth = useAuth();
  const toast = useToast();
  const [detail, setDetail] = useState<VoiceDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [remoteMatches, setRemoteMatches] = useState<VoiceRemoteSourceSet[]>([]);
  const [isRemoteLoading, setIsRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState("");
  const [message, setMessage] = useState("");
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
  const [fetchSelection, setFetchSelection] = useState<{ work: VoiceKnownWork | VoiceRemoteWork; sourceId: number; code: string; detail: RemoteWorkDetail; selectedPaths: Set<string>; plan: RemoteWorkSavePlan | null; message: string } | null>(null);

  useEffect(() => {
    setIsLoading(true);
    setRemoteMatches([]);
    setRemoteError("");
    api.getVoice(personId).then((item) => {
      setDetail(item);
      setMessage("");
    }).catch((error) => {
      setDetail(null);
      toast.notify(toastFromError(error, "Voice actor detail is unavailable."));
    }).finally(() => setIsLoading(false));
  }, [personId]);

  const loadRemoteMatches = async (notify = false) => {
    setIsRemoteLoading(true);
    setRemoteError("");
    try {
      const result = await api.getVoiceRemoteMatches(personId);
      setRemoteMatches(result.remoteMatches);
      const failed = result.remoteMatches.filter((source) => remoteSourceFailed(source));
      if (failed.length > 0 || notify) {
        const timedOut = failed.some((source) => source.status === "timeout");
        const message = failed.length > 0
          ? `${failed.length} remote source${failed.length === 1 ? "" : "s"} ${timedOut ? "timed out or failed" : "failed"}.`
          : "Remote matches refreshed.";
        if (failed.length > 0) toast.info(message);
        else toast.success(message);
      }
    } catch (error) {
      const fallback = error instanceof Error ? error.message : "Remote matches unavailable.";
      setRemoteError(fallback);
      toast.notify(toastFromError(error, "Remote matches unavailable."));
    } finally {
      setIsRemoteLoading(false);
    }
  };

  useEffect(() => {
    if (!detail) return;
    void loadRemoteMatches(false);
  }, [detail?.personId]);

  const knownWorks = detail?.works ?? [];
  const remoteWorks = useMemo(() => remoteMatches.flatMap((source) => source.works), [remoteMatches]);
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

  const toggleFavorite = async () => {
    if (!detail) return;
    try {
      const next = await api.updateVoiceUserState(detail.personId, {
        favorite: !detail.favorite,
      });
      setDetail((current) => current ? { ...current, ...next, works: current.works, remoteMatches: current.remoteMatches } : current);
    } catch (error) {
      toast.notify(toastFromError(error, "Favorite update failed."));
    }
  };

  const refreshDetail = async () => {
    const item = await api.getVoice(personId);
    setDetail((current) => item ? { ...item, remoteMatches: current?.remoteMatches ?? [] } : item);
    void loadRemoteMatches(false);
  };

  const saveVoiceTags = async (tags: string[]) => {
    if (!detail) return;
    try {
      const result = await api.setVoiceUserTags(detail.personId, tags);
      setDetail((current) => current ? { ...current, userTags: result.userTags } : current);
    } catch (error) {
      toast.notify(toastFromError(error, "Voice tags update failed."));
    }
  };

  const updateWorkMark = async (work: VoiceKnownWork | VoiceRemoteWork, status: ListeningStatus) => {
    const workId = "workId" in work ? work.workId : null;
    if (!workId) {
      await syncAndMarkVoiceWork(work, status);
      return;
    }
    try {
      const result = await api.updateWorkUserState(workId, { listeningStatus: status });
      setDetail((current) => current ? {
        ...current,
        works: current.works.map((item) => item.workId === workId ? { ...item, listeningMark: result.listeningStatus } : item),
      } : current);
    } catch (error) {
      toast.notify(toastFromError(error, "Listening mark update failed."));
    }
  };

  const syncAndMarkVoiceWork = async (work: VoiceKnownWork | VoiceRemoteWork, status: ListeningStatus) => {
    const target = voiceWorkRemoteTarget(work);
    if (!target) return;
    setIsBulkBusy(true);
    setMessage("");
    try {
      const syncResult = await api.trackRemoteSourceWork(target.sourceId, target.code, "voice_mark_interest");
      await api.updateWorkUserState(syncResult.workId, { listeningStatus: status });
      toast.success(`Tracked and marked ${syncResult.primaryCode}.`);
      await refreshDetail();
    } catch (error) {
      toast.notify(toastFromError(error, "Listening mark update failed."));
    } finally {
      setIsBulkBusy(false);
    }
  };

  const trackVoiceWorkForState = async (work: VoiceKnownWork | VoiceRemoteWork, reason: string) => {
    const target = voiceWorkRemoteTarget(work);
    if (!target) return null;
    const syncResult = await api.trackRemoteSourceWork(target.sourceId, target.code, reason);
    return syncResult.workId;
  };

  const ensureVoiceWorkForList = async (work: VoiceKnownWork | VoiceRemoteWork) => {
    const workId = "workId" in work ? work.workId : null;
    if (workId) return workId;
    try {
      const nextWorkId = await trackVoiceWorkForState(work, "voice_list");
      if (!nextWorkId) return null;
      await refreshDetail();
      return nextWorkId;
    } catch (error) {
      toast.notify(toastFromError(error, "Track for list failed."));
      return null;
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
    try {
      const results = await runVoiceBulkBySource(selectedSyncable, "track_fetch");
      const synced = results.reduce((total, result) => total + result.synced, 0);
      const fetched = results.reduce((total, result) => total + result.fetched, 0);
      const runIds = results.map((result) => `#${result.runId}`).join(", ");
      toast.success(`Bulk workflow ${runIds}: tracked ${synced} and fetched ${fetched} selected works.`);
      await refreshDetail();
    } catch (error) {
      toast.notify(toastFromError(error, "Bulk track/fetch failed."));
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
    try {
      const results = await runVoiceBulkBySource(selectedSaveable, "fetch");
      const fetched = results.reduce((total, result) => total + result.fetched, 0);
      const runIds = results.map((result) => `#${result.runId}`).join(", ");
      toast.success(`Bulk workflow ${runIds}: fetched ${fetched} selected works.`);
      await refreshDetail();
    } catch (error) {
      toast.notify(toastFromError(error, "Bulk fetch failed."));
    } finally {
      setIsBulkBusy(false);
      setSaveConfirm(null);
    }
  };

  const runVoiceBulkBySource = (works: (VoiceKnownWork | VoiceRemoteWork)[], action: "fetch" | "track_fetch") => {
    const groups = new Map<number, string[]>();
    works.forEach((work) => {
      const target = voiceWorkRemoteTarget(work);
      if (!target) return;
      groups.set(target.sourceId, [...(groups.get(target.sourceId) ?? []), target.code]);
    });
    return Promise.all(Array.from(groups, ([sourceId, codes]) => api.recordRemoteBulkRun({ action, sourceId, codes })));
  };

  const saveSingleWork = async (work: VoiceKnownWork | VoiceRemoteWork) => {
    const target = voiceWorkRemoteTarget(work);
    if (!target) return;
    setIsBulkBusy(true);
    setMessage("");
    try {
      const detail = await api.getRemoteSourceWork(target.sourceId, target.code);
      setFetchSelection({ work, sourceId: target.sourceId, code: target.code, detail, selectedPaths: new Set(remoteFetchPaths(detail.tracks)), plan: null, message: "" });
    } catch (error) {
      toast.notify(toastFromError(error, "Remote directory failed."));
    } finally {
      setIsBulkBusy(false);
    }
  };

  const fetchSingleSelection = async () => {
    if (!fetchSelection) return;
    setIsBulkBusy(true);
    setMessage("");
    try {
      const paths = Array.from(fetchSelection.selectedPaths);
      const plan = await api.planRemoteSourceWorkFetch(fetchSelection.sourceId, fetchSelection.detail.primaryCode, paths);
      if (hasRemoteFetchConflicts(plan)) {
        setFetchSelection((current) => current ? { ...current, plan, message: formatRemoteFetchPlanConflict(plan) } : current);
        return;
      }
      const result = await api.fetchRemoteSourceWork(fetchSelection.sourceId, fetchSelection.detail.primaryCode, paths);
      toast.success(`Fetch queued for ${result.primaryCode} as workflow run #${result.runId}.`);
      setFetchSelection(null);
      await refreshDetail();
    } catch (error) {
      toast.notify(toastFromError(error, "Fetch failed."));
    } finally {
      setIsBulkBusy(false);
    }
  };

  const syncSingleWork = async (work: VoiceKnownWork | VoiceRemoteWork) => {
    const target = voiceWorkRemoteTarget(work);
    if (!target) return;
    setIsBulkBusy(true);
    try {
      const result = await api.trackRemoteSourceWork(target.sourceId, target.code, "voice_card_fetch");
      toast.success(`Tracked ${result.primaryCode} through workflow run #${result.runId}.`);
      await refreshDetail();
    } catch (error) {
      toast.notify(toastFromError(error, "Track failed."));
    } finally {
      setIsBulkBusy(false);
    }
  };

  if (isLoading) {
    return <VoiceDetailSkeleton />;
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
                </div>
                <h2 className="mt-3 truncate text-2xl font-semibold lg:text-3xl">{detail.displayName}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{detail.aliases.filter((alias) => alias !== detail.displayName).join(", ") || "No aliases"}</p>
                <UserTagRow tags={detail.userTags} onSave={saveVoiceTags} className="mt-3" />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant={detail.favorite ? "default" : "outline"} size="sm" onClick={() => void toggleFavorite()}>
                  <Heart className={`h-4 w-4 ${detail.favorite ? "fill-current" : ""}`} />
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

          </CardContent>
        </Card>

        <div className="space-y-5">
          {auth.hasPermission("metadata:sync") && (
            <AliasReviewPanel
              personId={detail.personId}
              aliases={detail.aliasRecords ?? []}
              onAliasesChange={(aliases) => setDetail((current) => current ? { ...current, aliasRecords: aliases, aliases: aliases.map((alias) => alias.alias) } : current)}
              onMerged={() => void refreshDetail()}
              onMessage={setMessage}
            />
          )}
          <RemoteSourcePanel
            sources={remoteMatches}
            loading={isRemoteLoading}
            error={remoteError}
            onRetry={() => void loadRemoteMatches(true)}
          />
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
            <Button variant={selectionMode ? "default" : "outline"} size="sm" onClick={() => {
              setSelectionMode((value) => {
                if (value) setSelectedWorkKeys(new Set());
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
              <GitBranchPlus className="h-4 w-4" />
              Track + Fetch {selectedSyncable.length}
            </Button>
            <Button variant="outline" size="sm" disabled={isBulkBusy || selectedSaveable.length === 0} onClick={() => void bulkSave()}>
              <HardDriveDownload className="h-4 w-4" />
              Fetch {selectedSaveable.length}
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
              onSave={() => void saveSingleWork(work)}
              onStatusChange={(status) => void updateWorkMark(work, status)}
              onFavoriteSaved={(favorite) => {
                setDetail((current) => current ? {
                  ...current,
                  works: current.works.map((item) => item.primaryCode === work.primaryCode ? { ...item, favorite } : item),
                } : current);
              }}
              onEnsureWork={() => ensureVoiceWorkForList(work)}
            />
          ))}
          {isRemoteLoading && <VoiceRemoteWorkSkeletonCards count={Math.min(4, pageSize)} />}
          {pageWorks.length === 0 && !isRemoteLoading && <Card><CardContent className="p-5 text-sm text-muted-foreground">No works match this view.</CardContent></Card>}
        </div>
        {totalPages > 1 && <CatalogPagination page={currentPage} pageSize={pageSize} totalItems={filteredWorks.length} totalPages={totalPages} onPageChange={setPage} onPageSizeChange={setPageSize} />}
      </section>
      {saveConfirm && <SaveConfirmModal count={saveConfirm.count} onClose={() => setSaveConfirm(null)} onConfirm={() => void saveConfirm.run()} />}
      {fetchSelection && (
        <RemoteFetchDialog
          title={`${fetchSelection.code} · ${fetchSelection.work.title}`}
          tracks={fetchSelection.detail.tracks}
          selectedPaths={fetchSelection.selectedPaths}
          disabled={isBulkBusy}
          plan={fetchSelection.plan}
          message={fetchSelection.message}
          onChange={(paths) => setFetchSelection((current) => current ? { ...current, selectedPaths: paths, plan: null, message: "" } : current)}
          onClose={() => setFetchSelection(null)}
          onFetch={() => void fetchSingleSelection()}
        />
      )}
    </div>
  );
}

function VoiceWorkCard({ work, selected, selectable, selectionActive, onSelectedChange, onSync, onSave, onStatusChange, onFavoriteSaved, onEnsureWork }: { work: VoiceKnownWork | VoiceRemoteWork; selected: boolean; selectable: boolean; selectionActive: boolean; onSelectedChange: (checked: boolean) => void; onSync: () => void; onSave: () => void; onStatusChange: (status: ListeningStatus) => void; onFavoriteSaved: (favorite: boolean) => void; onEnsureWork: () => Promise<number | null> }) {
  const isKnown = "local" in work;
  const local = "local" in work ? work.local : work.hasLocal;
  const remote = "remote" in work ? work.remote : work.hasRemote || work.remotePlayable;
  const cache = "cache" in work ? work.cache : work.hasCache;
  const cover = assetURL(work.coverUrl);
  const tags = "sourceTags" in work ? sourceTags(work.sourceTags) : [];
  const metadataTags = work.tags.slice(0, 4);
  const sourceName = "sourceName" in work ? work.sourceName : "";
  const workId = "workId" in work ? work.workId : null;
  const favorite = "favorite" in work ? work.favorite : false;
  const listeningMark = "listeningMark" in work ? work.listeningMark : "none";
  const isUnavailable = !local && !remote && !cache;
  const canOpen = Boolean((isKnown && workId) || (!isKnown && work.primaryCode));
  const view = voiceWorkCardView(work);

  return (
    <WorkCardShell
      work={view}
      selection={selectionActive ? <WorkCardSelection checked={selected} disabled={!selectable} onChange={onSelectedChange} /> : undefined}
      canOpen={canOpen}
      onOpen={() => openWorkRoute(work)}
      onCircleOpen={(externalId) => openCircleRoute(externalId)}
      onSeriesOpen={"seriesTitleId" in work && work.seriesTitleId && "circleExternalId" in work && work.circleExternalId ? () => openCircleSeriesRoute(work.circleExternalId, work.seriesTitleId) : undefined}
      footer={(
        <WorkCardFooter
          left={<WorkCardDLsiteAction href={voiceWorkDLsiteURL(work)} />}
          right={(
            <>
            <WorkCardActionButton title="Track" disabled={!voiceWorkRemoteTarget(work)} onClick={(event) => {
              event.stopPropagation();
              onSync();
            }}>
              <GitBranchPlus className="h-4 w-4" />
            </WorkCardActionButton>
            <WorkCardActionButton title="Fetch" disabled={!voiceWorkRemoteTarget(work)} onClick={(event) => {
              event.stopPropagation();
              onSave();
            }}>
              <HardDriveDownload className="h-4 w-4" />
            </WorkCardActionButton>
            <WorkCardListButton
              workId={workId}
              active={favorite}
              disabled={!workId && !voiceWorkRemoteTarget(work)}
              ensureWorkId={onEnsureWork}
              onSaved={onFavoriteSaved}
            />
            <WorkCardQuickMarkButton
              value={normalizeListeningStatus(listeningMark)}
              disabled={isUnavailable && !voiceWorkRemoteTarget(work)}
              onChange={onStatusChange}
            />
            </>
          )}
        />
      )}
    />
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

function WorkProgressLine({ progress }: { progress: NonNullable<VoiceKnownWork["progress"]> }) {
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

function voiceWorkCardView(work: VoiceKnownWork | VoiceRemoteWork): WorkCardViewModel {
  const isKnown = "local" in work;
  const sourceName = "sourceName" in work ? work.sourceName : "";
  const sourceBadges = isKnown
    ? circleSourceBadges({ local: work.local, remote: work.remote, cache: work.cache, sourceTags: work.sourceTags })
    : circleSourceBadges({ local: work.hasLocal, remote: work.hasRemote || work.remotePlayable, cache: work.hasCache, sourceTags: work.remotePlayable && work.sourceId ? [{
      key: String(work.sourceId),
      displayName: sourceName || work.sourceCode || "remote source",
      sourceId: work.sourceId,
      status: "available",
      count: 1,
    }] : [] });
  return {
    code: work.primaryCode || sourceName || "Source",
    title: work.title,
    circle: work.circle || sourceName || "Unknown circle",
    circleExternalId: "circleExternalId" in work ? work.circleExternalId : undefined,
    coverUrl: work.coverUrl,
    rating: work.rating,
    series: "series" in work ? work.series || null : null,
    dlsiteTags: dlsiteTagBadges(work.tags),
    date: cardDate(voiceWorkReleaseDate(work), voiceWorkUpdatedAt(work)),
    progress: "progress" in work ? work.progress : null,
    userTags: [],
    sourceBadges,
  };
}

function RemoteSourcePanel({ sources, loading, error, onRetry }: { sources: VoiceRemoteSourceSet[]; loading: boolean; error: string; onRetry: () => void }) {
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold">Remote Sources</h3>
            <p className="text-sm text-muted-foreground">Queried after local detail renders, so source outages do not block the page.</p>
          </div>
          <Button variant="outline" size="sm" disabled={loading} onClick={onRetry}>
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Retry
          </Button>
        </div>
        {loading && sources.length === 0 ? <RemoteSourceSkeleton /> : sources.map((source) => (
            <div key={source.sourceId} className="rounded-md border bg-background p-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-medium">{source.displayName}</div>
                  <div className="text-xs text-muted-foreground">{source.total || source.works.length} matches · {source.elapsedMs} ms</div>
                </div>
                <Badge variant={source.status === "ok" ? "outline" : "warning"}>{source.status}</Badge>
              </div>
              {remoteSourceStatusMessage(source) && <div className="mt-2 text-xs text-destructive">{remoteSourceStatusMessage(source)}</div>}
            </div>
          ))}
        {loading && sources.length > 0 && <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Refreshing remote matches</div>}
        {error && <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}
        {!loading && sources.length === 0 && !error && <div className="rounded-md border bg-background p-3 text-sm text-muted-foreground">No Kikoeru-compatible sources are configured.</div>}
      </CardContent>
    </Card>
  );
}

function RemoteSourceSkeleton() {
  return (
    <>
      {Array.from({ length: 2 }, (_, index) => (
        <div key={index} className="space-y-2 rounded-md border bg-background p-3">
          <EntitySkeletonLine className="h-4 w-32" />
          <EntitySkeletonLine className="h-3 w-24" />
        </div>
      ))}
    </>
  );
}

function remoteSourceStatusMessage(source: VoiceRemoteSourceSet) {
  if (source.status === "ok") return "";
  switch (source.status) {
  case "timeout":
    return "Remote source timed out.";
  case "unavailable":
  case "error":
    return "Remote source is unavailable.";
  case "invalid_response":
    return "Remote source returned an invalid response.";
  case "misconfigured":
    return "Remote source API endpoint is not configured.";
  case "disabled":
    return "Source is disabled.";
  case "unsupported":
    return "Source type is not supported.";
  default:
    return source.error || "";
  }
}

function remoteSourceFailed(source: VoiceRemoteSourceSet) {
  return !["ok", "disabled", "unsupported"].includes(source.status);
}

function VoiceRemoteWorkSkeletonCards({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <Card key={`remote-loading-${index}`}>
          <CardContent className="space-y-3 p-3">
            <EntitySkeletonLine className="aspect-[3/4] w-full" />
            <EntitySkeletonLine className="h-4 w-3/4" />
            <EntitySkeletonLine className="h-3 w-1/2" />
          </CardContent>
        </Card>
      ))}
    </>
  );
}

function VoiceDetailSkeleton() {
  return (
    <div className="space-y-5">
      <EntitySkeletonLine className="h-9 w-32" />
      <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardContent className="space-y-4 p-5">
            <EntitySkeletonLine className="h-5 w-24" />
            <EntitySkeletonLine className="h-9 w-64" />
            <EntitySkeletonLine className="h-5 w-80" />
            <div className="grid gap-3 sm:grid-cols-5">
              {Array.from({ length: 5 }, (_, index) => <EntitySkeletonLine key={index} className="h-20 w-full" />)}
            </div>
          </CardContent>
        </Card>
        <div className="space-y-5">
          <Card><CardContent className="space-y-3 p-4"><EntitySkeletonLine className="h-5 w-32" /><EntitySkeletonLine className="h-10 w-full" /></CardContent></Card>
          <Card><CardContent className="space-y-3 p-4"><EntitySkeletonLine className="h-5 w-32" /><RemoteSourceSkeleton /></CardContent></Card>
        </div>
      </section>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-6">
        <VoiceRemoteWorkSkeletonCards count={6} />
      </div>
    </div>
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

function formatTime(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function workProgressPercent(progress: NonNullable<VoiceKnownWork["progress"]>) {
  if (!progress.durationSeconds || progress.durationSeconds <= 0) return 0;
  return Math.min(100, Math.max(0, (progress.positionSeconds / progress.durationSeconds) * 100));
}

export function openVoiceRoute(personId: number) {
  window.history.pushState({}, "", `/voices/${personId}`);
  window.dispatchEvent(new Event("kikoto:navigation"));
}

function navigateToVoicesList() {
  window.history.pushState({}, "", "/voices");
  window.dispatchEvent(new Event("kikoto:navigation"));
}

function openWorkRoute(work: VoiceKnownWork | VoiceRemoteWork) {
  if ("workId" in work && work.workId) {
    window.history.pushState({ returnTo: currentVoiceReturnPath(), returnLabel: "Back to voices" }, "", `/${encodeURIComponent(work.primaryCode)}`);
    window.dispatchEvent(new Event("kikoto:navigation"));
    return;
  }
  if ("sourceId" in work && work.primaryCode) {
    window.history.pushState({ returnTo: currentVoiceReturnPath(), returnLabel: "Back to voices" }, "", `/${encodeURIComponent(work.primaryCode || work.remoteId)}?source=${work.sourceId}`);
    window.dispatchEvent(new Event("kikoto:navigation"));
  }
}

function currentVoiceReturnPath() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}
