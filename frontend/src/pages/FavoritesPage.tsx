import {
  ArrowDownAZ,
  ArrowDownZA,
  ArrowLeft,
  ArrowRight,
  ArrowUpDown,
  Check,
  ChevronRight,
  Cloud,
  Columns3,
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
  SlidersHorizontal,
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
import { NAVIGATION_EVENT, historyStateWithReturn } from "@/lib/browserHistory";
import { dismissKeyboardOnEnter } from "@/lib/keyboard";
import {
  WorkCardActionButton,
  WorkCardDLsiteAction,
  WorkCardFooter,
  WorkCardListButton,
  WorkCardQuickMarkButton,
  WorkCardSelection,
  WorkCardShell,
  dlsiteTagBadges,
  userTagBadges,
  type WorkCardViewModel,
} from "@/components/work-card/WorkCardShell";
import { sourcePresenceBadges } from "@/components/work-card/sourceBadges";
import {
  WorkCollectionLayoutPicker,
  workCollectionClassName,
  workCollectionStyle,
  useWorkCollectionLayout,
  type WorkCollectionColumnSetting,
} from "@/components/work-collection/WorkCollectionLayout";
import { WorkCollectionPagination } from "@/components/work-collection/WorkCollectionPagination";
import { WorkCollectionLoadingState } from "@/components/work-collection/WorkCollectionLoadingState";
import {
  CreatorCard,
  CreatorCollectionSkeleton,
  creatorCardMinHeightClassName,
  creatorCollectionClassName,
} from "@/components/creator/CreatorCard";
import {
  api,
  assetURL,
  type CircleSummary,
  type FavoriteList,
  type FavoriteSort,
  type LibrarySource,
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
import { currentClientStorageScope } from "@/lib/clientStorageScope";

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
  { value: "all", label: "Any availability" },
  { value: "local", label: "Local" },
  { value: "cache", label: "Cached" },
  { value: "remote", label: "Remote" },
  { value: "missing", label: "Missing" },
] as const;

const pageSizeOptions = [24, 48] as const;
const favoriteSortOptions: { value: FavoriteSort; label: string }[] = [
  { value: "activity", label: "Favorite activity" },
  { value: "added", label: "Added to list" },
  { value: "release", label: "Release date" },
  { value: "code", label: "DLsite code" },
  { value: "title", label: "Title" },
  { value: "rating", label: "Rating" },
  { value: "sales", label: "Sales" },
  { value: "random", label: "Random" },
];

function createFavoriteRandomSeed() {
  return (window.crypto.getRandomValues(new Uint32Array(1))[0] % 2147483646) + 1;
}

type PageSize = (typeof pageSizeOptions)[number];
type AvailabilityFilter = FavoriteAvailability;

type FavoritesEntryState = {
  favoritesBrowseScope?: unknown;
  favoritesBrowseState?: FavoritesBrowseState;
  favoritesSelection?: { active: boolean; workIDs: number[] };
  favoritesAnchor?: { workID: number; viewportOffset: number };
};

export function FavoritesPage() {
  const toast = useToast();
  const auth = useAuth();
  const principalID = auth.user?.id ?? null;
  const favoritesStorageScope = currentClientStorageScope(principalID);
  const initialEntryState = useRef(readFavoritesEntryState(favoritesStorageScope)).current;
  const initialBrowseState = useRef(
    favoritesBrowseStateFromSearch(
      window.location.search,
      initialEntryState.favoritesBrowseState ?? readFavoritesBrowseState(principalID) ?? defaultFavoritesBrowseState,
    ),
  ).current;
  const pendingAnchor = useRef(initialEntryState.favoritesAnchor ?? null);
  const [works, setWorks] = useState<Work[]>([]);
  const [favoriteLists, setFavoriteLists] = useState<FavoriteList[]>([]);
  const [areFavoriteListsLoading, setAreFavoriteListsLoading] = useState(true);
  const [fileSources, setFileSources] = useState<LibrarySource[]>([]);
  const [areFileSourcesLoading, setAreFileSourcesLoading] = useState(true);
  const [favoriteEntity, setFavoriteEntity] = useState<FavoriteEntity>(initialBrowseState.entity);
  const [circles, setCircles] = useState<CircleSummary[]>([]);
  const [voices, setVoices] = useState<VoiceSummary[]>([]);
  const [isEntitiesLoading, setIsEntitiesLoading] = useState(true);
  const [entitySnapshotUserID, setEntitySnapshotUserID] = useState<number | null>(null);
  const [entityLoadError, setEntityLoadError] = useState("");
  const [entityReloadToken, setEntityReloadToken] = useState(0);
  const [query, setQuery] = useState(initialBrowseState.query);
  const [statusFilter, setStatusFilter] = useState<ListeningStatus | "all">(initialBrowseState.status);
  const [availabilityFilter, setAvailabilityFilter] = useState<AvailabilityFilter>(initialBrowseState.availability);
  const [sourceIDs, setSourceIDs] = useState<number[]>(initialBrowseState.sourceIDs);
  const [activeList, setActiveList] = useState<"all" | number>(initialBrowseState.list);
  const [page, setPage] = useState(initialBrowseState.page);
  const [pageSize, setPageSize] = useState<PageSize>(initialBrowseState.pageSize);
  const [sort, setSort] = useState<FavoriteSort>(initialBrowseState.sort);
  const [sortDirection, setSortDirection] = useState<SortDirection>(initialBrowseState.direction);
  const [randomSeed, setRandomSeed] = useState(initialBrowseState.randomSeed);
  const [totalWorks, setTotalWorks] = useState(0);
  const [favoriteTotal, setFavoriteTotal] = useState(0);
  const [listCounts, setListCounts] = useState<Record<string, number>>({});
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
  const { mobileColumns, desktopColumns, setMobileColumns, setDesktopColumns } = useWorkCollectionLayout();
  const [selectionMode, setSelectionMode] = useState(Boolean(initialEntryState.favoritesSelection?.active));
  const [selectedWorkIDs, setSelectedWorkIDs] = useState<Set<number>>(
    () => new Set(initialEntryState.favoritesSelection?.workIDs ?? []),
  );
  const [isBulkUpdating, setIsBulkUpdating] = useState(false);
  const [listDialogTarget, setListDialogTarget] = useState<{ mode: "bulk" } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [worksSnapshotUserID, setWorksSnapshotUserID] = useState<number | null>(null);
  const [worksLoadError, setWorksLoadError] = useState("");
  const [worksReloadToken, setWorksReloadToken] = useState(0);
  const [listEditor, setListEditor] = useState<FavoriteList | "new" | null>(null);
  const [deleteListTarget, setDeleteListTarget] = useState<FavoriteList | null>(null);
  const [listActionsOpen, setListActionsOpen] = useState(false);
  const listActionsRef = useRef<HTMLDivElement | null>(null);
  const [entitySearchOpen, setEntitySearchOpen] = useState(false);
  const entitySearchRef = useRef<HTMLDivElement | null>(null);
  const entitySearchInputRef = useRef<HTMLInputElement | null>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    setEntitySearchOpen(false);
  }, [favoriteEntity]);

  useEffect(() => {
    if (!entitySearchOpen) return;
    const frame = window.requestAnimationFrame(() => entitySearchInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [entitySearchOpen]);

  useEffect(() => {
    if (!auth.user) {
      setFavoriteLists([]);
      setAreFavoriteListsLoading(false);
      return;
    }
    let cancelled = false;
    setAreFavoriteListsLoading(true);
    api
      .listFavoriteLists()
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
      setFileSources([]);
      setAreFileSourcesLoading(false);
      return;
    }
    let cancelled = false;
    setAreFileSourcesLoading(true);
    api
      .listLibrarySources()
      .then((sources) => {
        if (cancelled) return;
        setFileSources(sources);
        const availableSourceIDs = new Set(sources.map((source) => source.id));
        setSourceIDs((current) => current.filter((sourceID) => availableSourceIDs.has(sourceID)));
      })
      .catch((error) => {
        if (!cancelled) toast.notify(toastFromError(error, "File sources could not be loaded."));
      })
      .finally(() => {
        if (!cancelled) setAreFileSourcesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [auth.user]);

  useEffect(() => {
    if (!auth.user) {
      setCircles([]);
      setVoices([]);
      setEntitySnapshotUserID(null);
      setEntityLoadError("");
      setIsEntitiesLoading(false);
      return;
    }
    let cancelled = false;
    setIsEntitiesLoading(true);
    setEntityLoadError("");
    Promise.all([
      api.listCircles({ filter: "favorite", pageSize: 100 }),
      api.listVoices({ filter: "favorite", pageSize: 100 }),
    ])
      .then(([circlePage, voicePage]) => {
        if (cancelled) return;
        setCircles(circlePage.circles);
        setVoices(voicePage.voices);
        setEntitySnapshotUserID(principalID);
      })
      .catch((error) => {
        if (!cancelled) {
          setEntityLoadError("Favorite people and circles could not be loaded.");
          toast.notify(toastFromError(error, "Favorite people and circles could not be loaded."));
        }
      })
      .finally(() => {
        if (!cancelled) setIsEntitiesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [auth.user, entityReloadToken]);

  useEffect(() => {
    if (!auth.user) {
      setWorks([]);
      setTotalWorks(0);
      setFavoriteTotal(0);
      setListCounts({});
      setStatusCounts({});
      setWorksSnapshotUserID(null);
      setWorksLoadError("");
      setIsLoading(false);
      return;
    }
    const seq = ++requestSeq.current;
    setIsLoading(true);
    setWorksLoadError("");
    api
      .listFavoriteWorksPage(
        page,
        pageSize,
        "",
        activeList,
        statusFilter,
        availabilityFilter,
        sourceIDs,
        sort,
        sortDirection,
        randomSeed,
      )
      .then((result) => {
        if (seq !== requestSeq.current) return;
        setWorks(result.works);
        setTotalWorks(result.total);
        setFavoriteTotal(result.shelfTotal);
        setListCounts(result.listCounts);
        setStatusCounts(result.statusCounts);
        setWorksSnapshotUserID(principalID);
      })
      .catch((error) => {
        if (seq !== requestSeq.current) return;
        setWorksLoadError("Favorites could not be loaded.");
        toast.notify(toastFromError(error, "Favorites could not be loaded."));
      })
      .finally(() => {
        if (seq === requestSeq.current) setIsLoading(false);
      });
  }, [
    activeList,
    availabilityFilter,
    auth.user,
    page,
    pageSize,
    randomSeed,
    sort,
    sortDirection,
    sourceIDs,
    statusFilter,
    worksReloadToken,
  ]);

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
      sourceIDs,
      list: activeList,
      page,
      pageSize,
      sort,
      direction: sortDirection,
      randomSeed,
    };
    const search = favoritesBrowseSearch(browseState);
    if (auth.user) writeFavoritesBrowseState(principalID, browseState);
    const state = {
      ...(window.history.state && typeof window.history.state === "object" ? window.history.state : {}),
      favoritesBrowseScope: favoritesStorageScope,
      favoritesBrowseState: browseState,
      favoritesSelection: { active: selectionMode, workIDs: Array.from(selectedWorkIDs) },
    };
    window.history.replaceState(state, "", `/favorites${search}`);
  }, [
    activeList,
    auth.user,
    availabilityFilter,
    favoriteEntity,
    page,
    pageSize,
    query,
    randomSeed,
    selectedWorkIDs,
    selectionMode,
    sort,
    sortDirection,
    sourceIDs,
    statusFilter,
  ]);

  useEffect(() => {
    const anchor = pendingAnchor.current;
    if (isLoading || favoriteEntity !== "works" || !anchor) return;
    const target = document.querySelector<HTMLElement>(`[data-favorite-work-id="${anchor.workID}"]`);
    pendingAnchor.current = null;
    if (!target) return;
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => {
        const top = window.scrollY + target.getBoundingClientRect().top - anchor.viewportOffset;
        window.scrollTo({ top: Math.max(0, top), behavior: "auto" });
        target.focus({ preventScroll: true });
      }),
    );
  }, [favoriteEntity, isLoading, works]);

  const totalPages = Math.max(1, Math.ceil(totalWorks / pageSize));
  const currentPage = Math.min(page, totalPages);
  const hasActiveFilters =
    favoriteEntity === "works"
      ? statusFilter !== "all" || availabilityFilter !== "all" || sourceIDs.length > 0 || activeList !== "all"
      : Boolean(query.trim());
  const selectedList = activeList === "all" ? null : (favoriteLists.find((list) => list.id === activeList) ?? null);
  const selectedListIndex = selectedList ? favoriteLists.findIndex((list) => list.id === selectedList.id) : -1;
  const selectedWorks = works.filter((work) => selectedWorkIDs.has(work.id));
  const allPagedWorksSelected = works.length > 0 && works.every((work) => selectedWorkIDs.has(work.id));
  const favoriteCircles = circles.filter((circle) => circle.favorite);
  const favoriteVoices = voices.filter((voice) => voice.favorite);
  const hasEntitySnapshot = entitySnapshotUserID === principalID;
  const hasWorksSnapshot = worksSnapshotUserID === principalID;

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
      sourceIDs,
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
    window.history.replaceState(
      {
        ...(window.history.state && typeof window.history.state === "object" ? window.history.state : {}),
        favoritesBrowseScope: favoritesStorageScope,
        favoritesSelection: { active: selectionMode, workIDs: Array.from(selectedWorkIDs) },
        favoritesAnchor: anchor,
      },
      "",
      returnTo,
    );
    window.history.pushState(
      historyStateWithReturn(returnTo, "Back to favorites", { workPreview: work }),
      "",
      `/${work.primaryCode}`,
    );
    window.dispatchEvent(new Event(NAVIGATION_EVENT));
  };

  const updateWorkStatus = async (workID: number, status: ListeningStatus) => {
    const result = await api.updateWorkUserState(workID, { listeningStatus: status });
    setWorks((items) =>
      items.map((item) =>
        item.id === workID ? { ...item, listeningStatus: result.listeningStatus, favorite: result.favorite } : item,
      ),
    );
  };

  const clearFilters = () => {
    setQuery("");
    setStatusFilter("all");
    setAvailabilityFilter("all");
    setSourceIDs([]);
    setActiveList("all");
    setPage(1);
  };

  const changeAvailabilityFilter = (value: AvailabilityFilter) => {
    setAvailabilityFilter(value);
    setPage(1);
  };

  const changeSourceIDs = (value: number[]) => {
    setSourceIDs(value);
    setPage(1);
  };

  const changePageSize = (value: PageSize) => {
    setPageSize(value);
    setPage(1);
  };

  const toggleSelectionMode = () => {
    setSelectionMode((value) => {
      if (value) setSelectedWorkIDs(new Set());
      return !value;
    });
  };

  const changeFavoriteSort = (value: FavoriteSort) => {
    setSort(value);
    if (value === "random") setRandomSeed(createFavoriteRandomSeed());
    setPage(1);
  };

  const changeFavoriteSortDirection = (value: SortDirection) => {
    setSortDirection(value);
    setPage(1);
  };

  const reshuffleFavorites = () => {
    setRandomSeed(createFavoriteRandomSeed());
    setPage(1);
  };

  const openShelfUserTag = (tag: string) => {
    const tagClause = personalTagSearch(tag);
    const target = libraryLocation("/library", {
      ...defaultLibraryBrowseState,
      query: ["shelf:true", tagClause].filter(Boolean).join(" "),
      mobileColumns,
      desktopColumns,
    });
    window.history.pushState({}, "", target);
    window.dispatchEvent(new Event("kikoto:navigation"));
  };

  const reloadFavoriteLists = async () => {
    const lists = await api.listFavoriteLists();
    setFavoriteLists(lists);
    const result = await api.listFavoriteWorksPage(
      currentPage,
      pageSize,
      "",
      activeList,
      statusFilter,
      availabilityFilter,
      sourceIDs,
      sort,
      sortDirection,
      randomSeed,
    );
    setWorks(result.works);
    setTotalWorks(result.total);
    setFavoriteTotal(result.shelfTotal);
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
      <div className="border-b">
        <div className="flex min-w-0 items-end gap-3">
          <div className="min-w-0 flex-1 overflow-x-auto" role="tablist" aria-label="Favorite categories">
            <div className="flex w-max min-w-full gap-6">
              <FavoriteEntityTab
                active={favoriteEntity === "works"}
                icon={ListMusic}
                label="Works"
                count={favoriteTotal}
                onClick={() => setFavoriteEntity("works")}
              />
              <FavoriteEntityTab
                active={favoriteEntity === "circles"}
                icon={UsersRound}
                label="Circles"
                count={favoriteCircles.length}
                onClick={() => setFavoriteEntity("circles")}
              />
              <FavoriteEntityTab
                active={favoriteEntity === "voices"}
                icon={Mic2}
                label="Voice Actors"
                count={favoriteVoices.length}
                onClick={() => setFavoriteEntity("voices")}
              />
            </div>
          </div>

          {favoriteEntity !== "works" && (
            <div ref={entitySearchRef} className="relative mb-1 shrink-0">
              <div className="hidden items-center gap-2 md:flex">
                <label className="relative block w-56">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    className="h-9 w-full rounded-md border bg-card pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                    value={query}
                    onKeyDown={dismissKeyboardOnEnter}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={favoriteEntity === "circles" ? "Search circles" : "Search voice actors"}
                    aria-label={favoriteEntity === "circles" ? "Search circles" : "Search voice actors"}
                  />
                </label>
                {query.trim() && (
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-9 w-9"
                    onClick={() => setQuery("")}
                    aria-label="Clear search"
                    title="Clear search"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>

              <div className="md:hidden">
                <Button
                  variant="outline"
                  size="icon"
                  className={`h-9 w-9 ${query.trim() ? "text-primary" : ""}`}
                  onClick={() => setEntitySearchOpen((open) => !open)}
                  aria-label="Search favorites"
                  title="Search favorites"
                >
                  <Search className="h-4 w-4" />
                </Button>
              </div>

              <AnchoredPopover
                open={entitySearchOpen}
                anchorRef={entitySearchRef}
                onOpenChange={setEntitySearchOpen}
                className="w-[min(18rem,calc(100vw-1.5rem))] p-2"
              >
                <div className="flex items-center gap-2">
                  <label className="relative block min-w-0 flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <input
                      ref={entitySearchInputRef}
                      className="h-9 w-full rounded-md border bg-card pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                      value={query}
                      onKeyDown={dismissKeyboardOnEnter}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder={favoriteEntity === "circles" ? "Search circles" : "Search voice actors"}
                      aria-label={favoriteEntity === "circles" ? "Search circles" : "Search voice actors"}
                    />
                  </label>
                  {query.trim() && (
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-9 w-9 shrink-0"
                      onClick={() => setQuery("")}
                      aria-label="Clear search"
                      title="Clear search"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </AnchoredPopover>
            </div>
          )}
        </div>
      </div>

      {favoriteEntity !== "works" && (
        <FavoriteEntitySection
          kind={favoriteEntity}
          query={query}
          isLoading={isEntitiesLoading}
          hasSnapshot={hasEntitySnapshot}
          loadError={entityLoadError}
          circles={favoriteCircles}
          voices={favoriteVoices}
          onRetry={() => setEntityReloadToken((value) => value + 1)}
          onCircleChange={(next) =>
            setCircles((items) =>
              items.map((item) => (item.externalId === next.externalId ? { ...item, ...next } : item)),
            )
          }
          onVoiceChange={(next) =>
            setVoices((items) => items.map((item) => (item.personId === next.personId ? { ...item, ...next } : item)))
          }
        />
      )}

      {favoriteEntity === "works" && (
        <>
          <div className="space-y-2">
            <div className="flex items-center gap-2 pb-1">
              <div className="min-w-0 flex-1 overflow-x-auto">
                <div className="flex w-max min-w-full gap-2" role="group" aria-label="Favorite lists">
                  {areFavoriteListsLoading ? (
                    <FavoriteListTabSkeletons />
                  ) : (
                    <FavoriteListTab
                      active={activeList === "all"}
                      label="All Favorites"
                      count={favoriteTotal}
                      onClick={() => {
                        setActiveList("all");
                        setPage(1);
                      }}
                    />
                  )}
                  {favoriteLists.map((list) => (
                    <FavoriteListTab
                      key={list.id}
                      active={activeList === list.id}
                      label={list.name}
                      count={listCounts[String(list.id)] ?? 0}
                      title={list.description || list.name}
                      onClick={() => {
                        setActiveList(list.id);
                        setPage(1);
                      }}
                    />
                  ))}
                </div>
              </div>
              <div ref={listActionsRef} className="relative shrink-0">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-11 w-11 md:h-9 md:w-9"
                  disabled={areFavoriteListsLoading}
                  onClick={() => setListActionsOpen((open) => !open)}
                  aria-label="Favorite list options"
                  title="Manage favorite lists"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
                <AnchoredPopover
                  open={listActionsOpen}
                  anchorRef={listActionsRef}
                  onOpenChange={setListActionsOpen}
                  className="w-52 p-1 text-sm"
                >
                  <div role="menu" aria-label="Favorite list options">
                    <FavoriteListAction
                      icon={<Plus className="h-4 w-4" />}
                      label="New list"
                      onClick={() => {
                        setListActionsOpen(false);
                        setListEditor("new");
                      }}
                    />
                    {selectedList && (
                      <>
                        <div className="my-1 border-t" role="separator" />
                        <FavoriteListAction
                          icon={<Pencil className="h-4 w-4" />}
                          label="Rename list"
                          onClick={() => {
                            setListActionsOpen(false);
                            setListEditor(selectedList);
                          }}
                        />
                        <FavoriteListAction
                          icon={<ArrowLeft className="h-4 w-4" />}
                          label="Move list left"
                          disabled={selectedListIndex <= 0}
                          onClick={() => {
                            setListActionsOpen(false);
                            void moveFavoriteList(-1);
                          }}
                        />
                        <FavoriteListAction
                          icon={<ArrowRight className="h-4 w-4" />}
                          label="Move list right"
                          disabled={selectedListIndex < 0 || selectedListIndex >= favoriteLists.length - 1}
                          onClick={() => {
                            setListActionsOpen(false);
                            void moveFavoriteList(1);
                          }}
                        />
                        <FavoriteListAction
                          icon={<Trash2 className="h-4 w-4" />}
                          label="Delete list"
                          destructive
                          onClick={() => {
                            setListActionsOpen(false);
                            setDeleteListTarget(selectedList);
                          }}
                        />
                      </>
                    )}
                  </div>
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
                  <span className="text-[11px] tabular-nums opacity-65">
                    {tab.value === "all" ? favoriteTotal : (statusCounts[tab.value] ?? 0)}
                  </span>
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
            pageSizeControlClassName="hidden lg:block"
            compactMobile
            refreshing={isLoading && hasWorksSnapshot}
            refreshingLabel="Refreshing favorites"
            onPageChange={setPage}
            onPageSizeChange={(value) => changePageSize(value as PageSize)}
            leadingControls={
              <>
                <div className="lg:hidden">
                  <FavoriteMobileOptions
                    availability={availabilityFilter}
                    sources={fileSources}
                    selectedSourceIDs={sourceIDs}
                    sourcesLoading={areFileSourcesLoading}
                    sort={sort}
                    direction={sortDirection}
                    pageSize={pageSize}
                    mobileColumns={mobileColumns}
                    selectionMode={selectionMode}
                    hasActiveFilters={Boolean(hasActiveFilters)}
                    sortDisabled={isLoading}
                    onAvailabilityChange={changeAvailabilityFilter}
                    onSourceIDsChange={changeSourceIDs}
                    onSortChange={changeFavoriteSort}
                    onDirectionChange={changeFavoriteSortDirection}
                    onReshuffle={reshuffleFavorites}
                    onPageSizeChange={changePageSize}
                    onMobileColumnsChange={setMobileColumns}
                    onToggleSelection={toggleSelectionMode}
                    onClearFilters={clearFilters}
                  />
                </div>
                <div className="hidden items-center gap-2 lg:flex">
                  <select
                    className="h-8 rounded-md border bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
                    value={availabilityFilter}
                    onChange={(event) => changeAvailabilityFilter(event.target.value as AvailabilityFilter)}
                    aria-label="Availability filter"
                  >
                    {availabilityFilters.map((filter) => (
                      <option key={filter.value} value={filter.value}>
                        {filter.label}
                      </option>
                    ))}
                  </select>
                  <FavoriteSourceFilter
                    sources={fileSources}
                    selectedSourceIDs={sourceIDs}
                    loading={areFileSourcesLoading}
                    onChange={changeSourceIDs}
                  />
                  {hasActiveFilters && (
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8"
                      onClick={clearFilters}
                      aria-label="Clear favorite filters"
                      title="Clear favorite filters"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                  <Button
                    variant={selectionMode ? "default" : "outline"}
                    size="sm"
                    className="h-8"
                    onClick={toggleSelectionMode}
                  >
                    Select
                  </Button>
                  <WorkCollectionLayoutPicker
                    mobileColumns={mobileColumns}
                    desktopColumns={desktopColumns}
                    onMobileColumnsChange={setMobileColumns}
                    onDesktopColumnsChange={setDesktopColumns}
                  />
                  <FavoriteSortControls
                    value={sort}
                    direction={sortDirection}
                    disabled={isLoading}
                    onChange={changeFavoriteSort}
                    onDirectionChange={changeFavoriteSortDirection}
                    onReshuffle={reshuffleFavorites}
                  />
                </div>
              </>
            }
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
                <Button variant="outline" size="sm" onClick={() => togglePagedSelection(true)}>
                  Select page
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSelectedWorkIDs(new Set());
                    setSelectionMode(false);
                  }}
                >
                  Cancel
                </Button>
                <div className="relative">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={selectedWorks.length === 0 || isBulkUpdating}
                    onClick={() => setListDialogTarget((target) => (target ? null : { mode: "bulk" }))}
                  >
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

          {hasWorksSnapshot && worksLoadError && (
            <FavoriteLoadError
              message={worksLoadError}
              compact
              onRetry={() => setWorksReloadToken((value) => value + 1)}
            />
          )}
          {!hasWorksSnapshot ? (
            worksLoadError ? (
              <FavoriteLoadError message={worksLoadError} onRetry={() => setWorksReloadToken((value) => value + 1)} />
            ) : (
              <WorkCollectionLoadingState
                label="Loading favorite works"
                mobileColumns={mobileColumns}
                desktopColumns={desktopColumns}
              />
            )
          ) : works.length > 0 ? (
            <>
              <div
                className={workCollectionClassName()}
                style={workCollectionStyle(mobileColumns, desktopColumns)}
                aria-busy={isLoading}
              >
                {works.map((work) => (
                  <div key={work.id} data-favorite-work-id={work.id} tabIndex={-1} className="outline-none">
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

function FavoriteEntityTab({
  active,
  icon: Icon,
  label,
  count,
  onClick,
}: {
  active: boolean;
  icon: typeof Heart;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      className={`relative inline-flex h-11 shrink-0 items-center gap-2 px-1 text-sm font-medium transition-colors ${active ? "text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary" : "text-muted-foreground hover:text-foreground"}`}
      onClick={onClick}
      role="tab"
      aria-selected={active}
    >
      <Icon className="h-4 w-4" />
      {label}
      <span
        className={`rounded-full px-1.5 py-0.5 text-[11px] tabular-nums ${active ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}
      >
        {count}
      </span>
    </button>
  );
}

function FavoriteEntitySection({
  kind,
  query,
  isLoading,
  hasSnapshot,
  loadError,
  circles,
  voices,
  onRetry,
  onCircleChange,
  onVoiceChange,
}: {
  kind: Exclude<FavoriteEntity, "works">;
  query: string;
  isLoading: boolean;
  hasSnapshot: boolean;
  loadError: string;
  circles: CircleSummary[];
  voices: VoiceSummary[];
  onRetry: () => void;
  onCircleChange: (circle: CircleSummary) => void;
  onVoiceChange: (voice: VoiceSummary) => void;
}) {
  const needle = query.trim().toLowerCase();
  const filteredCircles = circles.filter(
    (circle) =>
      !needle ||
      [circle.externalId, circle.displayName, ...circle.userTags.map((tag) => tag.name)].some((value) =>
        value.toLowerCase().includes(needle),
      ),
  );
  const filteredVoices = voices.filter(
    (voice) =>
      !needle ||
      [voice.displayName, String(voice.personId), ...voice.aliases, ...voice.userTags.map((tag) => tag.name)].some(
        (value) => value.toLowerCase().includes(needle),
      ),
  );
  const items = kind === "circles" ? filteredCircles : filteredVoices;

  if (!hasSnapshot) {
    return loadError ? (
      <FavoriteLoadError message={loadError} onRetry={onRetry} />
    ) : (
      <CreatorCollectionSkeleton label={`Loading favorite ${kind === "circles" ? "circles" : "voice actors"}`} />
    );
  }
  if (items.length === 0) {
    return (
      <Card className={creatorCardMinHeightClassName} aria-busy={isLoading}>
        <CardContent
          className={`grid ${creatorCardMinHeightClassName} place-items-center p-5 text-sm text-muted-foreground`}
        >
          No favorite {kind === "circles" ? "circles" : "voice actors"} match this view.
        </CardContent>
      </Card>
    );
  }
  return (
    <div
      className={creatorCollectionClassName}
      role="region"
      aria-label={`Favorite ${kind === "circles" ? "circle" : "voice actor"} results`}
      aria-busy={isLoading}
    >
      {kind === "circles"
        ? filteredCircles.map((circle) => (
            <FavoriteCircleCard key={circle.externalId} circle={circle} onChange={onCircleChange} />
          ))
        : filteredVoices.map((voice) => (
            <FavoriteVoiceCard key={voice.personId} voice={voice} onChange={onVoiceChange} />
          ))}
    </div>
  );
}

function FavoriteCircleCard({
  circle,
  onChange,
}: {
  circle: CircleSummary;
  onChange: (circle: CircleSummary) => void;
}) {
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
  return (
    <CreatorCard
      name={circle.displayName}
      identityLabel={circle.externalId}
      aliases={circle.aliases}
      showAliases={false}
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
    />
  );
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
  return (
    <CreatorCard
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
    />
  );
}

function FavoriteSkeletonLine({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className}`} />;
}

function FavoriteListTab({
  active,
  label,
  count,
  title,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`inline-flex h-11 shrink-0 items-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors md:h-9 ${active ? "bg-primary text-primary-foreground" : "bg-card hover:bg-muted"}`}
      aria-pressed={active}
      title={title ?? label}
      onClick={onClick}
    >
      <ListMusic className="h-4 w-4" />
      <span className="max-w-48 truncate">{label}</span>
      <span className="text-xs tabular-nums opacity-80">{count}</span>
    </button>
  );
}

function FavoriteListTabSkeletons() {
  return (
    <>
      {Array.from({ length: 4 }, (_, index) => (
        <FavoriteSkeletonLine key={index} className="h-11 w-28 shrink-0 md:h-9" />
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
      role="menuitem"
      className={`flex min-h-11 w-full items-center gap-2 rounded-md px-3 py-2 text-left disabled:cursor-not-allowed disabled:opacity-45 ${destructive ? "text-destructive hover:bg-destructive/10" : "hover:bg-muted"}`}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function FavoriteLoadError({
  message,
  compact = false,
  onRetry,
}: {
  message: string;
  compact?: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      className={`${compact ? "flex min-h-12 items-center justify-between gap-3 px-3 py-2" : "grid min-h-40 place-items-center px-4 py-8 text-center"} rounded-lg border border-destructive/30 bg-destructive/5`}
      role="alert"
    >
      <p className="text-sm text-destructive">{message}</p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Retry
      </Button>
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
      onSeriesOpen={
        work.seriesTitleId && work.circleExternalId
          ? () => openCircleSeriesRoute(work.circleExternalId, work.seriesTitleId)
          : undefined
      }
      footer={
        <WorkCardFooter
          left={<WorkCardDLsiteAction href={work.dlsiteUrl} />}
          right={
            <>
              <WorkCardListButton
                workId={work.id}
                active={work.favorite}
                disabled={isListSaving}
                onSaved={() => void onListsChanged()}
              />
              <WorkCardQuickMarkButton
                value={work.listeningStatus}
                onChange={(status) => void onStatusChange(work.id, status)}
              />
            </>
          }
        />
      }
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
        {progress.completed
          ? "Finished"
          : `Resume ${progress.title || "track"} at ${formatTime(progress.positionSeconds)}`}
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
    ratingCount: work.ratingCount,
    sales: work.sales,
    regularPrice: work.regularPrice,
    price: work.price,
    priceCurrency: work.priceCurrency,
    series: work.series || null,
    hasAvailableNonOriginEdition: work.hasAvailableNonOriginEdition,
    dlsiteTags: [
      {
        key: `status:${work.listeningStatus}`,
        label: listeningStatusLabel(work.listeningStatus),
        variant: "secondary",
      },
      ...dlsiteTagBadges(work.tags),
    ],
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
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const label = favoriteSortOptions.find((option) => option.value === value)?.label ?? "Sort";
  const directionTitle = value === "random" ? "Reshuffle" : direction === "asc" ? "Ascending" : "Descending";
  return (
    <div className="relative" ref={anchorRef}>
      <div className="inline-flex h-8 shrink-0 items-center rounded-md border bg-background">
        <button
          type="button"
          className="inline-flex h-7 min-w-0 max-w-40 items-center gap-1.5 rounded-l-md px-2 text-xs text-foreground hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
          aria-label={`Sort favorite works: ${label}`}
          title={`Sort favorite works: ${label}`}
        >
          <ArrowUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{label}</span>
        </button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-8 rounded-l-none border-l"
          disabled={disabled}
          onClick={() => (value === "random" ? onReshuffle() : onDirectionChange(direction === "asc" ? "desc" : "asc"))}
          aria-label={directionTitle}
          title={directionTitle}
        >
          {value === "random" ? (
            <RefreshCw className="h-4 w-4" />
          ) : direction === "asc" ? (
            <ArrowDownAZ className="h-4 w-4" />
          ) : (
            <ArrowDownZA className="h-4 w-4" />
          )}
        </Button>
      </div>
      <AnchoredPopover
        open={open && !disabled}
        anchorRef={anchorRef}
        onOpenChange={setOpen}
        className="w-[min(12rem,calc(100vw-1.5rem))] p-1 text-sm"
      >
        <div role="menu" aria-label="Favorite sort options">
          {favoriteSortOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={value === option.value}
              className={`flex min-h-10 w-full items-center rounded-md px-3 py-2 text-left hover:bg-muted ${value === option.value ? "bg-primary/10 font-medium text-primary ring-1 ring-inset ring-primary/15" : "text-muted-foreground"}`}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      </AnchoredPopover>
    </div>
  );
}

function FavoriteSourceFilter({
  sources,
  selectedSourceIDs,
  loading,
  onChange,
}: {
  sources: LibrarySource[];
  selectedSourceIDs: number[];
  loading: boolean;
  onChange: (sourceIDs: number[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const label = loading
    ? "Loading sources"
    : sources.length === 0
      ? "No sources"
      : favoriteSourceFilterLabel(sources, selectedSourceIDs);
  const disabled = loading || sources.length === 0;
  return (
    <div className="relative" ref={anchorRef}>
      <Button
        variant="outline"
        size="sm"
        className={`h-8 max-w-44 ${selectedSourceIDs.length > 0 ? "border-primary/30 bg-primary/10 text-primary" : ""}`}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        aria-label={`Source filter: ${label}`}
        title={`Source filter: ${label}`}
      >
        <Cloud className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </Button>
      <AnchoredPopover
        open={open && !disabled}
        anchorRef={anchorRef}
        onOpenChange={setOpen}
        align="start"
        className="w-[min(17rem,calc(100vw-1.5rem))] p-1 text-sm"
      >
        <div role="menu" aria-label="Source filters">
          <div className="px-3 py-2 text-xs font-semibold text-foreground">Sources</div>
          <FavoriteSourceOptions sources={sources} selectedSourceIDs={selectedSourceIDs} onChange={onChange} />
        </div>
      </AnchoredPopover>
    </div>
  );
}

function FavoriteSourceOptions({
  sources,
  selectedSourceIDs,
  onChange,
}: {
  sources: LibrarySource[];
  selectedSourceIDs: number[];
  onChange: (sourceIDs: number[]) => void;
}) {
  const selected = new Set(selectedSourceIDs);
  const toggleSource = (sourceID: number) => {
    if (selectedSourceIDs.length === 0) {
      onChange([sourceID]);
      return;
    }
    const next = selected.has(sourceID)
      ? selectedSourceIDs.filter((candidate) => candidate !== sourceID)
      : [...selectedSourceIDs, sourceID];
    onChange(next);
  };
  return (
    <>
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={selectedSourceIDs.length === 0}
        className={`flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-muted ${selectedSourceIDs.length === 0 ? "bg-primary/10 font-medium text-primary ring-1 ring-inset ring-primary/15" : "text-muted-foreground"}`}
        onClick={() => onChange([])}
      >
        <Check className={`h-4 w-4 shrink-0 ${selectedSourceIDs.length === 0 ? "opacity-100" : "opacity-0"}`} />
        <span className="text-foreground">All sources</span>
      </button>
      <div className="my-1 border-t" role="separator" />
      {sources.map((source) => {
        const checked = selected.has(source.id);
        return (
          <button
            key={source.id}
            type="button"
            role="menuitemcheckbox"
            aria-checked={checked}
            className={`flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-muted ${checked ? "bg-primary/10 font-medium text-primary ring-1 ring-inset ring-primary/15" : "text-muted-foreground"}`}
            onClick={() => toggleSource(source.id)}
          >
            <Check className={`h-4 w-4 shrink-0 ${checked ? "opacity-100" : "opacity-0"}`} />
            <Cloud className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-foreground">{source.displayName || source.code}</span>
            {!source.enabled && <span className="text-[11px] text-muted-foreground">Disabled</span>}
          </button>
        );
      })}
    </>
  );
}

function favoriteSourceFilterLabel(sources: LibrarySource[], selectedSourceIDs: number[]) {
  if (selectedSourceIDs.length === 0) return "All sources";
  if (selectedSourceIDs.length > 1) return `${selectedSourceIDs.length} sources`;
  const selected = sources.find((source) => source.id === selectedSourceIDs[0]);
  return selected?.displayName || selected?.code || "1 source";
}

type FavoriteMobilePanel = "root" | "availability" | "sources" | "sort" | "columns" | "page-size";

function FavoriteMobileOptions({
  availability,
  sources,
  selectedSourceIDs,
  sourcesLoading,
  sort,
  direction,
  pageSize,
  mobileColumns,
  selectionMode,
  hasActiveFilters,
  sortDisabled,
  onAvailabilityChange,
  onSourceIDsChange,
  onSortChange,
  onDirectionChange,
  onReshuffle,
  onPageSizeChange,
  onMobileColumnsChange,
  onToggleSelection,
  onClearFilters,
}: {
  availability: AvailabilityFilter;
  sources: LibrarySource[];
  selectedSourceIDs: number[];
  sourcesLoading: boolean;
  sort: FavoriteSort;
  direction: SortDirection;
  pageSize: PageSize;
  mobileColumns: WorkCollectionColumnSetting;
  selectionMode: boolean;
  hasActiveFilters: boolean;
  sortDisabled: boolean;
  onAvailabilityChange: (value: AvailabilityFilter) => void;
  onSourceIDsChange: (sourceIDs: number[]) => void;
  onSortChange: (value: FavoriteSort) => void;
  onDirectionChange: (value: SortDirection) => void;
  onReshuffle: () => void;
  onPageSizeChange: (value: PageSize) => void;
  onMobileColumnsChange: (value: WorkCollectionColumnSetting) => void;
  onToggleSelection: () => void;
  onClearFilters: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<FavoriteMobilePanel>("root");
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const availabilityLabel =
    availabilityFilters.find((option) => option.value === availability)?.label ?? "Any availability";
  const sourceLabel = sourcesLoading
    ? "Loading"
    : sources.length === 0
      ? "None configured"
      : favoriteSourceFilterLabel(sources, selectedSourceIDs);
  const sortLabel = favoriteSortOptions.find((option) => option.value === sort)?.label ?? "Sort";
  const directionLabel = sort === "random" ? "Reshuffle" : direction === "asc" ? "Ascending" : "Descending";
  const columnsLabel = mobileColumns === "auto" ? "Auto" : String(mobileColumns);

  const close = () => {
    setOpen(false);
    setPanel("root");
  };
  const runAndClose = (action: () => void) => {
    action();
    close();
  };
  const setPopoverOpen = (value: boolean) => {
    setOpen(value);
    if (!value) setPanel("root");
  };

  return (
    <div className="relative" ref={anchorRef}>
      <Button
        variant="outline"
        size="icon"
        className="relative h-11 w-11"
        onClick={() => setPopoverOpen(!open)}
        aria-label="More favorite options"
        title="More favorite options"
        data-favorite-sort={sort}
      >
        <SlidersHorizontal className="h-4 w-4" />
        {(hasActiveFilters || selectionMode) && (
          <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-primary" />
        )}
      </Button>
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        onOpenChange={setPopoverOpen}
        className="w-[min(19rem,calc(100vw-1.5rem))] p-1 text-sm"
      >
        {panel === "root" ? (
          <div role="menu" aria-label="More favorite options">
            <div className="px-3 py-2 text-xs font-semibold text-foreground">More options</div>
            <FavoriteMobileMenuRow
              icon={<Filter className="h-4 w-4" />}
              label="Availability"
              value={availabilityLabel}
              onClick={() => setPanel("availability")}
            />
            <FavoriteMobileMenuRow
              icon={<Cloud className="h-4 w-4" />}
              label="Sources"
              value={sourceLabel}
              disabled={sourcesLoading || sources.length === 0}
              onClick={() => setPanel("sources")}
            />
            <FavoriteMobileMenuRow
              icon={<ArrowUpDown className="h-4 w-4" />}
              label="Sort"
              value={sortLabel}
              disabled={sortDisabled}
              onClick={() => setPanel("sort")}
            />
            <FavoriteMobileMenuRow
              icon={
                sort === "random" ? (
                  <RefreshCw className="h-4 w-4" />
                ) : direction === "asc" ? (
                  <ArrowDownAZ className="h-4 w-4" />
                ) : (
                  <ArrowDownZA className="h-4 w-4" />
                )
              }
              label={sort === "random" ? "Shuffle" : "Sort direction"}
              value={directionLabel}
              disabled={sortDisabled}
              trailing={false}
              onClick={() =>
                runAndClose(
                  sort === "random" ? onReshuffle : () => onDirectionChange(direction === "asc" ? "desc" : "asc"),
                )
              }
            />
            <FavoriteMobileMenuRow
              icon={<Columns3 className="h-4 w-4" />}
              label="Columns"
              value={columnsLabel}
              onClick={() => setPanel("columns")}
            />
            <FavoriteMobileMenuRow
              icon={<ListMusic className="h-4 w-4" />}
              label="Per page"
              value={String(pageSize)}
              onClick={() => setPanel("page-size")}
            />
            <FavoriteMobileMenuRow
              icon={<ListChecks className="h-4 w-4" />}
              label="Selection mode"
              value={selectionMode ? "On" : "Off"}
              trailing={false}
              onClick={() => runAndClose(onToggleSelection)}
            />
            {hasActiveFilters && (
              <FavoriteMobileMenuRow
                icon={<X className="h-4 w-4" />}
                label="Clear filters"
                value=""
                trailing={false}
                onClick={() => runAndClose(onClearFilters)}
              />
            )}
          </div>
        ) : panel === "sources" ? (
          <FavoriteMobileSourcePanel
            sources={sources}
            selectedSourceIDs={selectedSourceIDs}
            onBack={() => setPanel("root")}
            onChange={onSourceIDsChange}
          />
        ) : (
          <FavoriteMobileOptionPanel
            panel={panel}
            availability={availability}
            sort={sort}
            pageSize={pageSize}
            mobileColumns={mobileColumns}
            onBack={() => setPanel("root")}
            onAvailabilityChange={(value) => runAndClose(() => onAvailabilityChange(value))}
            onSortChange={(value) => runAndClose(() => onSortChange(value))}
            onPageSizeChange={(value) => runAndClose(() => onPageSizeChange(value))}
            onMobileColumnsChange={(value) => runAndClose(() => onMobileColumnsChange(value))}
          />
        )}
      </AnchoredPopover>
    </div>
  );
}

function FavoriteMobileMenuRow({
  icon,
  label,
  value,
  trailing = true,
  disabled = false,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  trailing?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-2 text-left text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
      disabled={disabled}
      onClick={onClick}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 text-foreground">{label}</span>
      {value && <span className="max-w-28 truncate text-xs">{value}</span>}
      {trailing && <ChevronRight className="h-4 w-4 shrink-0" />}
    </button>
  );
}

function FavoriteMobileSourcePanel({
  sources,
  selectedSourceIDs,
  onBack,
  onChange,
}: {
  sources: LibrarySource[];
  selectedSourceIDs: number[];
  onBack: () => void;
  onChange: (sourceIDs: number[]) => void;
}) {
  return (
    <div role="menu" aria-label="Source options">
      <div className="flex min-h-10 items-center gap-2 px-1">
        <button
          type="button"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onBack}
          aria-label="Back to more options"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="text-xs font-semibold text-foreground">Sources</span>
      </div>
      <FavoriteSourceOptions sources={sources} selectedSourceIDs={selectedSourceIDs} onChange={onChange} />
    </div>
  );
}

function FavoriteMobileOptionPanel({
  panel,
  availability,
  sort,
  pageSize,
  mobileColumns,
  onBack,
  onAvailabilityChange,
  onSortChange,
  onPageSizeChange,
  onMobileColumnsChange,
}: {
  panel: Exclude<FavoriteMobilePanel, "root" | "sources">;
  availability: AvailabilityFilter;
  sort: FavoriteSort;
  pageSize: PageSize;
  mobileColumns: WorkCollectionColumnSetting;
  onBack: () => void;
  onAvailabilityChange: (value: AvailabilityFilter) => void;
  onSortChange: (value: FavoriteSort) => void;
  onPageSizeChange: (value: PageSize) => void;
  onMobileColumnsChange: (value: WorkCollectionColumnSetting) => void;
}) {
  const title =
    panel === "availability"
      ? "Availability"
      : panel === "sort"
        ? "Sort"
        : panel === "columns"
          ? "Columns"
          : "Per page";
  const options =
    panel === "availability"
      ? availabilityFilters.map((option) => ({
          key: option.value,
          label: option.label,
          selected: option.value === availability,
          select: () => onAvailabilityChange(option.value),
        }))
      : panel === "sort"
        ? favoriteSortOptions.map((option) => ({
            key: option.value,
            label: option.label,
            selected: option.value === sort,
            select: () => onSortChange(option.value),
          }))
        : panel === "columns"
          ? (["auto", 1, 2] as const).map((option) => ({
              key: String(option),
              label: option === "auto" ? "Automatic" : `${option} ${option === 1 ? "column" : "columns"}`,
              selected: option === mobileColumns,
              select: () => onMobileColumnsChange(option),
            }))
          : pageSizeOptions.map((option) => ({
              key: String(option),
              label: `${option} per page`,
              selected: option === pageSize,
              select: () => onPageSizeChange(option),
            }));
  return (
    <div role="menu" aria-label={`${title} options`}>
      <div className="flex min-h-10 items-center gap-2 px-1">
        <button
          type="button"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onBack}
          aria-label="Back to more options"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="text-xs font-semibold text-foreground">{title}</span>
      </div>
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          role="menuitemradio"
          aria-checked={option.selected}
          className={`flex min-h-10 w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-muted ${option.selected ? "bg-primary/10 font-medium text-primary ring-1 ring-inset ring-primary/15" : "text-muted-foreground"}`}
          onClick={option.select}
        >
          <Check className={`h-4 w-4 shrink-0 ${option.selected ? "opacity-100" : "opacity-0"}`} />
          {option.label}
        </button>
      ))}
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
          {hasFilters
            ? "The current filters do not match any favorite works."
            : "Add favorite works from Library or Work Detail to build your collection."}
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
          {error && (
            <div className="rounded-md border bg-background px-3 py-2 text-xs text-muted-foreground">{error}</div>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
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
      <div
        className="w-full max-w-sm rounded-lg border bg-card p-4 shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h3 className="text-base font-semibold">Delete list</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Delete "{list.name}"? Works stay in the library, but this list membership is removed.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
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
    api
      .getWorkFavoriteLists(work.id)
      .then((lists) => {
        if (!cancelled) setSelectedIDs(new Set(lists.filter((list) => list.selected).map((list) => list.id)));
      })
      .catch((nextError) => {
        if (!cancelled)
          setError(nextError instanceof Error ? nextError.message : "Favorite lists could not be loaded.");
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
          <div className="rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">
            Loading lists...
          </div>
        ) : favoriteLists.length > 0 ? (
          favoriteLists.map((list) => (
            <div
              key={list.id}
              className={`flex min-h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm hover:bg-muted ${selectedIDs.has(list.id) ? "border-primary/30 bg-primary/10" : "bg-background"}`}
              onClick={() => toggleList(list.id, !selectedIDs.has(list.id))}
            >
              <Checkbox
                checked={selectedIDs.has(list.id)}
                onCheckedChange={(checked) => toggleList(list.id, checked)}
                onClick={(event) => event.stopPropagation()}
                aria-label={`${selectedIDs.has(list.id) ? "Remove from" : "Add to"} ${list.name}`}
              />
              <span className="min-w-0 flex-1 truncate">{list.name}</span>
            </div>
          ))
        ) : (
          <div className="rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">
            No favorite lists yet.
          </div>
        )}
        {error && (
          <div className="rounded-md border bg-background px-3 py-2 text-xs text-muted-foreground">{error}</div>
        )}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
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

function readFavoritesEntryState(storageScope: string): FavoritesEntryState {
  const value = window.history.state;
  if (!value || typeof value !== "object") return {};
  const state = value as FavoritesEntryState;
  if (state.favoritesBrowseScope !== storageScope) return {};
  const browseState = favoritesBrowseStateFromValue(state.favoritesBrowseState, defaultFavoritesBrowseState);
  const selection = state.favoritesSelection;
  const anchor = state.favoritesAnchor;
  return {
    favoritesBrowseState: state.favoritesBrowseState ? browseState : undefined,
    favoritesSelection:
      selection && Array.isArray(selection.workIDs)
        ? {
            active: Boolean(selection.active),
            workIDs: selection.workIDs.filter((id) => Number.isInteger(id) && id > 0),
          }
        : undefined,
    favoritesAnchor:
      anchor && Number.isInteger(anchor.workID) && anchor.workID > 0 && Number.isFinite(anchor.viewportOffset)
        ? { workID: anchor.workID, viewportOffset: anchor.viewportOffset }
        : undefined,
  };
}
