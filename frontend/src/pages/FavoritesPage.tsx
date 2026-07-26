import {
  ArrowDownAZ,
  ArrowDownZA,
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Filter,
  Heart,
  ListChecks,
  ListMusic,
  Mic2,
  MoreHorizontal,
  Pencil,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Star,
  Trash2,
  UsersRound,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { toastFromError, useToast } from "@/components/ui/toast";
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
  userTagBadges,
  type WorkCardViewModel,
} from "@/components/work-card/WorkCardShell";
import { sourcePresenceBadges } from "@/components/work-card/sourceBadges";
import {
  WorkCollectionLayoutPicker,
  workCollectionClassName,
  workCollectionItemClassName,
  workCollectionStyle,
  useWorkCollectionLayout,
  type WorkCollectionColumnSetting,
  type WorkCollectionViewMode,
} from "@/components/work-collection/WorkCollectionLayout";
import { WorkCollectionPagination } from "@/components/work-collection/WorkCollectionPagination";
import { CreatorCard, CreatorCardSkeleton, creatorCollectionClassName } from "@/components/creator/CreatorCard";
import {
  api,
  assetURL,
  type CircleSummary,
  type FavoriteList,
  type FavoriteSort,
  type ListeningStatus,
  type SortDirection,
  type VoiceSummary,
  type Work,
} from "@/lib/api";
import { openCircleSeriesRoute } from "@/pages/CirclesPage";
import { openCircleRoute } from "@/pages/CirclesPage";
import { openVoiceRoute } from "@/pages/CreatorWorksPage";
import {
  defaultFavoritesBrowseState,
  favoritesBrowseSearch,
  favoritesBrowseStateFromSearch,
  favoritesBrowseStateFromValue,
  favoritesLocation,
  personalTagSearch,
  readFavoritesBrowseState,
  writeFavoritesBrowseState,
  type FavoriteAvailability,
  type FavoritesBrowseState,
  type FavoriteEntity,
} from "@/pages/favoritesBrowseState";
import { defaultLibraryBrowseState, libraryLocation } from "@/pages/libraryBrowseState";

const listeningStatusOptions: { value: ListeningStatus; label: string }[] = [
  { value: "none", label: "Unmarked" },
  { value: "want_to_listen", label: "Want" },
  { value: "listening", label: "Listening" },
  { value: "finished", label: "Finished" },
  { value: "relisten", label: "Relisten" },
  { value: "paused", label: "Shelved" },
];

const statusTabs: { value: ListeningStatus | "all"; label: string; icon: typeof Heart }[] = [
  { value: "all", label: "All", icon: Heart },
  { value: "want_to_listen", label: "Want", icon: Star },
  { value: "listening", label: "Listening", icon: Play },
  { value: "finished", label: "Finished", icon: ListChecks },
  { value: "relisten", label: "Relisten", icon: Heart },
  { value: "paused", label: "Shelved", icon: Pause },
];

const availabilityFilters = [
  { value: "all", label: "All sources" },
  { value: "local", label: "Local" },
  { value: "cache", label: "Cached" },
  { value: "remote", label: "Remote" },
  { value: "missing", label: "Missing" },
] as const;

const pageSizeOptions = [24, 48] as const;
const favoriteSortOptions: { value: FavoriteSort; label: string }[] = [
  { value: "activity", label: "Shelf activity" },
  { value: "added", label: "Added to list" },
  { value: "release", label: "Release date" },
  { value: "code", label: "DLsite code" },
  { value: "title", label: "Title" },
  { value: "rating", label: "Rating" },
  { value: "sales", label: "Sales" },
  { value: "random", label: "Random" },
];

function createFavoriteRandomSeed() {
  return window.crypto.getRandomValues(new Uint32Array(1))[0] % 2147483646 + 1;
}

type PageSize = (typeof pageSizeOptions)[number];
type AvailabilityFilter = FavoriteAvailability;

type FavoritesEntryState = {
  favoritesBrowseState?: FavoritesBrowseState;
  favoritesSelection?: { active: boolean; workIDs: number[] };
  favoritesAnchor?: { workID: number; viewportOffset: number };
};

