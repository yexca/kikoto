import type { LibrarySort, ListeningStatus, SortDirection } from "@/lib/api";

export const localWorkPageSizeOptions = [24, 48] as const;
export type LocalWorkPageSize = (typeof localWorkPageSizeOptions)[number];
export const columnOptions = [1, 2, 3, 4, 5, 6, 7, 8] as const;
export type LibraryColumnCount = (typeof columnOptions)[number];
export type LibraryViewMode = "grid" | "masonry";

export type LibraryBrowseState = {
  query: string;
  page: number;
  pageSize: number;
  status: ListeningStatus | "all";
  sort: LibrarySort;
  direction: SortDirection;
  randomSeed: number;
  view: LibraryViewMode;
  mobileColumns: LibraryColumnCount;
  desktopColumns: LibraryColumnCount;
  scrollY: number;
};

export const defaultLibraryBrowseState: LibraryBrowseState = {
  query: "",
  page: 1,
  pageSize: 24,
  status: "all",
  sort: "recent",
  direction: "desc",
  randomSeed: 1,
  view: "grid",
  mobileColumns: 1,
  desktopColumns: 6,
  scrollY: 0,
};

const storagePrefix = "kikoto:library-browse:";
const statuses = ["none", "want_to_listen", "listening", "finished", "relisten", "paused"] satisfies ListeningStatus[];
const sorts = ["recent", "release", "code", "title", "rating", "sales", "random", "recommend"] satisfies LibrarySort[];

export function readLibraryBrowseState(key: string): LibraryBrowseState | null {
  try {
    const raw = window.sessionStorage.getItem(`${storagePrefix}${key}`);
    return raw ? libraryBrowseStateFromValue(JSON.parse(raw), defaultLibraryBrowseState) : null;
  } catch {
    return null;
  }
}

export function writeLibraryBrowseState(key: string, state: LibraryBrowseState) {
  try {
    window.sessionStorage.setItem(`${storagePrefix}${key}`, JSON.stringify(state));
  } catch {
    // Browsing still works when session storage is unavailable.
  }
}

export function libraryBrowseStateFromSearch(search: string, fallback: LibraryBrowseState): LibraryBrowseState {
  const params = new URLSearchParams(search);
  return libraryBrowseStateFromValue(
    {
      query: params.has("q") ? params.get("q") : fallback.query,
      page: params.has("page") ? Number(params.get("page")) : fallback.page,
      pageSize: params.has("pageSize") ? Number(params.get("pageSize")) : fallback.pageSize,
      status: params.has("status") ? params.get("status") : fallback.status,
      sort: params.has("sort") ? params.get("sort") : fallback.sort,
      direction: params.has("direction") ? params.get("direction") : fallback.direction,
      randomSeed: params.has("seed") ? Number(params.get("seed")) : fallback.randomSeed,
      view: params.has("view") ? params.get("view") : fallback.view,
      mobileColumns: params.has("mobileColumns") ? Number(params.get("mobileColumns")) : fallback.mobileColumns,
      desktopColumns: params.has("desktopColumns") ? Number(params.get("desktopColumns")) : fallback.desktopColumns,
      scrollY: fallback.scrollY,
    },
    fallback,
  );
}

export function libraryBrowseStateFromValue(
  value: Partial<Record<keyof LibraryBrowseState, unknown>>,
  fallback: LibraryBrowseState,
): LibraryBrowseState {
  const page = Number(value.page);
  const pageSize = Number(value.pageSize);
  const mobileColumns = Number(value.mobileColumns);
  const desktopColumns = Number(value.desktopColumns);
  const scrollY = Number(value.scrollY);
  const randomSeed = Number(value.randomSeed);
  const status =
    typeof value.status === "string" && (value.status === "all" || statuses.includes(value.status as ListeningStatus))
      ? (value.status as ListeningStatus | "all")
      : fallback.status;
  const sort =
    typeof value.sort === "string" && sorts.includes(value.sort as LibrarySort)
      ? (value.sort as LibrarySort)
      : fallback.sort;
  return {
    query: typeof value.query === "string" ? value.query : fallback.query,
    page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : fallback.page,
    pageSize: Number.isFinite(pageSize) && pageSize >= 1 && pageSize <= 100 ? Math.floor(pageSize) : fallback.pageSize,
    status,
    sort,
    direction: value.direction === "asc" || value.direction === "desc" ? value.direction : fallback.direction,
    randomSeed:
      Number.isFinite(randomSeed) && randomSeed >= 1 && randomSeed <= 2147483646
        ? Math.floor(randomSeed)
        : fallback.randomSeed,
    view: value.view === "grid" || value.view === "masonry" ? value.view : fallback.view,
    mobileColumns: columnOptions.includes(mobileColumns as LibraryColumnCount)
      ? (mobileColumns as LibraryColumnCount)
      : fallback.mobileColumns,
    desktopColumns: columnOptions.includes(desktopColumns as LibraryColumnCount)
      ? (desktopColumns as LibraryColumnCount)
      : fallback.desktopColumns,
    scrollY: Number.isFinite(scrollY) && scrollY >= 0 ? scrollY : fallback.scrollY,
  };
}

export function libraryBrowseSearch(state: LibraryBrowseState) {
  const params = new URLSearchParams();
  if (state.query.trim()) params.set("q", state.query);
  params.set("page", String(state.page));
  params.set("pageSize", String(state.pageSize));
  params.set("sort", state.sort);
  params.set("direction", state.direction);
  params.set("seed", String(state.randomSeed));
  params.set("status", state.status);
  params.set("view", state.view);
  params.set("mobileColumns", String(state.mobileColumns));
  params.set("desktopColumns", String(state.desktopColumns));
  return `?${params.toString()}`;
}

export function libraryLocation(path: string, state: LibraryBrowseState) {
  return `${path}${libraryBrowseSearch(state)}`;
}

export function localPageSize(value: number): LocalWorkPageSize {
  return value === 48 ? 48 : 24;
}
