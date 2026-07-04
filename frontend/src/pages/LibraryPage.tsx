import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleUserRound,
  Clock3,
  Database,
  Trash2,
  Eye,
  FileAudio,
  FileText,
  Filter,
  Folder,
  FolderTree,
  HardDrive,
  HardDriveDownload,
  Headphones,
  ImageIcon,
  ExternalLink,
  DownloadCloud,
  Cloud,
  ListChecks,
  MoreHorizontal,
  Pause,
  Play,
  RefreshCw,
  Search,
  Star,
  Tags,
  X,
  UserRound,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { openCircleRoute } from "@/pages/CirclesPage";
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
  type SourceAvailabilitySource,
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
const localWorkPageSizeOptions = [24, 48] as const;
type LocalWorkPageSize = (typeof localWorkPageSizeOptions)[number];

type RemoteSourceViewState = { page: number; pageSize: number; query: string };
const defaultRemoteSourceViewState: RemoteSourceViewState = { page: 1, pageSize: 24, query: "" };

export function LibraryPage() {
  const [works, setWorks] = useState<Work[]>([]);
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const [activeTab, setActiveTab] = useState<LibraryTab>(() => tabFromPath(window.location.pathname, []));
  const [remoteResult, setRemoteResult] = useState<RemoteWorksResponse | null>(null);
  const [remoteSourceStates, setRemoteSourceStates] = useState<Record<number, RemoteSourceViewState>>({});
  const [settings, setSettings] = useState<{ autoSyncRemote: boolean; cacheEnabled: boolean } | null>(null);
  const [selectedCode, setSelectedCode] = useState<string | null>(() => codeFromPath(window.location.pathname));
  const [selectedWork, setSelectedWork] = useState<WorkDetail | null>(null);
  const [selectedRemoteTarget, setSelectedRemoteTarget] = useState<{ source: LibrarySource; code: string } | null>(null);
  const [isAPIAvailable, setIsAPIAvailable] = useState(false);
  const [statusFilter, setStatusFilter] = useState<ListeningStatus | "all">("all");
  const [mobileColumns, setMobileColumns] = useState<1 | 2>(2);
  const [desktopColumns, setDesktopColumns] = useState<4 | 6 | 8>(6);
  const [workPage, setWorkPage] = useState(1);
  const [workPageSize, setWorkPageSize] = useState<LocalWorkPageSize>(24);

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
    api.listLibrarySources().then((items) => {
      setSources(items);
      setActiveTab((tab) => resolveTabFromPath(window.location.pathname, items, tab));
      const routeRemoteTarget = remoteTargetFromLocation(window.location.pathname, window.location.search, items);
      if (routeRemoteTarget) setSelectedRemoteTarget(routeRemoteTarget);
    }).catch(() => setSources([]));
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
    const syncFromPath = () => {
      setSelectedCode(codeFromPath(window.location.pathname));
      setSelectedRemoteTarget(remoteTargetFromLocation(window.location.pathname, window.location.search, sources));
      setActiveTab((tab) => resolveTabFromPath(window.location.pathname, sources, tab));
    };
    const handlePopState = () => syncFromPath();
    const handleAppNavigation = () => syncFromPath();
    window.addEventListener("popstate", handlePopState);
    window.addEventListener("kikoto:navigation", handleAppNavigation);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("kikoto:navigation", handleAppNavigation);
    };
  }, [sources]);

  useEffect(() => {
    setWorkPage(1);
  }, [activeTab.kind, activeTab.kind === "source" ? activeTab.source.id : "", statusFilter, workPageSize]);

  const openWork = (work: Work) => {
    const path = `/${work.primaryCode}`;
    window.history.pushState({}, "", path);
    window.dispatchEvent(new Event("kikoto:navigation"));
    setSelectedCode(work.primaryCode);
  };

  const openRemotePreview = (source: LibrarySource, work: RemoteWork) => {
    if (!work.primaryCode) return;
    setSelectedRemoteTarget({ source, code: work.primaryCode });
    window.history.pushState({}, "", `/${work.primaryCode}?source=${source.id}`);
    setSelectedCode(work.primaryCode);
  };

  const backToLibrary = () => {
    window.history.pushState({}, "", pathForLibraryTab(activeTab));
    window.dispatchEvent(new Event("kikoto:navigation"));
    setSelectedCode(null);
    setSelectedRemoteTarget(null);
  };

  const changeTab = (tab: LibraryTab) => {
    setActiveTab(tab);
    setSelectedRemoteTarget(null);
    const path = pathForLibraryTab(tab);
    if (window.location.pathname !== path) {
      window.history.pushState({}, "", path);
      window.dispatchEvent(new Event("kikoto:navigation"));
    }
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
    if (selectedRemoteTarget !== null && selectedRemoteTarget.code.toUpperCase() === selectedCode.toUpperCase()) {
      return (
        <RemoteWorkDetailView
          source={selectedRemoteTarget.source}
          code={selectedRemoteTarget.code}
          autoSyncRemote={(settings?.autoSyncRemote ?? false) || selectedRemoteTarget.source.autoSyncOnInterest || selectedRemoteTarget.source.cacheEnabled}
          onBack={backToLibrary}
          onOpenLocal={(workID) => {
            const work = works.find((item) => item.id === workID);
            if (work) openWork(work);
          }}
          onWorksChanged={async () => setWorks(await api.listWorks())}
        />
      );
    }
    return (
      <WorkDetailView
        code={selectedCode}
        work={selectedWork}
        sources={sources}
        autoSyncRemoteGlobal={settings?.autoSyncRemote ?? false}
        onBack={backToLibrary}
        onStatusChange={updateWorkStatus}
        onWorksChanged={async () => setWorks(await api.listWorks())}
      />
    );
  }

  if (selectedRemoteTarget !== null) {
    return (
        <RemoteWorkDetailView
          source={selectedRemoteTarget.source}
          code={selectedRemoteTarget.code}
          autoSyncRemote={(settings?.autoSyncRemote ?? false) || selectedRemoteTarget.source.autoSyncOnInterest || selectedRemoteTarget.source.cacheEnabled}
          onBack={backToLibrary}
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
  const totalWorkPages = Math.max(1, Math.ceil(visibleWorks.length / workPageSize));
  const currentWorkPage = Math.min(workPage, totalWorkPages);
  const pagedWorks = visibleWorks.slice((currentWorkPage - 1) * workPageSize, currentWorkPage * workPageSize);

  return (
    <div className="space-y-5">
      <section className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-h-10 flex-1 items-center gap-2 rounded-lg border bg-card px-3 text-sm text-muted-foreground lg:max-w-xl">
          <Search className="h-4 w-4" />
          <span>Search title, code, circle, tag, or creator</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <ColumnPicker mobileColumns={mobileColumns} desktopColumns={desktopColumns} onMobileChange={setMobileColumns} onDesktopChange={setDesktopColumns} />
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

      <LibraryTabs activeTab={activeTab} sources={sources} onChange={changeTab} />

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
        <div className="space-y-3">
          <section className={workGridClassName(mobileColumns, desktopColumns)}>
            {pagedWorks.map((work) => (
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
          {totalWorkPages > 1 && (
            <WorkPagination
              page={currentWorkPage}
              pageSize={workPageSize}
              totalItems={visibleWorks.length}
              totalPages={totalWorkPages}
              onPageChange={setWorkPage}
              onPageSizeChange={setWorkPageSize}
            />
          )}
        </div>
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
  const [bulkCodes, setBulkCodes] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [isBulkBusy, setIsBulkBusy] = useState(false);
  const [saveConfirm, setSaveConfirm] = useState<{ codes: string[]; run: () => Promise<void> } | null>(null);
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
  const selectableWorks = visibleWorks.filter((work) => work.primaryCode);
  const selectedWorks = selectableWorks.filter((work) => bulkCodes.has(work.primaryCode));
  const selectedSyncable = selectedWorks.filter((work) => work.workId === null);
  const selectedSaveable = selectedWorks;
  const selectionActive = selectionMode;
  const canGoNext = result !== null && result.works.length >= pageSize;
  const canGoPrevious = page > 1;

  useEffect(() => {
    setBulkCodes((current) => new Set(Array.from(current).filter((code) => visibleWorks.some((work) => work.primaryCode === code))));
  }, [visibleWorks]);

  const toggleBulkCode = (code: string, checked: boolean) => {
    setBulkCodes((current) => {
      const next = new Set(current);
      if (checked) next.add(code);
      else next.delete(code);
      return next;
    });
  };

  const toggleAllVisible = (checked: boolean) => {
    setBulkCodes(() => checked ? new Set(selectableWorks.map((work) => work.primaryCode)) : new Set());
  };

  const bulkSyncSelected = async () => {
    if (selectedSyncable.length === 0) return;
    setIsBulkBusy(true);
    setMessage("");
    let synced = 0;
    try {
      const parent = await api.recordRemoteBulkRun({ action: "sync", sourceId: source.id, codes: selectedSyncable.map((work) => work.primaryCode) }).catch(() => null);
      for (const work of selectedSyncable) {
        const result = await api.syncRemoteSourceWork(source.id, work.primaryCode, "bulk_manual_fetch");
        synced++;
        await onSynced(result.workId);
      }
      setMessage(parent ? `Bulk workflow #${parent.runId}: synced ${synced} remote-only works.` : `Synced ${synced} remote-only works.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Bulk sync failed.");
    } finally {
      setIsBulkBusy(false);
    }
  };

  const bulkSaveSelected = async () => {
    if (selectedSaveable.length === 0) return;
    setSaveConfirm({ codes: selectedSaveable.map((work) => work.primaryCode), run: runBulkSaveSelected });
  };

  const runBulkSaveSelected = async () => {
    setIsBulkBusy(true);
    setMessage("");
    let saved = 0;
    try {
      const parent = await api.recordRemoteBulkRun({ action: "save", sourceId: source.id, codes: selectedSaveable.map((work) => work.primaryCode) }).catch(() => null);
      for (const work of selectedSaveable) {
        const result = await api.saveRemoteSourceWork(source.id, work.primaryCode, []);
        saved++;
        await onSynced(result.workId);
      }
      setMessage(parent ? `Bulk workflow #${parent.runId}: saved ${saved} selected works.` : `Saved ${saved} selected works.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Bulk save failed.");
    } finally {
      setIsBulkBusy(false);
      setSaveConfirm(null);
    }
  };

  const saveSingle = (work: RemoteWork) => {
    setSaveConfirm({
      codes: [work.primaryCode],
      run: async () => {
        setIsSyncingCode(work.primaryCode);
        setMessage("");
        try {
          const result = await api.saveRemoteSourceWork(source.id, work.primaryCode, []);
          setMessage(`Saved ${result.primaryCode} through workflow run #${result.runId}.`);
          await onSynced(result.workId);
        } catch (error) {
          setMessage(error instanceof Error ? error.message : "Save failed.");
        } finally {
          setIsSyncingCode(null);
          setSaveConfirm(null);
        }
      },
    });
  };

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{source.displayName}</h2>
          <p className="text-sm text-muted-foreground">Browse source results without importing until a user action needs local state.</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 rounded-md border bg-card px-2 py-1 text-xs text-muted-foreground">
            <input type="checkbox" checked={selectionMode} onChange={(event) => {
              setSelectionMode(event.target.checked);
              if (!event.target.checked) setBulkCodes(new Set());
            }} />
            Select
          </label>
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
      {selectionMode && <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2 text-sm">
        <div className="text-muted-foreground">{selectedWorks.length} selected</div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => toggleAllVisible(true)}>Select all</Button>
          <Button variant="outline" size="sm" onClick={() => {
            setBulkCodes(new Set());
            setSelectionMode(false);
          }}>Cancel selection</Button>
          <Button variant="outline" size="sm" disabled={isBulkBusy || selectedSyncable.length === 0} onClick={() => void bulkSyncSelected()}>
            <DownloadCloud className="h-4 w-4" />
            Sync {selectedSyncable.length}
          </Button>
          <Button variant="outline" size="sm" disabled={isBulkBusy || selectedSaveable.length === 0} onClick={() => void bulkSaveSelected()}>
            <HardDriveDownload className="h-4 w-4" />
            Save {selectedSaveable.length}
          </Button>
        </div>
      </div>}
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
        <section className={workGridClassName(2, 6)}>
          {visibleWorks.map((work) => (
            <RemoteWorkCard
              key={work.remoteId}
              work={work}
              selected={bulkCodes.has(work.primaryCode)}
              selectable={Boolean(work.primaryCode)}
              selectionActive={selectionActive}
              isBusy={isSyncingCode === work.primaryCode}
              onSelectedChange={(checked) => toggleBulkCode(work.primaryCode, checked)}
              onOpen={() => onOpenPreview(work)}
              onFetch={() => void syncWork(work, "manual_fetch")}
              onFetchAndMark={() => void syncWork(work, "mark_interest")}
              onSave={() => saveSingle(work)}
            />
          ))}
        </section>
      )}
      {saveConfirm && (
        <SaveConfirmModal
          count={saveConfirm.codes.length}
          onClose={() => setSaveConfirm(null)}
          onConfirm={() => void saveConfirm.run()}
        />
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
        <div className="relative block w-full cursor-pointer text-left" onClick={onOpen}>
          <WorkCardMedia coverUrl={work.coverUrl} code={work.primaryCode} rating={work.rating} />
          <WorkCardBody
            title={work.title}
            circle={work.circle || "Unknown circle"}
            circleExternalId={work.circleExternalId}
            releaseDate={work.releaseDate}
            updatedAt={work.updatedAt || work.createdAt}
            rating={work.rating}
            sales={work.sales}
            tagBadges={work.tags.slice(0, 3).map((tag) => ({ value: tag, variant: "outline" as const }))}
            sourceBadges={work.availability.map((item) => ({ value: item, variant: item === "missing" ? ("warning" as const) : ("secondary" as const) }))}
          />
        </div>
        <div className="flex h-11 items-center justify-between border-t px-3">
          <Button variant="ghost" size="icon" asChild title="Open DLsite">
            <a href={work.dlsiteUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} aria-label="Open DLsite">
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
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
        </div>
      </CardContent>
    </Card>
  );
}

function RemoteWorkCard({
  work,
  selected,
  selectable,
  selectionActive,
  isBusy,
  onSelectedChange,
  onOpen,
  onFetch,
  onFetchAndMark,
  onSave,
}: {
  work: RemoteWork;
  selected: boolean;
  selectable: boolean;
  selectionActive: boolean;
  isBusy: boolean;
  onSelectedChange: (checked: boolean) => void;
  onOpen: () => void;
  onFetch: () => void;
  onFetchAndMark: () => void;
  onSave: () => void;
}) {
  return (
    <Card className="group h-full overflow-hidden transition-colors hover:border-primary/50">
      <CardContent className="p-0">
        <div className="relative block w-full cursor-pointer text-left" onClick={onOpen}>
          {selectionActive && (
            <label className="absolute right-3 top-3 z-10 rounded-md bg-background/90 px-2 py-1 text-xs" onClick={(event) => event.stopPropagation()}>
              <input type="checkbox" checked={selected} disabled={!selectable} onChange={(event) => onSelectedChange(event.target.checked)} />
            </label>
          )}
          <WorkCardMedia coverUrl={work.coverUrl} code={work.primaryCode || work.remoteId} rating={work.rating} />
          <WorkCardBody
            title={work.title}
            circle={work.circle || "Unknown circle"}
            circleExternalId=""
            releaseDate={work.releaseDate || null}
            updatedAt={work.updatedAt || work.releaseDate}
            rating={work.rating}
            sales={work.sales}
            tagBadges={work.tags.slice(0, 3).map((tag) => ({ value: tag, variant: "outline" as const }))}
            sourceBadges={work.remotePlayable ? [{ value: "remote source", variant: "outline" as const }] : []}
          />
        </div>
        <div className="flex h-11 items-center justify-between border-t px-3">
          <Button variant="ghost" size="icon" asChild title="Open DLsite">
            <a href={dlsiteWorkURL(work.primaryCode)} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} aria-label="Open DLsite">
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
          <div className="flex items-center gap-1">
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
            <IconButton
              title="Save to library"
              disabled={isBusy || !work.primaryCode}
              onClick={(event) => {
                event.stopPropagation();
                onSave();
              }}
            >
              <HardDriveDownload className="h-4 w-4" />
            </IconButton>
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

function WorkCardMedia({
  coverUrl,
  code,
  rating,
}: {
  coverUrl: string;
  code: string;
  rating: number | null;
}) {
  const codeText = code || "Remote";
  return (
    <div className="relative aspect-[4/3] overflow-hidden bg-muted">
      {coverUrl ? (
        <img src={assetURL(coverUrl)} alt="" className="h-full w-full object-contain transition-transform group-hover:scale-[1.03]" />
      ) : (
        <div className="grid h-full place-items-center bg-secondary text-2xl font-bold text-secondary-foreground">{codeText.slice(0, 2)}</div>
      )}
      <div className="absolute left-3 top-3 rounded-md bg-background/90 px-2 py-1 text-xs font-semibold">{codeText}</div>
      <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-md bg-background/90 px-2 py-1 text-xs font-semibold">
        <Star className="h-3.5 w-3.5 fill-current" />
        {rating === null ? "No rating" : rating.toFixed(2)}
      </div>
    </div>
  );
}

type CardBadge = { value: string; variant: "secondary" | "outline" | "warning" };

function WorkCardBody({
  title,
  circle,
  circleExternalId,
  releaseDate,
  updatedAt,
  rating,
  sales,
  tagBadges,
  sourceBadges,
}: {
  title: string;
  circle: string;
  circleExternalId: string;
  releaseDate: string | null;
  updatedAt: string;
  rating: number | null;
  sales: number | null;
  tagBadges: CardBadge[];
  sourceBadges: CardBadge[];
}) {
  return (
    <div className="flex min-h-52 flex-col gap-3 p-4">
      <div className="space-y-1">
        <h2 className="line-clamp-2 min-h-10 text-base font-semibold leading-snug">{title}</h2>
        <button
          className="block max-w-full truncate text-left text-sm text-muted-foreground hover:text-primary"
          onClick={(event) => {
            event.stopPropagation();
            openCircleRoute(circleExternalId || undefined);
          }}
        >
          {circle}
        </button>
      </div>
      <div className="flex min-h-6 flex-wrap gap-1.5">
        {tagBadges.length > 0 ? tagBadges.map((badge) => (
          <Badge key={`${badge.value}:${badge.variant}`} variant={badge.variant}>
            {badge.value}
          </Badge>
        )) : <span className="text-xs text-muted-foreground">No tags</span>}
      </div>
      <div className="grid gap-1 text-xs text-muted-foreground">
        <div className="truncate">Release {releaseDate || "unknown"} · Updated {updatedAt || "unknown"}</div>
        <div className="truncate">DLsite rate {rating === null ? "unknown" : rating.toFixed(2)} · Sales {sales === null ? "unknown" : sales.toLocaleString()}</div>
      </div>
      <div className="mt-auto flex min-h-6 flex-wrap gap-1.5">
        {sourceBadges.length > 0 ? sourceBadges.map((badge) => (
          <Badge key={`${badge.value}:${badge.variant}`} variant={badge.variant}>
            {badge.value}
          </Badge>
        )) : <Badge variant="warning">missing</Badge>}
      </div>
    </div>
  );
}

function ColumnPicker({
  mobileColumns,
  desktopColumns,
  onMobileChange,
  onDesktopChange,
}: {
  mobileColumns: 1 | 2;
  desktopColumns: 4 | 6 | 8;
  onMobileChange: (value: 1 | 2) => void;
  onDesktopChange: (value: 4 | 6 | 8) => void;
}) {
  return (
    <>
      <div className="flex rounded-md border bg-card p-1 sm:hidden" aria-label="Mobile card columns">
        {[1, 2].map((value) => (
          <button
            key={value}
            className={`h-7 rounded px-2 text-xs font-medium ${mobileColumns === value ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
            onClick={() => onMobileChange(value as 1 | 2)}
          >
            {value}
          </button>
        ))}
      </div>
      <div className="hidden rounded-md border bg-card p-1 sm:flex" aria-label="Desktop card columns">
        {[4, 6, 8].map((value) => (
          <button
            key={value}
            className={`h-7 rounded px-2 text-xs font-medium ${desktopColumns === value ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
            onClick={() => onDesktopChange(value as 4 | 6 | 8)}
          >
            {value}
          </button>
        ))}
      </div>
    </>
  );
}

function WorkPagination({
  page,
  pageSize,
  totalItems,
  totalPages,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageSize: LocalWorkPageSize;
  totalItems: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: LocalWorkPageSize) => void;
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
          onChange={(event) => onPageSizeChange(Number(event.target.value) as LocalWorkPageSize)}
          aria-label="Works per page"
        >
          {localWorkPageSizeOptions.map((value) => (
            <option key={value} value={value}>
              {value} / page
            </option>
          ))}
        </select>
        <IconButton title="Previous page" disabled={page <= 1} onClick={() => onPageChange(Math.max(1, page - 1))}>
          <ChevronLeft className="h-4 w-4" />
        </IconButton>
        <IconButton title="Next page" disabled={page >= totalPages} onClick={() => onPageChange(Math.min(totalPages, page + 1))}>
          <ChevronRight className="h-4 w-4" />
        </IconButton>
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

function workGridClassName(mobileColumns: 1 | 2, desktopColumns: 4 | 6 | 8) {
  const mobileClass = mobileColumns === 1 ? "grid-cols-1" : "grid-cols-2";
  const desktopClass = desktopColumns === 4 ? "sm:grid-cols-4" : desktopColumns === 6 ? "sm:grid-cols-6" : "sm:grid-cols-8";
  return `grid gap-4 ${mobileClass} ${desktopClass}`;
}

function dlsiteWorkURL(code: string) {
  const site = code.toUpperCase().startsWith("RJ") ? "maniax" : "home";
  return `https://www.dlsite.com/${site}/work/=/product_id/${encodeURIComponent(code)}.html`;
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
  const [isSaving, setIsSaving] = useState(false);
  const [directoryMode, setDirectoryMode] = useState<"browse" | "tree">("browse");
  const tree = useMemo(() => buildRemoteTree(detail?.tracks ?? []), [detail]);
  const remoteFilePaths = useMemo(() => remoteSelectablePaths(tree), [tree]);
  const [selectedSavePaths, setSelectedSavePaths] = useState<Set<string>>(new Set());
  const [isSaveSelectionOpen, setIsSaveSelectionOpen] = useState(false);
  const [cacheDeleteTarget, setCacheDeleteTarget] = useState<MediaDeleteTarget | null>(null);
  const [isDeletingCache, setIsDeletingCache] = useState(false);
  const trackCount = useMemo(() => countTreeFiles(tree), [tree]);
  const remotePlayableTracks = useMemo(() => flattenTracks(tree), [tree]);
  const remoteTabs = useMemo<SourceTabInfo[]>(() => detail ? [{ key: remoteSourceTabKey(source.id), label: detail.sourceName, fileSourceId: null }] : [], [detail, source.id]);
  const player = usePlayer();

  useEffect(() => {
    setDetail(null);
    setMessage("");
    setSelectedSavePaths(new Set());
    api.getRemoteSourceWork(source.id, code).then(setDetail).catch((error) => {
      setMessage(error instanceof Error ? error.message : "Remote preview failed.");
    });
  }, [source.id, code]);

  useEffect(() => {
    setSelectedSavePaths(new Set(remoteFilePaths));
  }, [remoteFilePaths]);

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

  const selectedPaths = Array.from(selectedSavePaths).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  const saveSelected = async () => {
    if (!detail?.primaryCode || selectedPaths.length === 0) return;
    setIsSaving(true);
    setMessage("");
    try {
      const result = await api.saveRemoteSourceWork(source.id, detail.primaryCode, selectedPaths);
      setMessage(`Fetched ${result.savedFiles} files through workflow run #${result.runId}.`);
      setIsSaveSelectionOpen(false);
      await onWorksChanged();
      onOpenLocal(result.workId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Save failed.");
    } finally {
      setIsSaving(false);
    }
  };

  const deleteCache = async () => {
    if (!cacheDeleteTarget) return;
    setIsDeletingCache(true);
    setMessage("");
    try {
      const result = await api.deleteMediaCacheLocation(cacheDeleteTarget.locationId);
      setMessage(`Deleted cache ${result.cachePath} through workflow run #${result.runId}.`);
      setCacheDeleteTarget(null);
      const refreshed = await api.getRemoteSourceWork(source.id, code);
      setDetail(refreshed);
      await onWorksChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Cache delete failed.");
    } finally {
      setIsDeletingCache(false);
    }
  };

  const playRemoteTracks = (tracks: TreeTrack[], locationId: number) => {
    if (!detail || tracks.length === 0) return;
    player.playQueue(
      tracks.map((track) => toRemotePreviewPlayerTrack(track, detail)),
      locationId,
    );
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

      <DetailHero
        coverUrl={detail.coverUrl}
        fallbackCode={detail.primaryCode || detail.remoteId}
        code={detail.primaryCode || detail.remoteId}
        title={detail.title}
        circle={detail.circle}
        circleExternalId=""
        ratingLabel="Rating"
        rating={detail.rating}
        releaseDate={detail.releaseDate || "Unknown"}
        fileLabel={source.displayName}
        fileValue={`${trackCount} files`}
        voiceActors={detail.voiceActors}
        tags={detail.tags}
        actions={
          <Button variant="outline" size="sm" disabled={isFetching || !detail.primaryCode} onClick={() => void fetchWork("manual_fetch")}>
            <RefreshCw className="h-4 w-4" />
            Sync DLsite
          </Button>
        }
      />

      <SourceDirectoryPanel
        title={detail.sourceName}
        description={`Previewing remote files from ${detail.sourceName}; fetch before local marks or saves.`}
        tabs={remoteTabs}
        activeKey={remoteSourceTabKey(source.id)}
        onActiveKeyChange={() => undefined}
        directoryMode={directoryMode}
        onDirectoryModeChange={setDirectoryMode}
        root={tree}
        currentLocationId={player.currentTrack?.locationId ?? null}
        emptyLabel="No remote files detected."
        toolbar={
          <SourceDirectoryToolbar
            label={detail.sourceName}
            description={`${trackCount} remote files detected.`}
            message={message}
            busy={isFetching || isSaving}
            onPlay={remotePlayableTracks.length > 0 ? () => playRemoteTracks(remotePlayableTracks, remotePlayableTracks[0].locationId) : undefined}
            onOpenLocal={detail.workId !== null ? () => onOpenLocal(detail.workId!) : undefined}
            onSelectSaveFiles={() => setIsSaveSelectionOpen(true)}
            selectedCount={selectedPaths.length}
          />
        }
        selectionModal={isSaveSelectionOpen ? (
          <RemoteSaveSelectionPanel
            root={tree}
            selectedPaths={selectedSavePaths}
            onChange={setSelectedSavePaths}
            disabled={isSaving}
            onClose={() => setIsSaveSelectionOpen(false)}
            onSave={() => void saveSelected()}
          />
        ) : null}
        onPlayFolder={playRemoteTracks}
        onDeleteCache={setCacheDeleteTarget}
      />
      {cacheDeleteTarget && (
        <ConfirmMediaDeleteModal
          target={cacheDeleteTarget}
          deleting={isDeletingCache}
          onCancel={() => setCacheDeleteTarget(null)}
          onConfirm={() => void deleteCache()}
        />
      )}
    </div>
  );
}

function WorkDetailView({
  code,
  work,
  sources,
  autoSyncRemoteGlobal,
  onBack,
  onStatusChange,
  onWorksChanged,
}: {
  code: string;
  work: WorkDetail | null;
  sources: LibrarySource[];
  autoSyncRemoteGlobal: boolean;
  onBack: () => void;
  onStatusChange: (workID: number, status: ListeningStatus) => Promise<void>;
  onWorksChanged: () => Promise<void>;
}) {
  const [remoteSources, setRemoteSources] = useState<RemoteSourceAvailability[]>([]);
  const [isCheckingSources, setIsCheckingSources] = useState(false);
  const sourceTabs = useMemo(() => buildSourceTabs(work?.mediaItems ?? [], remoteSources), [work, remoteSources]);
  const [activeSourceKey, setActiveSourceKey] = useState("local");
  const [directoryMode, setDirectoryMode] = useState<"browse" | "tree">("browse");
  const [preview, setPreview] = useState<FilePreviewState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MediaDeleteTarget | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [message, setMessage] = useState("");
  const [selectedSavePaths, setSelectedSavePaths] = useState<Set<string>>(new Set());
  const [isSaving, setIsSaving] = useState(false);
  const [isSyncingDetail, setIsSyncingDetail] = useState(false);
  const [isSaveSelectionOpen, setIsSaveSelectionOpen] = useState(false);
  const selectedSource = sourceTabs.find((source) => source.key === activeSourceKey) ?? sourceTabs[0];
  const selectedRemoteSource = remoteSources.find((item) => selectedSource?.key === remoteSourceTabKey(item.source.id));
  const selectedRemoteDetail = selectedRemoteSource?.detail ?? null;
  const selectedRemoteSourceID = selectedRemoteSource?.source.id ?? null;
  const selectedRemoteWorkCode = selectedRemoteSource?.summary.primaryCode || work?.primaryCode || code;
  const tree = useMemo(
    () => {
      if (selectedRemoteSource && !selectedRemoteDetail) return emptyTree();
      return selectedRemoteDetail ? buildRemoteTree(selectedRemoteDetail.tracks) : buildTree(work?.mediaItems ?? [], selectedSource?.fileSourceId ?? null, work?.primaryCode ?? "");
    },
    [work, selectedSource, selectedRemoteDetail],
  );
  const allTracks = useMemo(() => flattenTracks(tree), [tree]);
  const remoteFilePaths = useMemo(() => selectedRemoteDetail ? remoteSelectablePaths(tree) : [], [selectedRemoteDetail, tree]);
  const selectedPaths = useMemo(() => Array.from(selectedSavePaths).sort((a, b) => naturalCompare(a, b)), [selectedSavePaths]);
  const player = usePlayer();
  const directoryTitle = selectedRemoteSource?.source.displayName ?? selectedSource?.label ?? "Directory";
  const directoryDescription = selectedRemoteSource
    ? `Previewing remote files from ${selectedRemoteSource.source.displayName}.`
    : "File locations are grouped by local, cache, and remote source.";

  useEffect(() => {
    if (sourceTabs.length > 0 && !sourceTabs.some((source) => source.key === activeSourceKey)) {
      setActiveSourceKey(sourceTabs[0].key);
    }
  }, [activeSourceKey, sourceTabs]);

  useEffect(() => {
    setRemoteSources([]);
    if (!work?.primaryCode || sources.length === 0) return;
    let cancelled = false;
    setIsCheckingSources(true);
    api.getSourceAvailability(work.primaryCode)
      .then((result) => {
        if (cancelled) return;
        const availableSources = result.sources.flatMap((summary) => {
          const source = sources.find((candidate) => candidate.id === summary.sourceId);
          return source && summary.status === "available" ? [{ source, summary }] : [];
        });
        setRemoteSources(availableSources);
      })
      .catch(() => {
        if (!cancelled) setRemoteSources([]);
      })
      .finally(() => {
        if (!cancelled) setIsCheckingSources(false);
      });
    return () => {
      cancelled = true;
    };
  }, [work?.primaryCode, sources]);

  useEffect(() => {
    if (!selectedRemoteSource || selectedRemoteSource.detail || selectedRemoteSource.loading || selectedRemoteSource.error) return;
    const sourceID = selectedRemoteSource.source.id;
    setRemoteSources((items) => items.map((item) => item.source.id === sourceID ? { ...item, loading: true, error: "" } : item));
    api.getRemoteSourceWork(sourceID, selectedRemoteWorkCode)
      .then((detail) => {
        setRemoteSources((items) => items.map((item) => item.source.id === sourceID ? { ...item, detail, loading: false, error: "" } : item));
      })
      .catch((error) => {
        setRemoteSources((items) => items.map((item) => item.source.id === sourceID ? { ...item, loading: false, error: error instanceof Error ? error.message : "Remote detail failed." } : item));
      });
  }, [selectedRemoteSourceID, selectedRemoteWorkCode]);

  useEffect(() => {
    setSelectedSavePaths(new Set(remoteFilePaths));
  }, [remoteFilePaths]);

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

  const playRemoteTracks = (tracks: TreeTrack[], locationId: number) => {
    if (!selectedRemoteDetail || tracks.length === 0) return;
    player.playQueue(
      tracks.map((track) => toRemotePreviewPlayerTrack(track, selectedRemoteDetail)),
      locationId,
    );
  };

  const deleteLocal = async () => {
    if (!deleteTarget || deleteTarget.kind !== "local") return;
    setIsDeleting(true);
    setMessage("");
    try {
      const result = await api.deleteMediaLocalLocation(deleteTarget.locationId);
      setMessage(`Deleted local file through workflow run #${result.runId}.`);
      setDeleteTarget(null);
      await onWorksChanged();
    } finally {
      setIsDeleting(false);
    }
  };

  const deleteCache = async () => {
    if (!deleteTarget || deleteTarget.kind !== "cache") return;
    setIsDeleting(true);
    setMessage("");
    try {
      const result = await api.deleteMediaCacheLocation(deleteTarget.locationId);
      setMessage(`Deleted cache ${result.cachePath} through workflow run #${result.runId}.`);
      setDeleteTarget(null);
      await onWorksChanged();
    } finally {
      setIsDeleting(false);
    }
  };

  const planRemoteSave = async () => {
    if (!selectedRemoteSource?.detail || selectedPaths.length === 0) return;
    setIsSaving(true);
    setMessage("");
    try {
      const result = await api.saveRemoteSourceWork(selectedRemoteSource.source.id, selectedRemoteSource.detail.primaryCode, selectedPaths);
      setMessage(`Fetched ${result.savedFiles} files through workflow run #${result.runId}.`);
      setIsSaveSelectionOpen(false);
      await onWorksChanged();
      openRemoteLocal(result.workId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Save failed.");
    } finally {
      setIsSaving(false);
    }
  };

  const syncDetailMetadata = async () => {
    if (!work?.primaryCode) return;
    setIsSyncingDetail(true);
    setMessage("");
    try {
      if (selectedRemoteSource?.detail?.primaryCode) {
        const result = await api.syncRemoteSourceWork(selectedRemoteSource.source.id, selectedRemoteSource.detail.primaryCode, "manual_fetch");
        setMessage(`Synced ${result.primaryCode} through workflow run #${result.runId}.`);
        await onWorksChanged();
        openRemoteLocal(result.workId);
      } else {
        const result = await api.runDLsiteSync();
        setMessage(`DLsite sync run #${result.runId}: ${result.syncedWorks}/${result.targetWorks} works synced.`);
        await onWorksChanged();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sync failed.");
    } finally {
      setIsSyncingDetail(false);
    }
  };

  const openRemoteLocal = (workID: number) => {
    if (!work || work.id === workID) {
      setActiveSourceKey("local");
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

      <DetailHero
        coverUrl={work.coverUrl}
        fallbackCode={work.primaryCode}
        code={work.primaryCode}
        title={work.title}
        circle={work.circle}
        circleExternalId={work.circleExternalId}
        ratingLabel="DL rating"
        rating={work.rating}
        releaseDate={work.releaseDate ?? "Unknown"}
        fileLabel="Known files"
        fileValue={`${work.mediaItems.length} items`}
        voiceActors={work.voiceActors}
        tags={work.tags}
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <a href={work.dlsiteUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="h-4 w-4" />
                DLsite
              </a>
            </Button>
            <Button variant="outline" size="sm" disabled={isSyncingDetail} onClick={() => void syncDetailMetadata()}>
              <RefreshCw className="h-4 w-4" />
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
          </>
        }
        availability={
          <SourceAvailabilitySummary
            tabs={sourceTabs}
            remoteSources={remoteSources}
            checking={isCheckingSources}
          />
        }
      />

      <SourceDirectoryPanel
        title={directoryTitle}
        description={directoryDescription}
        tabs={sourceTabs}
        activeKey={activeSourceKey}
        onActiveKeyChange={setActiveSourceKey}
        checkingLabel={isCheckingSources ? "Checking sources..." : ""}
        directoryMode={directoryMode}
        onDirectoryModeChange={setDirectoryMode}
        root={tree}
        currentLocationId={player.currentTrack?.locationId ?? null}
        emptyLabel={selectedRemoteSource ? "No remote files detected." : "No local files detected."}
        toolbar={
          selectedRemoteSource?.detail ? (
            <SourceDirectoryToolbar
              label={selectedRemoteSource.source.displayName}
              description={`${countTreeFiles(tree)} remote files detected.`}
              message={message}
              busy={isSaving}
              onPlay={allTracks.length > 0 ? playAll : undefined}
              onSelectSaveFiles={() => setIsSaveSelectionOpen(true)}
              selectedCount={selectedPaths.length}
            />
          ) : (
            <SourceDirectoryToolbar
              label={directoryTitle}
              description={`${allTracks.length} playable files in this source.`}
              message={message}
              busy={false}
              onPlay={allTracks.length > 0 ? playAll : undefined}
            />
          )
        }
        selectionModal={isSaveSelectionOpen && selectedRemoteDetail ? (
          <RemoteSaveSelectionPanel
            root={tree}
            selectedPaths={selectedSavePaths}
            onChange={setSelectedSavePaths}
            disabled={isSaving}
            onClose={() => setIsSaveSelectionOpen(false)}
            onSave={() => void planRemoteSave()}
          />
        ) : null}
        loadingMessage={selectedRemoteSource && !selectedRemoteSource.detail ? (selectedRemoteSource.loading ? "Loading remote directory..." : selectedRemoteSource.error || "Remote directory is not loaded yet.") : ""}
        onPlayFolder={selectedRemoteDetail ? playRemoteTracks : playTracks}
        onPreview={setPreview}
        onDeleteCache={selectedRemoteDetail ? setDeleteTarget : undefined}
        onDeleteLocal={selectedRemoteSource ? undefined : setDeleteTarget}
      />
      {preview && <FilePreviewModal preview={preview} onClose={() => setPreview(null)} />}
      {deleteTarget && (
        <ConfirmMediaDeleteModal
          target={deleteTarget}
          deleting={isDeleting}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void (deleteTarget.kind === "cache" ? deleteCache() : deleteLocal())}
        />
      )}
    </div>
  );
}

function DetailHero({
  coverUrl,
  fallbackCode,
  code,
  title,
  circle,
  circleExternalId,
  ratingLabel,
  rating,
  releaseDate,
  fileLabel,
  fileValue,
  voiceActors,
  tags,
  actions,
  availability,
}: {
  coverUrl: string;
  fallbackCode: string;
  code: string;
  title: string;
  circle: string;
  circleExternalId: string;
  ratingLabel: string;
  rating: number | null;
  releaseDate: string;
  fileLabel: string;
  fileValue: string;
  voiceActors: string[];
  tags: string[];
  actions?: ReactNode;
  availability?: ReactNode;
}) {
  return (
    <section className="grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
      <div className="self-start overflow-hidden rounded-lg border bg-muted">
        <div className="aspect-[4/3]">
          {coverUrl ? (
            <img src={assetURL(coverUrl)} alt="" className="h-full w-full object-contain" />
          ) : (
            <div className="grid h-full place-items-center text-4xl font-bold">{fallbackCode.slice(0, 2)}</div>
          )}
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <div className="text-sm font-semibold text-primary">{code}</div>
          <h2 className="mt-1 text-2xl font-semibold leading-tight lg:text-3xl">{title}</h2>
          <button className="mt-2 block max-w-full truncate text-left text-sm text-muted-foreground hover:text-primary" onClick={() => openCircleRoute(circleExternalId || undefined)}>
            {circle || "Unknown circle"}
          </button>
        </div>

        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        {availability}

        <div className="grid gap-3 sm:grid-cols-3">
          <MetaTile icon={<Star className="h-4 w-4 fill-current" />} label={ratingLabel} value={rating === null ? "No rating" : rating.toFixed(2)} />
          <MetaTile icon={<Clock3 className="h-4 w-4" />} label="Released" value={releaseDate} />
          <MetaTile icon={<FileAudio className="h-4 w-4" />} label={fileLabel} value={fileValue} />
        </div>

        <InfoRow icon={<CircleUserRound className="h-4 w-4" />} label="Voice" value={voiceActors.join(", ") || "No voice actor metadata"} />
        <InfoRow icon={<Tags className="h-4 w-4" />} label="Tags" value={tags.join(", ") || "No tag metadata"} />
      </div>
    </section>
  );
}

function SourceAvailabilitySummary({
  tabs,
  remoteSources,
  checking,
}: {
  tabs: SourceTabInfo[];
  remoteSources: RemoteSourceAvailability[];
  checking: boolean;
}) {
  if (tabs.length === 0 && !checking) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {tabs.map((tab) => {
        const remote = remoteSources.find((item) => remoteSourceTabKey(item.source.id) === tab.key);
        return (
          <Badge key={tab.key} variant={remote?.summary.hasCache ? "secondary" : "outline"}>
            {tab.label}{remote?.summary.hasCache ? " cached" : ""}
          </Badge>
        );
      })}
      {checking && <Badge variant="secondary">Checking sources</Badge>}
    </div>
  );
}

function SourceDirectoryPanel({
  title,
  description,
  tabs,
  activeKey,
  onActiveKeyChange,
  checkingLabel,
  directoryMode,
  onDirectoryModeChange,
  root,
  currentLocationId,
  emptyLabel,
  toolbar,
  selectionPanel,
  selectionModal,
  loadingMessage,
  onPlayFolder,
  onPreview,
  onDeleteCache,
  onDeleteLocal,
}: {
  title: string;
  description: string;
  tabs: SourceTabInfo[];
  activeKey: string;
  onActiveKeyChange: (key: string) => void;
  checkingLabel?: string;
  directoryMode: "browse" | "tree";
  onDirectoryModeChange: (mode: "browse" | "tree") => void;
  root: TreeNode;
  currentLocationId: number | null;
  emptyLabel: string;
  toolbar?: ReactNode;
  selectionPanel?: ReactNode;
  selectionModal?: ReactNode;
  loadingMessage?: string;
  onPlayFolder?: (tracks: TreeTrack[], locationId: number) => void;
  onPreview?: (preview: FilePreviewState) => void;
  onDeleteCache?: (target: MediaDeleteTarget) => void;
  onDeleteLocal?: (target: MediaDeleteTarget) => void;
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">{title}</h3>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="flex gap-2 overflow-x-auto">
            {tabs.map((source) => (
              <button
                key={source.key}
                className={`h-8 shrink-0 rounded-md px-3 text-xs font-medium ${
                  source.key === activeKey ? "bg-primary text-primary-foreground" : "border bg-card text-muted-foreground hover:bg-muted"
                }`}
                onClick={() => onActiveKeyChange(source.key)}
              >
                {source.label}
              </button>
            ))}
            {checkingLabel && <span className="inline-flex h-8 items-center px-2 text-xs text-muted-foreground">{checkingLabel}</span>}
          </div>
          <DirectoryModeSwitch mode={directoryMode} onChange={onDirectoryModeChange} />
        </div>
      </div>
      <Card>
        <CardContent className="p-4">
          {toolbar}
          {loadingMessage && <div className="mb-4 rounded-md border bg-background p-3 text-sm text-muted-foreground">{loadingMessage}</div>}
          {selectionPanel}
          {directoryMode === "browse" ? (
            <DirectoryBrowser
              root={root}
              currentLocationId={currentLocationId}
              emptyLabel={emptyLabel}
              onPlayFolder={onPlayFolder}
              onPreview={onPreview}
              onDeleteCache={onDeleteCache}
              onDeleteLocal={onDeleteLocal}
            />
          ) : (
            <DirectoryTree
              root={root}
              currentLocationId={currentLocationId}
              emptyLabel={emptyLabel}
              onPlayFolder={onPlayFolder}
              onPreview={onPreview}
              onDeleteCache={onDeleteCache}
              onDeleteLocal={onDeleteLocal}
            />
          )}
        </CardContent>
      </Card>
      {selectionModal}
    </section>
  );
}

function DirectoryModeSwitch({ mode, onChange }: { mode: "browse" | "tree"; onChange: (mode: "browse" | "tree") => void }) {
  return (
    <div className="flex rounded-md border bg-card p-0.5">
      <button
        className={`inline-flex h-7 items-center gap-1 rounded px-2 text-xs font-medium ${
          mode === "browse" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
        }`}
        title="Browse directory"
        onClick={() => onChange("browse")}
      >
        <Folder className="h-3.5 w-3.5" />
        Browse
      </button>
      <button
        className={`inline-flex h-7 items-center gap-1 rounded px-2 text-xs font-medium ${
          mode === "tree" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
        }`}
        title="Tree view"
        onClick={() => onChange("tree")}
      >
        <FolderTree className="h-3.5 w-3.5" />
        Tree
      </button>
    </div>
  );
}

function SourceDirectoryToolbar({
  label,
  description,
  message,
  busy,
  onPlay,
  onOpenLocal,
  onSelectSaveFiles,
  selectedCount,
}: {
  label: string;
  description: string;
  message?: string;
  busy: boolean;
  onPlay?: () => void;
  onOpenLocal?: () => void;
  onSelectSaveFiles?: () => void;
  selectedCount?: number;
}) {
  return (
    <div className="mb-4 space-y-3 rounded-md border bg-background p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold">{label}</div>
          <div className="text-xs text-muted-foreground">{description}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          {onPlay && (
            <Button size="sm" onClick={onPlay}>
              <Play className="h-4 w-4" />
              Play
            </Button>
          )}
          {onOpenLocal && (
            <Button size="sm" onClick={onOpenLocal}>
              <MoreHorizontal className="h-4 w-4" />
              Open local detail
            </Button>
          )}
          {onSelectSaveFiles && (
            <Button size="sm" disabled={busy} onClick={onSelectSaveFiles}>
              <HardDriveDownload className="h-4 w-4" />
              Fetch{selectedCount !== undefined ? ` (${selectedCount})` : ""}
            </Button>
          )}
        </div>
      </div>
      {message && <div className="rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">{message}</div>}
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
  baseName: string;
  sourcePath: string;
  kind: string;
  folderPath: string;
  locationType: string;
  streamUrl: string;
  downloadUrl: string;
  assetUrl: string;
  sizeBytes: number | null;
  availability: string;
  cacheLocationId: number | null;
  cachePath: string;
  cacheAvailable: boolean;
  cacheStreamUrl: string;
  localLocationId: number | null;
  localPath: string;
  localAvailable: boolean;
  progress: MediaItem["progress"];
};

type FilePreviewState =
  | { kind: "image"; title: string; url: string }
  | { kind: "text"; title: string; locationId: number };

type MediaDeleteTarget = { kind: "cache" | "local"; locationId: number; title: string; path: string };

type SourceTabInfo = {
  key: string;
  label: string;
  fileSourceId: number | null;
  kind?: "local";
};

type RemoteSourceAvailability = {
  source: LibrarySource;
  summary: SourceAvailabilitySource;
  detail?: RemoteWorkDetail;
  loading?: boolean;
  error?: string;
};

function emptyTree(): TreeNode {
  return { name: "", path: "", children: new Map(), files: [] };
}

function buildSourceTabs(items: MediaItem[], remoteSources: RemoteSourceAvailability[] = []): SourceTabInfo[] {
  const sources = new Map<number, SourceTabInfo>();
  for (const item of items) {
    for (const location of item.locations) {
      if (!sources.has(location.fileSourceId)) {
        const label =
          location.locationType === "local"
            ? "Local"
            : location.locationType === "cache"
              ? "Cache"
              : location.locationType === "remote_stream"
                ? "Remote"
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
  const baseTabs = tabs.length > 0 ? tabs : [{ key: "local", label: "Local", fileSourceId: null, kind: "local" as const }];
  for (const remote of remoteSources) {
    baseTabs.push({
      key: remoteSourceTabKey(remote.source.id),
      label: remote.source.displayName,
      fileSourceId: null,
    });
  }
  return baseTabs;
}

function remoteSourceTabKey(sourceID: number) {
  return `remote-source:${sourceID}`;
}

function buildTree(items: MediaItem[], fileSourceId: number | null, workCode: string): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map(), files: [] };
  for (const item of items) {
    const sourceLocations = fileSourceId === null ? item.locations : item.locations.filter((location) => location.fileSourceId === fileSourceId);
    const location = sourceLocations.find((candidate) => candidate.availability === "available" && candidate.streamUrl) ?? sourceLocations[0];
    if (!location) continue;
    const parts = displayPathParts(location.path, location.locationType, workCode);
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
      baseName: baseNameWithoutExtension(fileName),
      sourcePath: parts.length > 0 ? `${parts.join("/")}/${fileName}` : fileName,
      kind: item.kind,
      folderPath: cursor.path,
      locationType: location.locationType,
      streamUrl: location.streamUrl,
      downloadUrl: location.downloadUrl,
      assetUrl: location.locationType === "local" ? `/api/media/${location.id}/asset` : location.downloadUrl,
      sizeBytes: location.sizeBytes,
      availability: location.availability,
      cacheLocationId: location.locationType === "cache" && location.availability === "available" ? location.id : null,
      cachePath: location.locationType === "cache" ? location.path : "",
      cacheAvailable: location.locationType === "cache" && location.availability === "available",
      cacheStreamUrl: location.locationType === "cache" && location.availability === "available" ? `/api/media/${location.id}/stream` : "",
      localLocationId: location.locationType === "local" && location.availability === "available" ? location.id : null,
      localPath: location.locationType === "local" ? location.path : "",
      localAvailable: location.locationType === "local" && location.availability === "available",
      progress: item.progress,
    });
  }
  return normalizeDisplayTree(root);
}

function displayPathParts(path: string, locationType: string, workCode: string) {
  const parts = path.split("/").filter(Boolean);
  if (locationType !== "local" || !workCode) return parts;
  const code = workCode.toUpperCase();
  const workRootIndex = parts.findIndex((part) => part.toUpperCase().includes(code));
  if (workRootIndex < 0 || workRootIndex >= parts.length - 1) return parts;
  return parts.slice(workRootIndex + 1);
}

function buildRemoteTree(tracks: RemoteTrack[]): TreeNode {
  let nextID = -1;
  const root: TreeNode = { name: "", path: "", children: new Map(), files: [] };
  const walk = (nodes: RemoteTrack[], cursor: TreeNode) => {
    nodes.forEach((node, index) => {
      const title = (node.title ?? "").trim() || `Track ${index + 1}`;
      const children = node.children ?? [];
      if (children.length > 0 || node.type === "folder") {
        const childPath = cursor.path ? `${cursor.path}/${title}` : title;
        const child = cursor.children.get(title) ?? { name: title, path: childPath, children: new Map(), files: [] };
        cursor.children.set(title, child);
        walk(children, child);
        return;
      }
      const hasCache = node.cacheAvailable && node.cacheLocationId !== null;
      cursor.files.push({
        mediaItemId: nextID,
        locationId: hasCache ? node.cacheLocationId! : nextID,
        title,
        baseName: baseNameWithoutExtension(title),
        sourcePath: cursor.path ? `${cursor.path}/${title}` : title,
        kind: node.type || "file",
        folderPath: cursor.path,
        locationType: hasCache ? "cache" : "remote_stream",
        streamUrl: hasCache ? `/api/media/${node.cacheLocationId}/stream` : node.streamUrl,
        downloadUrl: node.downloadUrl,
        assetUrl: hasCache ? `/api/media/${node.cacheLocationId}/asset` : node.downloadUrl || node.streamUrl,
        sizeBytes: node.sizeBytes,
        availability: hasCache ? "available" : node.streamUrl || node.downloadUrl ? "remote" : "metadata",
        cacheLocationId: node.cacheLocationId,
        cachePath: node.cachePath,
        cacheAvailable: node.cacheAvailable,
        cacheStreamUrl: node.cacheAvailable && node.cacheLocationId !== null ? `/api/media/${node.cacheLocationId}/stream` : "",
        localLocationId: node.localLocationId,
        localPath: node.localPath,
        localAvailable: node.localAvailable,
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
  onPreview,
  onDeleteCache,
  onDeleteLocal,
  emptyLabel = "No local files detected.",
}: {
  root: TreeNode;
  currentLocationId: number | null;
  onPlayFolder?: (tracks: TreeTrack[], locationId: number) => void;
  onPreview?: (preview: FilePreviewState) => void;
  onDeleteCache?: (target: MediaDeleteTarget) => void;
  onDeleteLocal?: (target: MediaDeleteTarget) => void;
  emptyLabel?: string;
}) {
  const folders = sortedFolders(root);
  if (folders.length === 0 && root.files.length === 0) {
    return <div className="text-sm text-muted-foreground">{emptyLabel}</div>;
  }
  return (
    <div className="space-y-2">
      {sortedFiles(root).map((file) => (
        <TreeFile
          key={file.locationId}
          file={file}
          files={playableFiles(root.files)}
          depth={0}
          isActive={file.locationId === currentLocationId}
          onPlayFolder={onPlayFolder}
          onPreview={onPreview}
          onDeleteCache={onDeleteCache}
          onDeleteLocal={onDeleteLocal}
        />
      ))}
      {folders.map((node) => (
        <TreeFolder
          key={node.path}
          node={node}
          depth={0}
          currentLocationId={currentLocationId}
          onPlayFolder={onPlayFolder}
          onPreview={onPreview}
          onDeleteCache={onDeleteCache}
          onDeleteLocal={onDeleteLocal}
        />
      ))}
    </div>
  );
}

function RemoteSaveSelectionPanel({
  root,
  selectedPaths,
  disabled,
  onClose,
  onSave,
  onChange,
}: {
  root: TreeNode;
  selectedPaths: Set<string>;
  disabled: boolean;
  onClose: () => void;
  onSave: () => void;
  onChange: (paths: Set<string>) => void;
}) {
  const allPaths = remoteSelectablePaths(root);
  const planByPath = useMemo(() => new Map<string, never>(), []);
  const setAll = () => onChange(new Set(allPaths));
  const setAudioOnly = () => onChange(new Set(remoteSelectableFiles(root).filter((file) => file.kind === "audio").map((file) => file.sourcePath)));
  const clear = () => onChange(new Set());
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4" onMouseDown={onClose}>
      <div className="flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border bg-background shadow-xl" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex min-h-12 items-center justify-between gap-3 border-b px-4">
          <div>
            <h3 className="text-base font-semibold">Fetch selection</h3>
            <p className="text-xs text-muted-foreground">Choose which remote files should be fetched to the local library.</p>
          </div>
          <IconButton title="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <Badge variant="secondary">{selectedPaths.size} / {allPaths.length} files</Badge>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={disabled} onClick={setAll}>All</Button>
            <Button variant="outline" size="sm" disabled={disabled} onClick={setAudioOnly}>Audio</Button>
            <Button variant="outline" size="sm" disabled={disabled} onClick={clear}>None</Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-card p-2">
          <RemoteSaveSelectionNode
            node={root}
            depth={0}
            selectedPaths={selectedPaths}
            planByPath={planByPath}
            disabled={disabled}
            onChange={onChange}
            isRoot
          />
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t p-3">
          <Button variant="outline" onClick={onClose} disabled={disabled}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={disabled || selectedPaths.size === 0}>
            <HardDriveDownload className="h-4 w-4" />
            Fetch
          </Button>
        </div>
      </div>
    </div>
  );
}

function RemoteSaveSelectionNode({
  node,
  depth,
  selectedPaths,
  planByPath,
  disabled,
  isRoot,
  onChange,
}: {
  node: TreeNode;
  depth: number;
  selectedPaths: Set<string>;
  planByPath: Map<string, { status: string }>;
  disabled: boolean;
  isRoot?: boolean;
  onChange: (paths: Set<string>) => void;
}) {
  const folders = sortedFolders(node);
  const files = sortedFiles(node);
  const nodePaths = remoteSelectablePaths(node);
  const checkedCount = nodePaths.filter((path) => selectedPaths.has(path)).length;
  const checked = nodePaths.length > 0 && checkedCount === nodePaths.length;
  const mixed = checkedCount > 0 && checkedCount < nodePaths.length;
  const toggleNode = () => {
    const next = new Set(selectedPaths);
    for (const path of nodePaths) {
      if (checked) next.delete(path);
      else next.add(path);
    }
    onChange(next);
  };
  return (
    <div className="space-y-1">
      {!isRoot && (
        <label className="flex min-h-7 items-center gap-2 rounded px-2 text-sm hover:bg-muted" style={{ paddingLeft: depth * 14 + 8 }}>
          <input type="checkbox" checked={checked} ref={(input) => { if (input) input.indeterminate = mixed; }} disabled={disabled || nodePaths.length === 0} onChange={toggleNode} />
          <Folder className="h-4 w-4 text-primary" />
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          <span className="text-xs text-muted-foreground">{checkedCount}/{nodePaths.length}</span>
        </label>
      )}
      {folders.map((child) => (
        <RemoteSaveSelectionNode
          key={child.path}
          node={child}
          depth={isRoot ? 0 : depth + 1}
          selectedPaths={selectedPaths}
          planByPath={planByPath}
          disabled={disabled}
          onChange={onChange}
        />
      ))}
      {files.map((file) => {
        const path = file.sourcePath;
        const plan = planByPath.get(path);
        return (
          <label key={path} className="flex min-h-7 items-center gap-2 rounded px-2 text-sm hover:bg-muted" style={{ paddingLeft: (isRoot ? 0 : depth + 1) * 14 + 8 }}>
            <input
              type="checkbox"
              checked={selectedPaths.has(path)}
              disabled={disabled}
              onChange={(event) => {
                const next = new Set(selectedPaths);
                if (event.target.checked) next.add(path);
                else next.delete(path);
                onChange(next);
              }}
            />
            {fileIcon(file)}
            <span className="min-w-0 flex-1 truncate">{file.title}</span>
            {plan && <span className="text-xs text-muted-foreground">{plan.status}</span>}
          </label>
        );
      })}
    </div>
  );
}

function ConfirmMediaDeleteModal({
  target,
  deleting,
  onCancel,
  onConfirm,
}: {
  target: MediaDeleteTarget;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const isLocal = target.kind === "local";
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4" onMouseDown={onCancel}>
      <div className="w-full max-w-lg rounded-lg border bg-background shadow-xl" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b p-4">
          <div>
            <h3 className="text-base font-semibold">{isLocal ? "Delete local file" : "Delete cached file"}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {isLocal ? "This removes the local file and clears playback state for the work." : "The remote source and saved local files will not be deleted."}
            </p>
          </div>
          <IconButton title="Close" onClick={onCancel}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="space-y-3 p-4 text-sm">
          <div>
            <div className="font-medium">{target.title}</div>
            <div className="mt-1 break-all rounded-md border bg-muted px-3 py-2 text-xs text-muted-foreground">{target.path}</div>
          </div>
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive">
            {isLocal
              ? "This removes the local file from disk, marks its location unavailable, and clears progress and marks for the work."
              : "This removes the cached file from disk and marks the cache location unavailable."}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t p-4">
          <Button variant="outline" onClick={onCancel} disabled={deleting}>
            Cancel
          </Button>
          <Button className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={onConfirm} disabled={deleting}>
            <Trash2 className="h-4 w-4" />
            {deleting ? "Deleting" : isLocal ? "Delete local" : "Delete cache"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function DirectoryBrowser({
  root,
  currentLocationId,
  onPlayFolder,
  onPreview,
  onDeleteCache,
  onDeleteLocal,
  emptyLabel = "No local files detected.",
}: {
  root: TreeNode;
  currentLocationId: number | null;
  onPlayFolder?: (tracks: TreeTrack[], locationId: number) => void;
  onPreview?: (preview: FilePreviewState) => void;
  onDeleteCache?: (target: MediaDeleteTarget) => void;
  onDeleteLocal?: (target: MediaDeleteTarget) => void;
  emptyLabel?: string;
}) {
  const [path, setPath] = useState<string[]>([]);
  const current = useMemo(() => nodeAtPath(root, path) ?? root, [root, path]);
  const folders = sortedFolders(current);
  const files = sortedFiles(current);
  useEffect(() => {
    if (!nodeAtPath(root, path)) {
      setPath([]);
    }
  }, [root, path]);

  if (folders.length === 0 && files.length === 0) {
    return <div className="text-sm text-muted-foreground">{emptyLabel}</div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex min-h-9 flex-wrap items-center gap-1 rounded-md border bg-background px-2 text-sm">
        <button className="rounded px-2 py-1 font-medium hover:bg-muted" onClick={() => setPath([])}>
          root
        </button>
        {path.map((part, index) => (
          <span key={`${part}:${index}`} className="inline-flex items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            <button className="rounded px-2 py-1 font-medium hover:bg-muted" onClick={() => setPath(path.slice(0, index + 1))}>
              {part}
            </button>
          </span>
        ))}
      </div>
      <div className="space-y-1">
        {path.length > 0 && (
          <button
            className="flex min-h-9 w-full items-center gap-2 rounded-md border bg-background px-3 text-left text-sm hover:bg-muted"
            onClick={() => setPath(path.slice(0, -1))}
          >
            <ChevronLeft className="h-4 w-4 text-muted-foreground" />
            <span>Parent folder</span>
          </button>
        )}
        {folders.map((folder) => (
          <button
            key={folder.path || folder.name}
            className="flex min-h-9 w-full items-center gap-2 rounded-md border bg-background px-3 text-left text-sm hover:bg-muted"
            onClick={() => setPath([...path, folder.name])}
          >
            <Folder className="h-4 w-4 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate">{folder.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{folderSummary(folder)}</span>
          </button>
        ))}
        {files.map((file) => (
          <TreeFile
            key={file.locationId}
            file={file}
            files={playableFiles(current.files)}
            depth={0}
            isActive={file.locationId === currentLocationId}
            onPlayFolder={onPlayFolder}
            onPreview={onPreview}
            onDeleteCache={onDeleteCache}
            onDeleteLocal={onDeleteLocal}
          />
        ))}
      </div>
    </div>
  );
}

function TreeFolder({
  node,
  depth,
  currentLocationId,
  onPlayFolder,
  onPreview,
  onDeleteCache,
  onDeleteLocal,
}: {
  node: TreeNode;
  depth: number;
  currentLocationId: number | null;
  onPlayFolder?: (tracks: TreeTrack[], locationId: number) => void;
  onPreview?: (preview: FilePreviewState) => void;
  onDeleteCache?: (target: MediaDeleteTarget) => void;
  onDeleteLocal?: (target: MediaDeleteTarget) => void;
}) {
  const [isOpen, setIsOpen] = useState(depth === 0 || folderNameHasPriority(node.name));
  const childFolders = sortedFolders(node);
  const playable = playableFiles(node.files);
  const filesLabel = playable.length > 0 ? `${playable.length} audio` : node.files.length > 0 ? `${node.files.length} files` : "";
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
              onPreview={onPreview}
              onDeleteCache={onDeleteCache}
              onDeleteLocal={onDeleteLocal}
            />
          ))}
          {sortedFiles(node).map((file) => (
            <TreeFile
              key={file.locationId}
              file={file}
              files={playable}
              depth={depth + 1}
              isActive={file.locationId === currentLocationId}
              onPlayFolder={onPlayFolder}
              onPreview={onPreview}
              onDeleteCache={onDeleteCache}
              onDeleteLocal={onDeleteLocal}
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
  onPreview,
  onDeleteCache,
  onDeleteLocal,
}: {
  file: TreeTrack;
  files: TreeTrack[];
  depth: number;
  isActive: boolean;
  onPlayFolder?: (tracks: TreeTrack[], locationId: number) => void;
  onPreview?: (preview: FilePreviewState) => void;
  onDeleteCache?: (target: MediaDeleteTarget) => void;
  onDeleteLocal?: (target: MediaDeleteTarget) => void;
}) {
  const canPlay = Boolean(onPlayFolder && ["available", "remote"].includes(file.availability) && file.streamUrl);
  const preview = previewForFile(file);
  const [confirmingDelete, setConfirmingDelete] = useState<"cache" | "local" | null>(null);
  return (
    <div
      className={`flex min-h-9 items-center justify-between gap-3 rounded-md border px-3 text-left text-sm ${
        isActive ? "border-primary bg-secondary" : "bg-background hover:bg-muted"
      }`}
      style={{ marginLeft: depth * 14, width: `calc(100% - ${depth * 14}px)` }}
    >
      <button
        className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
        disabled={!canPlay}
        onClick={() => onPlayFolder?.(files, file.locationId)}
      >
        {isActive ? <Pause className="h-4 w-4 text-primary" /> : fileIcon(file)}
        <span className="truncate">{file.title}</span>
      </button>
      <div className="flex shrink-0 items-center gap-2">
        {file.localAvailable && <Badge variant="outline">Local</Badge>}
        {file.cacheAvailable && <Badge variant="outline">Cached</Badge>}
        {preview && onPreview && (
          <IconButton title={preview.kind === "image" ? "Preview image" : "Preview text"} onClick={() => onPreview(preview)}>
            <Eye className="h-4 w-4" />
          </IconButton>
        )}
        {file.cacheAvailable && file.cacheLocationId !== null && onDeleteCache && (
          <div
            className="relative"
            onMouseLeave={() => setConfirmingDelete(null)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setConfirmingDelete(null);
            }}
          >
            <IconButton title="Delete cache" onClick={() => setConfirmingDelete((value) => (value === "cache" ? null : "cache"))}>
              <Trash2 className="h-4 w-4" />
            </IconButton>
            {confirmingDelete === "cache" && (
              <div className="absolute right-0 z-20 mt-2 w-44 rounded-md border bg-popover p-2 text-xs shadow-lg">
                <div className="mb-2 text-muted-foreground">Delete cached file?</div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 w-full"
                  onClick={() =>
                    onDeleteCache({
                      kind: "cache",
                      locationId: file.cacheLocationId!,
                      title: file.title,
                      path: file.cachePath,
                    })
                  }
                >
                  Continue
                </Button>
              </div>
            )}
          </div>
        )}
        {file.localAvailable && file.localLocationId !== null && onDeleteLocal && (
          <div
            className="relative"
            onMouseLeave={() => setConfirmingDelete(null)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setConfirmingDelete(null);
            }}
          >
            <IconButton title="Delete local file" onClick={() => setConfirmingDelete((value) => (value === "local" ? null : "local"))}>
              <Trash2 className="h-4 w-4" />
            </IconButton>
            {confirmingDelete === "local" && (
              <div className="absolute right-0 z-20 mt-2 w-48 rounded-md border bg-popover p-2 text-xs shadow-lg">
                <div className="mb-2 text-muted-foreground">Delete local file?</div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 w-full"
                  onClick={() =>
                    onDeleteLocal({
                      kind: "local",
                      locationId: file.localLocationId!,
                      title: file.title,
                      path: file.localPath,
                    })
                  }
                >
                  Continue
                </Button>
              </div>
            )}
          </div>
        )}
        <span className="text-xs text-muted-foreground">
          {formatBytes(file.sizeBytes)} · {file.availability}
        </span>
      </div>
    </div>
  );
}

function folderNameHasPriority(name: string) {
  const lower = name.toLowerCase();
  return ["本編", "honhen", "main", "mp3"].some((value) => lower.includes(value.toLowerCase()));
}

function remoteSelectableFiles(root: TreeNode) {
  const files: TreeTrack[] = [];
  const visit = (node: TreeNode) => {
    files.push(...node.files.filter((file) => file.downloadUrl || file.streamUrl));
    for (const child of node.children.values()) visit(child);
  };
  visit(root);
  return files;
}

function remoteSelectablePaths(root: TreeNode) {
  return remoteSelectableFiles(root).map((file) => file.sourcePath);
}

function sortedFolders(node: TreeNode) {
  return Array.from(node.children.values()).sort((a, b) => naturalCompare(a.name, b.name));
}

function sortedFiles(node: TreeNode) {
  return [...node.files].sort((a, b) => naturalCompare(a.title, b.title));
}

function playableFiles(files: TreeTrack[]) {
  return files.filter((file) => file.kind === "audio" && ["available", "remote"].includes(file.availability) && file.streamUrl);
}

function nodeAtPath(root: TreeNode, path: string[]) {
  let cursor: TreeNode | undefined = root;
  for (const part of path) {
    cursor = cursor?.children.get(part);
    if (!cursor) return null;
  }
  return cursor;
}

function folderSummary(node: TreeNode) {
  const folderCount = node.children.size;
  const fileCount = node.files.length;
  if (folderCount > 0 && fileCount > 0) return `${folderCount} folders, ${fileCount} files`;
  if (folderCount > 0) return `${folderCount} folders`;
  return `${fileCount} files`;
}

function naturalCompare(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function fileIcon(file: TreeTrack) {
  if (file.kind === "audio") return <FileAudio className="h-4 w-4 text-muted-foreground" />;
  if (file.kind === "image") return <ImageIcon className="h-4 w-4 text-muted-foreground" />;
  if (file.kind === "text") return <FileText className="h-4 w-4 text-muted-foreground" />;
  return <FileText className="h-4 w-4 text-muted-foreground" />;
}

function previewForFile(file: TreeTrack): FilePreviewState | null {
  if (file.kind === "image" && file.assetUrl) {
    return { kind: "image", title: file.title, url: file.assetUrl };
  }
  if (file.kind === "text" && file.locationId > 0) {
    return { kind: "text", title: file.title, locationId: file.locationId };
  }
  return null;
}

function FilePreviewModal({ preview, onClose }: { preview: FilePreviewState; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setText(null);
    setError("");
    if (preview.kind !== "text") return;
    api.getMediaText(preview.locationId).then((result) => setText(result.content)).catch((err) => {
      setError(err instanceof Error ? err.message : "Text preview failed.");
    });
  }, [preview]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={onClose}
    >
      <div
        className="flex max-h-[86vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border bg-card shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex min-h-11 items-center justify-between gap-3 border-b px-4">
          <div className="min-w-0 truncate text-sm font-semibold">{preview.title}</div>
          <div className="flex items-center gap-2">
            {preview.kind === "image" && (
              <Button variant="outline" size="sm" disabled>
                <ImageIcon className="h-4 w-4" />
                Set cover
              </Button>
            )}
            <IconButton title="Close preview" onClick={onClose}>
              <X className="h-4 w-4" />
            </IconButton>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-background p-4">
          {preview.kind === "image" ? (
            <img src={assetURL(preview.url)} alt="" className="mx-auto max-h-[72vh] max-w-full rounded-md object-contain" />
          ) : error ? (
            <div className="text-sm text-muted-foreground">{error}</div>
          ) : text === null ? (
            <div className="text-sm text-muted-foreground">Loading text...</div>
          ) : (
            <pre className="whitespace-pre-wrap break-words text-sm leading-relaxed">{text}</pre>
          )}
        </div>
      </div>
    </div>
  );
}

function flattenTracks(root: TreeNode) {
  const tracks: TreeTrack[] = [];
  const visit = (node: TreeNode) => {
    tracks.push(...playableFiles(node.files));
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
  const lyrics = findLyricsForTrack(track, work.mediaItems);
  return {
    ...track,
    workId: work.id,
    workCode: work.primaryCode,
    workTitle: work.title,
    coverUrl: work.coverUrl,
    circle: work.circle,
    progress: track.progress,
    lyricsLocationId: lyrics?.locationId ?? null,
    lyricsTitle: lyrics?.title ?? "",
  };
}

function toRemotePreviewPlayerTrack(track: TreeTrack, detail: RemoteWorkDetail): PlayerTrack {
  return {
    ...track,
    workId: detail.workId ?? 0,
    workCode: detail.primaryCode || detail.remoteId,
    workTitle: detail.title,
    coverUrl: detail.coverUrl,
    circle: detail.circle,
    progress: null,
    lyricsLocationId: null,
    lyricsTitle: "",
    remoteSourceId: detail.sourceId,
    remoteWorkCode: detail.primaryCode || detail.remoteId,
    remotePath: track.sourcePath,
  };
}

function findLyricsForTrack(track: TreeTrack, items: MediaItem[]) {
  const candidates = items.flatMap((item) =>
    item.kind === "text"
      ? item.locations
          .filter((location) => location.locationType === "local" && location.availability === "available" && isLyricsPath(location.path))
          .map((location) => {
            const name = fileNameFromPath(location.path);
            return {
              locationId: location.id,
              title: name,
              keys: lyricMatchKeys(baseNameWithoutExtension(name)),
            };
          })
      : [],
  );
  if (candidates.length === 0) return null;
  const trackKeys = lyricMatchKeys(track.baseName || track.title);
  return candidates.find((candidate) => candidate.keys.some((key) => trackKeys.includes(key))) ?? null;
}

function isLyricsPath(path: string) {
  const lower = path.toLowerCase();
  return [".lrc", ".txt", ".cue"].some((extension) => lower.endsWith(extension));
}

function lyricMatchKeys(value: string) {
  const normalized = normalizeLyricName(value);
  const withoutLeadingNumber = normalized.replace(/^\d+/, "");
  const withoutTrackPrefix = normalized.replace(/^track\d+/, "");
  return Array.from(new Set([normalized, withoutLeadingNumber, withoutTrackPrefix].filter((item) => item.length >= 2)));
}

function normalizeLyricName(value: string) {
  return value
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, "")
    .replace(/^(track|tr|disc|cd)[\s_.-]*/i, "")
    .replace(/[\s_.\-()[\]【】「」『』]+/g, "");
}

function fileNameFromPath(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function baseNameWithoutExtension(name: string) {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(0, index) : name;
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

function remoteTargetFromLocation(path: string, search: string, sources: LibrarySource[]) {
  const code = codeFromPath(path);
  if (!code) return null;
  const params = new URLSearchParams(search);
  const sourceID = Number(params.get("source"));
  if (!Number.isFinite(sourceID) || sourceID <= 0) return null;
  const source = sources.find((candidate) => candidate.id === sourceID);
  return source ? { source, code } : null;
}

function tabFromPath(path: string, sources: LibrarySource[], fallback: LibraryTab = { kind: "local" }): LibraryTab {
  if (path === "/remote" || path === "/library/remote") {
    return { kind: "remote" };
  }
  if (path === "/" || path === "/library") {
    return { kind: "local" };
  }
  const encodedKey = path.startsWith("/library/source/")
    ? path.slice("/library/source/".length).replace(/\/$/, "")
    : path.replace(/^\//, "").replace(/\/$/, "");
  if (encodedKey === "") {
    return fallback;
  }
  if (WORK_CODE_PATTERN.test(`/${encodedKey}`)) {
    return fallback;
  }
  const key = safeDecodePathSegment(encodedKey).toLowerCase();
  const source = sources.find((item) => sourceRouteKey(item).toLowerCase() === key || item.displayName.toLowerCase() === key);
  return source ? { kind: "source", source } : fallback;
}

function resolveTabFromPath(path: string, sources: LibrarySource[], fallback: LibraryTab): LibraryTab {
  return tabFromPath(path, sources, fallback);
}

function pathForLibraryTab(tab: LibraryTab) {
  switch (tab.kind) {
    case "remote":
      return "/remote";
    case "source":
      return `/${encodeURIComponent(sourceRouteKey(tab.source))}`;
    default:
      return "/";
  }
}

function sourceRouteKey(source: LibrarySource) {
  return source.code || source.displayName;
}

function safeDecodePathSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
