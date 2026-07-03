import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleUserRound,
  Clock3,
  Database,
  FileAudio,
  Filter,
  Folder,
  HardDrive,
  HardDriveDownload,
  Headphones,
  ExternalLink,
  DownloadCloud,
  Cloud,
  ListChecks,
  MoreHorizontal,
  Pause,
  Play,
  Search,
  Star,
  Tags,
  UserRound,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  api,
  assetURL,
  type LibrarySource,
  type ListeningStatus,
  type MediaItem,
  type RemoteTrack,
  type RemoteWorksResponse,
  type RemoteWork,
  type RemoteWorkDetail,
  type Work,
  type WorkDetail,
} from "@/lib/api";
import { type PlayerTrack, usePlayer } from "@/player/PlayerProvider";

const WORK_CODE_PATTERN = /^\/((?:RJ|BJ|VJ|CC)\d{4,8})\/?$/i;
const listeningStatusOptions: { value: ListeningStatus; label: string }[] = [
  { value: "none", label: "Unmarked" },
  { value: "want_to_listen", label: "Want" },
  { value: "listening", label: "Listening" },
  { value: "finished", label: "Finished" },
  { value: "relisten", label: "Relisten" },
  { value: "paused", label: "Paused" },
];

type RemoteSourceViewState = { page: number; pageSize: number; query: string };
const defaultRemoteSourceViewState: RemoteSourceViewState = { page: 1, pageSize: 24, query: "" };

