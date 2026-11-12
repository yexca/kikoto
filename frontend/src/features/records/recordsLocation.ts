/**
 * The Record page location. The URL names the open folder, the grid filter and
 * order, and an open video or photo overlay; the history entry carries the
 * breadcrumb trail that led to the folder so Back and reload restore it
 * without another lookup.
 */

export const RECORDS_PATH = "/records";

export const recordKindFilters = ["all", "videos", "photos"] as const;
export type RecordKindFilter = (typeof recordKindFilters)[number];

export const recordSortOrders = ["name", "name-desc"] as const;
export type RecordSortOrder = (typeof recordSortOrders)[number];

export type RecordOverlay = { kind: "video" | "photo"; assetId: number };

export type RecordsLocation = {
  /** The open folder; 0 is the record root. */
  folderId: number;
  filter: RecordKindFilter;
  sort: RecordSortOrder;
  overlay: RecordOverlay | null;
};

/** One breadcrumb step below the root, with the artwork its parent listing reported. */
export type RecordCrumb = {
  id: number;
  name: string;
  posterUrl?: string;
  backdropUrl?: string;
};

export type RecordsNavigation =
  | { mode: "push" | "replace"; href: string; state: Record<string, unknown> }
  /** Return to the entry below, which shows the same folder without the overlay. */
  | { mode: "back"; fallback: { href: string; state: Record<string, unknown> } };

const trailStateKey = "recordTrail";
const overlayStateKey = "recordOverlay";
const maxTrailLength = 64;

function positiveId(value: string | null) {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function readRecordsLocation(search: string): RecordsLocation {
  const params = new URLSearchParams(search);
  const filter = params.get("kind");
  const sort = params.get("sort");
  const play = positiveId(params.get("play"));
  const photo = positiveId(params.get("photo"));
  return {
    folderId: positiveId(params.get("folder")) ?? 0,
    filter: recordKindFilters.includes(filter as RecordKindFilter) ? (filter as RecordKindFilter) : "all",
    sort: recordSortOrders.includes(sort as RecordSortOrder) ? (sort as RecordSortOrder) : "name",
    overlay: play ? { kind: "video", assetId: play } : photo ? { kind: "photo", assetId: photo } : null,
  };
}

/** The canonical href; default values stay out of the URL. */
export function recordsHref(location: RecordsLocation) {
  const params = new URLSearchParams();
  if (location.folderId > 0) params.set("folder", String(location.folderId));
  if (location.filter !== "all") params.set("kind", location.filter);
  if (location.sort !== "name") params.set("sort", location.sort);
  if (location.overlay)
    params.set(location.overlay.kind === "video" ? "play" : "photo", String(location.overlay.assetId));
  const query = params.toString();
  return query ? `${RECORDS_PATH}?${query}` : RECORDS_PATH;
}

function stateRecord(state: unknown): Record<string, unknown> {
  return state && typeof state === "object" && !Array.isArray(state) ? { ...(state as Record<string, unknown>) } : {};
}

function crumbFromValue(value: unknown): RecordCrumb | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "number" || !Number.isSafeInteger(record.id) || record.id <= 0) return null;
  if (typeof record.name !== "string") return null;
  const crumb: RecordCrumb = { id: record.id, name: record.name };
  if (typeof record.posterUrl === "string") crumb.posterUrl = record.posterUrl;
  if (typeof record.backdropUrl === "string") crumb.backdropUrl = record.backdropUrl;
  return crumb;
}

/**
 * The trail a history entry carries for this folder, or null when the entry
 * has none or it names another folder, as after a pasted link.
 */
export function recordTrailFromState(state: unknown, folderId: number): RecordCrumb[] | null {
  const value = stateRecord(state)[trailStateKey];
  if (!Array.isArray(value)) return folderId === 0 ? [] : null;
  const trail = value.map(crumbFromValue);
  if (trail.some((crumb) => crumb === null)) return null;
  const crumbs = trail as RecordCrumb[];
  if (folderId === 0) return crumbs.length === 0 ? [] : null;
  return crumbs.length > 0 && crumbs[crumbs.length - 1].id === folderId ? crumbs : null;
}

