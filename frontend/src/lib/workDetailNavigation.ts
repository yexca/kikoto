import { isPageID, pageAtPath, type PageID } from "./appPages";
import { NAVIGATION_EVENT, historyStateWithReturn } from "./browserHistory";
import { safeDecodePathSegment } from "./routeSegment";
import { WORK_CODE_PATH_PATTERN } from "./workCode";

const ownerPageStateKey = "__kikotoWorkDetailOwner";

// A remote-only work route is one path segment qualified by a `source` query.
export const REMOTE_SOURCE_WORK_PATTERN = /^\/([^/?#]+)\/?$/;

export type WorkDetailSourceIntent = {
  sourceId: number;
  remoteCode: string;
};

export type WorkDetailIntent =
  | {
      kind: "known";
      canonicalCode: string;
      view?: "local" | "tracked";
      trackedSourceId?: number | null;
      source?: WorkDetailSourceIntent | null;
    }
  | {
      kind: "remote-only";
      sourceId: number;
      remoteCode: string;
    };

export type WorkDetailNavigationOptions = {
  returnTo: string;
  returnLabel: string;
  workPreview?: unknown;
};

export function workDetailRoute(intent: WorkDetailIntent) {
  if (intent.kind === "remote-only") {
    const remoteCode = intent.remoteCode.trim();
    if (!remoteCode || !validSourceID(intent.sourceId)) return null;
    const params = new URLSearchParams({ source: String(intent.sourceId) });
    return `/${encodeURIComponent(remoteCode)}?${params.toString()}`;
  }

  const canonicalCode = intent.canonicalCode.trim();
  if (!canonicalCode) return null;
  const params = new URLSearchParams();
  if (intent.source) {
    const remoteCode = intent.source.remoteCode.trim();
    if (!remoteCode || !validSourceID(intent.source.sourceId)) return null;
    params.set("view", "remote");
    params.set("source", String(intent.source.sourceId));
    params.set("remoteCode", remoteCode);
  } else if (intent.view) {
    params.set("view", intent.view);
    if (intent.view === "tracked" && intent.trackedSourceId && validSourceID(intent.trackedSourceId)) {
      params.set("trackedSource", String(intent.trackedSourceId));
    }
  }
  const query = params.toString();
  return `/${encodeURIComponent(canonicalCode)}${query ? `?${query}` : ""}`;
}

export function openWorkDetail(intent: WorkDetailIntent, options: WorkDetailNavigationOptions) {
  const route = workDetailRoute(intent);
  if (!route) return false;
  window.history.pushState(
    historyStateWithReturn(options.returnTo, options.returnLabel, {
      ...(options.workPreview === undefined ? {} : { workPreview: options.workPreview }),
    }),
    "",
    route,
  );
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
  return true;
}

/**
 * Returns the work code a location opens as work detail, or null for a list
 * location. It is the inverse of `workDetailRoute` and stays free of page
 * imports so the app shell can recognize a direct work link before the Library
 * chunk loads.
 */
export function workDetailCodeFromLocation(path: string, search: string) {
  const standardMatch = path.match(WORK_CODE_PATH_PATTERN);
  if (standardMatch) return standardMatch[1].toUpperCase();
  const sourceID = Number(new URLSearchParams(search).get("source"));
  if (!Number.isFinite(sourceID) || sourceID <= 0) return null;
  // Another page may carry its own `source` query, such as a Settings deep link.
  const pagePath = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (pageAtPath(pagePath)) return null;
  const match = path.match(REMOTE_SOURCE_WORK_PATTERN);
  return match ? safeDecodePathSegment(match[1]) : null;
}

/**
 * The page a work detail entry belongs to: the page it was opened from, so the
 * navigation keeps showing that page and Back returns to it. A direct link has
 * no recorded owner and belongs to Library.
 */
export function workDetailOwnerPage(state: unknown): PageID {
  const owner = state && typeof state === "object" ? (state as Record<string, unknown>)[ownerPageStateKey] : undefined;
  return isPageID(owner) ? owner : "library";
}

/** Keeps an owner the entry already names; `replace` assigns the given one regardless. */
export function historyStateWithWorkDetailOwner(state: unknown, owner: PageID, replace = false) {
  const record = state && typeof state === "object" && !Array.isArray(state) ? (state as Record<string, unknown>) : {};
  if (!replace && isPageID(record[ownerPageStateKey])) return record;
  return { ...record, [ownerPageStateKey]: owner };
}

function validSourceID(value: number) {
  return Number.isInteger(value) && value > 0;
}