export function LibraryPage() {
  const [works, setWorks] = useState<Work[]>([]);
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const [activeTab, setActiveTab] = useState<LibraryTab>({ kind: "local" });
  const [remoteResult, setRemoteResult] = useState<RemoteWorksResponse | null>(null);
  const [remoteSourceStates, setRemoteSourceStates] = useState<Record<number, RemoteSourceViewState>>({});
  const [settings, setSettings] = useState<{ autoSyncRemote: boolean; cacheEnabled: boolean } | null>(null);
  const [selectedCode, setSelectedCode] = useState<string | null>(() => codeFromPath(window.location.pathname));
  const [selectedWork, setSelectedWork] = useState<WorkDetail | null>(null);
  const [selectedRemoteTarget, setSelectedRemoteTarget] = useState<{ source: LibrarySource; code: string } | null>(null);
  const [isAPIAvailable, setIsAPIAvailable] = useState(false);
  const [statusFilter, setStatusFilter] = useState<ListeningStatus | "all">("all");

  useEffect(() => {
    api
      .listWorks()
      .then((items) => {
        setWorks(items);
        setIsAPIAvailable(true);
      })
      .catch(() => {
        setWorks([]);
        setIsAPIAvailable(false);
      });
  }, []);

  useEffect(() => {
    api.listLibrarySources().then(setSources).catch(() => setSources([]));
  }, []);

  useEffect(() => {
    api.getRuntimeSettings().then((next) => setSettings(next)).catch(() => setSettings(null));
  }, []);

  useEffect(() => {
    if (activeTab.kind !== "source") {
      setRemoteResult(null);
      return;
    }
    const sourceState = remoteSourceStates[activeTab.source.id] ?? defaultRemoteSourceViewState;
    setRemoteResult(null);
    api.listRemoteSourceWorks(activeTab.source.id, sourceState.page, sourceState.pageSize, sourceState.query).then(setRemoteResult).catch(() => {
      setRemoteResult({
        sourceId: activeTab.source.id,
        works: [],
        page: sourceState.page,
        pageSize: sourceState.pageSize,
        total: 0,
        status: "unavailable",
      });
    });
  }, [activeTab, remoteSourceStates]);

  useEffect(() => {
    if (selectedCode === null) {
      setSelectedWork(null);
      return;
    }
    const work = works.find((item) => item.primaryCode.toUpperCase() === selectedCode.toUpperCase());
    if (!work) {
      if (works.length > 0) {
        setSelectedWork(null);
      }
      return;
    }
    api.getWork(work.id).then(setSelectedWork).catch(() => setSelectedWork(null));
  }, [selectedCode, works]);

  useEffect(() => {
    const handlePopState = () => setSelectedCode(codeFromPath(window.location.pathname));
    const handleAppNavigation = () => setSelectedCode(codeFromPath(window.location.pathname));
    window.addEventListener("popstate", handlePopState);
    window.addEventListener("kikoto:navigation", handleAppNavigation);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("kikoto:navigation", handleAppNavigation);
    };
  }, []);

  const openWork = (work: Work) => {
    const path = `/${work.primaryCode}`;
    window.history.pushState({}, "", path);
    window.dispatchEvent(new Event("kikoto:navigation"));
    setSelectedCode(work.primaryCode);
  };

  const openRemotePreview = (source: LibrarySource, work: RemoteWork) => {
    if (!work.primaryCode) return;
    setSelectedRemoteTarget({ source, code: work.primaryCode });
  };

  const backToLibrary = () => {
    window.history.pushState({}, "", "/");
    window.dispatchEvent(new Event("kikoto:navigation"));
    setSelectedCode(null);
    setSelectedRemoteTarget(null);
  };

  const updateWorkStatus = async (workID: number, status: ListeningStatus) => {
    const result = await api.updateWorkUserState(workID, { listeningStatus: status });
    setWorks((items) =>
      items.map((item) => (item.id === workID ? { ...item, listeningStatus: result.listeningStatus } : item)),
    );
    setSelectedWork((item) => (item?.id === workID ? { ...item, listeningStatus: result.listeningStatus } : item));
  };

  const activeRemoteSourceState =
    activeTab.kind === "source" ? (remoteSourceStates[activeTab.source.id] ?? defaultRemoteSourceViewState) : defaultRemoteSourceViewState;

  const updateRemoteSourceState = (sourceID: number, patch: Partial<RemoteSourceViewState>) => {
    setRemoteSourceStates((states) => ({
      ...states,
      [sourceID]: {
        ...(states[sourceID] ?? defaultRemoteSourceViewState),
        ...patch,
      },
    }));
  };

  if (selectedCode !== null) {
    return <WorkDetailView code={selectedCode} work={selectedWork} onBack={backToLibrary} onStatusChange={updateWorkStatus} />;
  }

  if (selectedRemoteTarget !== null) {
    return (
      <RemoteWorkDetailView
        source={selectedRemoteTarget.source}
        code={selectedRemoteTarget.code}
        autoSyncRemote={(settings?.autoSyncRemote ?? false) || selectedRemoteTarget.source.autoSyncOnInterest || selectedRemoteTarget.source.cacheEnabled}
        onBack={() => setSelectedRemoteTarget(null)}
        onOpenLocal={(workID) => {
          const work = works.find((item) => item.id === workID);
          if (work) openWork(work);
        }}
        onWorksChanged={async () => setWorks(await api.listWorks())}
      />
    );
  }

  const scopedWorks =
    activeTab.kind === "local"
      ? works.filter(hasLocalAvailability)
      : activeTab.kind === "remote"
        ? works.filter(hasRemoteAvailability)
        : works;
  const visibleWorks = statusFilter === "all" ? scopedWorks : scopedWorks.filter((work) => work.listeningStatus === statusFilter);

  return (
    <div className="space-y-5">
      <section className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-h-10 flex-1 items-center gap-2 rounded-lg border bg-card px-3 text-sm text-muted-foreground lg:max-w-xl">
          <Search className="h-4 w-4" />
          <span>Search title, code, circle, tag, or creator</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <select
            className="h-8 rounded-md border bg-card px-3 text-xs font-medium outline-none focus:ring-2 focus:ring-ring"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as ListeningStatus | "all")}
            aria-label="Listening status filter"
          >
            <option value="all">All marks</option>
            {listeningStatusOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <Button variant="outline" size="sm">
            <Filter className="h-4 w-4" />
            Filters
          </Button>
          <Button size="sm">
            <Headphones className="h-4 w-4" />
            {isAPIAvailable ? `${visibleWorks.length} works` : "Preview data"}
          </Button>
        </div>
      </section>

      <LibraryTabs activeTab={activeTab} sources={sources} onChange={setActiveTab} />

      {activeTab.kind === "source" ? (
        <RemoteSourcePanel
          source={activeTab.source}
          result={remoteResult}
          viewState={activeRemoteSourceState}
          onQueryChange={(query) => updateRemoteSourceState(activeTab.source.id, { query })}
          onPageChange={(page) => updateRemoteSourceState(activeTab.source.id, { page })}
          onPageSizeChange={(value) => {
            updateRemoteSourceState(activeTab.source.id, { pageSize: value, page: 1 });
          }}
          autoSyncRemote={(settings?.autoSyncRemote ?? false) || activeTab.source.autoSyncOnInterest || activeTab.source.cacheEnabled}
          onOpenPreview={(work) => openRemotePreview(activeTab.source, work)}
          onSynced={async (workId) => {
            const nextWorks = await api.listWorks();
            setWorks(nextWorks);
            const synced = nextWorks.find((item) => item.id === workId);
            if (synced) openWork(synced);
          }}
        />
      ) : (
        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {visibleWorks.map((work) => (
            <WorkCard key={work.id} work={work} onOpen={() => openWork(work)} onStatusChange={updateWorkStatus} />
          ))}
          {visibleWorks.length === 0 && (
            <Card className="sm:col-span-2 xl:col-span-3">
              <CardContent className="p-5 text-sm text-muted-foreground">
                {activeTab.kind === "remote"
                  ? "No imported remote or cached works yet."
                  : "No local works match this view."}
              </CardContent>
            </Card>
          )}
        </section>
      )}
    </div>
  );
}

type LibraryTab = { kind: "local" } | { kind: "remote" } | { kind: "source"; source: LibrarySource };

function LibraryTabs({
  activeTab,
  sources,
  onChange,
}: {
  activeTab: LibraryTab;
  sources: LibrarySource[];
  onChange: (tab: LibraryTab) => void;
}) {
  return (
    <div className="flex gap-2 overflow-x-auto rounded-lg border bg-card p-1">
      <TabButton active={activeTab.kind === "local"} onClick={() => onChange({ kind: "local" })} icon={<HardDrive className="h-4 w-4" />}>
        Local
      </TabButton>
      <TabButton active={activeTab.kind === "remote"} onClick={() => onChange({ kind: "remote" })} icon={<Database className="h-4 w-4" />}>
        Remote
      </TabButton>
      {sources.map((source) => (
        <TabButton
          key={source.id}
          active={activeTab.kind === "source" && activeTab.source.id === source.id}
          onClick={() => onChange({ kind: "source", source })}
          icon={<Database className="h-4 w-4" />}
          disabled={!source.enabled}
        >
          {source.displayName}
        </TabButton>
      ))}
    </div>
  );
}

