import type { FavoriteSort, ListeningStatus, SortDirection } from "@/lib/api";
import { currentScopedStorageKey, type ClientPrincipalID } from "@/lib/clientStorageScope";

export type FavoriteAvailability = "all" | "available" | "local" | "remote" | "missing";
/** A listening status, every work, or any Quick mark (`marked`), which the Marked system list also holds. */
export type FavoriteStatusFilter = ListeningStatus | "all" | "marked";
export const favoritePageSizeOptions = [24, 48, 96] as const;
export type FavoritePageSize = (typeof favoritePageSizeOptions)[number];

export type FavoritesBrowseState = {
  query: string;
  status: FavoriteStatusFilter;
  availability: FavoriteAvailability;
  list: "all" | number;
  page: number;
  pageSize: FavoritePageSize;
  sort: FavoriteSort;
  direction: SortDirection;
  randomSeed: number;
};

export const defaultFavoritesBrowseState: FavoritesBrowseState = {
  query: "",
  status: "all",
  availability: "all",
  list: "all",
  page: 1,
  pageSize: 24,
  sort: "added",
  direction: "desc",
  randomSeed: 1,
};

const favoritesBrowseStorageKey = "kikoto:favorites-browse:v3";

const statuses: FavoriteStatusFilter[] = [
  "all",
  "marked",
  "none",
  "want_to_listen",
  "listening",
  "finished",
  "relisten",
  "paused",
];
const availabilities: FavoriteAvailability[] = ["all", "available", "local", "remote", "missing"];
const sorts: FavoriteSort[] = [
  "activity",
  "added",
  "release",
  "code",
  "title",
  "rating",
  "user_rating",
  "sales",
  "random",
];

export function favoritesBrowseStateFromSearch(
  search: string,
  fallback = defaultFavoritesBrowseState,
): FavoritesBrowseState {
  const params = new URLSearchParams(search);
  const status = params.get("status");
  const availability = params.get("availability");
  const rawList = params.get("list");
  const listID = Number(rawList);
  const page = Number(params.get("page"));
  const pageSize = Number(params.get("pageSize"));
  const sort = params.get("sort");
  const randomSeed = Number(params.get("seed"));
  return {
    query: params.has("q") ? (params.get("q") ?? "") : fallback.query,
    status: statuses.includes(status as FavoriteStatusFilter) ? (status as FavoriteStatusFilter) : fallback.status,
    availability: availabilities.includes(availability as FavoriteAvailability)
      ? (availability as FavoriteAvailability)
      : fallback.availability,
    list:
      rawList === "all" || rawList === null
        ? fallback.list
        : Number.isInteger(listID) && listID > 0
          ? listID
          : fallback.list,
    page: Number.isInteger(page) && page > 0 ? page : fallback.page,
    pageSize: favoritePageSizeOptions.find((option) => option === pageSize) ?? fallback.pageSize,
    sort: sorts.includes(sort as FavoriteSort) ? (sort as FavoriteSort) : fallback.sort,
    direction:
      params.get("direction") === "asc" || params.get("direction") === "desc"
        ? (params.get("direction") as SortDirection)
        : fallback.direction,
    randomSeed:
      Number.isInteger(randomSeed) && randomSeed >= 1 && randomSeed <= 2147483646 ? randomSeed : fallback.randomSeed,
  };
}

export function favoritesBrowseStateFromValue(
  value: unknown,
  fallback = defaultFavoritesBrowseState,
): FavoritesBrowseState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const state = value as Partial<Record<keyof FavoritesBrowseState, unknown>>;
  const status = typeof state.status === "string" ? state.status : null;
  const availability = typeof state.availability === "string" ? state.availability : null;
  const listID = Number(state.list);
  const page = Number(state.page);
  const pageSize = Number(state.pageSize);
  const sort = typeof state.sort === "string" ? state.sort : null;
  const randomSeed = Number(state.randomSeed);
  return {
    query: typeof state.query === "string" ? state.query : fallback.query,
    status: statuses.includes(status as FavoriteStatusFilter) ? (status as FavoriteStatusFilter) : fallback.status,
    availability: availabilities.includes(availability as FavoriteAvailability)
      ? (availability as FavoriteAvailability)
      : fallback.availability,
    list: state.list === "all" ? "all" : Number.isInteger(listID) && listID > 0 ? listID : fallback.list,
    page: Number.isInteger(page) && page > 0 ? page : fallback.page,
    pageSize: favoritePageSizeOptions.find((option) => option === pageSize) ?? fallback.pageSize,
    sort: sorts.includes(sort as FavoriteSort) ? (sort as FavoriteSort) : fallback.sort,
    direction: state.direction === "asc" || state.direction === "desc" ? state.direction : fallback.direction,
    randomSeed:
      Number.isInteger(randomSeed) && randomSeed >= 1 && randomSeed <= 2147483646 ? randomSeed : fallback.randomSeed,
  };
}

export function readFavoritesBrowseState(principalID: ClientPrincipalID) {
  try {
    const raw = window.sessionStorage.getItem(currentScopedStorageKey(favoritesBrowseStorageKey, principalID));
    return raw ? favoritesBrowseStateFromValue(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writeFavoritesBrowseState(principalID: ClientPrincipalID, state: FavoritesBrowseState) {
  try {
    window.sessionStorage.setItem(
      currentScopedStorageKey(favoritesBrowseStorageKey, principalID),
      JSON.stringify(state),
    );
  } catch {
    // Favorites remains usable when session storage is unavailable.
  }
}

export function favoritesBrowseSearch(state: FavoritesBrowseState) {
  const params = new URLSearchParams();
  if (state.query.trim()) params.set("q", state.query);
  const value = params.toString();
  return value ? `?${value}` : "";
}

export function favoritesLocation(state: FavoritesBrowseState) {
  return `/favorites${favoritesBrowseSearch(state)}`;
}

export function personalTagSearch(tag: string) {
  const value = tag.trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return value ? `mytag:"${value}"` : "";
}