export function FavoritesPage() {
  const toast = useToast();
  const auth = useAuth();
  const initialEntryState = useRef(readFavoritesEntryState()).current;
  const initialBrowseState = useRef(favoritesBrowseStateFromSearch(
    window.location.search,
    initialEntryState.favoritesBrowseState
      ?? (auth.user ? readFavoritesBrowseState(auth.user.id) : null)
      ?? defaultFavoritesBrowseState,
  )).current;
  const pendingAnchor = useRef(initialEntryState.favoritesAnchor ?? null);
  const [works, setWorks] = useState<Work[]>([]);
  const [favoriteLists, setFavoriteLists] = useState<FavoriteList[]>([]);
  const [areFavoriteListsLoading, setAreFavoriteListsLoading] = useState(true);
  const [favoriteEntity, setFavoriteEntity] = useState<FavoriteEntity>(initialBrowseState.entity);
  const [circles, setCircles] = useState<CircleSummary[]>([]);
  const [voices, setVoices] = useState<VoiceSummary[]>([]);
  const [isEntitiesLoading, setIsEntitiesLoading] = useState(true);
  const [query, setQuery] = useState(initialBrowseState.query);
  const [statusFilter, setStatusFilter] = useState<ListeningStatus | "all">(initialBrowseState.status);
  const [availabilityFilter, setAvailabilityFilter] = useState<AvailabilityFilter>(initialBrowseState.availability);
  const [activeList, setActiveList] = useState<"all" | number>(initialBrowseState.list);
  const [page, setPage] = useState(initialBrowseState.page);
  const [pageSize, setPageSize] = useState<PageSize>(initialBrowseState.pageSize);
  const [sort, setSort] = useState<FavoriteSort>(initialBrowseState.sort);
  const [sortDirection, setSortDirection] = useState<SortDirection>(initialBrowseState.direction);
  const [randomSeed, setRandomSeed] = useState(initialBrowseState.randomSeed);
  const [totalWorks, setTotalWorks] = useState(0);
  const [shelfTotal, setShelfTotal] = useState(0);
  const [listCounts, setListCounts] = useState<Record<string, number>>({});
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
  const { mobileColumns, desktopColumns, viewMode, setMobileColumns, setDesktopColumns, setViewMode } = useWorkCollectionLayout();
  const [selectionMode, setSelectionMode] = useState(Boolean(initialEntryState.favoritesSelection?.active));
  const [selectedWorkIDs, setSelectedWorkIDs] = useState<Set<number>>(() => new Set(initialEntryState.favoritesSelection?.workIDs ?? []));
  const [isBulkUpdating, setIsBulkUpdating] = useState(false);
  const [listDialogTarget, setListDialogTarget] = useState<{ mode: "bulk" } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [listEditor, setListEditor] = useState<FavoriteList | "new" | null>(null);
  const [deleteListTarget, setDeleteListTarget] = useState<FavoriteList | null>(null);
  const [listActionsOpen, setListActionsOpen] = useState(false);
  const listActionsRef = useRef<HTMLDivElement | null>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    if (!auth.user) {
      setFavoriteLists([]);
      setAreFavoriteListsLoading(false);
      return;
    }
    let cancelled = false;
    setAreFavoriteListsLoading(true);
    api.listFavoriteLists()
      .then((lists) => {
        if (!cancelled) setFavoriteLists(lists);
      })
      .catch((error) => {
        if (!cancelled) toast.notify(toastFromError(error, "Favorite lists could not be loaded."));
      })
      .finally(() => {
        if (!cancelled) setAreFavoriteListsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [auth.user]);

  useEffect(() => {
    if (!auth.user) {
      setCircles([]);
      setVoices([]);
      setIsEntitiesLoading(false);
      return;
    }
    let cancelled = false;
    setIsEntitiesLoading(true);
    Promise.all([
      api.listCircles({ filter: "favorite", pageSize: 100 }),
      api.listVoices({ filter: "favorite", pageSize: 100 }),
    ])
      .then(([circlePage, voicePage]) => {
        if (cancelled) return;
        setCircles(circlePage.circles);
        setVoices(voicePage.voices);
      })
      .catch((error) => {
        if (!cancelled) toast.notify(toastFromError(error, "Favorite people and circles could not be loaded."));
      })
      .finally(() => {
        if (!cancelled) setIsEntitiesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [auth.user]);

  useEffect(() => {
    if (!auth.user) {
      setWorks([]);
      setTotalWorks(0);
      setShelfTotal(0);
      setListCounts({});
      setStatusCounts({});
      setIsLoading(false);
      return;
    }
    const seq = ++requestSeq.current;
    setIsLoading(true);
    api.listFavoriteWorksPage(page, pageSize, "", activeList, statusFilter, availabilityFilter, sort, sortDirection, randomSeed)
      .then((result) => {
        if (seq !== requestSeq.current) return;
        setWorks(result.works);
        setTotalWorks(result.total);
        setShelfTotal(result.shelfTotal);
        setListCounts(result.listCounts);
        setStatusCounts(result.statusCounts);
      })
      .catch((error) => {
        if (seq !== requestSeq.current) return;
        setWorks([]);
        setTotalWorks(0);
        toast.notify(toastFromError(error, "Favorites could not be loaded."));
      })
      .finally(() => {
        if (seq === requestSeq.current) setIsLoading(false);
      });
  }, [activeList, availabilityFilter, auth.user, page, pageSize, randomSeed, sort, sortDirection, statusFilter]);

  useEffect(() => {
    if (isLoading) return;
    setSelectedWorkIDs((ids) => new Set(Array.from(ids).filter((id) => works.some((work) => work.id === id))));
  }, [isLoading, works]);

  useEffect(() => {
    if (window.location.pathname !== "/favorites") return;
    const browseState: FavoritesBrowseState = {
      entity: favoriteEntity,
      query,
      status: statusFilter,
      availability: availabilityFilter,
      list: activeList,
      page,
      pageSize,
      sort,
      direction: sortDirection,
      randomSeed,
    };
    const search = favoritesBrowseSearch(browseState);
    if (auth.user) writeFavoritesBrowseState(auth.user.id, browseState);
    const state = {
      ...(window.history.state && typeof window.history.state === "object" ? window.history.state : {}),
      favoritesBrowseState: browseState,
      favoritesSelection: { active: selectionMode, workIDs: Array.from(selectedWorkIDs) },
    };
    window.history.replaceState(state, "", `/favorites${search}`);
  }, [activeList, auth.user, availabilityFilter, favoriteEntity, page, pageSize, query, randomSeed, selectedWorkIDs, selectionMode, sort, sortDirection, statusFilter]);

  useEffect(() => {
    const anchor = pendingAnchor.current;
    if (isLoading || favoriteEntity !== "works" || !anchor) return;
    const target = document.querySelector<HTMLElement>(`[data-favorite-work-id="${anchor.workID}"]`);
    pendingAnchor.current = null;
    if (!target) return;
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const top = window.scrollY + target.getBoundingClientRect().top - anchor.viewportOffset;
      window.scrollTo({ top: Math.max(0, top), behavior: "auto" });
      target.focus({ preventScroll: true });
    }));
  }, [favoriteEntity, isLoading, works]);

  const totalPages = Math.max(1, Math.ceil(totalWorks / pageSize));
  const currentPage = Math.min(page, totalPages);
  const hasActiveFilters = favoriteEntity === "works"
    ? statusFilter !== "all" || availabilityFilter !== "all" || activeList !== "all"
    : Boolean(query.trim());
  const selectedList = activeList === "all" ? null : favoriteLists.find((list) => list.id === activeList) ?? null;
  const selectedListIndex = selectedList ? favoriteLists.findIndex((list) => list.id === selectedList.id) : -1;
  const selectedWorks = works.filter((work) => selectedWorkIDs.has(work.id));
  const allPagedWorksSelected = works.length > 0 && works.every((work) => selectedWorkIDs.has(work.id));
  const favoriteCircles = circles.filter((circle) => circle.favorite);
  const favoriteVoices = voices.filter((voice) => voice.favorite);

  useEffect(() => {
    if (!isLoading && page > totalPages) setPage(totalPages);
  }, [isLoading, page, totalPages]);

  useEffect(() => setListActionsOpen(false), [activeList]);

  if (!auth.user) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          Sign in to view and manage your favorites.
        </CardContent>
      </Card>
    );
  }

  const openWork = (work: Work) => {
    const browseState = {
      entity: favoriteEntity,
      query,
      status: statusFilter,
      availability: availabilityFilter,
      list: activeList,
      page,
      pageSize,
      sort,
      direction: sortDirection,
      randomSeed,
    };
    const target = document.querySelector<HTMLElement>(`[data-favorite-work-id="${work.id}"]`);
    const anchor = { workID: work.id, viewportOffset: target?.getBoundingClientRect().top ?? 0 };
    const returnTo = favoritesLocation(browseState);
    window.history.replaceState({
      ...(window.history.state && typeof window.history.state === "object" ? window.history.state : {}),
      favoritesSelection: { active: selectionMode, workIDs: Array.from(selectedWorkIDs) },
      favoritesAnchor: anchor,
    }, "", returnTo);
    window.history.pushState({ returnTo, returnLabel: "Back to favorites", workPreview: work }, "", `/${work.primaryCode}`);
    window.dispatchEvent(new Event("kikoto:navigation"));
  };

  const updateWorkStatus = async (workID: number, status: ListeningStatus) => {
    const result = await api.updateWorkUserState(workID, { listeningStatus: status });
    setWorks((items) => items.map((item) => (item.id === workID ? { ...item, listeningStatus: result.listeningStatus, favorite: result.favorite } : item)));
  };

  const clearFilters = () => {
    setQuery("");
    setStatusFilter("all");
    setAvailabilityFilter("all");
    setActiveList("all");
    setPage(1);
  };

  const openShelfUserTag = (tag: string) => {
    const tagClause = personalTagSearch(tag);
    const target = libraryLocation("/library", {
      ...defaultLibraryBrowseState,
      query: ["shelf:true", tagClause].filter(Boolean).join(" "),
      view: viewMode,
      mobileColumns,
      desktopColumns,
    });
    window.history.pushState({}, "", target);
    window.dispatchEvent(new Event("kikoto:navigation"));
  };

  const reloadFavoriteLists = async () => {
    const lists = await api.listFavoriteLists();
    setFavoriteLists(lists);
    const result = await api.listFavoriteWorksPage(currentPage, pageSize, "", activeList, statusFilter, availabilityFilter, sort, sortDirection, randomSeed);
    setWorks(result.works);
    setTotalWorks(result.total);
    setShelfTotal(result.shelfTotal);
    setListCounts(result.listCounts);
    setStatusCounts(result.statusCounts);
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
    toast.success("Favorite list saved.");
  };

  const deleteFavoriteList = async () => {
    if (!deleteListTarget) return;
    await api.deleteFavoriteList(deleteListTarget.id);
    setDeleteListTarget(null);
    setActiveList("all");
    await reloadFavoriteLists();
    toast.success("Favorite list deleted.");
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
    toast.success("Favorite list reordered.");
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
      for (const work of works) {
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
      await reloadFavoriteLists();
      setSelectedWorkIDs(new Set());
      setSelectionMode(false);
      setListDialogTarget(null);
      toast.success(`Updated list membership for ${targetWorks.length} work${targetWorks.length === 1 ? "" : "s"}.`);
    } catch (error) {
      toast.notify(toastFromError(error, "Bulk list update failed."));
    } finally {
      setIsBulkUpdating(false);
    }
  };

  return (
    <section className="space-y-5">
      {favoriteEntity !== "works" && (
        <div className="flex justify-end">
          <div className="flex w-full items-center gap-2 sm:max-w-sm">
            <label className="relative block min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                className="h-9 w-full rounded-md border bg-card pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={favoriteEntity === "circles" ? "Search circles" : "Search voice actors"}
              />
            </label>
            {query.trim() && (
              <Button variant="outline" size="icon" onClick={() => setQuery("")} aria-label="Clear search">
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="border-b" role="tablist" aria-label="Favorite categories">
        <div className="flex gap-6 overflow-x-auto">
          <FavoriteEntityTab active={favoriteEntity === "works"} icon={ListMusic} label="Works" count={shelfTotal} onClick={() => setFavoriteEntity("works")} />
          <FavoriteEntityTab active={favoriteEntity === "circles"} icon={UsersRound} label="Circles" count={favoriteCircles.length} onClick={() => setFavoriteEntity("circles")} />
          <FavoriteEntityTab active={favoriteEntity === "voices"} icon={Mic2} label="Voice Actors" count={favoriteVoices.length} onClick={() => setFavoriteEntity("voices")} />
        </div>
      </div>

      {favoriteEntity !== "works" && (
        <FavoriteEntitySection
          kind={favoriteEntity}
          query={query}
          isLoading={isEntitiesLoading}
          circles={favoriteCircles}
          voices={favoriteVoices}
          onCircleChange={(next) => setCircles((items) => items.map((item) => item.externalId === next.externalId ? { ...item, ...next } : item))}
          onVoiceChange={(next) => setVoices((items) => items.map((item) => item.personId === next.personId ? { ...item, ...next } : item))}
        />
      )}

      {favoriteEntity === "works" && (
      <>
      <div className="space-y-2">
        <div className="flex gap-2 overflow-x-auto pb-1">
        {areFavoriteListsLoading ? <FavoriteListTabSkeletons /> : <button
          className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-md border px-3 text-sm font-medium ${activeList === "all" ? "bg-primary text-primary-foreground" : "bg-card hover:bg-muted"}`}
          onClick={() => {
            setActiveList("all");
            setPage(1);
          }}
        >
          <ListMusic className="h-4 w-4" />
          All Shelf
          <span className="text-xs opacity-80">{shelfTotal}</span>
        </button>}
        {favoriteLists.map((list) => (
          <button
            key={list.id}
            className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-md border px-3 text-sm font-medium ${activeList === list.id ? "bg-primary text-primary-foreground" : "bg-card hover:bg-muted"}`}
            onClick={() => {
              setActiveList(list.id);
              setPage(1);
            }}
            title={list.description || list.name}
          >
            <ListMusic className="h-4 w-4" />
            <span className="max-w-48 truncate">{list.name}</span>
            <span className="text-xs opacity-80">{listCounts[String(list.id)] ?? 0}</span>
          </button>
        ))}
        <Button variant="outline" size="sm" className="shrink-0" onClick={() => setListEditor("new")} disabled={areFavoriteListsLoading}>
          <Plus className="h-4 w-4" />
          New list
        </Button>
        <div ref={listActionsRef} className="relative shrink-0">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            disabled={!selectedList || areFavoriteListsLoading}
            onClick={() => setListActionsOpen((open) => !open)}
            aria-label="List actions"
            title={selectedList ? `Manage ${selectedList.name}` : "Select a custom list to manage it"}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
          <AnchoredPopover open={listActionsOpen && Boolean(selectedList)} anchorRef={listActionsRef} onOpenChange={setListActionsOpen} className="w-48 p-1 text-sm">
            {selectedList && (
              <>
                <FavoriteListAction icon={<Pencil className="h-4 w-4" />} label="Rename list" onClick={() => { setListActionsOpen(false); setListEditor(selectedList); }} />
                <FavoriteListAction icon={<ArrowLeft className="h-4 w-4" />} label="Move list left" disabled={selectedListIndex <= 0} onClick={() => { setListActionsOpen(false); void moveFavoriteList(-1); }} />
                <FavoriteListAction icon={<ArrowRight className="h-4 w-4" />} label="Move list right" disabled={selectedListIndex < 0 || selectedListIndex >= favoriteLists.length - 1} onClick={() => { setListActionsOpen(false); void moveFavoriteList(1); }} />
                <FavoriteListAction icon={<Trash2 className="h-4 w-4" />} label="Delete list" destructive onClick={() => { setListActionsOpen(false); setDeleteListTarget(selectedList); }} />
              </>
            )}
          </AnchoredPopover>
        </div>
        </div>

        <div className="flex items-center gap-1 overflow-x-auto pb-1" aria-label="Listening status filters">
          <span className="mr-1 inline-flex h-7 shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground">
            <Filter className="h-3 w-3" />
            Status
          </span>
          {statusTabs.map((tab) => (
            <button
              key={tab.value}
              className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors ${statusFilter === tab.value ? "bg-primary/10 text-primary ring-1 ring-inset ring-primary/20" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
              onClick={() => {
                setStatusFilter(tab.value);
                setPage(1);
              }}
              aria-pressed={statusFilter === tab.value}
            >
              <tab.icon className="h-3 w-3" />
              {tab.label}
              <span className="text-[11px] tabular-nums opacity-65">{tab.value === "all" ? shelfTotal : statusCounts[tab.value] ?? 0}</span>
            </button>
          ))}
        </div>
      </div>

      <WorkCollectionPagination
        placement="top"
        page={currentPage}
        pageSize={pageSize}
        totalItems={totalWorks}
        totalPages={totalPages}
        pageSizeOptions={pageSizeOptions}
        onPageChange={setPage}
        onPageSizeChange={(value) => {
          setPageSize(value as PageSize);
          setPage(1);
        }}
        leadingControls={(
          <>
            <select
              className="h-8 rounded-md border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
              value={availabilityFilter}
              onChange={(event) => {
                setAvailabilityFilter(event.target.value as AvailabilityFilter);
                setPage(1);
              }}
              aria-label="Availability filter"
            >
              {availabilityFilters.map((filter) => (
                <option key={filter.value} value={filter.value}>
                  {filter.label}
                </option>
              ))}
            </select>
            {hasActiveFilters && (
              <Button variant="outline" size="icon" className="h-8 w-8" onClick={clearFilters} aria-label="Clear shelf filters" title="Clear shelf filters">
                <X className="h-4 w-4" />
              </Button>
            )}
            <Button variant={selectionMode ? "default" : "outline"} size="sm" className="h-8" onClick={() => {
              setSelectionMode((value) => {
                if (value) setSelectedWorkIDs(new Set());
                return !value;
              });
            }}>
              Select
            </Button>
            <WorkCollectionLayoutPicker
              viewMode={viewMode}
              mobileColumns={mobileColumns}
              desktopColumns={desktopColumns}
              onViewModeChange={setViewMode}
              onMobileColumnsChange={setMobileColumns}
              onDesktopColumnsChange={setDesktopColumns}
            />
            <FavoriteSortControls
              value={sort}
              direction={sortDirection}
              disabled={isLoading}
              onChange={(value) => {
                setSort(value);
                if (value === "random") setRandomSeed(createFavoriteRandomSeed());
                setPage(1);
              }}
              onDirectionChange={(value) => {
                setSortDirection(value);
                setPage(1);
              }}
              onReshuffle={() => {
                setRandomSeed(createFavoriteRandomSeed());
                setPage(1);
              }}
            />
          </>
        )}
      />

      {selectionMode && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2 text-sm">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Checkbox
              checked={allPagedWorksSelected}
              disabled={works.length === 0}
              onCheckedChange={togglePagedSelection}
              aria-label="Select current page"
            />
            {selectedWorks.length} selected
          </div>
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
        <FavoriteWorkGridSkeleton viewMode={viewMode} mobileColumns={mobileColumns} desktopColumns={desktopColumns} />
      ) : works.length > 0 ? (
        <>
          <div className={workCollectionClassName(viewMode)} style={workCollectionStyle(mobileColumns, desktopColumns)}>
            {works.map((work) => (
              <div key={work.id} data-favorite-work-id={work.id} tabIndex={-1} className={`${workCollectionItemClassName(viewMode)} outline-none`}>
                <FavoriteWorkCard
                  work={work}
                  selected={selectedWorkIDs.has(work.id)}
                  selectionActive={selectionMode}
                  onSelectedChange={(selected) => toggleWorkSelection(work.id, selected)}
                  favoriteLists={favoriteLists}
                  isListSaving={isBulkUpdating}
                  onListsChanged={async () => {
                    await reloadFavoriteLists();
                    toast.success(`Updated list membership for ${work.primaryCode}.`);
                  }}
                  onOpen={() => openWork(work)}
                  onUserTagOpen={openShelfUserTag}
                  onStatusChange={updateWorkStatus}
                />
              </div>
            ))}
          </div>
          <WorkCollectionPagination
            placement="bottom"
            page={currentPage}
            pageSize={pageSize}
            totalItems={totalWorks}
            totalPages={totalPages}
            onPageChange={setPage}
          />
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
      </>
      )}
    </section>
  );
}

function FavoriteEntityTab({ active, icon: Icon, label, count, onClick }: { active: boolean; icon: typeof Heart; label: string; count: number; onClick: () => void }) {
  return (
    <button
      className={`relative inline-flex h-11 shrink-0 items-center gap-2 px-1 text-sm font-medium transition-colors ${active ? "text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary" : "text-muted-foreground hover:text-foreground"}`}
      onClick={onClick}
      role="tab"
      aria-selected={active}
    >
      <Icon className="h-4 w-4" />
      {label}
      <span className={`rounded-full px-1.5 py-0.5 text-[11px] tabular-nums ${active ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>{count}</span>
    </button>
  );
}

function FavoriteEntitySection({
  kind,
  query,
  isLoading,
  circles,
  voices,
  onCircleChange,
  onVoiceChange,
}: {
  kind: Exclude<FavoriteEntity, "works">;
  query: string;
  isLoading: boolean;
  circles: CircleSummary[];
  voices: VoiceSummary[];
  onCircleChange: (circle: CircleSummary) => void;
  onVoiceChange: (voice: VoiceSummary) => void;
}) {
  const needle = query.trim().toLowerCase();
  const filteredCircles = circles.filter((circle) => !needle || [circle.externalId, circle.displayName, ...circle.userTags.map((tag) => tag.name)].some((value) => value.toLowerCase().includes(needle)));
  const filteredVoices = voices.filter((voice) => !needle || [voice.displayName, String(voice.personId), ...voice.aliases, ...voice.userTags.map((tag) => tag.name)].some((value) => value.toLowerCase().includes(needle)));
  const items = kind === "circles" ? filteredCircles : filteredVoices;

  if (isLoading) {
    return <FavoriteEntitySkeletonGrid />;
  }
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="p-5 text-sm text-muted-foreground">No favorite {kind === "circles" ? "circles" : "voice actors"} match this view.</CardContent>
      </Card>
    );
  }
  return (
    <div className={creatorCollectionClassName}>
      {kind === "circles"
        ? filteredCircles.map((circle) => <FavoriteCircleCard key={circle.externalId} circle={circle} onChange={onCircleChange} />)
        : filteredVoices.map((voice) => <FavoriteVoiceCard key={voice.personId} voice={voice} onChange={onVoiceChange} />)}
    </div>
  );
}

function FavoriteCircleCard({ circle, onChange }: { circle: CircleSummary; onChange: (circle: CircleSummary) => void }) {
  const toast = useToast();
  const saveTags = async (tags: string[]) => {
    try {
      const result = await api.setCircleUserTags(circle.externalId, tags);
      onChange({ ...circle, userTags: result.userTags });
    } catch (error) {
      toast.notify(toastFromError(error, "Circle tags update failed."));
    }
  };
  const removeFavorite = async () => {
    try {
      const next = await api.updateCircleUserState(circle.externalId, { favorite: false });
      onChange({ ...circle, ...next });
    } catch (error) {
      toast.notify(toastFromError(error, "Circle favorite update failed."));
    }
  };
  return <CreatorCard
    name={circle.displayName}
    identityLabel={circle.externalId}
    aliases={circle.aliases}
    latestWork={circle.latestWork}
    favorite={circle.favorite}
    userTags={circle.userTags}
    syncState={circle.syncState}
    workCount={circle.catalogWorks}
    unavailableCount={circle.missingWorks}
    sources={circle.sourceSummaries}
    onOpen={() => openCircleRoute(circle.externalId)}
    onFavoriteToggle={() => void removeFavorite()}
    onTagsSave={saveTags}
  />;
}

function FavoriteVoiceCard({ voice, onChange }: { voice: VoiceSummary; onChange: (voice: VoiceSummary) => void }) {
  const toast = useToast();
  const saveTags = async (tags: string[]) => {
    try {
      const result = await api.setVoiceUserTags(voice.personId, tags);
      onChange({ ...voice, userTags: result.userTags });
    } catch (error) {
      toast.notify(toastFromError(error, "Voice tags update failed."));
    }
  };
  const removeFavorite = async () => {
    try {
      const next = await api.updateVoiceUserState(voice.personId, { favorite: false });
      onChange({ ...voice, ...next });
    } catch (error) {
      toast.notify(toastFromError(error, "Voice favorite update failed."));
    }
  };
  return <CreatorCard
    name={voice.displayName}
    identityLabel={voice.latestWork ? undefined : "Voice actor"}
    aliases={voice.aliases}
    latestWork={voice.latestWork}
    favorite={voice.favorite}
    userTags={voice.userTags}
    workCount={voice.knownWorks}
    unavailableCount={Math.max(0, voice.knownWorks - voice.playableWorks)}
    sources={voice.sourceSummaries}
    onOpen={() => openVoiceRoute(voice.personId)}
    onFavoriteToggle={() => void removeFavorite()}
    onTagsSave={saveTags}
  />;
}

function FavoriteEntitySkeletonGrid() {
  return (
    <div className={creatorCollectionClassName}>
      {Array.from({ length: 6 }, (_, index) => <CreatorCardSkeleton key={index} />)}
    </div>
  );
}

function FavoriteSkeletonLine({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className}`} />;
}

function FavoriteListTabSkeletons() {
  return (
    <>
      {Array.from({ length: 4 }, (_, index) => (
        <FavoriteSkeletonLine key={index} className="h-9 w-28 shrink-0" />
      ))}
    </>
  );
}

function FavoriteListAction({
  icon,
  label,
  disabled = false,
  destructive = false,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  disabled?: boolean;
  destructive?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`flex h-9 w-full items-center gap-2 rounded-md px-2 text-left disabled:cursor-not-allowed disabled:opacity-45 ${destructive ? "text-destructive hover:bg-destructive/10" : "hover:bg-muted"}`}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function FavoriteWorkGridSkeleton({ viewMode, mobileColumns, desktopColumns }: { viewMode: WorkCollectionViewMode; mobileColumns: WorkCollectionColumnSetting; desktopColumns: WorkCollectionColumnSetting }) {
  return (
    <div className={workCollectionClassName(viewMode)} style={workCollectionStyle(mobileColumns, desktopColumns)}>
      {Array.from({ length: 12 }, (_, index) => (
        <div key={index} className={`${workCollectionItemClassName(viewMode)} overflow-hidden rounded-lg border bg-card`}>
          <FavoriteSkeletonLine className="aspect-[4/5] rounded-none" />
          <div className="space-y-2 p-3">
            <FavoriteSkeletonLine className="h-4 w-3/4" />
            <FavoriteSkeletonLine className="h-3 w-1/2" />
            <div className="flex gap-2 pt-2">
              <FavoriteSkeletonLine className="h-6 w-16" />
              <FavoriteSkeletonLine className="h-6 w-20" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function FavoriteWorkCard({
  work,
  selected,
  selectionActive,
  onSelectedChange,
  favoriteLists,
  isListSaving,
  onListsChanged,
  onOpen,
  onUserTagOpen,
  onStatusChange,
}: {
  work: Work;
  selected: boolean;
  selectionActive: boolean;
  onSelectedChange: (selected: boolean) => void;
  favoriteLists: FavoriteList[];
  isListSaving: boolean;
  onListsChanged: () => Promise<void>;
  onOpen: () => void;
  onUserTagOpen: (tag: string) => void;
  onStatusChange: (workID: number, status: ListeningStatus) => Promise<void>;
}) {
  const view = favoriteWorkCardView(work, onUserTagOpen);

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
            <WorkCardListButton
              workId={work.id}
              active={work.favorite}
              disabled={isListSaving}
              onSaved={() => void onListsChanged()}
            />
            <WorkCardQuickMarkButton value={work.listeningStatus} onChange={(status) => void onStatusChange(work.id, status)} />
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

function favoriteWorkCardView(work: Work, onUserTagOpen?: (tag: string) => void): WorkCardViewModel {
  return {
    code: work.primaryCode,
    title: work.title,
    circle: work.circle || "Unknown circle",
    circleExternalId: work.circleExternalId,
    ageRating: work.ageRating,
    voiceActors: work.voiceActors,
    voiceCredits: work.voiceCredits,
    coverUrl: work.coverUrl,
    rating: work.rating,
    regularPrice: work.regularPrice,
    price: work.price,
    priceCurrency: work.priceCurrency,
    series: work.series || null,
    dlsiteTags: [
      { key: `status:${work.listeningStatus}`, label: listeningStatusLabel(work.listeningStatus), variant: "secondary" },
      ...dlsiteTagBadges(work.tags),
    ],
    date: cardDate(work.releaseDate, work.updatedAt || work.createdAt),
    progress: work.progress,
    userTags: userTagBadges(work.userTags ?? [], onUserTagOpen),
    sourceBadges: sourcePresenceBadges(work.sourcePresence, work.availability),
  };
}

function FavoriteSortControls({
  value,
  direction,
  disabled,
  onChange,
  onDirectionChange,
  onReshuffle,
}: {
  value: FavoriteSort;
  direction: SortDirection;
  disabled: boolean;
  onChange: (value: FavoriteSort) => void;
  onDirectionChange: (value: SortDirection) => void;
  onReshuffle: () => void;
}) {
  const directionTitle = value === "random" ? "Reshuffle" : direction === "asc" ? "Ascending" : "Descending";
  return (
    <div className="inline-flex h-8 shrink-0 items-center rounded-md border bg-background">
      <select
        className="h-7 max-w-36 rounded-l-md bg-transparent px-2 text-xs outline-none disabled:opacity-50"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as FavoriteSort)}
        aria-label="Sort shelf works"
      >
        {favoriteSortOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-8 rounded-l-none border-l"
        disabled={disabled}
        onClick={() => value === "random" ? onReshuffle() : onDirectionChange(direction === "asc" ? "desc" : "asc")}
        aria-label={directionTitle}
        title={directionTitle}
      >
        {value === "random"
          ? <RefreshCw className="h-4 w-4" />
          : direction === "asc"
            ? <ArrowDownAZ className="h-4 w-4" />
            : <ArrowDownZA className="h-4 w-4" />}
      </Button>
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
      <div className="app-scroll mt-3 max-h-64 space-y-2 overflow-auto">
        {isLoading ? (
          <div className="rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">Loading lists...</div>
        ) : favoriteLists.length > 0 ? favoriteLists.map((list) => (
          <div key={list.id} className={`flex min-h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm hover:bg-muted ${selectedIDs.has(list.id) ? "border-primary/30 bg-primary/10" : "bg-background"}`} onClick={() => toggleList(list.id, !selectedIDs.has(list.id))}>
            <Checkbox checked={selectedIDs.has(list.id)} onCheckedChange={(checked) => toggleList(list.id, checked)} onClick={(event) => event.stopPropagation()} aria-label={`${selectedIDs.has(list.id) ? "Remove from" : "Add to"} ${list.name}`} />
            <span className="min-w-0 flex-1 truncate">{list.name}</span>
          </div>
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

function readFavoritesEntryState(): FavoritesEntryState {
  const value = window.history.state;
  if (!value || typeof value !== "object") return {};
  const state = value as FavoritesEntryState;
  const browseState = favoritesBrowseStateFromValue(state.favoritesBrowseState, defaultFavoritesBrowseState);
  const selection = state.favoritesSelection;
  const anchor = state.favoritesAnchor;
  return {
    favoritesBrowseState: state.favoritesBrowseState ? browseState : undefined,
    favoritesSelection: selection && Array.isArray(selection.workIDs)
      ? { active: Boolean(selection.active), workIDs: selection.workIDs.filter((id) => Number.isInteger(id) && id > 0) }
      : undefined,
    favoritesAnchor: anchor && Number.isInteger(anchor.workID) && anchor.workID > 0 && Number.isFinite(anchor.viewportOffset)
      ? { workID: anchor.workID, viewportOffset: anchor.viewportOffset }
      : undefined,
  };
}