function TabButton({
  active,
  disabled,
  icon,
  children,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors ${
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
      } disabled:pointer-events-none disabled:opacity-50`}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      <span className="max-w-40 truncate">{children}</span>
    </button>
  );
}

function RemoteSourcePanel({
  source,
  result,
  viewState,
  onQueryChange,
  onPageChange,
  onPageSizeChange,
  autoSyncRemote,
  onOpenPreview,
  onSynced,
}: {
  source: LibrarySource;
  result: RemoteWorksResponse | null;
  viewState: RemoteSourceViewState;
  onQueryChange: (query: string) => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  autoSyncRemote: boolean;
  onOpenPreview: (work: RemoteWork) => void;
  onSynced: (workID: number) => Promise<void>;
}) {
  const isLoading = result === null;
  const [isSyncingCode, setIsSyncingCode] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const { page, pageSize, query } = viewState;

  const syncWork = async (work: RemoteWork, reason: string) => {
    if (!work.primaryCode) {
      setMessage("This remote work has no stable work code.");
      return;
    }
    if (!autoSyncRemote && reason !== "manual_fetch") {
      const confirmed = window.confirm(
        "This work needs to be fetched into Remote before Kikoto can mark it. You can enable automatic pull on interest in Settings.",
      );
      if (!confirmed) return;
    }
    setIsSyncingCode(work.primaryCode);
    setMessage("");
    try {
      const result = await api.syncRemoteSourceWork(source.id, work.primaryCode, reason);
      setMessage(`Pulled ${result.primaryCode} through workflow run #${result.runId}.`);
      await onSynced(result.workId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Remote sync failed.");
    } finally {
      setIsSyncingCode(null);
    }
  };

  const visibleWorks = useMemo(() => {
    const works = result?.works ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) return works;
    return works.filter((work) =>
      [work.primaryCode, work.title, work.circle, ...work.tags].some((value) => value.toLowerCase().includes(needle)),
    );
  }, [query, result]);
  const canGoNext = result !== null && result.works.length >= pageSize;
  const canGoPrevious = page > 1;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{source.displayName}</h2>
          <p className="text-sm text-muted-foreground">Browse source results without importing until a user action needs local state.</p>
        </div>
        <div className="flex gap-2">
          <Badge variant={source.enabled ? "outline" : "warning"}>{source.enabled ? "enabled" : "disabled"}</Badge>
          <Badge variant="secondary">{result?.status ?? "loading"}</Badge>
        </div>
      </div>
      <div className="flex min-h-10 items-center gap-2 rounded-lg border bg-card px-3 text-sm">
        <Search className="h-4 w-4 text-muted-foreground" />
        <input
          className="min-w-0 flex-1 bg-transparent outline-none"
          value={query}
          onChange={(event) => {
            onQueryChange(event.target.value);
            onPageChange(1);
          }}
          placeholder="Search remote source"
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2">
        <div className="text-xs text-muted-foreground">
          Page {page}
          {result?.total ? ` · ${result.total} works` : ""}
        </div>
        <div className="flex items-center gap-2">
          <select
            className="h-8 rounded-md border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
            aria-label="Remote page size"
          >
            {[12, 24, 48, 96].map((value) => (
              <option key={value} value={value}>
                {value} / page
              </option>
            ))}
          </select>
          <IconButton title="Previous page" disabled={!canGoPrevious || isLoading} onClick={() => onPageChange(Math.max(1, page - 1))}>
            <ChevronLeft className="h-4 w-4" />
          </IconButton>
          <IconButton title="Next page" disabled={!canGoNext || isLoading} onClick={() => onPageChange(page + 1)}>
            <ChevronRight className="h-4 w-4" />
          </IconButton>
        </div>
      </div>
      {message && <div className="rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">{message}</div>}
      {isLoading ? (
        <Card>
          <CardContent className="p-5 text-sm text-muted-foreground">Loading remote page...</CardContent>
        </Card>
      ) : visibleWorks.length === 0 ? (
        <Card>
          <CardContent className="p-5 text-sm text-muted-foreground">No remote works on this page.</CardContent>
        </Card>
      ) : (
        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {visibleWorks.map((work) => (
            <RemoteWorkCard
              key={work.remoteId}
              work={work}
              isBusy={isSyncingCode === work.primaryCode}
              onOpen={() => onOpenPreview(work)}
              onFetch={() => void syncWork(work, "manual_fetch")}
              onFetchAndMark={() => void syncWork(work, "mark_interest")}
            />
          ))}
        </section>
      )}
    </section>
  );
}

