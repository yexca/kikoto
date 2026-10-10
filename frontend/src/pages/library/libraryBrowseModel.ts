import type { LibrarySort, ListeningStatus, SortDirection, Work } from "@/lib/api";
import {
  defaultLibraryBrowseState,
  type LibraryBrowseState,
  libraryBrowseStateFromSearch,
  libraryBrowseStateFromValue,
  type LibraryColumnSetting,
  type LocalWorkPageSize,
  localWorkPageSizeOptions,
  readLibraryBrowseState,
  readLibrarySortPreference,
} from "@/lib/libraryBrowseState";
import type { SearchClause } from "@/lib/librarySearchClauses";

import { libraryBrowseKey, type LibraryTab, localScopeFromPath, tabFromPath } from "./libraryRoutes";
import { workMatchesSearch } from "./workSearchMatch";

export const librarySortOptions: { value: LibrarySort; label: string }[] = [
  { value: "recommend", label: "Recommended" },
  { value: "recent", label: "Recently added" },
  { value: "release", label: "Release date" },
  { value: "random", label: "Random" },
  { value: "rating", label: "Rating" },
  { value: "code", label: "Code" },
  { value: "sales", label: "Sales" },
  { value: "title", label: "Title" },
];

export const remoteSortValues: LibrarySort[] = ["recent", "release", "code", "rating", "sales", "random"];

export function remoteLibrarySort(value: LibrarySort): LibrarySort {
  return value === "code" || value === "release" || value === "rating" || value === "sales" || value === "random"
    ? value
    : "recent";
}

export function createRandomSortSeed() {
  return (window.crypto.getRandomValues(new Uint32Array(1))[0] % 2147483646) + 1;
}

export type RemoteSourceViewState = { page: number; pageSize: number };

export const defaultRemoteSourceViewState: RemoteSourceViewState = { page: 1, pageSize: 24 };

type LibraryHistoryState = {
  libraryBrowseScope?: unknown;
  libraryBrowseState?: unknown;
};

export function readLibraryHistoryBrowseState(storageScope: string): LibraryBrowseState | null {
  const historyState = window.history.state as LibraryHistoryState | null;
  if (historyState?.libraryBrowseScope !== storageScope) return null;
  const value = historyState?.libraryBrowseState;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return libraryBrowseStateFromValue(
    value as Partial<Record<keyof LibraryBrowseState, unknown>>,
    defaultLibraryBrowseState,
  );
}

export function writeLibraryHistoryBrowseState(storageScope: string, state: LibraryBrowseState) {
  window.history.replaceState(
    {
      ...(window.history.state && typeof window.history.state === "object" ? window.history.state : {}),
      libraryBrowseScope: storageScope,
      libraryBrowseState: state,
    },
    "",
  );
}

export function libraryBrowseControlsKey(state: LibraryBrowseState) {
  return JSON.stringify([
    state.query,
    state.page,
    state.pageSize,
    state.status,
    state.sort,
    state.direction,
    state.randomSeed,
  ]);
}

export function initialLibraryPageBrowseState(
  browseStorageScope: string,
  sessionDefaultBrowseState: LibraryBrowseState,
) {
  const tab = tabFromPath(window.location.pathname, []);
  const scope = localScopeFromPath(window.location.pathname);
  const sortPreference = readLibrarySortPreference(libraryBrowseKey(tab, scope, browseStorageScope));
  const state = libraryBrowseStateFromSearch(
    window.location.search,
    readLibraryHistoryBrowseState(browseStorageScope) ??
      readLibraryBrowseState(libraryBrowseKey(tab, scope, browseStorageScope)) ?? {
        ...sessionDefaultBrowseState,
        ...sortPreference,
      },
  );
  return { tab, scope, state };
}

export function activeRemoteSourceViewState(
  activeTab: LibraryTab,
  remoteSourceStates: Record<number, RemoteSourceViewState>,
) {
  return activeTab.kind === "source"
    ? (remoteSourceStates[activeTab.source.id] ?? defaultRemoteSourceViewState)
    : defaultRemoteSourceViewState;
}

export function activeLibraryBrowseState({
  activeTab,
  remoteSourceState,
  searchQuery,
  workPage,
  workPageSize,
  statusFilter,
  librarySort,
  sortDirection,
  randomSeed,
  mobileColumns,
  desktopColumns,
}: {
  activeTab: LibraryTab;
  remoteSourceState: RemoteSourceViewState;
  searchQuery: string;
  workPage: number;
  workPageSize: LocalWorkPageSize;
  statusFilter: ListeningStatus | "all";
  librarySort: LibrarySort;
  sortDirection: SortDirection;
  randomSeed: number;
  mobileColumns: LibraryColumnSetting;
  desktopColumns: LibraryColumnSetting;
}): LibraryBrowseState {
  const remoteSelected = activeTab.kind === "source";
  return {
    query: searchQuery,
    page: remoteSelected ? remoteSourceState.page : workPage,
    pageSize: remoteSelected ? remoteSourceState.pageSize : workPageSize,
    status: statusFilter,
    sort: librarySort,
    direction: sortDirection,
    randomSeed,
    mobileColumns,
    desktopColumns,
    scrollY: 0,
  };
}

export function libraryBrowseSurfaceState({
  works,
  optimisticSearchClauses,
  workTotal,
  workPage,
  workPageSize,
  activeTab,
  remoteSourceState,
}: {
  works: Work[];
  optimisticSearchClauses: SearchClause[] | null;
  workTotal: number;
  workPage: number;
  workPageSize: LocalWorkPageSize;
  activeTab: LibraryTab;
  remoteSourceState: RemoteSourceViewState;
}) {
  const visibleWorks = optimisticSearchClauses
    ? works.filter((work) => workMatchesSearch(work, optimisticSearchClauses))
    : works;
  const totalWorkPages = Math.max(1, Math.ceil(workTotal / workPageSize));
  const remoteSelected = activeTab.kind === "source";
  return {
    visibleWorks,
    totalWorkPages,
    currentWorkPage: Math.min(workPage, totalWorkPages),
    activePageSize: remoteSelected ? remoteSourceState.pageSize : workPageSize,
    activePageSizeOptions: remoteSelected ? ([12, 24, 48, 96] as const) : localWorkPageSizeOptions,
  };
}