export function historyStateWithRecordTrail(state: unknown, trail: readonly RecordCrumb[]) {
  return { ...stateRecord(state), [trailStateKey]: trail.slice(-maxTrailLength) };
}

/** Whether this entry was pushed to open an overlay over its folder. */
export function isRecordOverlayEntry(state: unknown) {
  return stateRecord(state)[overlayStateKey] === true;
}

function withoutOverlayMarker(state: unknown) {
  const next = stateRecord(state);
  delete next[overlayStateKey];
  return next;
}

/** Opens a child folder as a new history entry; the filter and order carry over. */
export function openFolderNavigation(
  current: RecordsLocation,
  trail: readonly RecordCrumb[],
  folder: RecordCrumb,
): RecordsNavigation {
  return {
    mode: "push",
    href: recordsHref({ ...current, folderId: folder.id, overlay: null }),
    state: historyStateWithRecordTrail({}, [...trail, folder]),
  };
}

/** Opens a breadcrumb ancestor (an index into the trail, -1 for the root) as a new entry. */
export function openCrumbNavigation(
  current: RecordsLocation,
  trail: readonly RecordCrumb[],
  index: number,
): RecordsNavigation {
  const nextTrail = index < 0 ? [] : trail.slice(0, index + 1);
  const folderId = nextTrail.length > 0 ? nextTrail[nextTrail.length - 1].id : 0;
  return {
    mode: "push",
    href: recordsHref({ ...current, folderId, overlay: null }),
    state: historyStateWithRecordTrail({}, nextTrail),
  };
}

/** Changes the filter or order in place, so Back leaves the folder rather than undoing a toggle. */
export function updateViewNavigation(
  current: RecordsLocation,
  state: unknown,
  change: Partial<Pick<RecordsLocation, "filter" | "sort">>,
): RecordsNavigation {
  return { mode: "replace", href: recordsHref({ ...current, ...change }), state: stateRecord(state) };
}

/** Opens a video or photo over the folder as its own entry, so Back closes it. */
export function openOverlayNavigation(
  current: RecordsLocation,
  state: unknown,
  overlay: RecordOverlay,
): RecordsNavigation {
  if (current.overlay) return stepOverlayNavigation(current, state, overlay.assetId);
  return {
    mode: "push",
    href: recordsHref({ ...current, overlay }),
    state: { ...withoutOverlayMarker(state), [overlayStateKey]: true },
  };
}

/**
 * Opens a video in its own folder, as Continue watching does from the root.
 * The player sits over that folder in a new entry, so closing it goes back to
 * the place it was opened from; the folder's trail is recovered from its listing.
 */
export function openFolderVideoNavigation(
  current: RecordsLocation,
  folderId: number,
  assetId: number,
): RecordsNavigation {
  return {
    mode: "push",
    href: recordsHref({ ...current, folderId, overlay: { kind: "video", assetId } }),
    state: { [overlayStateKey]: true },
  };
}

/** Moves the open overlay to a sibling without adding a Back step. */
export function stepOverlayNavigation(current: RecordsLocation, state: unknown, assetId: number): RecordsNavigation {
  if (!current.overlay) return { mode: "replace", href: recordsHref(current), state: stateRecord(state) };
  return {
    mode: "replace",
    href: recordsHref({ ...current, overlay: { ...current.overlay, assetId } }),
    state: stateRecord(state),
  };
}

/**
 * Closes the overlay. An overlay this page opened returns through history, so
 * the folder entry below it is reused; one opened from a pasted or reloaded
 * link has no such entry and is replaced by its folder instead.
 */
export function closeOverlayNavigation(current: RecordsLocation, state: unknown): RecordsNavigation {
  const fallback = { href: recordsHref({ ...current, overlay: null }), state: withoutOverlayMarker(state) };
  if (isRecordOverlayEntry(state)) return { mode: "back", fallback };
  return { mode: "replace", ...fallback };
}
