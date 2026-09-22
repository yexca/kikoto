import { NAVIGATION_EVENT, historyStateWithReturn } from "../lib/browserHistory";
import { WORK_CODE_PATH_PATTERN } from "../lib/workCode";

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
  const match = path.match(REMOTE_SOURCE_WORK_PATTERN);
  return match ? safeDecodePathSegment(match[1]) : null;
}

function safeDecodePathSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function validSourceID(value: number) {
  return Number.isInteger(value) && value > 0;
}
