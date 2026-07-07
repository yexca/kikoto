import {
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Filter,
  Heart,
  ListChecks,
  ListMusic,
  Pencil,
  Pause,
  Play,
  Plus,
  Search,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  WorkCardActionButton,
  WorkCardDLsiteAction,
  WorkCardFooter,
  WorkCardSelection,
  WorkCardShell,
  cardDate,
  dlsiteTagBadges,
  type WorkCardViewModel,
} from "@/components/work-card/WorkCardShell";
import { sourcePresenceBadges } from "@/components/work-card/sourceBadges";
import { api, assetURL, type FavoriteList, type ListeningStatus, type Work } from "@/lib/api";
import { openCircleSeriesRoute } from "@/pages/CirclesPage";

const listeningStatusOptions: { value: ListeningStatus; label: string }[] = [
  { value: "none", label: "Unmarked" },
  { value: "want_to_listen", label: "Want" },
  { value: "listening", label: "Listening" },
  { value: "paused", label: "Paused" },
  { value: "finished", label: "Finished" },
  { value: "relisten", label: "Relisten" },
];

const statusTabs: { value: ListeningStatus | "all"; label: string; icon: typeof Heart }[] = [
  { value: "all", label: "All", icon: Heart },
  { value: "want_to_listen", label: "Want", icon: Star },
  { value: "listening", label: "Listening", icon: Play },
  { value: "paused", label: "Paused", icon: Pause },
  { value: "finished", label: "Finished", icon: ListChecks },
  { value: "relisten", label: "Relisten", icon: Heart },
];

const availabilityFilters = [
  { value: "all", label: "All sources" },
  { value: "local", label: "Local" },
  { value: "cache", label: "Cached" },
  { value: "remote", label: "Remote" },
  { value: "missing", label: "Missing" },
] as const;

const pageSizeOptions = [24, 48] as const;
type PageSize = (typeof pageSizeOptions)[number];
type AvailabilityFilter = (typeof availabilityFilters)[number]["value"];

