import { Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "@/auth/AuthProvider";
import { DemoContentNotice } from "@/components/DemoReadOnlyNotice";
import { BrowseLoadingIndicator } from "@/components/collection/BrowseLoadingIndicator";
import { useCollectionResultsScroll } from "@/components/collection/useCollectionResultsScroll";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toastFromError, useToast } from "@/components/ui/toast";
import {
  WorkCollectionDisplayPicker,
  useWorkCollectionLayout,
} from "@/components/work-collection/WorkCollectionLayout";
import { WorkCollectionLoadingState } from "@/components/work-collection/WorkCollectionLoadingState";
import { WorkCollectionPagination } from "@/components/work-collection/WorkCollectionPagination";
import { favoriteListIcon } from "@/components/favorite-list/favoriteListIcons";
import { FavoriteContinueStrip, useFavoriteContinueListening } from "@/features/favorites/FavoriteContinueStrip";
import { FavoriteCreatorShelf } from "@/features/favorites/FavoriteCreatorShelf";
import type { FavoriteListMembershipChanges } from "@/features/favorites/FavoriteListMembershipPicker";
import { FavoriteListManager } from "@/features/favorites/FavoriteListManager";
import { FavoriteMobileControls } from "@/features/favorites/FavoriteMobileControls";
import { FavoriteSelectionBar } from "@/features/favorites/FavoriteSelectionBar";
import { FavoriteShelfHeader } from "@/features/favorites/FavoriteShelfHeader";
import {
  FavoriteShelfSidebar,
  FavoriteShelfStrip,
  type FavoriteShelfNavigation,
} from "@/features/favorites/FavoriteShelfNavigator";
import { EmptyFavorites, FavoriteLoadError } from "@/features/favorites/FavoriteStates";
import { FavoriteStatusTabs } from "@/features/favorites/FavoriteStatusTabs";
import { FavoriteWorkGrid } from "@/features/favorites/FavoriteWorkGrid";
import { SmartListPanel } from "@/features/favorites/SmartListPanel";
import {
  FavoriteWorkList,
  FavoriteWorkListSkeleton,
  type FavoriteWorkItemHandlers,
} from "@/features/favorites/FavoriteWorkList";
import {
  FavoriteResourceFilter,
  FavoriteSearchInput,
  FavoriteSelectionToggle,
  FavoriteSortControls,
} from "@/features/favorites/FavoriteWorksControls";
import {
  favoriteShelfKind,
  favoriteShelfProgress,
  favoriteStatusFilterOptions,
} from "@/features/favorites/favoriteShelfModel";
import { useFavoriteViewMode } from "@/features/favorites/favoriteViewMode";
import { useFavoriteCreators } from "@/features/favorites/useFavoriteCreators";
import { useFavoriteListEditing } from "@/features/favorites/useFavoriteListEditing";
import { useFavoriteLists } from "@/features/favorites/useFavoriteLists";
import { useFavoriteShelfCovers } from "@/features/favorites/useFavoriteShelfCovers";
import { useFavoriteWorks } from "@/features/favorites/useFavoriteWorks";
import {
  defaultFavoritesBrowseState,
  favoritePageSizeOptions,
  favoritesBrowseSearch,
  favoritesBrowseStateFromSearch,
  favoritesBrowseStateFromValue,
  favoritesLocation,
  personalTagSearch,
  readFavoritesBrowseState,
  writeFavoritesBrowseState,
  type FavoriteAvailability,
  type FavoriteEntity,
  type FavoritePageSize,
  type FavoritesBrowseState,
} from "@/features/favorites/favoritesBrowseState";
import { useBrowseHistoryState } from "@/hooks/useBrowseHistoryState";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import { useStableCallback } from "@/hooks/useStableCallback";
import { api, type FavoriteSort, type ListeningStatus, type SortDirection, type Work } from "@/lib/api";
import { NAVIGATION_EVENT, historyStateWithReturn } from "@/lib/browserHistory";
import { currentClientStorageScope } from "@/lib/clientStorageScope";
import { defaultLibraryBrowseState, libraryLocation } from "@/lib/libraryBrowseState";

function createFavoriteRandomSeed() {
  return (window.crypto.getRandomValues(new Uint32Array(1))[0] % 2147483646) + 1;
}

