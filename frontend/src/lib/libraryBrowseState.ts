import type { LibrarySort, ListeningStatus, SortDirection } from "@/lib/api";
import { accountScopeKey, localStore, sessionStore } from "@/lib/clientStorage";
import { isWorkCodePath } from "@/lib/workCode";
import { WORKFLOWS_PATH } from "@/lib/workflowLinks";
import {
  isWorkCollectionColumnCount,
  type WorkCollectionColumnSetting,
} from "../components/work-collection/workCollectionLayoutModel";

export const libraryPageSizeOptions = [24, 48, 96] as const;
export type LibraryPageSize = (typeof libraryPageSizeOptions)[number];
export type LibraryColumnSetting = WorkCollectionColumnSetting;

export type LibraryBrowseState = {
  query: string;
  page: number;
  pageSize: number;
  status: ListeningStatus | "all";
  sort: LibrarySort;
  direction: SortDirection;
  randomSeed: number;
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
  mobileColumns: "auto",
  desktopColumns: "auto",
  scrollY: 0,
};

const browseStorageName = "kikoto:library-browse";
const lastLocationStorageName = "kikoto:library-last-location";
const sortPreferenceStorageName = "kikoto:library-sort";
const statuses = ["none", "want_to_listen", "listening", "finished", "relisten", "paused"] satisfies ListeningStatus[];
const sorts = [
  "recent",
  "release",
  "code",
  "title",
  "rating",
  "user_rating",
  "sales",
  "random",
  "recommend",
] satisfies LibrarySort[];

// `key` is a `libraryBrowseKey`: the account storage scope followed by the tab.
export function readLibraryBrowseState(key: string): LibraryBrowseState | null {
  const value = sessionStore.readJSON(accountScopeKey(browseStorageName, key));
  return value ? libraryBrowseStateFromValue(value, defaultLibraryBrowseState) : null;
}

// Browsing still works when session storage is unavailable.
export function writeLibraryBrowseState(key: string, state: LibraryBrowseState) {
  sessionStore.writeJSON(accountScopeKey(browseStorageName, key), { ...state, query: "" });
}

export function readLibrarySortPreference(key: string): Pick<LibraryBrowseState, "sort" | "direction"> | null {
  const value = localStore.readJSON(accountScopeKey(sortPreferenceStorageName, key));
  if (!value || typeof value !== "object") return null;
  const { sort, direction } = value as { sort?: unknown; direction?: unknown };
  if (typeof sort !== "string" || !sorts.includes(sort as LibrarySort)) return null;
  if (direction !== "asc" && direction !== "desc") return null;
  return { sort: sort as LibrarySort, direction };
}

// Sorting still works when local storage is unavailable.
export function writeLibrarySortPreference(key: string, sort: LibrarySort, direction: SortDirection) {
  localStore.writeJSON(accountScopeKey(sortPreferenceStorageName, key), { sort, direction });
}

export function readLastLibraryLocation(storageScope: string): string | null {
  return normalizeLibraryBrowseLocation(
    sessionStore.read(accountScopeKey(lastLocationStorageName, storageScope)) ?? "",
  );
}

// Navigation still works when session storage is unavailable.
export function writeLastLibraryLocation(storageScope: string, location: string) {
  const normalized = normalizeLibraryBrowseLocation(location);
  if (!normalized) return;
  sessionStore.write(accountScopeKey(lastLocationStorageName, storageScope), normalized);
}

export function normalizeLibraryBrowseLocation(location: string): string | null {
  const value = location.trim();
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  const base = "http://kikoto.invalid";
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

export function libraryPageSize(value: number): LibraryPageSize {
  return libraryPageSizeOptions.find((option) => option === value) ?? 24;
}

function parseColumnSearchValue(value: string | null) {
  return value === "auto" ? "auto" : Number(value);
}

/**
 * The top-level paths that another page renders or redirects from. Every other
 * single segment that is not a work code is a library source's own route.
 */
const otherPageTopLevelPaths = new Set([
  "/about",
  "/activity",
  "/circles",
  "/cleanup",
  "/discover",
  "/favorites",
  "/for-you",
  "/history",
  "/insights",
  "/maintenance",
  "/metadata",
  "/no-source",
  "/records",
  "/runs",
  "/settings",
  "/subscriptions",
  "/system",
  "/tags",
  "/translation",
  "/user-data",
  "/users",
  "/voices",
  "/work-management",
  WORKFLOWS_PATH,
]);

/** Whether a path is one of the Library's lists: a local scope or a library source. */
function isLibraryBrowsePath(path: string) {
  const normalized = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (["/", "/tracked", "/library", "/library/tracked"].includes(normalized)) return true;
  if (/^\/library\/source\/[^/]+$/.test(normalized)) return true;
  return /^\/[^/]+$/.test(normalized) && !isWorkCodePath(normalized) && !otherPageTopLevelPaths.has(normalized);
}
