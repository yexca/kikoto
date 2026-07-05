import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Filter,
  Heart,
  ListChecks,
  ListMusic,
  Pause,
  Play,
  Search,
  Star,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api, assetURL, type FavoriteList, type ListeningStatus, type Work } from "@/lib/api";

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
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState("");

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

  const favoriteWorks = useMemo(() => works.filter((work) => work.favorite), [works]);
  const statusCounts = useMemo(() => countByStatus(favoriteWorks), [favoriteWorks]);
  const listCounts = useMemo(() => estimateListCounts(favoriteLists, favoriteWorks.length, listWorkIDs), [favoriteLists, favoriteWorks.length, listWorkIDs]);

  const filteredWorks = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const activeListIDs = activeList === "all" ? null : new Set(listWorkIDs[activeList] ?? []);
    return favoriteWorks.filter((work) => {
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
  }, [activeList, availabilityFilter, favoriteWorks, listWorkIDs, query, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredWorks.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedWorks = filteredWorks.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const hasActiveFilters = query.trim() || statusFilter !== "all" || availabilityFilter !== "all" || activeList !== "all";

  const openWork = (work: Work) => {
    window.history.pushState({}, "", `/${work.primaryCode}`);
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

  return (
    <section className="space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">Personal lists and listening marks across the unified library</p>
          <h2 className="text-xl font-semibold">Favorites</h2>
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
        <MetricCard label="Favorites" value={favoriteWorks.length} icon={Heart} />
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
          All Favorites
          <span className="text-xs opacity-80">{favoriteWorks.length}</span>
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
          Showing {filteredWorks.length} of {favoriteWorks.length} favorite works
        </div>
        <div className="flex items-center gap-2">
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

      {isLoading ? (
        <div className="grid min-h-60 place-items-center rounded-lg border bg-card text-sm text-muted-foreground">Loading favorites...</div>
      ) : pagedWorks.length > 0 ? (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {pagedWorks.map((work) => (
              <FavoriteWorkCard
                key={work.id}
                work={work}
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

function FavoriteWorkCard({
  work,
  onOpen,
  onStatusChange,
  onFavoriteChange,
}: {
  work: Work;
  onOpen: () => void;
  onStatusChange: (workID: number, status: ListeningStatus) => Promise<void>;
  onFavoriteChange: (workID: number, favorite: boolean) => Promise<void>;
}) {
  const sourceBadges = work.availability.length > 0 ? work.availability : ["missing"];

  return (
    <Card className="group h-full overflow-hidden transition-colors hover:border-primary/50">
      <CardContent className="p-0">
        <button className="block w-full text-left" onClick={onOpen}>
          <div className="relative aspect-[4/3] overflow-hidden bg-muted">
            {work.coverUrl ? (
              <img src={assetURL(work.coverUrl)} alt="" className="h-full w-full object-contain transition-transform group-hover:scale-[1.03]" />
            ) : (
              <div className="grid h-full place-items-center bg-secondary text-2xl font-bold text-secondary-foreground">{work.primaryCode.slice(0, 2)}</div>
            )}
            <div className="absolute left-3 top-3 rounded-md bg-background/90 px-2 py-1 text-xs font-semibold">{work.primaryCode}</div>
            <div className="absolute bottom-3 right-3 rounded-md bg-background/90 px-2 py-1 text-xs font-semibold">
              {work.rating === null ? "No rating" : `Rate ${work.rating.toFixed(2)}`}
            </div>
          </div>
          <div className="flex min-h-48 flex-col gap-3 p-4">
            <div className="space-y-1">
              <h3 className="line-clamp-2 min-h-10 text-base font-semibold leading-snug">{work.title}</h3>
              <div className="truncate text-sm text-muted-foreground">{work.circle || "Unknown circle"}</div>
            </div>
            <div className="flex min-h-6 flex-wrap gap-1.5">
              <Badge>{listeningStatusLabel(work.listeningStatus)}</Badge>
              {work.tags.slice(0, 3).map((tag) => (
                <Badge key={tag} variant="outline">
                  {tag}
                </Badge>
              ))}
            </div>
            <div className="grid gap-1 text-xs text-muted-foreground">
              <div className="truncate">Release {work.releaseDate || "unknown"} · Updated {work.updatedAt || work.createdAt || "unknown"}</div>
              <div className="truncate">{work.trackCount} tracks · Sales {work.sales === null ? "unknown" : work.sales.toLocaleString()}</div>
            </div>
            <div className="mt-auto flex min-h-6 flex-wrap gap-1.5">
              {sourceBadges.map((badge) => (
                <Badge key={badge} variant={badge === "missing" ? "warning" : "secondary"}>
                  {badge}
                </Badge>
              ))}
            </div>
          </div>
        </button>
        <div className="flex h-12 items-center justify-between border-t px-3">
          <Button variant="ghost" size="icon" asChild title="Open DLsite">
            <a href={work.dlsiteUrl} target="_blank" rel="noreferrer" aria-label="Open DLsite">
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
          <div className="flex items-center gap-2">
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
            <Button variant="outline" size="sm" onClick={() => void onFavoriteChange(work.id, false)}>
              <Heart className="h-4 w-4 fill-current" />
              Remove
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
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
        <h3 className="text-base font-semibold">{hasFilters ? "No matches" : "No favorite works yet"}</h3>
        <p className="text-sm text-muted-foreground">
          {hasFilters ? "The current filters do not match any favorite works." : "Mark works from Library or Work Detail to build this shelf."}
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