export function FavoritesPage() {
  const [works, setWorks] = useState<Work[]>([]);
  const [favoriteLists, setFavoriteLists] = useState<FavoriteList[]>([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<ListeningStatus | "all">("all");
  const [availabilityFilter, setAvailabilityFilter] = useState<AvailabilityFilter>("all");
  const [activeList, setActiveList] = useState<"all" | number>("all");
  const [listWorkIDs, setListWorkIDs] = useState<Record<number, number[]>>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(24);
  const [mobileColumns, setMobileColumns] = useState<1 | 2>(2);
  const [desktopColumns, setDesktopColumns] = useState<4 | 6 | 8>(6);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedWorkIDs, setSelectedWorkIDs] = useState<Set<number>>(new Set());
  const [isBulkUpdating, setIsBulkUpdating] = useState(false);
  const [listDialogTarget, setListDialogTarget] = useState<{ mode: "bulk" } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [listEditor, setListEditor] = useState<FavoriteList | "new" | null>(null);
  const [deleteListTarget, setDeleteListTarget] = useState<FavoriteList | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    Promise.all([api.listWorks(), api.listFavoriteLists()])
      .then(([workItems, lists]) => {
        if (cancelled) return;
        setWorks(workItems);
        setFavoriteLists(lists);
        setMessage("");
      })
      .catch((error) => {
        if (cancelled) return;
        setWorks([]);
        setFavoriteLists([]);
        setMessage(error instanceof Error ? error.message : "Favorites could not be loaded.");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setPage(1);
  }, [query, statusFilter, availabilityFilter, activeList, pageSize]);

  useEffect(() => {
    if (activeList === "all" || listWorkIDs[activeList]) return;
    let cancelled = false;
    api.listFavoriteListWorkIDs(activeList)
      .then((result) => {
        if (!cancelled) setListWorkIDs((items) => ({ ...items, [result.listId]: result.workIds }));
      })
      .catch((error) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : "Favorite list could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [activeList, listWorkIDs]);

  useEffect(() => {
    const unloadedLists = favoriteLists.filter((list) => !listWorkIDs[list.id]);
    if (unloadedLists.length === 0) return;
    let cancelled = false;
    Promise.all(unloadedLists.map((list) => api.listFavoriteListWorkIDs(list.id)))
      .then((results) => {
        if (cancelled) return;
        setListWorkIDs((items) => ({
          ...items,
          ...Object.fromEntries(results.map((result) => [result.listId, result.workIds])),
        }));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [favoriteLists, listWorkIDs]);

  const shelfWorks = useMemo(() => works.filter((work) => work.favorite || work.listeningStatus !== "none" || Boolean(work.progress.mediaItemId)), [works]);
  const favoriteWorks = useMemo(() => works.filter((work) => work.favorite), [works]);
  const statusCounts = useMemo(() => countByStatus(shelfWorks), [shelfWorks]);
  const listCounts = useMemo(() => estimateListCounts(favoriteLists, favoriteWorks.length, listWorkIDs), [favoriteLists, favoriteWorks.length, listWorkIDs]);

  const filteredWorks = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const activeListIDs = activeList === "all" ? null : new Set(listWorkIDs[activeList] ?? []);
    return shelfWorks.filter((work) => {
      if (activeListIDs && !activeListIDs.has(work.id)) return false;
      if (statusFilter !== "all" && work.listeningStatus !== statusFilter) return false;
      if (availabilityFilter !== "all" && !hasAvailability(work, availabilityFilter)) return false;
      if (!normalizedQuery) return true;
      const haystack = [
        work.primaryCode,
        work.title,
        work.circle,
        ...work.tags,
        ...work.voiceActors,
      ].join(" ").toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [activeList, availabilityFilter, listWorkIDs, query, shelfWorks, statusFilter]);

  useEffect(() => {
    setSelectedWorkIDs((ids) => new Set(Array.from(ids).filter((id) => filteredWorks.some((work) => work.id === id))));
  }, [filteredWorks]);

  const totalPages = Math.max(1, Math.ceil(filteredWorks.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedWorks = filteredWorks.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const hasActiveFilters = query.trim() || statusFilter !== "all" || availabilityFilter !== "all" || activeList !== "all";
  const selectedList = activeList === "all" ? null : favoriteLists.find((list) => list.id === activeList) ?? null;
  const selectedListIndex = selectedList ? favoriteLists.findIndex((list) => list.id === selectedList.id) : -1;
  const selectedWorks = filteredWorks.filter((work) => selectedWorkIDs.has(work.id));
  const allPagedWorksSelected = pagedWorks.length > 0 && pagedWorks.every((work) => selectedWorkIDs.has(work.id));

  const openWork = (work: Work) => {
    window.history.pushState({ returnTo: "/favorites", returnLabel: "Back to favorites" }, "", `/${work.primaryCode}`);
    window.dispatchEvent(new Event("kikoto:navigation"));
  };

  const updateWorkStatus = async (workID: number, status: ListeningStatus) => {
    const result = await api.updateWorkUserState(workID, { listeningStatus: status });
    setWorks((items) => items.map((item) => (item.id === workID ? { ...item, listeningStatus: result.listeningStatus, favorite: result.favorite } : item)));
  };

  const updateWorkFavorite = async (workID: number, favorite: boolean) => {
    const result = await api.updateWorkUserState(workID, { favorite });
    setWorks((items) => items.map((item) => (item.id === workID ? { ...item, listeningStatus: result.listeningStatus, favorite: result.favorite } : item)));
    if (!favorite) {
      setListWorkIDs((items) => Object.fromEntries(Object.entries(items).map(([listID, ids]) => [listID, ids.filter((id) => id !== workID)])));
    }
  };

  const clearFilters = () => {
    setQuery("");
    setStatusFilter("all");
    setAvailabilityFilter("all");
    setActiveList("all");
  };

  const reloadFavoriteLists = async () => {
    const lists = await api.listFavoriteLists();
    setFavoriteLists(lists);
    const results = await Promise.all(lists.map((list) => api.listFavoriteListWorkIDs(list.id)));
    setListWorkIDs(Object.fromEntries(results.map((result) => [result.listId, result.workIds])));
    return lists;
  };

  const saveFavoriteList = async (payload: { name: string; description: string }) => {
    if (listEditor === null) return;
    if (listEditor === "new") {
      const list = await api.createFavoriteList(payload);
      const lists = await reloadFavoriteLists();
      setActiveList(lists.some((item) => item.id === list.id) ? list.id : "all");
    } else {
      const list = await api.updateFavoriteList(listEditor.id, payload);
      await reloadFavoriteLists();
      setActiveList(list.id);
    }
    setListEditor(null);
    setMessage("");
  };

  const deleteFavoriteList = async () => {
    if (!deleteListTarget) return;
    await api.deleteFavoriteList(deleteListTarget.id);
    setDeleteListTarget(null);
    setActiveList("all");
    setWorks(await api.listWorks());
    await reloadFavoriteLists();
    setMessage("");
  };

  const moveFavoriteList = async (direction: -1 | 1) => {
    if (!selectedList || selectedListIndex < 0) return;
    const nextIndex = selectedListIndex + direction;
    if (nextIndex < 0 || nextIndex >= favoriteLists.length) return;
    const reordered = [...favoriteLists];
    const [moving] = reordered.splice(selectedListIndex, 1);
    reordered.splice(nextIndex, 0, moving);
    setFavoriteLists(reordered.map((list, index) => ({ ...list, sortOrder: index })));
    await Promise.all(reordered.map((list, index) => api.updateFavoriteList(list.id, { sortOrder: index })));
    await reloadFavoriteLists();
    setActiveList(selectedList.id);
    setMessage("");
  };

  const toggleWorkSelection = (workID: number, selected: boolean) => {
    setSelectedWorkIDs((ids) => {
      const next = new Set(ids);
      if (selected) next.add(workID);
      else next.delete(workID);
      return next;
    });
  };

  const togglePagedSelection = (selected: boolean) => {
    setSelectedWorkIDs((ids) => {
      const next = new Set(ids);
      for (const work of pagedWorks) {
        if (selected) next.add(work.id);
        else next.delete(work.id);
      }
      return next;
    });
  };

  const applyListMembership = async (targetListIDs: number[]) => {
    const targetWorks = selectedWorks;
    if (targetWorks.length === 0) return;
    setIsBulkUpdating(true);
    try {
      for (const work of targetWorks) {
        await api.setWorkFavoriteLists(work.id, targetListIDs);
      }
      setWorks(await api.listWorks());
      await reloadFavoriteLists();
      setSelectedWorkIDs(new Set());
      setSelectionMode(false);
      setListDialogTarget(null);
      setMessage(`Updated list membership for ${targetWorks.length} work${targetWorks.length === 1 ? "" : "s"}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Bulk list update failed.");
    } finally {
      setIsBulkUpdating(false);
    }
  };

  return (
    <section className="space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">Favorite lists and quick marks across the unified library</p>
          <h2 className="text-xl font-semibold">Personal Shelf</h2>
        </div>
        <div className="grid gap-2 sm:grid-cols-[minmax(220px,360px)_auto] sm:items-center">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              className="h-9 w-full rounded-md border bg-card pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search title, code, circle, tag"
            />
          </label>
          <div className="flex items-center gap-2">
            <select
              className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={availabilityFilter}
              onChange={(event) => setAvailabilityFilter(event.target.value as AvailabilityFilter)}
              aria-label="Availability filter"
            >
              {availabilityFilters.map((filter) => (
                <option key={filter.value} value={filter.value}>
                  {filter.label}
                </option>
              ))}
            </select>
            {hasActiveFilters && (
              <Button variant="outline" size="icon" onClick={clearFilters} aria-label="Clear filters">
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>

      {message && <div className="rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">{message}</div>}

      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        <MetricCard label="Shelf Works" value={shelfWorks.length} icon={Heart} />
        {statusTabs.slice(1).map((tab) => (
          <MetricCard key={tab.value} label={tab.label} value={statusCounts[tab.value as ListeningStatus] ?? 0} icon={tab.icon} />
        ))}
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1">
        <button
          className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-md border px-3 text-sm font-medium ${activeList === "all" ? "bg-primary text-primary-foreground" : "bg-card hover:bg-muted"}`}
          onClick={() => setActiveList("all")}
        >
          <ListMusic className="h-4 w-4" />
          All Shelf
          <span className="text-xs opacity-80">{shelfWorks.length}</span>
        </button>
        {favoriteLists.map((list) => (
          <button
            key={list.id}
            className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-md border px-3 text-sm font-medium ${activeList === list.id ? "bg-primary text-primary-foreground" : "bg-card hover:bg-muted"}`}
            onClick={() => setActiveList(list.id)}
            title={list.description || list.name}
          >
            <ListMusic className="h-4 w-4" />
            <span className="max-w-48 truncate">{list.name}</span>
            <span className="text-xs opacity-80">{listCounts.get(list.id) ?? 0}</span>
          </button>
        ))}
        <Button variant="outline" size="sm" className="shrink-0" onClick={() => setListEditor("new")}>
          <Plus className="h-4 w-4" />
          New list
        </Button>
        {selectedList && (
          <>
            <Button variant="outline" size="sm" className="shrink-0" onClick={() => setListEditor(selectedList)}>
              <Pencil className="h-4 w-4" />
              Rename
            </Button>
            <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" disabled={selectedListIndex <= 0} onClick={() => void moveFavoriteList(-1)} aria-label="Move list left">
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 shrink-0"
              disabled={selectedListIndex < 0 || selectedListIndex >= favoriteLists.length - 1}
              onClick={() => void moveFavoriteList(1)}
              aria-label="Move list right"
            >
              <ArrowRight className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" className="shrink-0" onClick={() => setDeleteListTarget(selectedList)}>
              <Trash2 className="h-4 w-4" />
              Delete
            </Button>
          </>
        )}
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {statusTabs.map((tab) => (
          <button
            key={tab.value}
            className={`inline-flex h-8 shrink-0 items-center gap-2 rounded-md border px-3 text-xs font-medium ${statusFilter === tab.value ? "bg-primary text-primary-foreground" : "bg-card hover:bg-muted"}`}
            onClick={() => setStatusFilter(tab.value)}
          >
            <tab.icon className="h-3.5 w-3.5" />
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-2 rounded-lg border bg-card px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Filter className="h-4 w-4" />
          Showing {filteredWorks.length} of {shelfWorks.length} shelf works
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant={selectionMode ? "default" : "outline"} size="sm" onClick={() => {
            setSelectionMode((value) => {
              if (value) setSelectedWorkIDs(new Set());
              return !value;
            });
          }}>
            Select
          </Button>
          <ColumnPicker
            mobileColumns={mobileColumns}
            desktopColumns={desktopColumns}
            onMobileChange={setMobileColumns}
            onDesktopChange={setDesktopColumns}
          />
          <span className="text-xs text-muted-foreground">Page size</span>
          <select
            className="h-8 rounded-md border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
            value={pageSize}
            onChange={(event) => setPageSize(Number(event.target.value) as PageSize)}
          >
            {pageSizeOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
      </div>

      {selectionMode && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2 text-sm">
          <label className="flex items-center gap-2 text-muted-foreground">
            <input
              type="checkbox"
              checked={allPagedWorksSelected}
              disabled={pagedWorks.length === 0}
              onChange={(event) => togglePagedSelection(event.target.checked)}
            />
            {selectedWorks.length} selected
          </label>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => togglePagedSelection(true)}>Select page</Button>
            <Button variant="outline" size="sm" onClick={() => {
              setSelectedWorkIDs(new Set());
              setSelectionMode(false);
            }}>Cancel</Button>
            <div className="relative">
              <Button variant="outline" size="sm" disabled={selectedWorks.length === 0 || isBulkUpdating} onClick={() => setListDialogTarget((target) => target ? null : { mode: "bulk" })}>
                Change lists
              </Button>
              {listDialogTarget && (
                <ListMembershipPopover
                  title={`${selectedWorks.length} selected works`}
                  work={null}
                  favoriteLists={favoriteLists}
                  defaultSelectedListIDs={selectedList ? [selectedList.id] : undefined}
                  disabled={isBulkUpdating}
                  align="right"
                  onClose={() => setListDialogTarget(null)}
                  onSave={applyListMembership}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="grid min-h-60 place-items-center rounded-lg border bg-card text-sm text-muted-foreground">Loading favorites...</div>
      ) : pagedWorks.length > 0 ? (
        <>
          <div className={workGridClassName(mobileColumns, desktopColumns)}>
            {pagedWorks.map((work) => (
              <FavoriteWorkCard
                key={work.id}
                work={work}
                selected={selectedWorkIDs.has(work.id)}
                selectionActive={selectionMode}
                onSelectedChange={(selected) => toggleWorkSelection(work.id, selected)}
                favoriteLists={favoriteLists}
                isListSaving={isBulkUpdating}
                onSaveLists={async (listIDs) => {
                  setIsBulkUpdating(true);
                  try {
                    await api.setWorkFavoriteLists(work.id, listIDs);
                    setWorks(await api.listWorks());
                    await reloadFavoriteLists();
                    setMessage(`Updated list membership for ${work.primaryCode}.`);
                  } catch (error) {
                    setMessage(error instanceof Error ? error.message : "List membership could not be saved.");
                  } finally {
                    setIsBulkUpdating(false);
                  }
                }}
                onOpen={() => openWork(work)}
                onStatusChange={updateWorkStatus}
                onFavoriteChange={updateWorkFavorite}
              />
            ))}
          </div>
          {totalPages > 1 && (
            <Pagination
              page={currentPage}
              totalPages={totalPages}
              totalItems={filteredWorks.length}
              onPageChange={setPage}
            />
          )}
        </>
      ) : (
        <EmptyFavorites hasFilters={Boolean(hasActiveFilters)} onClearFilters={clearFilters} />
      )}
      {listEditor && (
        <FavoriteListEditor
          list={listEditor === "new" ? null : listEditor}
          onClose={() => setListEditor(null)}
          onSave={saveFavoriteList}
        />
      )}
      {deleteListTarget && (
        <ConfirmDeleteList
          list={deleteListTarget}
          onClose={() => setDeleteListTarget(null)}
          onConfirm={() => void deleteFavoriteList()}
        />
      )}
    </section>
  );
}

function MetricCard({ label, value, icon: Icon }: { label: string; value: number; icon: typeof Heart }) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-4">
        <div>
          <div className="text-2xl font-semibold">{value}</div>
          <div className="text-sm text-muted-foreground">{label}</div>
        </div>
        <Icon className="h-5 w-5 text-primary" />
      </CardContent>
    </Card>
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
      <div className="flex rounded-md border bg-background p-1 sm:hidden" aria-label="Mobile card columns">
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
      <div className="hidden rounded-md border bg-background p-1 sm:flex" aria-label="Desktop card columns">
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

function workGridClassName(mobileColumns: 1 | 2, desktopColumns: 4 | 6 | 8) {
  const mobileClass = mobileColumns === 1 ? "grid-cols-1" : "grid-cols-2";
  const desktopClass = desktopColumns === 4 ? "sm:grid-cols-4" : desktopColumns === 6 ? "sm:grid-cols-6" : "sm:grid-cols-8";
  return `grid gap-4 ${mobileClass} ${desktopClass}`;
}

function FavoriteWorkCard({
  work,
  selected,
  selectionActive,
  onSelectedChange,
  favoriteLists,
  isListSaving,
  onSaveLists,
  onOpen,
  onStatusChange,
  onFavoriteChange,
}: {
  work: Work;
  selected: boolean;
  selectionActive: boolean;
  onSelectedChange: (selected: boolean) => void;
  favoriteLists: FavoriteList[];
  isListSaving: boolean;
  onSaveLists: (listIDs: number[]) => Promise<void>;
  onOpen: () => void;
  onStatusChange: (workID: number, status: ListeningStatus) => Promise<void>;
  onFavoriteChange: (workID: number, favorite: boolean) => Promise<void>;
}) {
  const [isListPopoverOpen, setIsListPopoverOpen] = useState(false);
  const view = favoriteWorkCardView(work);

  return (
    <WorkCardShell
      work={view}
      selection={selectionActive ? <WorkCardSelection checked={selected} onChange={onSelectedChange} /> : undefined}
      onOpen={onOpen}
      onSeriesOpen={work.seriesTitleId && work.circleExternalId ? () => openCircleSeriesRoute(work.circleExternalId, work.seriesTitleId) : undefined}
      footer={(
        <WorkCardFooter
          left={<WorkCardDLsiteAction href={work.dlsiteUrl} />}
          right={(
            <>
            <select
              className="h-8 rounded-md border bg-background px-2 text-xs font-medium outline-none focus:ring-2 focus:ring-ring"
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
            <WorkCardActionButton title="Remove favorite" onClick={(event) => {
              event.stopPropagation();
              void onFavoriteChange(work.id, false);
            }}>
              <Heart className="h-4 w-4 fill-current" />
            </WorkCardActionButton>
            <div className="relative">
              <WorkCardActionButton title="Favorite lists" onClick={(event) => {
                event.stopPropagation();
                setIsListPopoverOpen((open) => !open);
              }}>
                <ListMusic className="h-4 w-4" />
              </WorkCardActionButton>
              {isListPopoverOpen && (
                <ListMembershipPopover
                  title={`${work.primaryCode} lists`}
                  work={work}
                  favoriteLists={favoriteLists}
                  disabled={isListSaving}
                  align="right"
                  onClose={() => setIsListPopoverOpen(false)}
                  onSave={async (listIDs) => {
                    await onSaveLists(listIDs);
                    setIsListPopoverOpen(false);
                  }}
                />
              )}
            </div>
            </>
          )}
        />
      )}
    />
  );
}

function WorkProgress({ progress }: { progress: Work["progress"] }) {
  if (!progress.mediaItemId || !progress.lastPlayedAt) {
    return <div className="h-8 text-xs text-muted-foreground">No playback yet</div>;
  }
  return (
    <div className="space-y-1">
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${progressPercent(progress)}%` }} />
      </div>
      <div className="truncate text-xs text-muted-foreground">
        {progress.completed ? "Finished" : `Resume ${progress.title || "track"} at ${formatTime(progress.positionSeconds)}`}
      </div>
    </div>
  );
}

function favoriteWorkCardView(work: Work): WorkCardViewModel {
  return {
    code: work.primaryCode,
    title: work.title,
    circle: work.circle || "Unknown circle",
    circleExternalId: work.circleExternalId,
    coverUrl: work.coverUrl,
    rating: work.rating,
    series: work.series || null,
    dlsiteTags: [
      { key: `status:${work.listeningStatus}`, label: listeningStatusLabel(work.listeningStatus), variant: "secondary" },
      ...dlsiteTagBadges(work.tags),
    ],
    date: cardDate(work.releaseDate, work.updatedAt || work.createdAt),
    progress: work.progress,
    userTags: [],
    sourceBadges: sourcePresenceBadges(work.sourcePresence, work.availability),
  };
}

function Pagination({
  page,
  totalPages,
  totalItems,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  totalItems: number;
  onPageChange: (page: number) => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="text-xs text-muted-foreground">
        Page {page} / {totalPages} · {totalItems} works
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          <ChevronLeft className="h-4 w-4" />
          Prev
        </Button>
        <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
          Next
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function EmptyFavorites({ hasFilters, onClearFilters }: { hasFilters: boolean; onClearFilters: () => void }) {
  return (
    <div className="grid min-h-72 place-items-center rounded-lg border bg-card p-6 text-center">
      <div className="max-w-sm space-y-3">
        <Heart className="mx-auto h-8 w-8 text-primary" />
        <h3 className="text-base font-semibold">{hasFilters ? "No matches" : "No shelf works yet"}</h3>
        <p className="text-sm text-muted-foreground">
          {hasFilters ? "The current filters do not match any shelf works." : "Favorite or quick mark works from Library or Work Detail to build this shelf."}
        </p>
        {hasFilters && (
          <Button variant="outline" size="sm" onClick={onClearFilters}>
            Clear filters
          </Button>
        )}
      </div>
    </div>
  );
}

function FavoriteListEditor({
  list,
  onClose,
  onSave,
}: {
  list: FavoriteList | null;
  onClose: () => void;
  onSave: (payload: { name: string; description: string }) => Promise<void>;
}) {
  const [name, setName] = useState(list?.name ?? "");
  const [description, setDescription] = useState(list?.description ?? "");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setIsSaving(true);
    setError("");
    try {
      await onSave({ name, description });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Favorite list could not be saved.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/50 p-4" onMouseDown={onClose}>
      <form
        className="w-full max-w-sm rounded-lg border bg-card p-4 shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!isSaving && name.trim()) void save();
        }}
      >
        <h3 className="text-base font-semibold">{list ? "Rename list" : "New list"}</h3>
        <div className="mt-4 space-y-3">
          <label className="grid gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">Name</span>
            <input
              className="h-9 rounded-md border bg-background px-3 outline-none focus:ring-2 focus:ring-ring"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">Description</span>
            <input
              className="h-9 rounded-md border bg-background px-3 outline-none focus:ring-2 focus:ring-ring"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          {error && <div className="rounded-md border bg-background px-3 py-2 text-xs text-muted-foreground">{error}</div>}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" type="submit" disabled={isSaving || !name.trim()}>
            {isSaving ? "Saving" : "Save"}
          </Button>
        </div>
      </form>
    </div>
  );
}

function ConfirmDeleteList({
  list,
  onClose,
  onConfirm,
}: {
  list: FavoriteList;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/50 p-4" onMouseDown={onClose}>
      <div className="w-full max-w-sm rounded-lg border bg-card p-4 shadow-xl" onMouseDown={(event) => event.stopPropagation()}>
        <h3 className="text-base font-semibold">Delete list</h3>
        <p className="mt-2 text-sm text-muted-foreground">Delete "{list.name}"? Works stay in the library, but this list membership is removed.</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={onConfirm}>
            Delete
          </Button>
        </div>
      </div>
    </div>
  );
}

function ListMembershipPopover({
  title,
  work,
  favoriteLists,
  defaultSelectedListIDs,
  disabled,
  align = "left",
  onClose,
  onSave,
}: {
  title: string;
  work: Work | null;
  favoriteLists: FavoriteList[];
  defaultSelectedListIDs?: number[];
  disabled: boolean;
  align?: "left" | "right";
  onClose: () => void;
  onSave: (listIDs: number[]) => Promise<void>;
}) {
  const [selectedIDs, setSelectedIDs] = useState<Set<number>>(() => new Set(defaultSelectedListIDs ?? []));
  const [isLoading, setIsLoading] = useState(Boolean(work));
  const [error, setError] = useState("");
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!work) return;
    let cancelled = false;
    setIsLoading(true);
    api.getWorkFavoriteLists(work.id)
      .then((lists) => {
        if (!cancelled) setSelectedIDs(new Set(lists.filter((list) => list.selected).map((list) => list.id)));
      })
      .catch((nextError) => {
        if (!cancelled) setError(nextError instanceof Error ? nextError.message : "Favorite lists could not be loaded.");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [work]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && popoverRef.current?.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const toggleList = (listID: number, selected: boolean) => {
    setSelectedIDs((items) => {
      const next = new Set(items);
      if (selected) next.add(listID);
      else next.delete(listID);
      return next;
    });
  };

  const save = async () => {
    setError("");
    try {
      await onSave(Array.from(selectedIDs));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "List membership could not be saved.");
    }
  };

  return (
    <div
      ref={popoverRef}
      className={`absolute top-full z-50 mt-2 w-72 rounded-lg border bg-card p-3 text-left shadow-xl ${align === "right" ? "right-0" : "left-0"}`}
      onClick={(event) => event.stopPropagation()}
    >
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-3 max-h-64 space-y-2 overflow-auto">
        {isLoading ? (
          <div className="rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">Loading lists...</div>
        ) : favoriteLists.length > 0 ? favoriteLists.map((list) => (
          <label key={list.id} className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md border bg-background px-3 text-sm hover:bg-muted">
            <input type="checkbox" checked={selectedIDs.has(list.id)} onChange={(event) => toggleList(list.id, event.target.checked)} />
            <span className="min-w-0 flex-1 truncate">{list.name}</span>
          </label>
        )) : (
          <div className="rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">No favorite lists yet.</div>
        )}
        {error && <div className="rounded-md border bg-background px-3 py-2 text-xs text-muted-foreground">{error}</div>}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" disabled={disabled || isLoading} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </div>
  );
}

function listeningStatusLabel(status: ListeningStatus) {
  return listeningStatusOptions.find((option) => option.value === status)?.label ?? "Unmarked";
}

function countByStatus(works: Work[]) {
  const counts: Record<ListeningStatus, number> = {
    none: 0,
    want_to_listen: 0,
    listening: 0,
    finished: 0,
    relisten: 0,
    paused: 0,
  };
  for (const work of works) counts[work.listeningStatus] += 1;
  return counts;
}

function hasAvailability(work: Work, filter: AvailabilityFilter) {
  if (filter === "all") return true;
  return work.availability.some((item) => item.toLowerCase().includes(filter));
}

function estimateListCounts(lists: FavoriteList[], favoriteCount: number, listWorkIDs: Record<number, number[]>) {
  const counts = new Map<number, number>();
  if (lists.length === 1) counts.set(lists[0].id, favoriteCount);
  for (const list of lists) {
    const workIDs = listWorkIDs[list.id];
    if (workIDs) counts.set(list.id, workIDs.length);
  }
  return counts;
}

function formatTime(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function progressPercent(progress: Work["progress"]) {
  if (!progress.durationSeconds || progress.durationSeconds <= 0) return 0;
  return Math.min(100, Math.max(0, (progress.positionSeconds / progress.durationSeconds) * 100));
}
