import {
  Album,
  ArrowDownAZ,
  ArrowDownZA,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronDown,
  Cloud,
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
import { BrowseLoadingIndicator } from "@/components/collection/BrowseLoadingIndicator";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { PageSizePicker } from "@/components/collection/PageSizePicker";
import { toastFromError, useToast } from "@/components/ui/toast";
import { useAuth } from "@/auth/AuthProvider";
import { NAVIGATION_EVENT, historyStateWithReturn } from "@/lib/browserHistory";
import { dismissKeyboardOnEnter } from "@/lib/keyboard";
import { hasPlaybackHistory } from "@/lib/playbackHistory";
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
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";

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
  { value: "all", label: "Any available" },
  { value: "local", label: "Local" },
  { value: "cache", label: "Cached" },
  { value: "remote", label: "Remote" },
  { value: "missing", label: "Missing" },
] as const;

const pageSizeOptions = [24, 48] as const;
const favoriteSortOptions: { value: FavoriteSort; label: string }[] = [
  { value: "activity", label: "Favorite activity" },
  { value: "added", label: "Marked or added" },
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

export function FavoritesPage({ active = true }: { active?: boolean }) {
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
  const [isDeletingList, setIsDeletingList] = useState(false);
  const [listManagerOpen, setListManagerOpen] = useState(false);
  const [listActionsOpen, setListActionsOpen] = useState(false);
  const listActionsRef = useRef<HTMLDivElement | null>(null);
  const requestSeq = useRef(0);
  const mobileNavigationLayout = useMobileNavigationLayout();

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
        setSourceIDs((current) => {
          const available = current.filter((sourceID) => availableSourceIDs.has(sourceID));
          return available.length === current.length ? current : available;
        });
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
    if (favoriteEntity !== "works") {
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
        query,
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
    favoriteEntity,
    page,
    pageSize,
    query,
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
    if (!active || window.location.pathname !== "/favorites") return;
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
    active,
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
      ? Boolean(query.trim()) ||
        statusFilter !== "all" ||
        availabilityFilter !== "all" ||
        sourceIDs.length > 0 ||
        activeList !== "all"
      : Boolean(query.trim());
  const markedList = favoriteLists.find((list) => list.kind === "marked") ?? null;
  const userFavoriteLists = favoriteLists.filter((list) => list.kind !== "marked");
  const selectedList = activeList === "all" ? null : (userFavoriteLists.find((list) => list.id === activeList) ?? null);
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
    setWorksReloadToken((value) => value + 1);
  };

  const clearFilters = () => {
    setQuery("");
    setStatusFilter("all");
    setAvailabilityFilter("all");
    setSourceIDs([]);
    setActiveList("all");
    setPage(1);
  };

  const changeResourceSelection = ({ availability, sourceIDs }: FavoriteResourceSelection) => {
    setAvailabilityFilter(availability);
    setSourceIDs(sourceIDs);
    setPage(1);
  };

  const changeFavoriteEntity = (value: FavoriteEntity) => {
    setFavoriteEntity(value);
    setQuery("");
    setPage(1);
  };

  const changeFavoriteQuery = (value: string) => {
    setQuery(value);
    if (favoriteEntity === "works") setPage(1);
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
      query,
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

  const openFavoriteListManager = () => {
    setListEditor(null);
    setDeleteListTarget(null);
    setListManagerOpen(true);
  };

  const closeFavoriteListManager = () => {
    if (isDeletingList) return;
    setListManagerOpen(false);
    setListEditor(null);
    setDeleteListTarget(null);
  };

  const deleteFavoriteList = async () => {
    if (!deleteListTarget || isDeletingList) return;
    const deletingList = deleteListTarget;
    setIsDeletingList(true);
    try {
      await api.deleteFavoriteList(deletingList.id);
      setDeleteListTarget(null);
      if (activeList === deletingList.id) setActiveList("all");
      await reloadFavoriteLists();
      toast.success("Favorite list deleted.");
    } catch (error) {
      toast.notify(toastFromError(error, "Favorite list could not be deleted."));
    } finally {
      setIsDeletingList(false);
    }
  };

  const moveFavoriteListByID = async (listID: number, direction: -1 | 1) => {
    const targetIndex = userFavoriteLists.findIndex((list) => list.id === listID);
    if (targetIndex < 0) return;
    const nextIndex = targetIndex + direction;
    if (nextIndex < 0 || nextIndex >= userFavoriteLists.length) return;
    const reordered = [...userFavoriteLists];
    const [moving] = reordered.splice(targetIndex, 1);
    reordered.splice(nextIndex, 0, moving);
    const previousLists = favoriteLists;
    setFavoriteLists((lists) =>
      lists.map((list) => {
        const nextIndex = reordered.findIndex((item) => item.id === list.id);
        return nextIndex >= 0 ? { ...list, sortOrder: nextIndex } : list;
      }),
    );
    try {
      await Promise.all(reordered.map((list, index) => api.updateFavoriteList(list.id, { sortOrder: index })));
      await reloadFavoriteLists();
      setActiveList(listID);
      toast.success("Favorite list reordered.");
    } catch (error) {
      setFavoriteLists(previousLists);
      toast.notify(toastFromError(error, "Favorite lists could not be reordered."));
    }
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
    <section className="relative space-y-5">
      <div
        hidden={mobileNavigationLayout}
        className={`${mobileNavigationLayout ? "hidden" : "flex"} flex-col space-y-3`}
        data-toast-avoid
      >
        <div className="flex items-center gap-3">
          <FavoriteEntityPicker value={favoriteEntity} onChange={changeFavoriteEntity} />
          <FavoriteSearchInput
            value={query}
            placeholder={
              favoriteEntity === "works"
                ? "Search title, code, circle, tag, or creator"
                : favoriteEntity === "circles"
                  ? "Search circles"
                  : "Search voice actors"
            }
            onChange={changeFavoriteQuery}
          />
          {favoriteEntity === "works" && (
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <FavoriteResourceFilter
                availability={availabilityFilter}
                sources={fileSources}
                selectedSourceIDs={sourceIDs}
                loading={areFileSourcesLoading}
                onChange={changeResourceSelection}
              />
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
                compact
                onChange={changeFavoriteSort}
                onDirectionChange={changeFavoriteSortDirection}
                onReshuffle={reshuffleFavorites}
              />
              <PageSizePicker
                value={pageSize}
                options={pageSizeOptions}
                onChange={(value) => changePageSize(value as PageSize)}
              />
            </div>
          )}
        </div>
        {favoriteEntity === "works" && (
          <>
            <FavoriteDesktopListRow
              markedList={markedList}
              userFavoriteLists={userFavoriteLists}
              activeList={activeList}
              favoriteTotal={favoriteTotal}
              listCounts={listCounts}
              loading={areFavoriteListsLoading}
              selectionMode={selectionMode}
              onListChange={(list) => {
                setActiveList(list);
                setPage(1);
              }}
              onToggleSelection={toggleSelectionMode}
              onEditLists={openFavoriteListManager}
            />
            <FavoriteDesktopStatusFilters
              value={statusFilter}
              counts={statusCounts}
              favoriteTotal={activeList === "all" ? favoriteTotal : (listCounts[String(activeList)] ?? 0)}
              onChange={(value) => {
                setStatusFilter(value);
                setPage(1);
              }}
            />
            <WorkCollectionPagination
              placement="top"
              page={currentPage}
              pageSize={pageSize}
              totalItems={totalWorks}
              totalPages={totalPages}
              compactMobile
              compactTop
              refreshing={isLoading && hasWorksSnapshot}
              refreshingLabel="Refreshing favorites"
              onPageChange={setPage}
            />
          </>
        )}
      </div>

      <div hidden={!mobileNavigationLayout} className={mobileNavigationLayout ? "block" : "hidden"}>
        <FavoriteMobileToolbar
          favoriteEntity={favoriteEntity}
          query={query}
          worksOptions={
            favoriteEntity === "works" ? (
              <FavoriteMobileWorksControls
                availability={availabilityFilter}
                sources={fileSources}
                selectedSourceIDs={sourceIDs}
                sourcesLoading={areFileSourcesLoading}
                sort={sort}
                direction={sortDirection}
                pageSize={pageSize}
                mobileColumns={mobileColumns}
                sortDisabled={isLoading}
                onResourceChange={changeResourceSelection}
                onSortChange={changeFavoriteSort}
                onDirectionChange={changeFavoriteSortDirection}
                onReshuffle={reshuffleFavorites}
                onPageSizeChange={changePageSize}
                onMobileColumnsChange={setMobileColumns}
                desktopColumns={desktopColumns}
                onDesktopColumnsChange={setDesktopColumns}
              />
            ) : null
          }
          onEntityChange={changeFavoriteEntity}
          onQueryChange={changeFavoriteQuery}
        />
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
          <div hidden={!mobileNavigationLayout} className={mobileNavigationLayout ? "space-y-2" : "hidden"}>
            <div className="flex items-center gap-2 pb-1">
              <div
                className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain"
                role="region"
                aria-label="Favorite list tabs"
              >
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
                  {markedList && (
                    <FavoriteListTab
                      active={activeList === markedList.id}
                      label="Marked"
                      count={listCounts[String(markedList.id)] ?? 0}
                      title="Works with a quick mark"
                      onClick={() => {
                        setActiveList(markedList.id);
                        setPage(1);
                      }}
                    />
                  )}
                  {userFavoriteLists.map((list) => (
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
                  variant="ghost"
                  size="icon"
                  className="group -m-1 h-11 w-11 hover:bg-transparent lg:m-0 lg:h-8 lg:w-8"
                  disabled={areFavoriteListsLoading}
                  onClick={() => setListActionsOpen((open) => !open)}
                  aria-label="Favorite list options"
                  title="Manage favorite lists"
                >
                  <span className="grid h-9 w-9 place-items-center rounded-[var(--control-radius)] border border-input bg-card transition-colors group-hover:bg-muted lg:h-8 lg:w-8">
                    <MoreHorizontal className="h-4 w-4" />
                  </span>
                </Button>
                <AnchoredPopover
                  open={listActionsOpen}
                  anchorRef={listActionsRef}
                  onOpenChange={setListActionsOpen}
                  className="w-52 p-1 text-sm"
                >
                  <div role="menu" aria-label="Favorite list options">
                    <FavoriteListAction
                      icon={<Check className="h-4 w-4" />}
                      label={selectionMode ? "Exit selection" : "Select works"}
                      onClick={() => {
                        setListActionsOpen(false);
                        toggleSelectionMode();
                      }}
                    />
                    <FavoriteListAction
                      icon={<Pencil className="h-4 w-4" />}
                      label="Edit lists"
                      onClick={() => {
                        setListActionsOpen(false);
                        openFavoriteListManager();
                      }}
                    />
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
                    {tab.value === "all"
                      ? activeList === "all"
                        ? favoriteTotal
                        : (listCounts[String(activeList)] ?? 0)
                      : (statusCounts[tab.value] ?? 0)}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div hidden={!mobileNavigationLayout} className={mobileNavigationLayout ? "block" : "hidden"}>
            <WorkCollectionPagination
              placement="top"
              page={currentPage}
              pageSize={pageSize}
              totalItems={totalWorks}
              totalPages={totalPages}
              compactMobile
              compactTop
              refreshing={isLoading && hasWorksSnapshot}
              refreshingLabel="Refreshing favorites"
              onPageChange={setPage}
            />
          </div>

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
                      favoriteLists={userFavoriteLists}
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
                      favoriteLists={userFavoriteLists}
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
          {listManagerOpen && (
            <FavoriteListManager
              markedList={markedList}
              lists={userFavoriteLists}
              editor={listEditor}
              deleteTarget={deleteListTarget}
              deleting={isDeletingList}
              onClose={closeFavoriteListManager}
              onNew={() => setListEditor("new")}
              onEdit={setListEditor}
              onCancelEdit={() => setListEditor(null)}
              onSave={saveFavoriteList}
              onDelete={setDeleteListTarget}
              onCancelDelete={() => setDeleteListTarget(null)}
              onConfirmDelete={() => void deleteFavoriteList()}
              onMove={(listID, direction) => void moveFavoriteListByID(listID, direction)}
            />
          )}
        </>
      )}
      <BrowseLoadingIndicator
        refreshing={favoriteEntity === "works" && isLoading && hasWorksSnapshot}
        label="Refreshing favorite works"
      />
    </section>
  );
}

function FavoriteEntityPicker({
  value,
  onChange,
  compact = false,
}: {
  value: FavoriteEntity;
  onChange: (value: FavoriteEntity) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const options: { value: FavoriteEntity; label: string; icon: typeof ListMusic }[] = [
    { value: "works", label: "Works", icon: Album },
    { value: "circles", label: "Circles", icon: UsersRound },
    { value: "voices", label: "Voice Actors", icon: Mic2 },
  ];
  const selected = options.find((option) => option.value === value) ?? options[0];
  return (
    <div className="relative shrink-0" ref={anchorRef}>
      <Button
        variant="outline"
        size={compact ? "icon" : "sm"}
        className={compact ? "h-8 w-8" : "h-9 min-w-32 justify-between"}
        onClick={() => setOpen((current) => !current)}
        aria-label={`Favorite type: ${selected.label}`}
        title={`Favorite type: ${selected.label}`}
      >
        {compact ? (
          <selected.icon className="h-4 w-4" />
        ) : (
          <>
            <span className="flex items-center gap-2">
              <selected.icon className="h-4 w-4" />
              <span>{selected.label}</span>
            </span>
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          </>
        )}
      </Button>
      <AnchoredPopover open={open} anchorRef={anchorRef} onOpenChange={setOpen} className="w-44 p-1 text-sm">
        <div role="menu" aria-label="Favorite types">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={option.value === value}
              className={`flex min-h-10 w-full items-center gap-2 rounded-md px-3 py-2 text-left hover:bg-muted ${option.value === value ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground"}`}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <option.icon className="h-4 w-4" />
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      </AnchoredPopover>
    </div>
  );
}

function FavoriteMobileToolbar({
  favoriteEntity,
  query,
  worksOptions,
  onEntityChange,
  onQueryChange,
}: {
  favoriteEntity: FavoriteEntity;
  query: string;
  worksOptions: ReactNode;
  onEntityChange: (value: FavoriteEntity) => void;
  onQueryChange: (value: string) => void;
}) {
  const [searchOpen, setSearchOpen] = useState(() => Boolean(query.trim()));
  const searchAnchorRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const placeholder =
    favoriteEntity === "works"
      ? "Search title, code, circle, tag, or creator"
      : favoriteEntity === "circles"
        ? "Search circles"
        : "Search voice actors";

  useEffect(() => {
    if (query.trim()) setSearchOpen(true);
  }, [query]);

  useEffect(() => {
    if (!searchOpen) return;
    const frame = window.requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [searchOpen]);

  useEffect(() => {
    setSearchOpen(Boolean(query.trim()));
  }, [favoriteEntity]);

  return (
    <div className="flex items-center gap-2" data-toast-avoid>
      <FavoriteEntityPicker value={favoriteEntity} onChange={onEntityChange} compact />
      <div className="relative shrink-0" ref={searchAnchorRef}>
        <Button
          variant="outline"
          size="icon"
          className={`h-8 w-8 ${query.trim() ? "border-primary/30 bg-primary/10 text-primary" : ""}`}
          onClick={() => setSearchOpen((open) => !open)}
          aria-label={query.trim() ? "Edit favorite search" : "Search favorites"}
          title={query.trim() ? "Edit favorite search" : "Search favorites"}
        >
          <Search className="h-4 w-4" />
        </Button>
        <AnchoredPopover
          open={searchOpen}
          anchorRef={searchAnchorRef}
          onOpenChange={setSearchOpen}
          align="start"
          className="w-[min(22rem,calc(100vw-1.5rem))] p-2"
        >
          <div className="flex items-center gap-2">
            <label className="relative block min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                ref={searchInputRef}
                className="h-11 w-full rounded-md border bg-card pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                value={query}
                onKeyDown={dismissKeyboardOnEnter}
                onChange={(event) => onQueryChange(event.target.value)}
                placeholder={placeholder}
                aria-label={placeholder}
              />
            </label>
            {query.trim() && (
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => onQueryChange("")}
                aria-label="Clear search"
                title="Clear search"
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        </AnchoredPopover>
      </div>
      <div className="ml-auto shrink-0">{worksOptions}</div>
    </div>
  );
}

function FavoriteSearchInput({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex min-w-0 max-w-xl flex-1 items-center gap-2 rounded-lg border bg-card px-3 text-sm">
      <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
      <input
        className="min-w-0 flex-1 bg-transparent py-2 outline-none placeholder:text-muted-foreground"
        value={value}
        onKeyDown={dismissKeyboardOnEnter}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
      {value.trim() && (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => onChange("")}
          aria-label="Clear search"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </label>
  );
}

function FavoriteDesktopListRow({
  markedList,
  userFavoriteLists,
  activeList,
  favoriteTotal,
  listCounts,
  loading,
  selectionMode,
  onListChange,
  onToggleSelection,
  onEditLists,
}: {
  markedList: FavoriteList | null;
  userFavoriteLists: FavoriteList[];
  activeList: "all" | number;
  favoriteTotal: number;
  listCounts: Record<string, number>;
  loading: boolean;
  selectionMode: boolean;
  onListChange: (list: "all" | number) => void;
  onToggleSelection: () => void;
  onEditLists: () => void;
}) {
  return (
    <div className="flex items-center gap-2" aria-label="Favorite lists">
      <div className="min-w-0 flex-1 overflow-x-auto">
        <div className="flex w-max min-w-full gap-2">
          {loading ? (
            <FavoriteListTabSkeletons />
          ) : (
            <FavoriteListTab
              active={activeList === "all"}
              label="All Favorites"
              count={favoriteTotal}
              onClick={() => onListChange("all")}
            />
          )}
          {markedList && (
            <FavoriteListTab
              active={activeList === markedList.id}
              label="Marked"
              count={listCounts[String(markedList.id)] ?? 0}
              onClick={() => onListChange(markedList.id)}
            />
          )}
          {userFavoriteLists.map((list) => (
            <FavoriteListTab
              key={list.id}
              active={activeList === list.id}
              label={list.name}
              count={listCounts[String(list.id)] ?? 0}
              title={list.description || list.name}
              onClick={() => onListChange(list.id)}
            />
          ))}
        </div>
      </div>
      <FavoriteDesktopListActions
        selectionMode={selectionMode}
        onToggleSelection={onToggleSelection}
        onEditLists={onEditLists}
      />
    </div>
  );
}

function FavoriteDesktopListActions({
  selectionMode,
  onToggleSelection,
  onEditLists,
}: {
  selectionMode: boolean;
  onToggleSelection: () => void;
  onEditLists: () => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const close = () => setOpen(false);
  return (
    <div className="relative shrink-0" ref={anchorRef}>
      <Button
        variant="outline"
        size="icon"
        className="h-8 w-8"
        onClick={() => setOpen((current) => !current)}
        aria-label="Favorite list options"
        title="Favorite list options"
      >
        <MoreHorizontal className="h-4 w-4" />
      </Button>
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        onOpenChange={setOpen}
        align="end"
        className="w-52 p-1 text-sm"
      >
        <div role="menu" aria-label="Favorite list options">
          <FavoriteListAction
            icon={<Check className="h-4 w-4" />}
            label={selectionMode ? "Exit selection" : "Select works"}
            onClick={() => {
              close();
              onToggleSelection();
            }}
          />
          <FavoriteListAction
            icon={<Pencil className="h-4 w-4" />}
            label="Edit lists"
            onClick={() => {
              close();
              onEditLists();
            }}
          />
        </div>
      </AnchoredPopover>
    </div>
  );
}

function FavoriteDesktopStatusFilters({
  value,
  counts,
  favoriteTotal,
  onChange,
}: {
  value: ListeningStatus | "all";
  counts: Record<string, number>;
  favoriteTotal: number;
  onChange: (value: ListeningStatus | "all") => void;
}) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto pb-1" aria-label="Listening status filters">
      <span className="mr-1 inline-flex h-7 shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground">
        <Filter className="h-3 w-3" />
        Status
      </span>
      {statusTabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium ${value === tab.value ? "bg-primary/10 text-primary ring-1 ring-inset ring-primary/20" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
          onClick={() => onChange(tab.value)}
          aria-pressed={value === tab.value}
        >
          <tab.icon className="h-3 w-3" />
          {tab.label}
          <span className="text-[11px] tabular-nums opacity-65">
            {tab.value === "all" ? favoriteTotal : (counts[tab.value] ?? 0)}
          </span>
        </button>
      ))}
    </div>
  );
}

type FavoriteResourceSelection = {
  availability: AvailabilityFilter;
  sourceIDs: number[];
};

function FavoriteResourceFilter({
  availability,
  sources,
  selectedSourceIDs,
  loading,
  onChange,
}: {
  availability: AvailabilityFilter;
  sources: LibrarySource[];
  selectedSourceIDs: number[];
  loading: boolean;
  onChange: (selection: FavoriteResourceSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const selection: FavoriteResourceSelection = { availability, sourceIDs: selectedSourceIDs };
  const label = favoriteResourceLabel(sources, selection);
  const disabled = loading;
  const select = (next: FavoriteResourceSelection) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <div className="relative" ref={anchorRef}>
      <Button
        variant="outline"
        size="sm"
        className={`h-8 max-w-48 ${availability !== "all" || selectedSourceIDs.length > 0 ? "border-primary/30 bg-primary/10 text-primary" : ""}`}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        aria-label={`Resource: ${label}`}
        title={`Resource: ${label}`}
      >
        <Cloud className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </Button>
      <AnchoredPopover
        open={open && !disabled}
        anchorRef={anchorRef}
        onOpenChange={setOpen}
        align="start"
        className="w-[min(18rem,calc(100vw-1.5rem))] p-1 text-sm"
      >
        <div role="menu" aria-label="Resource filters">
          <div className="px-3 py-2 text-xs font-semibold text-foreground">Resource</div>
          <FavoriteResourceOption
            label="Any available"
            selected={availability === "all" && selectedSourceIDs.length === 0}
            onClick={() => select({ availability: "all", sourceIDs: [] })}
          />
          <FavoriteResourceOption
            label="Local"
            selected={availability === "local" && selectedSourceIDs.length === 0}
            onClick={() => select({ availability: "local", sourceIDs: [] })}
          />
          <FavoriteResourceOption
            label="Cached"
            selected={availability === "cache" && selectedSourceIDs.length === 0}
            onClick={() => select({ availability: "cache", sourceIDs: [] })}
          />
          <FavoriteResourceOption
            label="Any remote"
            selected={availability === "remote" && selectedSourceIDs.length === 0}
            onClick={() => select({ availability: "remote", sourceIDs: [] })}
          />
          {sources.map((source) => (
            <FavoriteResourceOption
              key={source.id}
              label={source.displayName || source.code}
              selected={
                availability === "remote" && selectedSourceIDs.length === 1 && selectedSourceIDs[0] === source.id
              }
              onClick={() => select({ availability: "remote", sourceIDs: [source.id] })}
              icon={<Cloud className="h-3.5 w-3.5 shrink-0" />}
              suffix={!source.enabled ? "Disabled" : undefined}
            />
          ))}
          <FavoriteResourceOption
            label="Missing"
            selected={availability === "missing" && selectedSourceIDs.length === 0}
            onClick={() => select({ availability: "missing", sourceIDs: [] })}
          />
        </div>
      </AnchoredPopover>
    </div>
  );
}

function FavoriteResourceOption({
  label,
  selected,
  onClick,
  icon,
  suffix,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
  icon?: ReactNode;
  suffix?: string;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      className={`flex min-h-10 w-full items-center gap-2 rounded-md px-3 py-2 text-left hover:bg-muted ${selected ? "bg-primary/10 font-medium text-primary ring-1 ring-inset ring-primary/15" : "text-muted-foreground"}`}
      onClick={onClick}
    >
      <Check className={`h-4 w-4 shrink-0 ${selected ? "opacity-100" : "opacity-0"}`} />
      {icon}
      <span className="min-w-0 flex-1 truncate text-foreground">{label}</span>
      {suffix && <span className="text-[11px] text-muted-foreground">{suffix}</span>}
    </button>
  );
}

function favoriteResourceLabel(sources: LibrarySource[], selection: FavoriteResourceSelection) {
  if (selection.sourceIDs.length === 1) {
    const source = sources.find((candidate) => candidate.id === selection.sourceIDs[0]);
    return source?.displayName || source?.code || "Remote source";
  }
  switch (selection.availability) {
    case "local":
      return "Local";
    case "cache":
      return "Cached";
    case "remote":
      return "Any remote";
    case "missing":
      return "Missing";
    default:
      return "Any available";
  }
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
      availabilitySummary={{ available: circle.playableWorks, total: circle.catalogWorks }}
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
      syncState={voice.syncState}
      workCount={voice.knownWorks}
      availabilityCounts={{ local: voice.localWorks, remote: voice.remoteWorks }}
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
      className="group -my-1 inline-flex h-11 shrink-0 items-center rounded-md transition-[box-shadow,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[var(--press-scale)] motion-reduce:active:scale-100 lg:my-0 lg:h-8"
      aria-pressed={active}
      title={title ?? label}
      onClick={onClick}
    >
      <span
        className={`inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors lg:h-8 ${active ? "bg-primary text-primary-foreground" : "bg-card group-hover:bg-muted"}`}
      >
        <ListMusic className="h-4 w-4" />
        <span className="max-w-48 truncate">{label}</span>
        <span className="text-xs tabular-nums opacity-80">{count}</span>
      </span>
    </button>
  );
}

function FavoriteListTabSkeletons() {
  return (
    <>
      {Array.from({ length: 4 }, (_, index) => (
        <FavoriteSkeletonLine key={index} className="h-9 w-28 shrink-0 lg:h-8" />
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
    hasPlaybackHistory: hasPlaybackHistory(work.progress),
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
  compact = false,
  onChange,
  onDirectionChange,
  onReshuffle,
}: {
  value: FavoriteSort;
  direction: SortDirection;
  disabled: boolean;
  compact?: boolean;
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
          className={`inline-flex h-7 items-center gap-1.5 rounded-l-md px-2 text-xs text-foreground hover:bg-muted disabled:pointer-events-none disabled:opacity-50 ${compact ? "w-8 justify-center px-0" : "min-w-0 max-w-40"}`}
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
          aria-label={`Sort favorite works: ${label}`}
          title={`Sort favorite works: ${label}`}
        >
          <ArrowUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          {!compact && <span className="truncate">{label}</span>}
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

function favoriteSourceFilterLabel(sources: LibrarySource[], selectedSourceIDs: number[]) {
  if (selectedSourceIDs.length === 0) return "All sources";
  if (selectedSourceIDs.length > 1) return `${selectedSourceIDs.length} sources`;
  const selected = sources.find((source) => source.id === selectedSourceIDs[0]);
  return selected?.displayName || selected?.code || "1 source";
}

function FavoriteMobileWorksControls({
  availability,
  sources,
  selectedSourceIDs,
  sourcesLoading,
  sort,
  direction,
  pageSize,
  mobileColumns,
  desktopColumns,
  sortDisabled,
  onResourceChange,
  onSortChange,
  onDirectionChange,
  onReshuffle,
  onPageSizeChange,
  onMobileColumnsChange,
  onDesktopColumnsChange,
}: {
  availability: AvailabilityFilter;
  sources: LibrarySource[];
  selectedSourceIDs: number[];
  sourcesLoading: boolean;
  sort: FavoriteSort;
  direction: SortDirection;
  pageSize: PageSize;
  mobileColumns: WorkCollectionColumnSetting;
  desktopColumns: WorkCollectionColumnSetting;
  sortDisabled: boolean;
  onResourceChange: (selection: FavoriteResourceSelection) => void;
  onSortChange: (value: FavoriteSort) => void;
  onDirectionChange: (value: SortDirection) => void;
  onReshuffle: () => void;
  onPageSizeChange: (value: PageSize) => void;
  onMobileColumnsChange: (value: WorkCollectionColumnSetting) => void;
  onDesktopColumnsChange: (value: WorkCollectionColumnSetting) => void;
}) {
  const availabilityLabel =
    availabilityFilters.find((option) => option.value === availability)?.label ?? "Any available";
  const sourceLabel = sourcesLoading
    ? "Loading sources"
    : sources.length === 0
      ? "No sources"
      : favoriteSourceFilterLabel(sources, selectedSourceIDs);
  const resourceLabel = selectedSourceIDs.length > 0 ? sourceLabel : availabilityLabel;

  return (
    <div className="flex items-center gap-1">
      <FavoriteResourceIconControl
        availability={availability}
        sources={sources}
        selectedSourceIDs={selectedSourceIDs}
        loading={sourcesLoading}
        label={resourceLabel}
        onChange={onResourceChange}
      />
      <WorkCollectionLayoutPicker
        mobileColumns={mobileColumns}
        desktopColumns={desktopColumns}
        onMobileColumnsChange={onMobileColumnsChange}
        onDesktopColumnsChange={onDesktopColumnsChange}
      />
      <FavoriteSortControls
        value={sort}
        direction={direction}
        disabled={sortDisabled}
        compact
        onChange={onSortChange}
        onDirectionChange={onDirectionChange}
        onReshuffle={onReshuffle}
      />
      <PageSizePicker
        value={pageSize}
        options={pageSizeOptions}
        onChange={(value) => onPageSizeChange(value as PageSize)}
      />
    </div>
  );
}

function FavoriteResourceIconControl({
  availability,
  sources,
  selectedSourceIDs,
  loading,
  label,
  onChange,
}: {
  availability: AvailabilityFilter;
  sources: LibrarySource[];
  selectedSourceIDs: number[];
  loading: boolean;
  label: string;
  onChange: (selection: FavoriteResourceSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const disabled = loading;
  return (
    <div className="relative" ref={anchorRef}>
      <Button
        variant="outline"
        size="icon"
        className={`h-8 w-8 ${availability !== "all" || selectedSourceIDs.length > 0 ? "border-primary/30 bg-primary/10 text-primary" : ""}`}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        aria-label={`Resource: ${label}`}
        title={`Resource: ${label}`}
      >
        <Cloud className="h-4 w-4" />
      </Button>
      <AnchoredPopover
        open={open && !disabled}
        anchorRef={anchorRef}
        onOpenChange={setOpen}
        align="end"
        className="w-[min(18rem,calc(100vw-1.5rem))] p-1 text-sm"
      >
        <div role="menu" aria-label="Resource filters">
          <div className="px-3 py-2 text-xs font-semibold text-foreground">Resource</div>
          <FavoriteResourceOption
            label="Any available"
            selected={availability === "all" && selectedSourceIDs.length === 0}
            onClick={() => {
              onChange({ availability: "all", sourceIDs: [] });
              setOpen(false);
            }}
          />
          <FavoriteResourceOption
            label="Local"
            selected={availability === "local" && selectedSourceIDs.length === 0}
            onClick={() => {
              onChange({ availability: "local", sourceIDs: [] });
              setOpen(false);
            }}
          />
          <FavoriteResourceOption
            label="Cached"
            selected={availability === "cache" && selectedSourceIDs.length === 0}
            onClick={() => {
              onChange({ availability: "cache", sourceIDs: [] });
              setOpen(false);
            }}
          />
          <FavoriteResourceOption
            label="Any remote"
            selected={availability === "remote" && selectedSourceIDs.length === 0}
            onClick={() => {
              onChange({ availability: "remote", sourceIDs: [] });
              setOpen(false);
            }}
          />
          {sources.map((source) => (
            <FavoriteResourceOption
              key={source.id}
              label={source.displayName || source.code}
              selected={
                availability === "remote" && selectedSourceIDs.length === 1 && selectedSourceIDs[0] === source.id
              }
              onClick={() => {
                onChange({ availability: "remote", sourceIDs: [source.id] });
                setOpen(false);
              }}
              icon={<Cloud className="h-3.5 w-3.5 shrink-0" />}
              suffix={!source.enabled ? "Disabled" : undefined}
            />
          ))}
          <FavoriteResourceOption
            label="Missing"
            selected={availability === "missing" && selectedSourceIDs.length === 0}
            onClick={() => {
              onChange({ availability: "missing", sourceIDs: [] });
              setOpen(false);
            }}
          />
        </div>
      </AnchoredPopover>
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
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [name, setName] = useState(list?.name ?? "");
  const [description, setDescription] = useState(list?.description ?? "");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => editorRef.current?.scrollIntoView({ block: "nearest" }));
    return () => window.cancelAnimationFrame(frame);
  }, []);

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
    <div ref={editorRef} role="listitem">
      <form
        aria-label={list ? `Rename ${list.name}` : "Add favorite list"}
        className="rounded-md border bg-background p-3"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!isSaving && name.trim()) void save();
        }}
      >
        <h3 className="text-sm font-semibold">{list ? "Rename list" : "Add list"}</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
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
        </div>
        {error && (
          <div className="mt-3 rounded-md border bg-card px-3 py-2 text-xs text-muted-foreground" role="alert">
            {error}
          </div>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" type="submit" disabled={isSaving || !name.trim()}>
            {isSaving ? "Saving" : list ? "Save" : "Add list"}
          </Button>
        </div>
      </form>
    </div>
  );
}

function FavoriteListManager({
  markedList,
  lists,
  editor,
  deleteTarget,
  deleting,
  onClose,
  onNew,
  onEdit,
  onCancelEdit,
  onSave,
  onDelete,
  onCancelDelete,
  onConfirmDelete,
  onMove,
}: {
  markedList: FavoriteList | null;
  lists: FavoriteList[];
  editor: FavoriteList | "new" | null;
  deleteTarget: FavoriteList | null;
  deleting: boolean;
  onClose: () => void;
  onNew: () => void;
  onEdit: (list: FavoriteList) => void;
  onCancelEdit: () => void;
  onSave: (payload: { name: string; description: string }) => Promise<void>;
  onDelete: (list: FavoriteList) => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  onMove: (listID: number, direction: -1 | 1) => void;
}) {
  const actionsDisabled = editor !== null || deleteTarget !== null || deleting;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/50 p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="favorite-list-manager-title"
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-lg border bg-card p-4 shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between gap-3">
          <div>
            <h2 id="favorite-list-manager-title" className="text-base font-semibold">
              Edit favorite lists
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">Sort, rename, create, or remove your lists.</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            disabled={deleting}
            aria-label="Close favorite list editor"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div
          className="mt-4 min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain"
          role="list"
          aria-label="Favorite lists"
        >
          {markedList && (
            <div
              role="listitem"
              className="flex items-center gap-2 rounded-md border border-dashed bg-muted/30 px-3 py-2"
            >
              <ListMusic className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">Marked</div>
                <div className="truncate text-xs text-muted-foreground">System list · follows listening status</div>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">Fixed</span>
            </div>
          )}
          {lists.length === 0 && editor !== "new" ? (
            <div className="rounded-md border px-3 py-4 text-sm text-muted-foreground">No custom lists yet.</div>
          ) : (
            lists.map((list, index) =>
              editor !== "new" && editor?.id === list.id ? (
                <FavoriteListEditor key={`editor-${list.id}`} list={list} onClose={onCancelEdit} onSave={onSave} />
              ) : (
                <FavoriteListManagerRow
                  key={list.id}
                  list={list}
                  index={index}
                  total={lists.length}
                  actionsDisabled={actionsDisabled}
                  confirmingDelete={deleteTarget?.id === list.id}
                  deleting={deleting && deleteTarget?.id === list.id}
                  onMove={onMove}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onCancelDelete={onCancelDelete}
                  onConfirmDelete={onConfirmDelete}
                />
              ),
            )
          )}
          {editor === "new" && (
            <FavoriteListEditor key="new-list-editor" list={null} onClose={onCancelEdit} onSave={onSave} />
          )}
        </div>
        <div className="mt-4 flex shrink-0 gap-2">
          {editor === null && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onNew}
              disabled={deleteTarget !== null || deleting}
            >
              <Plus className="h-4 w-4" />
              Add list
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={onClose} disabled={deleting}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}

function FavoriteListManagerRow({
  list,
  index,
  total,
  actionsDisabled,
  confirmingDelete,
  deleting,
  onMove,
  onEdit,
  onDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  list: FavoriteList;
  index: number;
  total: number;
  actionsDisabled: boolean;
  confirmingDelete: boolean;
  deleting: boolean;
  onMove: (listID: number, direction: -1 | 1) => void;
  onEdit: (list: FavoriteList) => void;
  onDelete: (list: FavoriteList) => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  const deleteButtonRef = useRef<HTMLButtonElement | null>(null);
  const deleteTitleID = `favorite-list-delete-${list.id}-title`;
  const deleteDescriptionID = `favorite-list-delete-${list.id}-description`;

  const closeDeleteConfirmation = () => {
    onCancelDelete();
    window.requestAnimationFrame(() => deleteButtonRef.current?.focus());
  };

  return (
    <div role="listitem" className="flex items-center gap-1 rounded-md border bg-background px-2 py-2 sm:gap-2 sm:px-3">
      <ListMusic className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{list.name}</div>
        {list.description && <div className="truncate text-xs text-muted-foreground">{list.description}</div>}
      </div>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{index + 1}</span>
      <div className="flex shrink-0 items-center">
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11 sm:h-8 sm:w-8"
          disabled={actionsDisabled || index === 0}
          onClick={() => onMove(list.id, -1)}
          aria-label={`Move ${list.name} up`}
          title="Move up"
        >
          <ArrowUp className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11 sm:h-8 sm:w-8"
          disabled={actionsDisabled || index === total - 1}
          onClick={() => onMove(list.id, 1)}
          aria-label={`Move ${list.name} down`}
          title="Move down"
        >
          <ArrowDown className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11 sm:h-8 sm:w-8"
          disabled={actionsDisabled}
          onClick={() => onEdit(list)}
          aria-label={`Rename ${list.name}`}
          title="Rename"
        >
          <Pencil className="h-4 w-4" />
        </Button>
        <Button
          ref={deleteButtonRef}
          variant="ghost"
          size="icon"
          className="h-11 w-11 sm:h-8 sm:w-8"
          disabled={deleting || (actionsDisabled && !confirmingDelete)}
          onClick={() => onDelete(list)}
          aria-label={`Delete ${list.name}`}
          aria-haspopup="dialog"
          aria-expanded={confirmingDelete}
          title="Delete"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <AnchoredPopover
        open={confirmingDelete}
        anchorRef={deleteButtonRef}
        onOpenChange={(open) => {
          if (!open && !deleting) closeDeleteConfirmation();
        }}
        className="w-[min(18rem,calc(100vw-1.5rem))] p-3"
        zIndex={60}
      >
        <div role="alertdialog" aria-labelledby={deleteTitleID} aria-describedby={deleteDescriptionID}>
          <h3 id={deleteTitleID} className="text-sm font-semibold">
            Delete list?
          </h3>
          <p id={deleteDescriptionID} className="mt-2 text-sm text-muted-foreground">
            Delete "{list.name}"? Works stay in the library, but this list membership is removed.
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={closeDeleteConfirmation}
              disabled={deleting}
              autoFocus
            >
              Cancel
            </Button>
            <Button type="button" variant="destructive" size="sm" onClick={onConfirmDelete} disabled={deleting}>
              {deleting ? "Deleting..." : "Delete"}
            </Button>
          </div>
        </div>
      </AnchoredPopover>
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
        if (!cancelled)
          setSelectedIDs(
            new Set(lists.filter((list) => list.kind !== "marked" && list.selected).map((list) => list.id)),
          );
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
