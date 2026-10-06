import { ListMusic, Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "@/auth/AuthProvider";
import { DemoContentNotice } from "@/components/DemoReadOnlyNotice";
import { BrowseLoadingIndicator } from "@/components/collection/BrowseLoadingIndicator";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toastFromError, useToast } from "@/components/ui/toast";
import {
  WorkCollectionDisplayPicker,
  useWorkCollectionLayout,
} from "@/components/work-collection/WorkCollectionLayout";
import { WorkCollectionLoadingState } from "@/components/work-collection/WorkCollectionLoadingState";
import { WorkCollectionPagination } from "@/components/work-collection/WorkCollectionPagination";
import { WorkSelectionAction, WorkSelectionBar } from "@/components/work-collection/WorkSelectionBar";
import { favoriteListIcon } from "@/components/favorite-list/favoriteListIcons";
import { FavoriteContinueStrip, useFavoriteContinueListening } from "@/features/favorites/FavoriteContinueStrip";
import { FavoriteCreatorShelf } from "@/features/favorites/FavoriteCreatorShelf";
import {
  FavoriteListMembershipPopover,
  type FavoriteListMembershipChanges,
} from "@/features/favorites/FavoriteListMembershipPopover";
import { FavoriteListManager, type FavoriteListDraft } from "@/features/favorites/FavoriteListManager";
import { FavoriteShelfHeader } from "@/features/favorites/FavoriteShelfHeader";
import {
  FavoriteShelfSidebar,
  FavoriteShelfStrip,
  type FavoriteShelfNavigation,
} from "@/features/favorites/FavoriteShelfNavigator";
import { EmptyFavorites, FavoriteLoadError } from "@/features/favorites/FavoriteStates";
import { FavoriteStatusTabs } from "@/features/favorites/FavoriteStatusTabs";
import { FavoriteWorkGrid } from "@/features/favorites/FavoriteWorkGrid";
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
  FavoriteViewToggle,
  type FavoriteResourceSelection,
} from "@/features/favorites/FavoriteWorksControls";
import {
  favoriteShelfKind,
  favoriteShelfProgress,
  favoriteStatusFilterOptions,
} from "@/features/favorites/favoriteShelfModel";
import { useFavoriteViewMode } from "@/features/favorites/favoriteViewMode";
import { useFavoriteShelfCovers } from "@/features/favorites/useFavoriteShelfCovers";
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
  type FavoriteEntity,
  type FavoritesBrowseState,
} from "@/features/favorites/favoritesBrowseState";
import { useBrowseHistoryState } from "@/hooks/useBrowseHistoryState";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import { useStableCallback } from "@/hooks/useStableCallback";
import {
  api,
  type CircleSummary,
  type FavoriteList,
  type FavoriteSort,
  type LibrarySource,
  type ListeningStatus,
  type SortDirection,
  type VoiceSummary,
  type Work,
} from "@/lib/api";
import { NAVIGATION_EVENT, historyStateWithReturn } from "@/lib/browserHistory";
import { currentClientStorageScope } from "@/lib/clientStorageScope";
import { defaultLibraryBrowseState, libraryLocation } from "@/lib/libraryBrowseState";

