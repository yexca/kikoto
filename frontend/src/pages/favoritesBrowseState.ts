import type { FavoriteSort, ListeningStatus, SortDirection } from "@/lib/api";

export type FavoriteEntity = "works" | "circles" | "voices";
export type FavoriteAvailability = "all" | "local" | "cache" | "remote" | "missing";

export type FavoritesBrowseState = {
  entity: FavoriteEntity;
  query: string;
  status: ListeningStatus | "all";
  availability: FavoriteAvailability;
  list: "all" | number;
  page: number;
  pageSize: 24 | 48;
  sort: FavoriteSort;
  direction: SortDirection;
  randomSeed: number;
};

export const defaultFavoritesBrowseState: FavoritesBrowseState = {
  entity: "works",
  query: "",
  status: "all",
  availability: "all",
  list: "all",
  page: 1,
  pageSize: 24,
  sort: "activity",
  direction: "desc",
  randomSeed: 1,
};

const storagePrefix = "kikoto:favorites-browse:v2:";

const entities: FavoriteEntity[] = ["works", "circles", "voices"];
const statuses: Array<ListeningStatus | "all"> = ["all", "none", "want_to_listen", "listening", "finished", "relisten", "paused"];
const availabilities: FavoriteAvailability[] = ["all", "local", "cache", "remote", "missing"];
const sorts: FavoriteSort[] = ["activity", "added", "release", "code", "title", "rating", "sales", "random"];

export function favoritesBrowseStateFromSearch(search: string, fallback = defaultFavoritesBrowseState): FavoritesBrowseState {
  const params = new URLSearchParams(search);
  const entity = params.get("entity");
  const status = params.get("status");
  const availability = params.get("availability");
  const rawList = params.get("list");
  const listID = Number(rawList);
  const page = Number(params.get("page"));
  const pageSize = Number(params.get("pageSize"));
  const sort = params.get("sort");
  const randomSeed = Number(params.get("seed"));
  return {
    entity: entities.includes(entity as FavoriteEntity) ? entity as FavoriteEntity : fallback.entity,
    query: params.has("q") ? params.get("q") ?? "" : fallback.query,
    status: statuses.includes(status as ListeningStatus | "all") ? status as ListeningStatus | "all" : fallback.status,
    availability: availabilities.includes(availability as FavoriteAvailability) ? availability as FavoriteAvailability : fallback.availability,
    list: rawList === "all" || rawList === null ? fallback.list : Number.isInteger(listID) && listID > 0 ? listID : fallback.list,
    page: Number.isInteger(page) && page > 0 ? page : fallback.page,
    pageSize: pageSize === 48 ? 48 : pageSize === 24 ? 24 : fallback.pageSize,
    sort: sorts.includes(sort as FavoriteSort) ? sort as FavoriteSort : fallback.sort,
    direction: params.get("direction") === "asc" || params.get("direction") === "desc"
      ? params.get("direction") as SortDirection
      : fallback.direction,
    randomSeed: Number.isInteger(randomSeed) && randomSeed >= 1 && randomSeed <= 2147483646 ? randomSeed : fallback.randomSeed,
  };
}

export function favoritesBrowseStateFromValue(value: unknown, fallback = defaultFavoritesBrowseState): FavoritesBrowseState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const state = value as Partial<Record<keyof FavoritesBrowseState, unknown>>;
  const entity = typeof state.entity === "string" ? state.entity : null;
  const status = typeof state.status === "string" ? state.status : null;
  const availability = typeof state.availability === "string" ? state.availability : null;
  const listID = Number(state.list);
  const page = Number(state.page);
  const pageSize = Number(state.pageSize);
  const sort = typeof state.sort === "string" ? state.sort : null;
  const randomSeed = Number(state.randomSeed);
  return {
    entity: entities.includes(entity as FavoriteEntity) ? entity as FavoriteEntity : fallback.entity,
    query: typeof state.query === "string" ? state.query : fallback.query,
    status: statuses.includes(status as ListeningStatus | "all") ? status as ListeningStatus | "all" : fallback.status,
    availability: availabilities.includes(availability as FavoriteAvailability) ? availability as FavoriteAvailability : fallback.availability,
    list: state.list === "all" ? "all" : Number.isInteger(listID) && listID > 0 ? listID : fallback.list,
    page: Number.isInteger(page) && page > 0 ? page : fallback.page,
    pageSize: pageSize === 48 ? 48 : pageSize === 24 ? 24 : fallback.pageSize,
    sort: sorts.includes(sort as FavoriteSort) ? sort as FavoriteSort : fallback.sort,
    direction: state.direction === "asc" || state.direction === "desc" ? state.direction : fallback.direction,
    randomSeed: Number.isInteger(randomSeed) && randomSeed >= 1 && randomSeed <= 2147483646 ? randomSeed : fallback.randomSeed,
  };
}

export function readFavoritesBrowseState(userID: number) {
  try {
    const raw = window.sessionStorage.getItem(`${storagePrefix}${userID}`);
    return raw ? favoritesBrowseStateFromValue(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writeFavoritesBrowseState(userID: number, state: FavoritesBrowseState) {
  try {
    window.sessionStorage.setItem(`${storagePrefix}${userID}`, JSON.stringify(state));
  } catch {
    // Favorites remains usable when session storage is unavailable.
  }
}

export function favoritesBrowseSearch(state: FavoritesBrowseState) {
  const params = new URLSearchParams();
  if (state.entity !== defaultFavoritesBrowseState.entity) params.set("entity", state.entity);
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
