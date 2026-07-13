import type { ListeningStatus } from "@/lib/api";

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
};

export const defaultFavoritesBrowseState: FavoritesBrowseState = {
  entity: "works",
  query: "",
  status: "all",
  availability: "all",
  list: "all",
  page: 1,
  pageSize: 24,
};

const entities: FavoriteEntity[] = ["works", "circles", "voices"];
const statuses: Array<ListeningStatus | "all"> = ["all", "none", "want_to_listen", "listening", "finished", "relisten", "paused"];
const availabilities: FavoriteAvailability[] = ["all", "local", "cache", "remote", "missing"];

export function favoritesBrowseStateFromSearch(search: string, fallback = defaultFavoritesBrowseState): FavoritesBrowseState {
  const params = new URLSearchParams(search);
  const entity = params.get("entity");
  const status = params.get("status");
  const availability = params.get("availability");
  const rawList = params.get("list");
  const listID = Number(rawList);
  const page = Number(params.get("page"));
  const pageSize = Number(params.get("pageSize"));
  return {
    entity: entities.includes(entity as FavoriteEntity) ? entity as FavoriteEntity : fallback.entity,
    query: params.has("q") ? params.get("q") ?? "" : fallback.query,
    status: statuses.includes(status as ListeningStatus | "all") ? status as ListeningStatus | "all" : fallback.status,
    availability: availabilities.includes(availability as FavoriteAvailability) ? availability as FavoriteAvailability : fallback.availability,
    list: rawList === "all" || rawList === null ? fallback.list : Number.isInteger(listID) && listID > 0 ? listID : fallback.list,
    page: Number.isInteger(page) && page > 0 ? page : fallback.page,
    pageSize: pageSize === 48 ? 48 : pageSize === 24 ? 24 : fallback.pageSize,
  };
}

export function favoritesBrowseSearch(state: FavoritesBrowseState) {
  const params = new URLSearchParams();
  params.set("entity", state.entity);
  if (state.query.trim()) params.set("q", state.query);
  params.set("status", state.status);
  params.set("availability", state.availability);
  params.set("list", String(state.list));
  params.set("page", String(state.page));
  params.set("pageSize", String(state.pageSize));
  return `?${params.toString()}`;
}

export function favoritesLocation(state: FavoritesBrowseState) {
  return `/favorites${favoritesBrowseSearch(state)}`;
}

export function personalTagSearch(tag: string) {
  const value = tag.trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return value ? `mytag:"${value}"` : "";
}
