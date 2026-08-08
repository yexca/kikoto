import type { LibrarySort, ListeningStatus, SortDirection } from "@/lib/api";
import { isWorkCodePath } from "@/lib/workCode";
import {
  isWorkCollectionColumnCount,
  type WorkCollectionColumnSetting,
} from "../components/work-collection/workCollectionLayoutModel";

export const localWorkPageSizeOptions = [24, 48] as const;
export type LocalWorkPageSize = (typeof localWorkPageSizeOptions)[number];
export type LibraryColumnSetting = WorkCollectionColumnSetting;
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
  mobileColumns: LibraryColumnSetting;
  desktopColumns: LibraryColumnSetting;
  scrollY: number;
};

export const defaultLibraryBrowseState: LibraryBrowseState = {
  query: "",
  page: 1,
  pageSize: 24,
  status: "all",
  sort: "recommend",
  direction: "desc",
  randomSeed: 1,
  view: "grid",
  mobileColumns: "auto",
  desktopColumns: "auto",
  scrollY: 0,
};

const storagePrefix = "kikoto:library-browse:";
const lastLocationStoragePrefix = "kikoto:library-last-location:";
const sortPreferenceStoragePrefix = "kikoto:library-sort:";
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
    window.sessionStorage.setItem(`${storagePrefix}${key}`, JSON.stringify({ ...state, query: "" }));
  } catch {
    // Browsing still works when session storage is unavailable.
  }
}

export function readLibrarySortPreference(key: string): Pick<LibraryBrowseState, "sort" | "direction"> | null {
  try {
    const raw = window.localStorage.getItem(`${sortPreferenceStoragePrefix}${key}`);
    if (!raw) return null;
    const value = JSON.parse(raw) as { sort?: unknown; direction?: unknown };
    if (typeof value.sort !== "string" || !sorts.includes(value.sort as LibrarySort)) return null;
    if (value.direction !== "asc" && value.direction !== "desc") return null;
    return { sort: value.sort as LibrarySort, direction: value.direction };
  } catch {
    return null;
  }
}

export function writeLibrarySortPreference(key: string, sort: LibrarySort, direction: SortDirection) {
  try {
    window.localStorage.setItem(`${sortPreferenceStoragePrefix}${key}`, JSON.stringify({ sort, direction }));
  } catch {
    // Sorting still works when local storage is unavailable.
  }
}

export function readLastLibraryLocation(storageScope: string): string | null {
  try {
    return normalizeLibraryBrowseLocation(
      window.sessionStorage.getItem(`${lastLocationStoragePrefix}${storageScope}`) ?? "",
    );
  } catch {
    return null;
  }
}

export function writeLastLibraryLocation(storageScope: string, location: string) {
  const normalized = normalizeLibraryBrowseLocation(location);
  if (!normalized) return;
  try {
    window.sessionStorage.setItem(`${lastLocationStoragePrefix}${storageScope}`, normalized);
  } catch {
    // Navigation still works when session storage is unavailable.
  }
}

export function normalizeLibraryBrowseLocation(location: string): string | null {
  const value = location.trim();
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  const base = "http://kikoto.local";
  try {
    const parsed = new URL(value, base);
    if (parsed.origin !== base || parsed.hash || !isLibraryBrowsePath(parsed.pathname)) return null;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

export function libraryBrowseStateFromSearch(search: string, fallback: LibraryBrowseState): LibraryBrowseState {
  const params = new URLSearchParams(search);
  return libraryBrowseStateFromValue(
    {
      query: params.has("q") ? params.get("q") : "",
      page: params.has("page") ? Number(params.get("page")) : fallback.page,
      pageSize: params.has("pageSize") ? Number(params.get("pageSize")) : fallback.pageSize,
      status: params.has("status") ? params.get("status") : fallback.status,
      sort: params.has("sort") ? params.get("sort") : fallback.sort,
      direction: params.has("direction") ? params.get("direction") : fallback.direction,
      randomSeed: params.has("seed") ? Number(params.get("seed")) : fallback.randomSeed,
      view: params.has("view") ? params.get("view") : fallback.view,
      mobileColumns: params.has("mobileColumns")
        ? parseColumnSearchValue(params.get("mobileColumns"))
        : fallback.mobileColumns,
      desktopColumns: params.has("desktopColumns")
        ? parseColumnSearchValue(params.get("desktopColumns"))
        : fallback.desktopColumns,
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
  const mobileColumns = value.mobileColumns === "auto" ? "auto" : Number(value.mobileColumns);
  const desktopColumns = value.desktopColumns === "auto" ? "auto" : Number(value.desktopColumns);
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
    mobileColumns:
      mobileColumns === "auto" || isWorkCollectionColumnCount(mobileColumns) ? mobileColumns : fallback.mobileColumns,
    desktopColumns:
      desktopColumns === "auto" || isWorkCollectionColumnCount(desktopColumns)
        ? desktopColumns
        : fallback.desktopColumns,
    scrollY: Number.isFinite(scrollY) && scrollY >= 0 ? scrollY : fallback.scrollY,
  };
}

export function libraryBrowseSearch(state: LibraryBrowseState) {
  const params = new URLSearchParams();
  if (state.query.trim()) params.set("q", state.query);
  if (state.status !== "all") params.set("status", state.status);
  const value = params.toString();
  return value ? `?${value}` : "";
}

export function libraryLocation(path: string, state: LibraryBrowseState) {
  return `${path}${libraryBrowseSearch(state)}`;
}

export function withSharedLibraryQuery(state: LibraryBrowseState, query: string): LibraryBrowseState {
  if (state.query === query) return state;
  return { ...state, query, page: 1, scrollY: 0 };
}

export function localPageSize(value: number): LocalWorkPageSize {
  return value === 48 ? 48 : 24;
}

function parseColumnSearchValue(value: string | null) {
  return value === "auto" ? "auto" : Number(value);
}

function isLibraryBrowsePath(path: string) {
  if (["/", "/tracked", "/library", "/library/tracked"].includes(path)) {
    return true;
  }
  if (["/no-source", "/library/no-source", "/library/all", "/library/remote"].includes(path)) {
    return false;
  }
  if (/^\/library\/source\/[^/]+\/?$/.test(path)) return true;
  if (
    [
      "/favorites",
      "/circles",
      "/voices",
      "/workflows",
      "/activity",
      "/runs",
      "/settings",
      "/maintenance",
      "/users",
      "/about",
    ].includes(path.replace(/\/$/, ""))
  ) {
    return false;
  }
  return /^\/[^/]+\/?$/.test(path) && !isWorkCodePath(path);
}
