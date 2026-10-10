import { openWorkDetail, REMOTE_SOURCE_WORK_PATTERN, workDetailCodeFromLocation } from "@/app/workDetailNavigation";
import { type DetailSourceIntent, remoteSourceTabKey } from "@/features/work-detail/source/sourceContextModel";
import type { RemoteWorkPreview, WorkPreview } from "@/features/work-detail/workDetailShared";
import type { LibrarySource, Work } from "@/lib/api";
import { WORK_CODE_PATH_PATTERN } from "@/lib/workCode";

import { remoteWorkPreviewFromHistory } from "./workPreviewHistory";

export type LibraryTab = { kind: "all" } | { kind: "source"; source: LibrarySource };

export type LocalLibraryScope = "local" | "tracked";

export function localBrowseRoute(path: string) {
  const normalized = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return [
    "/",
    "/library",
    "/tracked",
    "/library/tracked",
    "/no-source",
    "/library/no-source",
    "/library/all",
    "/library/remote",
  ].includes(normalized);
}

export function knownLibraryRoute(path: string, search: string, sources: LibrarySource[]) {
  const normalizedPath = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (
    [
      "/",
      "/library",
      "/tracked",
      "/library/tracked",
      "/no-source",
      "/library/no-source",
      "/library/all",
      "/library/remote",
    ].includes(normalizedPath)
  )
    return true;
  if (WORK_CODE_PATH_PATTERN.test(normalizedPath)) return true;

  const sourceID = Number(new URLSearchParams(search).get("source"));
  if (Number.isInteger(sourceID) && sourceID > 0) {
    return REMOTE_SOURCE_WORK_PATTERN.test(normalizedPath) && sources.some((source) => source.id === sourceID);
  }

  const encodedKey = normalizedPath.startsWith("/library/source/")
    ? normalizedPath.slice("/library/source/".length)
    : (normalizedPath.match(/^\/[^/]+$/)?.[0].slice(1) ?? "");
  if (!encodedKey) return false;
  const key = safeDecodePathSegment(encodedKey).toLowerCase();
  return sources.some(
    (source) => sourceRouteKey(source).toLowerCase() === key || source.displayName.toLowerCase() === key,
  );
}

export function tabFromPath(
  path: string,
  sources: LibrarySource[],
  fallback: LibraryTab = { kind: "all" },
): LibraryTab {
  if (path === "/tracked" || path === "/library/tracked") {
    return { kind: "all" };
  }
  if (path === "/no-source" || path === "/library/no-source") {
    return { kind: "all" };
  }
  if (path === "/" || path === "/library") {
    return { kind: "all" };
  }
  if (path === "/library/all" || path === "/library/remote") {
    return { kind: "all" };
  }
  const encodedKey = path.startsWith("/library/source/")
    ? path.slice("/library/source/".length).replace(/\/$/, "")
    : path.replace(/^\//, "").replace(/\/$/, "");
  if (encodedKey === "") {
    return fallback;
  }
  if (WORK_CODE_PATH_PATTERN.test(`/${encodedKey}`)) {
    return fallback;
  }
  const key = safeDecodePathSegment(encodedKey).toLowerCase();
  const source = sources.find(
    (item) => sourceRouteKey(item).toLowerCase() === key || item.displayName.toLowerCase() === key,
  );
  return source ? { kind: "source", source } : fallback;
}

export function pathForLibraryTab(tab: LibraryTab) {
  switch (tab.kind) {
    case "source":
      return `/${encodeURIComponent(sourceRouteKey(tab.source))}`;
    default:
      return "/";
  }
}

export function pathForLocalScope(scope: LocalLibraryScope) {
  switch (scope) {
    case "tracked":
      return "/tracked";
    case "local":
      return "/";
    default:
      return null;
  }
}

export function pathForActiveLibrary(tab: LibraryTab, scope: LocalLibraryScope) {
  return tab.kind === "source" ? pathForLibraryTab(tab) : (pathForLocalScope(scope) ?? "/");
}

export function libraryBrowseKey(tab: LibraryTab, scope: LocalLibraryScope, storageScope: string) {
  return tab.kind === "source" ? `${storageScope}:source:${tab.source.id}` : `${storageScope}:scope:${scope}`;
}

export function localScopeFromPath(path: string): LocalLibraryScope {
  if (path === "/tracked" || path === "/library/tracked") return "tracked";
  return "local";
}

function sourceRouteKey(source: LibrarySource) {
  return source.code || source.displayName;
}

function safeDecodePathSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function detailSourceIntentFromLocation(search: string): DetailSourceIntent {
  const params = new URLSearchParams(search);
  if (params.get("view") === "tracked") return "tracked";
  if (params.get("view") === "remote") {
    const sourceID = Number(params.get("source"));
    if (Number.isInteger(sourceID) && sourceID > 0) return remoteSourceTabKey(sourceID);
  }
  return "local";
}

export function detailTrackedSourceIDFromLocation(search: string) {
  const value = Number(new URLSearchParams(search).get("trackedSource"));
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function detailRemoteCodeFromLocation(search: string) {
  const params = new URLSearchParams(search);
  return params.get("view") === "remote" ? (params.get("remoteCode") ?? "").trim() : "";
}

export function recentWorkSourceIntent(work: Work): DetailSourceIntent {
  const hasLocal = (work.sourcePresence ?? []).some(
    (item) => item.type === "local" && item.availability === "available",
  );
  const hasTracked = (work.sourcePresence ?? []).some(
    (item) => item.type === "tracked" && item.availability === "available",
  );
  return hasLocal || !hasTracked ? "local" : "tracked";
}

export function remoteTargetFromLocation(path: string, search: string, sources: LibrarySource[]) {
  const code = workDetailCodeFromLocation(path, search);
  if (!code) return null;
  const params = new URLSearchParams(search);
  if (params.get("view") === "remote") return null;
  const sourceID = Number(params.get("source"));
  if (!Number.isFinite(sourceID) || sourceID <= 0) return null;
  const source = sources.find((candidate) => candidate.id === sourceID);
  const preview = remoteWorkPreviewFromHistory(code);
  return source ? { source, code, ...(preview ? { preview } : {}) } : null;
}

export function openRemoteSourceWorkRoute(
  sourceID: number,
  code: string,
  returnTo: string,
  returnLabel: string,
  workPreview?: RemoteWorkPreview,
) {
  const cleanCode = code.trim();
  if (!cleanCode) return;
  openWorkDetail(
    { kind: "remote-only", sourceId: sourceID, remoteCode: cleanCode },
    { returnTo, returnLabel, ...(workPreview ? { workPreview } : {}) },
  );
}

export function openPersistedRemoteSourceWorkRoute(
  sourceID: number,
  canonicalCode: string,
  remoteCode: string,
  returnTo: string,
  returnLabel: string,
  workPreview: WorkPreview,
) {
  openWorkDetail(
    {
      kind: "known",
      canonicalCode,
      source: { sourceId: sourceID, remoteCode },
    },
    { returnTo, returnLabel, workPreview },
  );
}