function WorkCard({
  work,
  onOpen,
  onStatusChange,
}: {
  work: Work;
  onOpen: () => void;
  onStatusChange: (workID: number, status: ListeningStatus) => Promise<void>;
}) {
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
        <div className="block w-full cursor-pointer text-left" onClick={onOpen}>
          <WorkCardMedia coverUrl={work.coverUrl} code={work.primaryCode} rating={work.rating} externalUrl={work.dlsiteUrl} />
          <WorkCardBody
            title={work.title}
            circle={work.circle || "Unknown circle"}
            badges={[
              ...(work.listeningStatus !== "none" ? [{ value: listeningStatusLabel(work.listeningStatus), variant: "warning" as const }] : []),
              ...work.availability.map((item) => ({ value: item, variant: item === "missing" ? ("warning" as const) : ("secondary" as const) })),
              ...work.tags.slice(0, 3).map((tag) => ({ value: tag, variant: "outline" as const })),
            ]}
            meta={[
              { icon: <UserRound className="h-3.5 w-3.5" />, value: work.voiceActors.join(", ") || "No voice actor metadata" },
              { icon: <FileAudio className="h-3.5 w-3.5" />, value: `${work.trackCount} tracks, ${work.availableLocations} files` },
            ]}
          />
        </div>
        <div className="flex h-11 items-center justify-between border-t px-3">
          <div className="relative" ref={markMenuRef}>
            <IconButton
              title={`Mark: ${listeningStatusLabel(work.listeningStatus)}`}
              onClick={(event) => {
                event.stopPropagation();
                setIsMarkOpen((value) => !value);
              }}
            >
              <ListChecks className={work.listeningStatus === "none" ? "h-4 w-4" : "h-4 w-4 text-primary"} />
            </IconButton>
            {isMarkOpen && (
              <MarkMenu
                value={work.listeningStatus}
                onChange={(status) => {
                  setIsMarkOpen(false);
                  void onStatusChange(work.id, status);
                }}
              />
            )}
          </div>
          <div className="flex items-center gap-1">
            <IconButton title="Open work" onClick={onOpen}>
              <MoreHorizontal className="h-4 w-4" />
            </IconButton>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function RemoteWorkCard({
  work,
  isBusy,
  onOpen,
  onFetch,
  onFetchAndMark,
}: {
  work: RemoteWork;
  isBusy: boolean;
  onOpen: () => void;
  onFetch: () => void;
  onFetchAndMark: () => void;
}) {
  return (
    <Card className="group h-full overflow-hidden transition-colors hover:border-primary/50">
      <CardContent className="p-0">
        <div className="block w-full cursor-pointer text-left" onClick={onOpen}>
          <WorkCardMedia coverUrl={work.coverUrl} code={work.primaryCode || work.remoteId} rating={work.rating} />
          <WorkCardBody
            title={work.title}
            circle={work.circle || "Unknown circle"}
            badges={[
              { value: work.importStatus, variant: work.importStatus === "synced" ? ("secondary" as const) : ("outline" as const) },
              ...(work.remotePlayable ? [{ value: "remote", variant: "outline" as const }] : []),
              ...work.tags.slice(0, 3).map((tag) => ({ value: tag, variant: "outline" as const })),
            ]}
            meta={[
              { icon: <Cloud className="h-3.5 w-3.5" />, value: "Browse source result" },
              { icon: <FileAudio className="h-3.5 w-3.5" />, value: work.primaryCode || work.remoteId },
            ]}
          />
        </div>
        <div className="flex h-11 items-center justify-between border-t px-3">
          <IconButton
            title="Fetch remote info"
            disabled={isBusy || !work.primaryCode}
            onClick={(event) => {
              event.stopPropagation();
              onFetch();
            }}
          >
            <DownloadCloud className="h-4 w-4" />
          </IconButton>
          <div className="flex items-center gap-1">
            <IconButton
              title="Fetch and mark"
              disabled={isBusy || !work.primaryCode}
              onClick={(event) => {
                event.stopPropagation();
                onFetchAndMark();
              }}
            >
              <ListChecks className="h-4 w-4" />
            </IconButton>
            <IconButton title="Save to library is not available yet" disabled onClick={() => {}}>
              <HardDriveDownload className="h-4 w-4" />
            </IconButton>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function WorkCardMedia({
  coverUrl,
  code,
  rating,
  externalUrl,
}: {
  coverUrl: string;
  code: string;
  rating: number | null;
  externalUrl?: string;
}) {
  const codeText = code || "Remote";
  return (
    <div className="relative aspect-[4/3] overflow-hidden bg-muted">
      {coverUrl ? (
        <img src={assetURL(coverUrl)} alt="" className="h-full w-full object-contain transition-transform group-hover:scale-[1.03]" />
      ) : (
        <div className="grid h-full place-items-center bg-secondary text-2xl font-bold text-secondary-foreground">{codeText.slice(0, 2)}</div>
      )}
      {externalUrl ? (
        <a
          className="absolute left-3 top-3 inline-flex items-center gap-1 rounded-md bg-background/90 px-2 py-1 text-xs font-semibold hover:text-primary"
          href={externalUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => event.stopPropagation()}
          title="Open external page"
        >
          {codeText}
          <ExternalLink className="h-3 w-3" />
        </a>
      ) : (
        <div className="absolute left-3 top-3 rounded-md bg-background/90 px-2 py-1 text-xs font-semibold">{codeText}</div>
      )}
      <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-md bg-background/90 px-2 py-1 text-xs font-semibold">
        <Star className="h-3.5 w-3.5 fill-current" />
        {rating === null ? "No rating" : rating.toFixed(2)}
      </div>
    </div>
  );
}

type CardBadge = { value: string; variant: "secondary" | "outline" | "warning" };
type CardMeta = { icon: ReactNode; value: string };

function WorkCardBody({ title, circle, badges, meta }: { title: string; circle: string; badges: CardBadge[]; meta: CardMeta[] }) {
  return (
    <div className="space-y-3 p-4">
      <div className="space-y-1">
        <h2 className="line-clamp-2 min-h-10 text-base font-semibold leading-snug">{title}</h2>
        <p className="truncate text-sm text-muted-foreground">{circle}</p>
      </div>
      <div className="flex min-h-6 flex-wrap gap-1.5">
        {badges.map((badge) => (
          <Badge key={`${badge.value}:${badge.variant}`} variant={badge.variant}>
            {badge.value}
          </Badge>
        ))}
      </div>
      <div className="grid gap-1 text-xs text-muted-foreground">
        {meta.map((item, index) => (
          <div key={index} className="flex items-center gap-1.5">
            {item.icon}
            <span className="truncate">{item.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function IconButton({
  title,
  disabled,
  children,
  onClick,
}: {
  title: string;
  disabled?: boolean;
  children: ReactNode;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      className="inline-flex h-8 w-8 items-center justify-center rounded-md border bg-background text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
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
          <ListChecks className={value === option.value && value !== "none" ? "h-3.5 w-3.5 text-primary" : "h-3.5 w-3.5"} />
          {option.label}
        </button>
      ))}
    </div>
  );
}

function RemoteWorkDetailView({
  source,
  code,
  autoSyncRemote,
  onBack,
  onOpenLocal,
  onWorksChanged,
}: {
  source: LibrarySource;
  code: string;
  autoSyncRemote: boolean;
  onBack: () => void;
  onOpenLocal: (workID: number) => void;
  onWorksChanged: () => Promise<void>;
}) {
  const [detail, setDetail] = useState<RemoteWorkDetail | null>(null);
  const [message, setMessage] = useState("");
  const [isFetching, setIsFetching] = useState(false);
  const tree = useMemo(() => buildRemoteTree(detail?.tracks ?? []), [detail]);
  const trackCount = useMemo(() => countTreeFiles(tree), [tree]);

  useEffect(() => {
    setDetail(null);
    setMessage("");
    api.getRemoteSourceWork(source.id, code).then(setDetail).catch((error) => {
      setMessage(error instanceof Error ? error.message : "Remote preview failed.");
    });
  }, [source.id, code]);

  const fetchWork = async (reason: string) => {
    if (!detail?.primaryCode) return;
    if (!autoSyncRemote && reason !== "manual_fetch") {
      const confirmed = window.confirm(
        "This work needs to be fetched into Remote before Kikoto can mark it. You can enable automatic pull on interest in Settings.",
      );
      if (!confirmed) return;
    }
    setIsFetching(true);
    setMessage("");
    try {
      const result = await api.syncRemoteSourceWork(source.id, detail.primaryCode, reason);
      setMessage(`Pulled ${result.primaryCode} through workflow run #${result.runId}.`);
      await onWorksChanged();
      onOpenLocal(result.workId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Remote sync failed.");
    } finally {
      setIsFetching(false);
    }
  };

  if (!detail) {
    return (
      <div className="space-y-4">
        <Button variant="outline" size="sm" onClick={onBack}>
          <ChevronLeft className="h-4 w-4" />
          Back to source
        </Button>
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">{message || `Loading ${code}...`}</CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Button variant="outline" size="sm" onClick={onBack}>
        <ChevronLeft className="h-4 w-4" />
        Back to source
      </Button>

      <section className="grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="self-start overflow-hidden rounded-lg border bg-muted">
          <div className="aspect-[4/3]">
            {detail.coverUrl ? (
              <img src={assetURL(detail.coverUrl)} alt="" className="h-full w-full object-contain" />
            ) : (
              <div className="grid h-full place-items-center text-4xl font-bold">{(detail.primaryCode || detail.remoteId).slice(0, 2)}</div>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <div className="text-sm font-semibold text-primary">{detail.primaryCode || detail.remoteId}</div>
            <h2 className="mt-1 text-2xl font-semibold leading-tight lg:text-3xl">{detail.title}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{detail.circle || "Unknown circle"}</p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={isFetching || !detail.primaryCode} onClick={() => void fetchWork("manual_fetch")}>
              <DownloadCloud className="h-4 w-4" />
              Fetch
            </Button>
            <Button size="sm" variant="outline" disabled={isFetching || !detail.primaryCode} onClick={() => void fetchWork("mark_interest")}>
              <ListChecks className="h-4 w-4" />
              Fetch and mark
            </Button>
            {detail.workId !== null && (
              <Button size="sm" onClick={() => onOpenLocal(detail.workId!)}>
                <MoreHorizontal className="h-4 w-4" />
                Open local detail
              </Button>
            )}
            {detail.sourceUrl && (
              <Button variant="outline" size="sm" asChild>
                <a href={detail.sourceUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" />
                  Source
                </a>
              </Button>
            )}
          </div>

          {message && <div className="rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">{message}</div>}

          <div className="grid gap-3 sm:grid-cols-3">
            <MetaTile icon={<Star className="h-4 w-4 fill-current" />} label="Rating" value={detail.rating === null ? "No rating" : detail.rating.toFixed(2)} />
            <MetaTile icon={<Clock3 className="h-4 w-4" />} label="Released" value={detail.releaseDate || "Unknown"} />
            <MetaTile icon={<FileAudio className="h-4 w-4" />} label={source.displayName} value={`${trackCount} playable files`} />
          </div>

          <InfoRow icon={<CircleUserRound className="h-4 w-4" />} label="Voice" value={detail.voiceActors.join(", ") || "No voice actor metadata"} />
          <InfoRow icon={<Tags className="h-4 w-4" />} label="Tags" value={detail.tags.join(", ") || "No tag metadata"} />
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold">Directory</h3>
            <p className="text-sm text-muted-foreground">Previewing remote files from {detail.sourceName}; fetch before local marks or saves.</p>
          </div>
          <div className="flex gap-2 overflow-x-auto">
            <button className="h-8 shrink-0 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground">{detail.sourceName}</button>
          </div>
        </div>
        <Card>
          <CardContent className="p-4">
            <DirectoryTree root={tree} currentLocationId={null} emptyLabel="No remote files detected." />
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function WorkDetailView({
  code,
  work,
  onBack,
  onStatusChange,
}: {
  code: string;
  work: WorkDetail | null;
  onBack: () => void;
  onStatusChange: (workID: number, status: ListeningStatus) => Promise<void>;
}) {
  const sourceTabs = useMemo(() => buildSourceTabs(work?.mediaItems ?? []), [work]);
  const [activeSourceKey, setActiveSourceKey] = useState("local");
  const selectedSource = sourceTabs.find((source) => source.key === activeSourceKey) ?? sourceTabs[0];
  const tree = useMemo(() => buildTree(work?.mediaItems ?? [], selectedSource?.fileSourceId ?? null), [work, selectedSource]);
  const allTracks = useMemo(() => flattenTracks(tree), [tree]);
  const player = usePlayer();

  useEffect(() => {
    if (sourceTabs.length > 0 && !sourceTabs.some((source) => source.key === activeSourceKey)) {
      setActiveSourceKey(sourceTabs[0].key);
    }
  }, [activeSourceKey, sourceTabs]);

  const playTracks = (tracks: TreeTrack[], locationId: number) => {
    if (!work || tracks.length === 0) return;
    player.playQueue(tracks.map((track) => toPlayerTrack(track, work)), locationId);
    if (work.listeningStatus === "none" || work.listeningStatus === "want_to_listen") {
      void onStatusChange(work.id, "listening");
    }
  };

  const playAll = () => {
    if (work && allTracks.length > 0) {
      playTracks(allTracks, allTracks[0].locationId);
    }
  };

  if (!work) {
    return (
      <div className="space-y-4">
        <Button variant="outline" size="sm" onClick={onBack}>
          <ChevronLeft className="h-4 w-4" />
          Back
        </Button>
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">Loading {code}...</CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Button variant="outline" size="sm" onClick={onBack}>
        <ChevronLeft className="h-4 w-4" />
        Back to library
      </Button>

      <section className="grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="self-start overflow-hidden rounded-lg border bg-muted">
          <div className="aspect-[4/3]">
            {work.coverUrl ? (
              <img src={assetURL(work.coverUrl)} alt="" className="h-full w-full object-contain" />
            ) : (
              <div className="grid h-full place-items-center text-4xl font-bold">{work.primaryCode.slice(0, 2)}</div>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <div className="text-sm font-semibold text-primary">{work.primaryCode}</div>
            <h2 className="mt-1 text-2xl font-semibold leading-tight lg:text-3xl">{work.title}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{work.circle || "Unknown circle"}</p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={playAll} disabled={allTracks.length === 0}>
              <Play className="h-4 w-4" />
              Play
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href={work.dlsiteUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="h-4 w-4" />
                DLsite
              </a>
            </Button>
            <Button variant="outline" size="sm">
              Sync DLsite
            </Button>
            <select
              className="h-8 rounded-md border bg-card px-3 text-xs font-medium outline-none focus:ring-2 focus:ring-ring"
              value={work.listeningStatus}
              onChange={(event) => void onStatusChange(work.id, event.target.value as ListeningStatus)}
              aria-label="Listening mark"
            >
              {listeningStatusOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <MetaTile icon={<Star className="h-4 w-4 fill-current" />} label="DL rating" value={work.rating === null ? "No rating" : work.rating.toFixed(2)} />
            <MetaTile icon={<Clock3 className="h-4 w-4" />} label="Released" value={work.releaseDate ?? "Unknown"} />
            <MetaTile icon={<FileAudio className="h-4 w-4" />} label="Local files" value={`${work.mediaItems.length} tracks`} />
          </div>

          <InfoRow icon={<CircleUserRound className="h-4 w-4" />} label="Voice" value={work.voiceActors.join(", ") || "No voice actor metadata"} />
          <InfoRow icon={<Tags className="h-4 w-4" />} label="Tags" value={work.tags.join(", ") || "No tag metadata"} />
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold">Directory</h3>
            <p className="text-sm text-muted-foreground">File locations are grouped by local, cache, and remote source.</p>
          </div>
          <div className="flex gap-2 overflow-x-auto">
            {sourceTabs.map((source) => (
              <button
                key={source.key}
                className={`h-8 shrink-0 rounded-md px-3 text-xs font-medium ${
                  source.key === activeSourceKey ? "bg-primary text-primary-foreground" : "border bg-card text-muted-foreground hover:bg-muted"
                }`}
                onClick={() => setActiveSourceKey(source.key)}
              >
                {source.label}
              </button>
            ))}
          </div>
        </div>
        <Card>
          <CardContent className="p-4">
            <DirectoryTree root={tree} currentLocationId={player.currentTrack?.locationId ?? null} onPlayFolder={playTracks} />
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function MetaTile({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1 truncate text-sm font-semibold">{value}</div>
    </div>
  );
}

function InfoRow({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex gap-2 text-sm">
      <div className="mt-0.5 text-muted-foreground">{icon}</div>
      <div className="min-w-0">
        <div className="font-medium">{label}</div>
        <div className="break-words text-muted-foreground">{value}</div>
      </div>
    </div>
  );
}

type TreeNode = {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  files: TreeTrack[];
};

type TreeTrack = {
  mediaItemId: number;
  locationId: number;
  title: string;
  kind: string;
  folderPath: string;
  streamUrl: string;
  downloadUrl: string;
  sizeBytes: number | null;
  availability: string;
  progress: MediaItem["progress"];
};

type SourceTabInfo = {
  key: string;
  label: string;
  fileSourceId: number | null;
};

function buildSourceTabs(items: MediaItem[]): SourceTabInfo[] {
  const sources = new Map<number, SourceTabInfo>();
  for (const item of items) {
    for (const location of item.locations) {
      if (!sources.has(location.fileSourceId)) {
        const label =
          location.locationType === "local"
            ? "Local"
            : location.locationType === "cache"
              ? "Cache"
              : location.fileSourceName;
        sources.set(location.fileSourceId, {
          key: `${location.fileSourceId}:${location.locationType}`,
          label,
          fileSourceId: location.fileSourceId,
        });
      }
    }
  }
  const tabs = Array.from(sources.values());
  return tabs.length > 0 ? tabs : [{ key: "local", label: "Local", fileSourceId: null }];
}

function buildTree(items: MediaItem[], fileSourceId: number | null): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map(), files: [] };
  for (const item of items) {
    const sourceLocations = fileSourceId === null ? item.locations : item.locations.filter((location) => location.fileSourceId === fileSourceId);
    const location = sourceLocations.find((candidate) => candidate.availability === "available" && candidate.streamUrl) ?? sourceLocations[0];
    if (!location) continue;
    const parts = location.path.split("/").filter(Boolean);
    const fileName = parts.pop() ?? item.title;
    let cursor = root;
    for (const part of parts) {
      if (!cursor.children.has(part)) {
        const childPath = cursor.path ? `${cursor.path}/${part}` : part;
        cursor.children.set(part, { name: part, path: childPath, children: new Map(), files: [] });
      }
      cursor = cursor.children.get(part)!;
    }
    cursor.files.push({
      mediaItemId: item.id,
      locationId: location.id,
      title: fileName,
      kind: item.kind,
      folderPath: cursor.path,
      streamUrl: location.streamUrl,
      downloadUrl: location.downloadUrl,
      sizeBytes: location.sizeBytes,
      availability: location.availability,
      progress: item.progress,
    });
  }
  return normalizeDisplayTree(root);
}

function buildRemoteTree(tracks: RemoteTrack[]): TreeNode {
  let nextID = -1;
  const root: TreeNode = { name: "", path: "", children: new Map(), files: [] };
  const walk = (nodes: RemoteTrack[], cursor: TreeNode) => {
    nodes.forEach((node, index) => {
      const title = node.title.trim() || `Track ${index + 1}`;
      if (node.children.length > 0 || node.type === "folder") {
        const childPath = cursor.path ? `${cursor.path}/${title}` : title;
        const child = cursor.children.get(title) ?? { name: title, path: childPath, children: new Map(), files: [] };
        cursor.children.set(title, child);
        walk(node.children, child);
        return;
      }
      cursor.files.push({
        mediaItemId: nextID,
        locationId: nextID,
        title,
        kind: node.type || "file",
        folderPath: cursor.path,
        streamUrl: node.streamUrl,
        downloadUrl: node.downloadUrl,
        sizeBytes: node.sizeBytes,
        availability: node.streamUrl || node.downloadUrl ? "remote" : "metadata",
        progress: null,
      });
      nextID -= 1;
    });
  };
  walk(tracks, root);
  return normalizeDisplayTree(root);
}

function normalizeDisplayTree(root: TreeNode): TreeNode {
  let displayRoot = cloneTree(root, "");
  while (displayRoot.files.length === 0 && displayRoot.children.size === 1) {
    const onlyChild = Array.from(displayRoot.children.values())[0];
    if (onlyChild.files.length > 0 || onlyChild.children.size !== 1) break;
    displayRoot = cloneTree(onlyChild, "");
  }
  return collapseSingleChildFolders(displayRoot, true);
}

function cloneTree(node: TreeNode, path: string): TreeNode {
  const clone: TreeNode = { name: node.name, path, children: new Map(), files: [...node.files] };
  for (const child of node.children.values()) {
    const childPath = path ? `${path}/${child.name}` : child.name;
    clone.children.set(child.name, cloneTree(child, childPath));
  }
  return clone;
}

function collapseSingleChildFolders(node: TreeNode, isRoot = false): TreeNode {
  const collapsed: TreeNode = { ...node, children: new Map(), files: [...node.files] };
  for (const child of node.children.values()) {
    let next = collapseSingleChildFolders(child);
    while (!isRoot && next.files.length === 0 && next.children.size === 1) {
      const grandChild = Array.from(next.children.values())[0];
      next = collapseSingleChildFolders({
        ...grandChild,
        name: `${next.name}/${grandChild.name}`,
        path: next.path,
      });
    }
    collapsed.children.set(next.name, next);
  }
  return collapsed;
}

function DirectoryTree({
  root,
  currentLocationId,
  onPlayFolder,
  emptyLabel = "No local files detected.",
}: {
  root: TreeNode;
  currentLocationId: number | null;
  onPlayFolder?: (tracks: TreeTrack[], locationId: number) => void;
  emptyLabel?: string;
}) {
  const folders = Array.from(root.children.values());
  if (folders.length === 0 && root.files.length === 0) {
    return <div className="text-sm text-muted-foreground">{emptyLabel}</div>;
  }
  return (
    <div className="space-y-2">
      {root.files.map((file) => (
        <TreeFile
          key={file.locationId}
          file={file}
          files={root.files}
          depth={0}
          isActive={file.locationId === currentLocationId}
          onPlayFolder={onPlayFolder}
        />
      ))}
      {folders.map((node) => (
        <TreeFolder
          key={node.path}
          node={node}
          depth={0}
          currentLocationId={currentLocationId}
          onPlayFolder={onPlayFolder}
        />
      ))}
    </div>
  );
}

function TreeFolder({
  node,
  depth,
  currentLocationId,
  onPlayFolder,
}: {
  node: TreeNode;
  depth: number;
  currentLocationId: number | null;
  onPlayFolder?: (tracks: TreeTrack[], locationId: number) => void;
}) {
  const [isOpen, setIsOpen] = useState(depth === 0 || folderNameHasPriority(node.name));
  const childFolders = Array.from(node.children.values());
  const playableFiles = node.files.filter((file) => file.availability === "available" && file.streamUrl);
  const filesLabel = playableFiles.length > 0 ? `${playableFiles.length} audio` : node.files.length > 0 ? `${node.files.length} files` : "";
  return (
    <div className="space-y-1">
      <button
        className="flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm font-medium hover:bg-muted"
        style={{ paddingLeft: depth * 14 + 8 }}
        onClick={() => setIsOpen((value) => !value)}
      >
        {isOpen ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
        <Folder className="h-4 w-4 shrink-0 text-primary" />
        <span className="truncate">{node.name}</span>
        {filesLabel && <span className="ml-auto shrink-0 text-xs text-muted-foreground">{filesLabel}</span>}
      </button>
      {isOpen && (
        <>
          {childFolders.map((child) => (
            <TreeFolder
              key={child.path}
              node={child}
              depth={depth + 1}
              currentLocationId={currentLocationId}
              onPlayFolder={onPlayFolder}
            />
          ))}
          {node.files.map((file) => (
            <TreeFile
              key={file.locationId}
              file={file}
              files={playableFiles}
              depth={depth + 1}
              isActive={file.locationId === currentLocationId}
              onPlayFolder={onPlayFolder}
            />
          ))}
        </>
      )}
    </div>
  );
}

function TreeFile({
  file,
  files,
  depth,
  isActive,
  onPlayFolder,
}: {
  file: TreeTrack;
  files: TreeTrack[];
  depth: number;
  isActive: boolean;
  onPlayFolder?: (tracks: TreeTrack[], locationId: number) => void;
}) {
  const canPlay = Boolean(onPlayFolder && file.availability === "available" && file.streamUrl);
  return (
    <button
      className={`flex min-h-9 w-full items-center justify-between gap-3 rounded-md border px-3 text-left text-sm ${
        isActive ? "border-primary bg-secondary" : "bg-background hover:bg-muted"
      }`}
      style={{ marginLeft: depth * 14, width: `calc(100% - ${depth * 14}px)` }}
      disabled={!canPlay}
      onClick={() => onPlayFolder?.(files, file.locationId)}
    >
      <div className="flex min-w-0 items-center gap-2">
        {isActive ? <Pause className="h-4 w-4 text-primary" /> : <FileAudio className="h-4 w-4 text-muted-foreground" />}
        <span className="truncate">{file.title}</span>
      </div>
      <div className="shrink-0 text-xs text-muted-foreground">
        {formatBytes(file.sizeBytes)} · {file.availability}
      </div>
    </button>
  );
}

function folderNameHasPriority(name: string) {
  const lower = name.toLowerCase();
  return ["本編", "honhen", "main", "mp3"].some((value) => lower.includes(value.toLowerCase()));
}

function flattenTracks(root: TreeNode) {
  const tracks: TreeTrack[] = [];
  const visit = (node: TreeNode) => {
    tracks.push(...node.files.filter((file) => file.availability === "available" && file.streamUrl));
    for (const child of node.children.values()) {
      visit(child);
    }
  };
  visit(root);
  return tracks;
}

function countTreeFiles(root: TreeNode) {
  let count = root.files.length;
  for (const child of root.children.values()) {
    count += countTreeFiles(child);
  }
  return count;
}

function toPlayerTrack(track: TreeTrack, work: WorkDetail): PlayerTrack {
  return {
    ...track,
    workId: work.id,
    workCode: work.primaryCode,
    workTitle: work.title,
    coverUrl: work.coverUrl,
    circle: work.circle,
    progress: track.progress,
  };
}

function formatBytes(value: number | null) {
  if (value === null) return "unknown";
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function listeningStatusLabel(status: ListeningStatus) {
  return listeningStatusOptions.find((option) => option.value === status)?.label ?? "Unmarked";
}

function hasRemoteAvailability(work: Work) {
  return work.availability.some((item) => item === "remote" || item === "cache" || item === "cached");
}

function hasLocalAvailability(work: Work) {
  return work.availability.includes("local");
}

function codeFromPath(path: string) {
  const match = path.match(WORK_CODE_PATTERN);
  return match ? match[1].toUpperCase() : null;
}