const pageSizeOptions = [24, 48] as const;

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
  const [viewMode, setViewMode] = useFavoriteViewMode();
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
  const [shelfCountsUserID, setShelfCountsUserID] = useState<number | null>(null);
  const [listEditor, setListEditor] = useState<FavoriteList | "new" | null>(null);
  const [deleteListTarget, setDeleteListTarget] = useState<FavoriteList | null>(null);
  const [isDeletingList, setIsDeletingList] = useState(false);
  const [listManagerOpen, setListManagerOpen] = useState(false);
  const requestSeq = useRef(0);
  const favoriteListsLoadedFor = useRef<number | null>(null);
  const fileSourcesLoadedFor = useRef<number | null>(null);
  const entitiesLoadedRequestKey = useRef("");
  const worksLoadedRequestKey = useRef("");
  const mobileNavigationLayout = useMobileNavigationLayout();
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
  const worksRequestKey = JSON.stringify([
    principalID,
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
    worksReloadToken,
  ]);
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
      setSourceIDs((current) =>
        current.length === browse.sourceIDs.length && current.every((id, index) => id === browse.sourceIDs[index])
          ? current
          : browse.sourceIDs,
      );
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

  useEffect(() => {
    if (!auth.user) {
      favoriteListsLoadedFor.current = null;
      setFavoriteLists([]);
      setAreFavoriteListsLoading(false);
      return;
    }
    if (!active || favoriteListsLoadedFor.current === principalID) return;
    const controller = new AbortController();
    let cancelled = false;
    setAreFavoriteListsLoading(true);
    api
      .listFavoriteLists(controller.signal)
      .then((lists) => {
        if (!cancelled) {
          favoriteListsLoadedFor.current = principalID;
          setFavoriteLists(lists);
        }
      })
      .catch((error) => {
        if (!cancelled) notifyUnavailable(error);
      })
      .finally(() => {
        if (!cancelled) setAreFavoriteListsLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [active, auth.user, notifyUnavailable, principalID]);

  useEffect(() => {
    if (!auth.user) {
      fileSourcesLoadedFor.current = null;
      setFileSources([]);
      setAreFileSourcesLoading(false);
      return;
    }
    if (!active || fileSourcesLoadedFor.current === principalID) return;
    const controller = new AbortController();
    let cancelled = false;
    setAreFileSourcesLoading(true);
    api
      .listLibrarySources(controller.signal)
      .then((sources) => {
        if (cancelled) return;
        fileSourcesLoadedFor.current = principalID;
        setFileSources(sources);
        const availableSourceIDs = new Set(sources.map((source) => source.id));
        setSourceIDs((current) => {
          const available = current.filter((sourceID) => availableSourceIDs.has(sourceID));
          return available.length === current.length ? current : available;
        });
      })
      .catch((error) => {
        if (!cancelled) notifyUnavailable(error);
      })
      .finally(() => {
        if (!cancelled) setAreFileSourcesLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [active, auth.user, notifyUnavailable, principalID]);

  useEffect(() => {
    if (!auth.user) {
      entitiesLoadedRequestKey.current = "";
      setCircles([]);
      setVoices([]);
      setEntitySnapshotUserID(null);
      setEntityLoadError("");
      setIsEntitiesLoading(false);
      return;
    }
    if (!active) return;
    const requestKey = `${principalID ?? "anonymous"}:${entityReloadToken}`;
    if (entitiesLoadedRequestKey.current === requestKey) return;
    const controller = new AbortController();
    let cancelled = false;
    setIsEntitiesLoading(true);
    setEntityLoadError("");
    Promise.all([
      api.listCircles({ filter: "favorite", pageSize: 100, signal: controller.signal }),
      api.listVoices({ filter: "favorite", pageSize: 100, signal: controller.signal }),
    ])
      .then(([circlePage, voicePage]) => {
        if (cancelled) return;
        entitiesLoadedRequestKey.current = requestKey;
        setCircles(circlePage.circles);
        setVoices(voicePage.voices);
        setEntitySnapshotUserID(principalID);
      })
      .catch((error) => {
        if (!cancelled) notifyUnavailable(error, setEntityLoadError);
      })
      .finally(() => {
        if (!cancelled) setIsEntitiesLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [active, auth.user, entityReloadToken, notifyUnavailable, principalID]);

  useEffect(() => {
    if (!auth.user) {
      worksLoadedRequestKey.current = "";
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
    if (!active || hasPendingRestoration()) return;
    const requestKey = worksRequestKey;
    if (worksLoadedRequestKey.current === requestKey) {
      setIsLoading(false);
      return;
    }
    const controller = new AbortController();
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
        controller.signal,
      )
      .then((result) => {
        if (controller.signal.aborted || seq !== requestSeq.current) return;
        worksLoadedRequestKey.current = requestKey;
        setWorks(result.works);
        setTotalWorks(result.total);
        setFavoriteTotal(result.shelfTotal);
        setListCounts(result.listCounts);
        setStatusCounts(result.statusCounts);
        setWorksSnapshotUserID(principalID);
      })
      .catch((error) => {
        if (controller.signal.aborted || seq !== requestSeq.current) return;
        notifyUnavailable(error, setWorksLoadError);
      })
      .finally(() => {
        if (!controller.signal.aborted && seq === requestSeq.current) setIsLoading(false);
      });
    return () => controller.abort();
  }, [
    active,
    activeList,
    availabilityFilter,
    auth.user,
    favoriteEntity,
    hasPendingRestoration,
    notifyUnavailable,
    page,
    pageSize,
    principalID,
    query,
    randomSeed,
    sort,
    sortDirection,
    sourceIDs,
    statusFilter,
    worksReloadToken,
    worksRequestKey,
  ]);

  useEffect(() => {
    if (!active || isLoading || worksLoadedRequestKey.current !== worksRequestKey) return;
    setSelectedWorkIDs((ids) => new Set(Array.from(ids).filter((id) => works.some((work) => work.id === id))));
  }, [active, isLoading, works, worksRequestKey]);

  useEffect(() => {
    if (!active || hasPendingRestoration() || window.location.pathname !== "/favorites") return;
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
    sourceIDs,
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
  const hasWorkFilters =
    Boolean(query.trim()) || statusFilter !== "all" || availabilityFilter !== "all" || sourceIDs.length > 0;
  const markedList = favoriteLists.find((list) => list.kind === "marked") ?? null;
  const userFavoriteLists = favoriteLists.filter((list) => list.kind !== "marked");
  const selectedWorks = works.filter((work) => selectedWorkIDs.has(work.id));
  const favoriteCircles = circles.filter((circle) => circle.favorite);
  const favoriteVoices = voices.filter((voice) => voice.favorite);
  const hasEntitySnapshot = entitySnapshotUserID === principalID;
  const hasWorksSnapshot = worksSnapshotUserID === principalID;
  const shelfKind = favoriteShelfKind(activeList, markedList);
  const activeUserList =
    shelfKind === "list" ? (userFavoriteLists.find((list) => list.id === activeList) ?? null) : null;
  const shelfTotal = activeList === "all" ? favoriteTotal : (listCounts[String(activeList)] ?? 0);
  // A creator shelf opened first still labels the works shelves, from a one-item request.
  useEffect(() => {
    if (!active || !auth.user || favoriteEntity === "works" || hasWorksSnapshot) return;
    if (shelfCountsUserID === principalID) return;
    const controller = new AbortController();
    api
      .listFavoriteWorksPage(1, 1, "", "all", "all", "all", [], "added", "desc", 1, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setFavoriteTotal(result.shelfTotal);
        setListCounts(result.listCounts);
        setShelfCountsUserID(principalID);
      })
      .catch(() => {
        // The shelves stay usable; their counts appear once works load.
      });
    return () => controller.abort();
  }, [active, auth.user, favoriteEntity, hasWorksSnapshot, principalID, shelfCountsUserID]);
  const continueWorks = useFavoriteContinueListening({
    enabled: active && Boolean(auth.user) && favoriteEntity === "works" && !query.trim() && currentPage === 1,
    listID: activeList,
    requestKey: `${principalID ?? "anonymous"}:${worksReloadToken}`,
  });
  const shelfCovers = useFavoriteShelfCovers({
    // Waiting for the shelf counts avoids a second request when the first count arrives.
    enabled:
      active &&
      Boolean(auth.user) &&
      favoriteEntity === "works" &&
      (hasWorksSnapshot || shelfCountsUserID === principalID),
    listID: activeList,
    // The shelf total follows membership changes that do not reload the works.
    requestKey: `${principalID ?? "anonymous"}:${worksReloadToken}:${shelfTotal}`,
  });

  useEffect(() => {
    if (active && !isLoading && worksLoadedRequestKey.current === worksRequestKey && page > totalPages)
      setPage(totalPages);
  }, [active, isLoading, page, totalPages, worksRequestKey]);

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
    setWorksReloadToken((value) => value + 1);
  };

  // Clearing filters keeps the open shelf; switching shelves is navigation, not a filter.
  const clearFilters = () => {
    setQuery("");
    setStatusFilter("all");
    setAvailabilityFilter("all");
    setSourceIDs([]);
    setPage(1);
  };

  const changeResourceSelection = ({ availability, sourceIDs }: FavoriteResourceSelection) => {
    setAvailabilityFilter(availability);
    setSourceIDs(sourceIDs);
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
    window.dispatchEvent(new Event(NAVIGATION_EVENT));
  };

  const browseLibrary = () => {
    window.history.pushState({}, "", "/library");
    window.dispatchEvent(new Event(NAVIGATION_EVENT));
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

  const saveFavoriteList = async (payload: FavoriteListDraft) => {
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
    if (favoriteEntity !== "works") setFavoriteEntity("works");
    setListEditor(null);
    toast.success(t("favorites.listSaved"));
  };

  const openFavoriteListManager = (editor: FavoriteList | "new" | null = null) => {
    setListEditor(editor);
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
      toast.success(t("favorites.listDeleted"));
    } catch (error) {
      toast.notify(toastFromError(error, t("favorites.listDeleteFailed")));
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
      toast.success(t("favorites.reordered"));
    } catch (error) {
      setFavoriteLists(previousLists);
      toast.notify(toastFromError(error, t("errors.unavailable")));
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
      setListDialogTarget(null);
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
  const changeCircle = useStableCallback((next: CircleSummary) =>
    setCircles((items) => items.map((item) => (item.externalId === next.externalId ? { ...item, ...next } : item))),
  );
  const changeVoice = useStableCallback((next: VoiceSummary) =>
    setVoices((items) => items.map((item) => (item.personId === next.personId ? { ...item, ...next } : item))),
  );

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
    userLists: userFavoriteLists,
    favoriteTotal,
    listCounts,
    worksCountsKnown: hasWorksSnapshot || shelfCountsUserID === principalID,
    circleCount: hasEntitySnapshot ? favoriteCircles.length : null,
    voiceCount: hasEntitySnapshot ? favoriteVoices.length : null,
    listsLoading: areFavoriteListsLoading,
    onWorksShelf: openWorksShelf,
    onCreatorShelf: openCreatorShelf,
    onEditLists: () => openFavoriteListManager(),
    onAddList: () => openFavoriteListManager("new"),
  };
  const searchPlaceholder =
    favoriteEntity === "works"
      ? t("library.searchPlaceholder")
      : favoriteEntity === "circles"
        ? t("creatorBrowse.searchCircles")
        : t("creatorBrowse.searchVoices");

  return (
    <section className="relative">
      {auth.demoMode && (
        <div className="mb-5">
          <DemoContentNotice surface="works" />
        </div>
      )}
      <div className={mobileNavigationLayout ? "" : "flex items-start gap-6"}>
        {!mobileNavigationLayout && <FavoriteShelfSidebar navigation={navigation} />}

        <div className="@container min-w-0 flex-1 space-y-5">
          {mobileNavigationLayout && (
            <div data-toast-avoid>
              <FavoriteShelfStrip navigation={navigation} />
            </div>
          )}

          {/* A wide shelf puts search, filters, and quick mark tabs beside the header, so works start higher. */}
          <div className="flex flex-col gap-5 @min-[60rem]:flex-row @min-[60rem]:items-start @min-[60rem]:gap-6">
            <div className="min-w-0 flex-1">
              {favoriteEntity === "works" ? (
                <FavoriteShelfHeader
                  kind={shelfKind}
                  listIcon={activeUserList ? favoriteListIcon(activeUserList) : undefined}
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
                        onClick={() => openFavoriteListManager(activeUserList)}
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
                  title={favoriteEntity === "circles" ? t("creatorBrowse.circles") : t("creatorBrowse.voiceActors")}
                  description={
                    favoriteEntity === "circles"
                      ? t("favorites.circleShelfDescription")
                      : t("favorites.voiceShelfDescription")
                  }
                  countLabel={
                    hasEntitySnapshot
                      ? favoriteEntity === "circles"
                        ? t("favorites.circleCount", { count: favoriteCircles.length })
                        : t("favorites.voiceCount", { count: favoriteVoices.length })
                      : null
                  }
                  covers={[]}
                />
              )}
            </div>
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
                    <FavoriteResourceFilter
                      availability={availabilityFilter}
                      sources={fileSources}
                      selectedSourceIDs={sourceIDs}
                      loading={areFileSourcesLoading}
                      compact={mobileNavigationLayout}
                      onChange={changeResourceSelection}
                    />
                    <FavoriteSortControls
                      value={sort}
                      direction={sortDirection}
                      disabled={isLoading}
                      compact={mobileNavigationLayout}
                      onChange={changeFavoriteSort}
                      onDirectionChange={changeFavoriteSortDirection}
                      onReshuffle={reshuffleFavorites}
                    />
                    <FavoriteViewToggle value={viewMode} onChange={setViewMode} />
                    <WorkCollectionDisplayPicker
                      mobileColumns={mobileColumns}
                      desktopColumns={desktopColumns}
                      onMobileColumnsChange={setMobileColumns}
                      onDesktopColumnsChange={setDesktopColumns}
                      showColumns={viewMode === "grid"}
                      pageSize={pageSize}
                      pageSizeOptions={pageSizeOptions}
                      onPageSizeChange={(value) => changePageSize(value as PageSize)}
                    />
                    <FavoriteSelectionToggle active={selectionMode} onToggle={toggleSelectionMode} />
                  </div>
                )}
              </div>
              {favoriteEntity === "works" && (
                <div className="flex flex-col gap-2 @min-[60rem]:items-end @min-[60rem]:gap-3">
                  <FavoriteStatusTabs
                    options={favoriteStatusFilterOptions(statusCounts, shelfTotal, statusFilter)}
                    value={statusFilter}
                    onChange={changeStatusFilter}
                  />
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
                      onPageChange={setPage}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {favoriteEntity === "works" && <FavoriteContinueStrip works={continueWorks} onOpen={openItemWork} />}

          {favoriteEntity !== "works" && (
            <FavoriteCreatorShelf
              kind={favoriteEntity}
              query={query}
              isLoading={isEntitiesLoading}
              hasSnapshot={hasEntitySnapshot}
              loadError={entityLoadError}
              circles={favoriteCircles}
              voices={favoriteVoices}
              onRetry={() => setEntityReloadToken((value) => value + 1)}
              onCircleChange={changeCircle}
              onVoiceChange={changeVoice}
            />
          )}

          {favoriteEntity === "works" && (
            <>
              {selectionMode && (
                <WorkSelectionBar
                  selectedCount={selectedWorks.length}
                  scopeSelectableCount={works.length}
                  scopeSelectedCount={selectedWorks.length}
                  onSelectScope={() => togglePagedSelection(true)}
                  onClear={() => setSelectedWorkIDs(new Set())}
                  onExit={() => {
                    setSelectedWorkIDs(new Set());
                    setSelectionMode(false);
                  }}
                >
                  <div className="relative">
                    <WorkSelectionAction
                      icon={<ListMusic className="h-4 w-4" />}
                      label={t("favorites.changeLists")}
                      count={selectedWorks.length}
                      disabled={isBulkUpdating}
                      className="w-full"
                      aria-expanded={Boolean(listDialogTarget)}
                      onClick={() => setListDialogTarget((target) => (target ? null : { mode: "bulk" }))}
                    />
                    {listDialogTarget && (
                      <FavoriteListMembershipPopover
                        title={t("favorites.selectedWorks", { count: selectedWorks.length })}
                        workIDs={selectedWorks.map((work) => work.id)}
                        favoriteLists={userFavoriteLists}
                        disabled={isBulkUpdating}
                        align="right"
                        onClose={() => setListDialogTarget(null)}
                        onSave={applyListMembership}
                      />
                    )}
                  </div>
                </WorkSelectionBar>
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
                  <FavoriteLoadError
                    message={worksLoadError}
                    onRetry={() => setWorksReloadToken((value) => value + 1)}
                  />
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
                    />
                  )}
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
                <EmptyFavorites
                  reason={hasWorkFilters ? "filtered" : shelfKind === "list" ? "list" : "shelf"}
                  onClearFilters={clearFilters}
                  onBrowseLibrary={browseLibrary}
                />
              )}
            </>
          )}
        </div>
      </div>
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