type AvailabilityFilter = FavoriteAvailability;

type FavoritesEntryState = {
  favoritesBrowseScope?: unknown;
  favoritesBrowseState?: FavoritesBrowseState;
  favoritesSelection?: { active: boolean; workIDs: number[] };
  favoritesAnchor?: { workID: number; viewportOffset: number };
};

export function FavoritesPage({ active = true }: { active?: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const auth = useAuth();
  const principalID = auth.user?.id ?? null;
  const favoritesStorageScope = currentClientStorageScope(principalID);
  // Load failures report through a stable callback, so a language change does
  // not refetch every favorites panel.
  const notifyUnavailable = useStableCallback((error: unknown, setLoadError?: (message: string) => void) => {
    setLoadError?.(t("errors.unavailable"));
    toast.notify(toastFromError(error, t("errors.unavailable")));
  });
  const initialEntryState = useRef(readFavoritesEntryState(favoritesStorageScope)).current;
  const initialBrowseState = useRef(
    favoritesBrowseStateFromSearch(
      window.location.search,
      initialEntryState.favoritesBrowseState ?? readFavoritesBrowseState(principalID) ?? defaultFavoritesBrowseState,
    ),
  ).current;
  const pendingAnchor = useRef(initialEntryState.favoritesAnchor ?? null);
  const {
    setFavoriteLists,
    isLoading: areFavoriteListsLoading,
    markedList,
    userLists,
  } = useFavoriteLists({ active, user: auth.user, notifyUnavailable });
  const [favoriteEntity, setFavoriteEntity] = useState<FavoriteEntity>(initialBrowseState.entity);
  const creators = useFavoriteCreators({ active, user: auth.user, notifyUnavailable });
  const [query, setQuery] = useState(initialBrowseState.query);
  const [statusFilter, setStatusFilter] = useState<ListeningStatus | "all">(initialBrowseState.status);
  const [availabilityFilter, setAvailabilityFilter] = useState<AvailabilityFilter>(initialBrowseState.availability);
  const [activeList, setActiveList] = useState<"all" | number>(initialBrowseState.list);
  const [page, setPage] = useState(initialBrowseState.page);
  const [pageSize, setPageSize] = useState<FavoritePageSize>(initialBrowseState.pageSize);
  const resultsScroll = useCollectionResultsScroll();
  const completeResultsScroll = resultsScroll.complete;
  const cancelResultsScroll = resultsScroll.cancel;
  const [sort, setSort] = useState<FavoriteSort>(initialBrowseState.sort);
  const [sortDirection, setSortDirection] = useState<SortDirection>(initialBrowseState.direction);
  const [randomSeed, setRandomSeed] = useState(initialBrowseState.randomSeed);
  // The smart list whose new works alone are shown; switching shelves ends the filter.
  const [newOnlyList, setNewOnlyList] = useState<number | null>(null);
  const { mobileColumns, desktopColumns, setMobileColumns, setDesktopColumns } = useWorkCollectionLayout();
  const [viewMode, setViewMode] = useFavoriteViewMode();
  const [selectionMode, setSelectionMode] = useState(Boolean(initialEntryState.favoritesSelection?.active));
  const [selectedWorkIDs, setSelectedWorkIDs] = useState<Set<number>>(
    () => new Set(initialEntryState.favoritesSelection?.workIDs ?? []),
  );
  const [isBulkUpdating, setIsBulkUpdating] = useState(false);
  const mobileNavigationLayout = useMobileNavigationLayout();
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
  const newOnly = newOnlyList !== null && newOnlyList === activeList;
  const hasPendingRestoration = useBrowseHistoryState({
    active,
    stateKey: JSON.stringify(browseState),
    keyOf: (state) => JSON.stringify(state.browse),
    isCurrentLocation: () => window.location.pathname === "/favorites",
    read: () => {
      const entry = readFavoritesEntryState(favoritesStorageScope);
      return {
        entry,
        browse: favoritesBrowseStateFromSearch(
          window.location.search,
          entry.favoritesBrowseState ?? readFavoritesBrowseState(principalID) ?? defaultFavoritesBrowseState,
        ),
      };
    },
    restore: ({ browse, entry }) => {
      setFavoriteEntity(browse.entity);
      setQuery(browse.query);
      setStatusFilter(browse.status);
      setAvailabilityFilter(browse.availability);
      setActiveList(browse.list);
      setPage(browse.page);
      setPageSize(browse.pageSize);
      setSort(browse.sort);
      setSortDirection(browse.direction);
      setRandomSeed(browse.randomSeed);
      setSelectionMode(Boolean(entry.favoritesSelection?.active));
      setSelectedWorkIDs(new Set(entry.favoritesSelection?.workIDs ?? []));
      pendingAnchor.current = entry.favoritesAnchor ?? null;
    },
  });
  const favoriteWorks = useFavoriteWorks({
    active,
    user: auth.user,
    browse: browseState,
    newOnly,
    hasPendingRestoration,
    notifyUnavailable,
  });
  const {
    works,
    setWorks,
    totalWorks,
    favoriteTotal,
    listCounts,
    newCounts,
    newWorkIDs,
    statusCounts,
    isLoading,
    hasSnapshot: hasWorksSnapshot,
    loadError: worksLoadError,
    reloadToken: worksReloadToken,
    reload: reloadWorks,
    isCurrent: worksAreCurrent,
  } = favoriteWorks;

  useEffect(() => {
    if (!active || isLoading || !worksAreCurrent) return;
    setSelectedWorkIDs((ids) => new Set(Array.from(ids).filter((id) => works.some((work) => work.id === id))));
  }, [active, isLoading, works, worksAreCurrent]);

  useEffect(() => {
    if (!active || hasPendingRestoration() || window.location.pathname !== "/favorites") return;
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
    favoritesStorageScope,
    hasPendingRestoration,
    page,
    pageSize,
    principalID,
    query,
    randomSeed,
    selectedWorkIDs,
    selectionMode,
    sort,
    sortDirection,
    statusFilter,
  ]);

  useEffect(() => {
    const anchor = pendingAnchor.current;
    if (!active || hasPendingRestoration() || isLoading || favoriteEntity !== "works" || !anchor) return;
    const target = document.querySelector<HTMLElement>(`[data-favorite-work-id="${anchor.workID}"]`);
    pendingAnchor.current = null;
    if (!target) return;
    target.focus({ preventScroll: true });
  }, [active, favoriteEntity, hasPendingRestoration, isLoading, works]);

  const totalPages = Math.max(1, Math.ceil(totalWorks / pageSize));
  const currentPage = Math.min(page, totalPages);
  const hasWorkFilters = Boolean(query.trim()) || statusFilter !== "all" || availabilityFilter !== "all";
  const selectedWorks = works.filter((work) => selectedWorkIDs.has(work.id));
  const shelfKind = favoriteShelfKind(activeList, markedList);
  const activeUserList = shelfKind === "list" ? (userLists.find((list) => list.id === activeList) ?? null) : null;
  const activeSmartList = activeUserList?.kind === "smart" ? activeUserList : null;
  const shelfTotal = activeList === "all" ? favoriteTotal : (listCounts[String(activeList)] ?? 0);
  const continueWorks = useFavoriteContinueListening({
    enabled: active && Boolean(auth.user) && favoriteEntity === "works" && !query.trim() && currentPage === 1,
    listID: activeList,
    requestKey: `${principalID ?? "anonymous"}:${worksReloadToken}`,
  });
  const shelfCovers = useFavoriteShelfCovers({
    // Waiting for the shelf counts avoids a second request when the first count arrives.
    enabled: active && Boolean(auth.user) && favoriteEntity === "works" && favoriteWorks.shelfCountsKnown,
    listID: activeList,
    // The shelf total follows membership changes that do not reload the works.
    requestKey: `${principalID ?? "anonymous"}:${worksReloadToken}:${shelfTotal}`,
  });

  useEffect(() => {
    if (active && !isLoading && worksAreCurrent && page > totalPages) setPage(totalPages);
  }, [active, isLoading, page, totalPages, worksAreCurrent]);

  useEffect(() => {
    if (!active || isLoading) return;
    if (worksAreCurrent) completeResultsScroll();
    else if (worksLoadError) cancelResultsScroll();
  }, [active, cancelResultsScroll, completeResultsScroll, isLoading, worksAreCurrent, worksLoadError]);

  const changePage = (value: number) => {
    resultsScroll.queue();
    setPage(value);
  };

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
    window.history.replaceState(
      {
        ...(window.history.state && typeof window.history.state === "object" ? window.history.state : {}),
        favoritesBrowseScope: favoritesStorageScope,
        favoritesBrowseState: browseState,
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
    reloadWorks();
  };

  // Clearing filters keeps the open shelf; switching shelves is navigation, not a filter.
  const clearFilters = () => {
    setQuery("");
    setStatusFilter("all");
    setAvailabilityFilter("all");
    setPage(1);
  };

  const changeAvailabilityFilter = (value: AvailabilityFilter) => {
    setAvailabilityFilter(value);
    setPage(1);
  };

  const openWorksShelf = (list: "all" | number) => {
    if (favoriteEntity !== "works") {
      setFavoriteEntity("works");
      setQuery("");
    }
    setActiveList(list);
    setPage(1);
  };

  const openCreatorShelf = (entity: Exclude<FavoriteEntity, "works">) => {
    if (favoriteEntity === entity) return;
    setFavoriteEntity(entity);
    setQuery("");
    setPage(1);
  };

  const changeFavoriteQuery = (value: string) => {
    setQuery(value);
    if (favoriteEntity === "works") setPage(1);
  };

  const changeStatusFilter = (value: ListeningStatus | "all") => {
    setStatusFilter(value);
    setPage(1);
  };

  const changePageSize = (value: FavoritePageSize) => {
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
    window.dispatchEvent(new Event(NAVIGATION_EVENT));
  };

  const browseLibrary = () => {
    window.history.pushState({}, "", "/library");
    window.dispatchEvent(new Event(NAVIGATION_EVENT));
  };

  const reloadFavoriteLists = async () => {
    const lists = await api.listFavoriteLists();
    setFavoriteLists(lists);
    await favoriteWorks.refetch(currentPage);
    return lists;
  };

  const listEditing = useFavoriteListEditing({
    userLists,
    setFavoriteLists,
    reloadLists: reloadFavoriteLists,
    onShowList: (list) => {
      setActiveList(list);
      if (favoriteEntity !== "works") setFavoriteEntity("works");
    },
    onListDeleted: (listID) => {
      if (activeList === listID) setActiveList("all");
    },
  });

  const markSmartListSeen = async (listID: number) => {
    try {
      await api.markFavoriteListSeen(listID);
      setNewOnlyList(null);
      await reloadFavoriteLists();
    } catch (error) {
      toast.notify(toastFromError(error, t("favorites.smart.markSeenFailed")));
    }
  };

  const convertSmartList = async (listID: number) => {
    try {
      await api.convertFavoriteList(listID);
      setNewOnlyList(null);
      await reloadFavoriteLists();
      toast.success(t("favorites.smart.converted"));
    } catch (error) {
      toast.notify(toastFromError(error, t("favorites.smart.convertFailed")));
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

  const applyListMembership = async (changes: FavoriteListMembershipChanges) => {
    const targetWorks = selectedWorks;
    if (targetWorks.length === 0) return;
    setIsBulkUpdating(true);
    try {
      await api.updateFavoriteListMembership({ workIds: targetWorks.map((work) => work.id), ...changes });
      await reloadFavoriteLists();
      setSelectedWorkIDs(new Set());
      setSelectionMode(false);
      toast.success(t("favorites.membershipUpdated", { count: targetWorks.length }));
    } catch (error) {
      toast.notify(toastFromError(error, t("errors.unavailable")));
    } finally {
      setIsBulkUpdating(false);
    }
  };

  // Stable item handlers let unchanged cards and rows skip rendering when the
  // page re-renders, such as when a tab switch toggles `active`.
  const openItemWork = useStableCallback(openWork);
  const openCardUserTag = useStableCallback(openShelfUserTag);
  const changeItemStatus = useStableCallback(updateWorkStatus);
  const changeItemSelection = useStableCallback(toggleWorkSelection);
  const refreshItemLists = useStableCallback(async (work: Work) => {
    await reloadFavoriteLists();
    toast.success(t("favorites.workMembershipUpdated", { code: work.primaryCode }));
  });
  const itemHandlers = useRef<FavoriteWorkItemHandlers>({
    onOpen: openItemWork,
    onStatusChange: changeItemStatus,
    onSelectedChange: changeItemSelection,
    onListsChanged: refreshItemLists,
  }).current;

  if (!auth.user) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">{t("favorites.signInDescription")}</CardContent>
      </Card>
    );
  }

  const navigation: FavoriteShelfNavigation = {
    entity: favoriteEntity,
    activeList,
    markedList,
    userLists,
    favoriteTotal,
    listCounts,
    newCounts,
    worksCountsKnown: favoriteWorks.shelfCountsKnown,
    circleCount: creators.hasSnapshot ? creators.favoriteCircles.length : null,
    voiceCount: creators.hasSnapshot ? creators.favoriteVoices.length : null,
    listsLoading: areFavoriteListsLoading,
    onWorksShelf: openWorksShelf,
    onCreatorShelf: openCreatorShelf,
    onEditLists: () => listEditing.openManager(),
    onAddList: () => listEditing.openManager("new"),
  };
  const searchPlaceholder =
    favoriteEntity === "works"
      ? t("library.searchPlaceholder")
      : favoriteEntity === "circles"
        ? t("creatorBrowse.searchCircles")
        : t("creatorBrowse.searchVoices");
  const shelfHeader =
    favoriteEntity === "works" ? (
      <FavoriteShelfHeader
        kind={shelfKind}
        compact={mobileNavigationLayout}
        listIcon={activeUserList ? favoriteListIcon(activeUserList) : undefined}
        eyebrow={activeSmartList ? t("favorites.smart.kind") : undefined}
        title={
          shelfKind === "all"
            ? t("favorites.all")
            : shelfKind === "marked"
              ? t("favorites.marked")
              : (activeUserList?.name ?? t("favorites.lists"))
        }
        description={
          shelfKind === "all"
            ? t("favorites.shelfAllDescription")
            : shelfKind === "marked"
              ? t("favorites.markedShelfDescription")
              : activeUserList?.description
        }
        countLabel={hasWorksSnapshot ? t("favorites.workCount", { count: shelfTotal }) : null}
        covers={shelfCovers}
        progress={hasWorksSnapshot ? favoriteShelfProgress(statusCounts) : null}
        actions={
          activeUserList ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 text-muted-foreground"
              onClick={() => listEditing.openManager(activeUserList)}
              aria-label={t("favorites.editList")}
              title={t("favorites.editList")}
            >
              <Pencil className="h-4 w-4" />
            </Button>
          ) : undefined
        }
      />
    ) : (
      <FavoriteShelfHeader
        kind={favoriteEntity}
        compact={mobileNavigationLayout}
        title={favoriteEntity === "circles" ? t("creatorBrowse.circles") : t("creatorBrowse.voiceActors")}
        description={
          favoriteEntity === "circles" ? t("favorites.circleShelfDescription") : t("favorites.voiceShelfDescription")
        }
        countLabel={
          creators.hasSnapshot
            ? favoriteEntity === "circles"
              ? t("favorites.circleCount", { count: creators.favoriteCircles.length })
              : t("favorites.voiceCount", { count: creators.favoriteVoices.length })
            : null
        }
        covers={[]}
      />
    );
  const resourceFilter = (
    <FavoriteResourceFilter
      value={availabilityFilter}
      compact={mobileNavigationLayout}
      onChange={changeAvailabilityFilter}
    />
  );
  const sortControls = (
    <FavoriteSortControls
      value={sort}
      direction={sortDirection}
      disabled={isLoading}
      onChange={changeFavoriteSort}
      onDirectionChange={changeFavoriteSortDirection}
      onReshuffle={reshuffleFavorites}
    />
  );
  const displayPicker = (
    <WorkCollectionDisplayPicker
      mobileColumns={mobileColumns}
      desktopColumns={desktopColumns}
      onMobileColumnsChange={setMobileColumns}
      onDesktopColumnsChange={setDesktopColumns}
      showColumns={viewMode === "grid"}
      view={{ mode: viewMode, onChange: setViewMode }}
      pageSize={pageSize}
      pageSizeOptions={favoritePageSizeOptions}
      onPageSizeChange={(value) => changePageSize(value as FavoritePageSize)}
    />
  );
  const selectionToggle = <FavoriteSelectionToggle active={selectionMode} onToggle={toggleSelectionMode} />;
  const statusOptions = favoriteStatusFilterOptions(statusCounts, shelfTotal, statusFilter);

  return (
    <section className="relative">
      {auth.demoMode && (
        <div className="mb-5">
          <DemoContentNotice surface="works" />
        </div>
      )}
      <div className={mobileNavigationLayout ? "" : "flex items-start gap-6"}>
        {!mobileNavigationLayout && <FavoriteShelfSidebar navigation={navigation} />}

        <div ref={resultsScroll.anchorRef} className="@container min-w-0 flex-1 scroll-mt-24 space-y-5">
          {mobileNavigationLayout ? (
            <div className="space-y-3">
              <div data-toast-avoid>
                <FavoriteShelfStrip navigation={navigation} />
              </div>
              {shelfHeader}
              <FavoriteMobileControls
                query={query}
                placeholder={searchPlaceholder}
                onQueryChange={changeFavoriteQuery}
                sort={favoriteEntity === "works" ? sortControls : null}
                actions={
                  <>
                    {resourceFilter}
                    {displayPicker}
                    {selectionToggle}
                  </>
                }
                status={
                  favoriteEntity === "works"
                    ? { options: statusOptions, value: statusFilter, onChange: changeStatusFilter }
                    : null
                }
                result={
                  favoriteEntity === "works" && hasWorksSnapshot
                    ? { count: totalWorks, page: currentPage, totalPages }
                    : null
                }
              />
            </div>
          ) : (
            // A wide shelf puts search, filters, and quick mark tabs beside the header, so works start higher.
            <div className="flex flex-col gap-5 @min-[60rem]:flex-row @min-[60rem]:items-start @min-[60rem]:gap-6">
              <div className="min-w-0 flex-1">{shelfHeader}</div>
              <div
                className="flex min-w-0 flex-col gap-3 @min-[60rem]:max-w-[46rem] @min-[60rem]:items-end"
                data-toast-avoid
              >
                <div className="flex flex-wrap items-center gap-2 @min-[60rem]:w-full @min-[60rem]:flex-nowrap @min-[60rem]:justify-end">
                  <FavoriteSearchInput
                    value={query}
                    placeholder={searchPlaceholder}
                    onChange={changeFavoriteQuery}
                    className="w-full @md:w-auto @md:max-w-sm @md:flex-1 @min-[60rem]:min-w-40 @min-[60rem]:max-w-none"
                  />
                  {favoriteEntity === "works" && (
                    <div className="ml-auto flex shrink-0 items-center gap-1.5">
                      {resourceFilter}
                      {sortControls}
                      {displayPicker}
                      {selectionToggle}
                    </div>
                  )}
                </div>
                {favoriteEntity === "works" && (
                  <div className="flex flex-col gap-2 @min-[60rem]:items-end @min-[60rem]:gap-3">
                    <FavoriteStatusTabs options={statusOptions} value={statusFilter} onChange={changeStatusFilter} />
                    {/* A single page needs no top pager; the shared pager draws its own divider, so this row owns spacing. */}
                    <div
                      hidden={totalPages <= 1}
                      className="shrink-0 self-end [&>div]:min-h-0 [&>div]:border-0 [&>div]:py-0"
                    >
                      <WorkCollectionPagination
                        placement="top"
                        page={currentPage}
                        pageSize={pageSize}
                        totalItems={totalWorks}
                        totalPages={totalPages}
                        compactMobile
                        compactTop
                        refreshing={isLoading && hasWorksSnapshot}
                        refreshingLabel={t("favorites.refreshing")}
                        onPageChange={changePage}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {favoriteEntity === "works" && activeSmartList && (
            <SmartListPanel
              list={activeSmartList}
              newCount={newCounts[String(activeSmartList.id)] ?? 0}
              newOnly={newOnly}
              workCount={listCounts[String(activeSmartList.id)] ?? 0}
              canEdit={!auth.demoMode}
              onToggleNewOnly={() => {
                setNewOnlyList(newOnly ? null : activeSmartList.id);
                setPage(1);
              }}
              onMarkSeen={() => markSmartListSeen(activeSmartList.id)}
              onEditRule={() => listEditing.openManager(activeSmartList)}
              onConvert={() => convertSmartList(activeSmartList.id)}
            />
          )}

          {favoriteEntity === "works" && <FavoriteContinueStrip works={continueWorks} onOpen={openItemWork} />}

          {favoriteEntity !== "works" && (
            <FavoriteCreatorShelf
              kind={favoriteEntity}
              query={query}
              isLoading={creators.isLoading}
              hasSnapshot={creators.hasSnapshot}
              loadError={creators.loadError}
              circles={creators.favoriteCircles}
              voices={creators.favoriteVoices}
              onRetry={creators.reload}
              onCircleChange={creators.changeCircle}
              onVoiceChange={creators.changeVoice}
            />
          )}

          {favoriteEntity === "works" && (
            <>
              {selectionMode && (
                <FavoriteSelectionBar
                  selectedWorks={selectedWorks}
                  pageWorkCount={works.length}
                  userLists={userLists}
                  mobile={mobileNavigationLayout}
                  busy={isBulkUpdating}
                  onSelectPage={() => togglePagedSelection(true)}
                  onClear={() => setSelectedWorkIDs(new Set())}
                  onExit={() => {
                    setSelectedWorkIDs(new Set());
                    setSelectionMode(false);
                  }}
                  onListCreated={() => void api.listFavoriteLists().then(setFavoriteLists, () => undefined)}
                  onSave={applyListMembership}
                />
              )}

              {hasWorksSnapshot && worksLoadError && (
                <FavoriteLoadError message={worksLoadError} compact onRetry={reloadWorks} />
              )}
              {!hasWorksSnapshot ? (
                worksLoadError ? (
                  <FavoriteLoadError message={worksLoadError} onRetry={reloadWorks} />
                ) : viewMode === "list" ? (
                  <FavoriteWorkListSkeleton label={t("favorites.loadingWorks")} />
                ) : (
                  <WorkCollectionLoadingState
                    label={t("favorites.loadingWorks")}
                    mobileColumns={mobileColumns}
                    desktopColumns={desktopColumns}
                  />
                )
              ) : works.length > 0 ? (
                <>
                  {viewMode === "list" ? (
                    <FavoriteWorkList
                      works={works}
                      selectedWorkIDs={selectedWorkIDs}
                      selectionActive={selectionMode}
                      isListSaving={isBulkUpdating}
                      busy={isLoading}
                      handlers={itemHandlers}
                      newWorkIDs={newWorkIDs}
                    />
                  ) : (
                    <FavoriteWorkGrid
                      works={works}
                      selectedWorkIDs={selectedWorkIDs}
                      selectionActive={selectionMode}
                      isListSaving={isBulkUpdating}
                      busy={isLoading}
                      mobileColumns={mobileColumns}
                      desktopColumns={desktopColumns}
                      handlers={itemHandlers}
                      onUserTagOpen={openCardUserTag}
                      newWorkIDs={newWorkIDs}
                    />
                  )}
                  <WorkCollectionPagination
                    placement="bottom"
                    page={currentPage}
                    pageSize={pageSize}
                    totalItems={totalWorks}
                    totalPages={totalPages}
                    onPageChange={changePage}
                  />
                </>
              ) : (
                <EmptyFavorites
                  reason={
                    hasWorkFilters || newOnly
                      ? "filtered"
                      : activeSmartList
                        ? "smart"
                        : shelfKind === "list"
                          ? "list"
                          : "shelf"
                  }
                  onClearFilters={() => {
                    clearFilters();
                    setNewOnlyList(null);
                  }}
                  onBrowseLibrary={browseLibrary}
                  onEditRule={activeSmartList ? () => listEditing.openManager(activeSmartList) : undefined}
                />
              )}
            </>
          )}
        </div>
      </div>
      {listEditing.open && (
        <FavoriteListManager markedList={markedList} lists={userLists} {...listEditing.managerProps} />
      )}
      <BrowseLoadingIndicator
        refreshing={favoriteEntity === "works" && isLoading && hasWorksSnapshot}
        label={t("favorites.refreshing")}
      />
    </section>
  );
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
