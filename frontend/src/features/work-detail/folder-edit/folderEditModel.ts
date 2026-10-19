import type {
  ComposedFetchPlan,
  ComposedFetchRequest,
  MediaItem,
  RemoteFetchFileDecision,
  RemoteFetchPreparation,
  RemoteFetchResolution,
  RemoteTrack,
  RemoteWorkSavePlanItem,
  WorkFolderEditAddition,
  WorkFolderEditItem,
  WorkFolderEditMergeCheck,
  WorkFolderEditMoveRequest,
  WorkFolderEditPlan,
  WorkFolderEditRequest,
  WorkFolderEditSources,
} from "../../../lib/api";
import { buildRemoteTree, flattenTreeFiles } from "../media/mediaTreeModel";
import { isLocalOffline } from "../../../lib/localAvailability";
import { emptyFolderEditLayout, inLyricsFolder, pathIdentity, type FolderEditLayout } from "./folderEditLayout";

/** The resource that is the edited folder itself. */
export const CURRENT_FOLDER_RESOURCE = "current";

export type FolderEditTarget = {
  workId: number;
  /** The edited folder; 0 for the new folder a Fetch creates. */
  folderId: number;
  rootPath: string;
};

/** The edition a Fetch publishes into a new folder, and the source it fetches it from. */
export type FetchComposeTarget = {
  sourceId: number;
  sourceName: string;
  /** The code the source knows the edition by. */
  remoteCode: string;
  /** The library edition the new folder belongs to. */
  editionCode: string;
};

/**
 * A place files can come from. The edited folder is the `current` resource:
 * its selected files stay, and the files cleared there are removed.
 */
export type FolderEditResource = {
  id: string;
  kind: "current" | "local" | "remote";
  editionCode: string;
  language: string;
  origin: boolean;
  /** Local resources: the folder and the edition work that owns it. */
  folderId: number;
  workId: number;
  rootPath: string;
  /** Remote resources: the configured source that offers the edition. */
  sourceId: number;
  sourceName: string;
  /** The code the source knows the edition by, when it differs from the edition's own. */
  remoteCode?: string;
  /** Local resources: the folder's storage pool is offline, so nothing can be taken from it. */
  offline?: boolean;
};

export type FolderEditFile = {
  /** The path inside the resource, which is also where the file lands in the edited folder. */
  path: string;
  name: string;
  kind: string;
  sizeBytes: number | null;
  /** The local file location, for files of the edited folder. */
  locationId: number | null;
};

export type FolderEditSelection = Readonly<Record<string, ReadonlySet<string>>>;

/**
 * The files of each resource that are added as lyrics, by path, with their
 * declared language; the empty language is the fallback lyrics. A file without
 * an entry is added as a file at its own path.
 */
export type FolderEditLyricsRoles = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** Sets the role of the given files: lyrics of a language, or a plain file for `null`. */
export function withLyricsRole(
  roles: Readonly<Record<string, string>> | undefined,
  paths: readonly string[],
  language: string | null,
): Readonly<Record<string, string>> {
  const next: Record<string, string> = { ...roles };
  for (const path of paths) {
    if (language === null) delete next[path];
    else next[path] = language;
  }
  return next;
}

export type FolderEditTreeNode<T> = {
  name: string;
  path: string;
  children: Map<string, FolderEditTreeNode<T>>;
  files: T[];
};

/**
 * What happens to one file of the result. A file added by a move inside the
 * folder is `add_move`, and the place it leaves is `moved`. A `pending` file is
 * added once the server's preview of it arrives.
 */
export type FolderEditResultState =
  | "keep"
  | "remove"
  | "replaced"
  | "moved"
  | "same"
  | "add_local"
  | "add_remote"
  | "add_move"
  | "conflict"
  | "excluded"
  | "pending";

/** What a result row shows of the planned addition behind it. */
export type FolderEditResultItem = Pick<
  WorkFolderEditItem,
  | "itemKey"
  | "resolution"
  | "targetConflict"
  | "targetConflictReason"
  | "targetBlock"
  | "targetBlocker"
  | "sourceKind"
  | "remoteSourceName"
  | "localSourcePath"
  | "remoteCode"
>;

/**
 * The resolutions a conflict offers. A folder or link at the target is never
 * replaced, and nothing can be created below a file that blocks the path.
 */
export function conflictResolutions(item: Pick<FolderEditResultItem, "targetBlock">): RemoteFetchResolution[] {
  if (item.targetBlock === "blocked_path") return ["auto", "keep_local", "rename"];
  if (item.targetBlock === "not_a_file") return ["auto", "keep_local", "keep_both", "rename"];
  return ["auto", "keep_local", "replace", "keep_both", "rename"];
}

/** One file of the folder as it will be after the edit, or one that leaves it. */
export type FolderEditResultEntry = {
  key: string;
  path: string;
  name: string;
  kind: string;
  sizeBytes: number | null;
  state: FolderEditResultState;
  /** The planned addition behind an added, conflicting, or excluded entry. */
  item: FolderEditResultItem | null;
};

function normalizePath(path: string) {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function localResourceId(folderId: number) {
  return `local:${folderId}`;
}

function remoteResourceId(sourceId: number, editionCode: string) {
  return `remote:${sourceId}:${editionCode.toUpperCase()}`;
}

/**
 * Lists the edited folder first, then every other active local folder of the
 * family, then every edition a configured source reports as available. A
 * folder whose path differs from the edited folder's only in letter case is
 * the edited folder to the server, so it is not listed as another place.
 */
export function folderEditResources(sources: WorkFolderEditSources, target: FolderEditTarget): FolderEditResource[] {
  const base = { folderId: 0, workId: 0, rootPath: "", sourceId: 0, sourceName: "" };
  const targetRoot = normalizePath(target.rootPath).toLowerCase();
  const targetEdition = sources.editions.find((edition) => edition.workId === target.workId);
  const resources: FolderEditResource[] = [
    {
      ...base,
      id: CURRENT_FOLDER_RESOURCE,
      kind: "current",
      editionCode: targetEdition?.primaryCode ?? sources.primaryCode,
      language: targetEdition?.metadataLanguage || targetEdition?.editionLabel || "",
      origin: targetEdition?.origin ?? false,
      folderId: target.folderId,
      workId: target.workId,
      rootPath: normalizePath(target.rootPath),
    },
  ];
  for (const edition of sources.editions) {
    for (const root of edition.localRoots ?? []) {
      if (root.state !== "active" || root.id === target.folderId) continue;
      if (targetRoot && normalizePath(root.rootPath).toLowerCase() === targetRoot) continue;
      resources.push({
        ...base,
        id: localResourceId(root.id),
        kind: "local",
        editionCode: edition.primaryCode,
        language: edition.metadataLanguage || edition.editionLabel,
        origin: edition.origin,
        folderId: root.id,
        workId: edition.workId,
        rootPath: normalizePath(root.rootPath),
        offline: isLocalOffline(root.availability),
      });
    }
  }
  for (const edition of sources.editions) {
    for (const source of edition.sources ?? []) {
      if (source.status !== "available") continue;
      resources.push({
        ...base,
        id: remoteResourceId(source.sourceId, edition.primaryCode),
        kind: "remote",
        editionCode: edition.primaryCode,
        language: edition.metadataLanguage || edition.editionLabel,
        origin: edition.origin,
        sourceId: source.sourceId,
        sourceName: source.displayName,
      });
    }
  }
  return resources;
}

/** The resource a Fetch from a remote source opens on, when the source offers it. */
export function folderEditRemoteResource(resources: FolderEditResource[], sourceId: number, editionCode: string) {
  const exact = resources.find((resource) => resource.id === remoteResourceId(sourceId, editionCode));
  return exact ?? resources.find((resource) => resource.kind === "remote" && resource.sourceId === sourceId) ?? null;
}

/** The available local files of a work that lie inside one of its folders. */
export function localFolderFiles(items: MediaItem[], rootPath: string): FolderEditFile[] {
  const prefix = `${normalizePath(rootPath)}/`;
  const files: FolderEditFile[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    for (const location of item.locations) {
      if (location.locationType !== "local" || location.availability !== "available") continue;
      const full = normalizePath(location.path);
      if (!full.startsWith(prefix)) continue;
      const path = full.slice(prefix.length);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      files.push({
        path,
        name: path.split("/").pop() ?? path,
        kind: item.kind,
        sizeBytes: location.sizeBytes,
        locationId: location.id,
      });
    }
  }
  return files;
}

/** The downloadable files of a remote edition, by their path in its tree. */
export function remoteEditionFiles(tracks: RemoteTrack[]): FolderEditFile[] {
  const seen = new Set<string>();
  const files: FolderEditFile[] = [];
  for (const file of flattenTreeFiles(buildRemoteTree(tracks))) {
    if (!(file.downloadUrl || file.streamUrl) || seen.has(file.sourcePath)) continue;
    seen.add(file.sourcePath);
    files.push({
      path: file.sourcePath,
      name: file.title,
      kind: file.kind,
      sizeBytes: file.sizeBytes,
      locationId: null,
    });
  }
  return files;
}

/** The tree of files, with the given folders present even where they hold nothing. */
export function buildFolderEditTree<T extends { path: string }>(
  files: readonly T[],
  folders: readonly string[] = [],
): FolderEditTreeNode<T> {
  const root: FolderEditTreeNode<T> = { name: "", path: "", children: new Map(), files: [] };
  const place = (parts: readonly string[]) => {
    let cursor = root;
    for (const folder of parts) {
      let child = cursor.children.get(folder);
      if (!child) {
        child = {
          name: folder,
          path: cursor.path ? `${cursor.path}/${folder}` : folder,
          children: new Map(),
          files: [],
        };
        cursor.children.set(folder, child);
      }
      cursor = child;
    }
    return cursor;
  };
  for (const folder of folders) place(normalizePath(folder).split("/").filter(Boolean));
  for (const file of files) {
    const parts = normalizePath(file.path).split("/").filter(Boolean);
    place(parts.slice(0, -1)).files.push(file);
  }
  return root;
}

export function folderEditTreeFiles<T>(node: FolderEditTreeNode<T>): T[] {
  return [...node.files, ...Array.from(node.children.values()).flatMap(folderEditTreeFiles)];
}

export function withFolderEditPaths(selected: ReadonlySet<string>, paths: readonly string[], included: boolean) {
  const next = new Set(selected);
  for (const path of paths) {
    if (included) next.add(path);
    else next.delete(path);
  }
  return next;
}

/**
 * The selection of a folder whose file list was refreshed: a file that was
 * already listed keeps its selection, a file that newly appears starts
 * selected, and a file that is gone drops out. Without an earlier list every
 * file starts selected.
 */
export function refreshedFolderEditSelection(
  selected: ReadonlySet<string> | undefined,
  previous: ReadonlySet<string> | null,
  files: readonly FolderEditFile[],
) {
  const next = new Set<string>();
  for (const file of files) {
    if (!previous?.has(file.path) || selected?.has(file.path)) next.add(file.path);
  }
  return next;
}

export function folderEditSelectedBytes(files: readonly FolderEditFile[], selected: ReadonlySet<string>) {
  return files.reduce((sum, file) => (selected.has(file.path) ? sum + (file.sizeBytes ?? 0) : sum), 0);
}

/** The extensions present among files, most common first. */
export function folderEditExtensions(files: readonly FolderEditFile[]) {
  const counts = new Map<string, string[]>();
  for (const file of files) {
    const dot = file.name.lastIndexOf(".");
    if (dot <= 0 || dot === file.name.length - 1) continue;
    const extension = file.name.slice(dot + 1).toLowerCase();
    counts.set(extension, [...(counts.get(extension) ?? []), file.path]);
  }
  return Array.from(counts, ([extension, paths]) => ({ extension, paths })).sort(
    (left, right) => right.paths.length - left.paths.length || left.extension.localeCompare(right.extension),
  );
}

/** How many files of a resource the edit changes: removed for the edited folder, added for any other. */
export function folderEditResourceChanges(
  resource: FolderEditResource,
  files: readonly FolderEditFile[] | undefined,
  selected: ReadonlySet<string> | undefined,
) {
  if (!files) return 0;
  const count = files.filter((file) => selected?.has(file.path)).length;
  return resource.kind === "current" ? files.length - count : count;
}

/** The key of a file of the edited folder, both as a result entry and as a placement. */
export function currentFileKey(path: string) {
  return `current:${path}`;
}

/**
 * Turns the selection into the edit: every selected file of another resource
 * is added, and every cleared file of the edited folder is removed. The layout
 * moves the edited folder's placed files, gives placed additions their target
 * path, and creates its folders; the merged local folders are deleted once
 * the edit is in place.
 */
export function folderEditRequest({
  target,
  resources,
  files,
  selection,
  lyrics = {},
  decisions,
  layout = emptyFolderEditLayout,
  merges = [],
}: {
  target: FolderEditTarget;
  resources: readonly FolderEditResource[];
  files: Readonly<Record<string, readonly FolderEditFile[] | undefined>>;
  selection: FolderEditSelection;
  lyrics?: FolderEditLyricsRoles;
  decisions: Readonly<Record<string, RemoteFetchFileDecision>>;
  layout?: FolderEditLayout;
  merges?: readonly number[];
}): WorkFolderEditRequest {
  const additions: WorkFolderEditAddition[] = [];
  const removeLocationIds: number[] = [];
  const moves: WorkFolderEditMoveRequest[] = [];
  for (const resource of resources) {
    const selected = selection[resource.id];
    for (const file of files[resource.id] ?? []) {
      const included = selected?.has(file.path) ?? false;
      if (resource.kind === "current") {
        if (file.locationId === null) continue;
        const placed = layout.placements[currentFileKey(file.path)];
        if (!included) removeLocationIds.push(file.locationId);
        else if (placed !== undefined && placed !== file.path)
          moves.push({ locationId: file.locationId, path: placed });
      } else if (included) {
        const addition = folderEditAddition(resource, file.path, lyrics[resource.id]?.[file.path]);
        const placed = layout.placements[folderEditItemKey(addition)];
        additions.push(
          addition.language === undefined && placed !== undefined && placed !== file.path
            ? { ...addition, targetPath: placed }
            : addition,
        );
      }
    }
  }
  const request: WorkFolderEditRequest = {
    folderId: target.folderId,
    additions,
    removeLocationIds,
    decisions: decisionsFor(decisions, new Set(additions.map(folderEditItemKey))),
  };
  if (moves.length > 0) request.moves = moves;
  if (layout.folders.length > 0) request.folders = [...layout.folders];
  if (merges.length > 0) request.mergeFolderIds = [...merges];
  return request;
}

function folderEditAddition(resource: FolderEditResource, path: string, language: string | undefined) {
  const addition: WorkFolderEditAddition =
    resource.kind === "local"
      ? { kind: "local", folderId: resource.folderId, path }
      : { kind: "remote", sourceId: resource.sourceId, remoteCode: resource.editionCode, path };
  return language === undefined ? addition : { ...addition, language };
}

/** The key of the result entry and placement a file of another place takes once it is added. */
export function folderEditResourceItemKey(resource: FolderEditResource, path: string) {
  return resource.kind === "current"
    ? currentFileKey(path)
    : folderEditItemKey(folderEditAddition(resource, path, undefined));
}

function decisionsFor(decisions: Readonly<Record<string, RemoteFetchFileDecision>>, itemKeys: ReadonlySet<string>) {
  return Object.values(decisions)
    .filter((decision) => itemKeys.has(decision.itemKey))
    .sort((left, right) => left.itemKey.localeCompare(right.itemKey));
}

/** The key the server gives the plan item of an addition. */
export function folderEditItemKey(addition: WorkFolderEditAddition) {
  return addition.kind === "local"
    ? `local:${addition.folderId}:${addition.path}`
    : `remote:${addition.sourceId}:${addition.remoteCode.toUpperCase()}:${addition.path}`;
}

function resultStateForItem(item: WorkFolderEditItem): FolderEditResultState {
  if (item.targetConflict || item.action === "conflict") return "conflict";
  if (item.action === "exclude") return "excluded";
  if (item.action === "copy_local") return "add_local";
  if (item.action === "cache_download") return "add_remote";
  return "same";
}

/** An addition the server has not previewed yet, with the kind of file it is. */
export type FolderEditPendingAddition = { key: string; path: string; kind: string; sizeBytes: number | null };

/**
 * The folder after the edit: the files it keeps, the files it loses, and the
 * planned additions. An addition that is already in the folder marks the file
 * there instead of appearing twice, and one that takes a kept file's place
 * marks that file as replaced. A placed file shows at its place at once; an
 * addition the preview does not cover yet shows as pending.
 */
export function folderEditResult(
  currentFiles: readonly FolderEditFile[],
  currentSelection: ReadonlySet<string>,
  plan: WorkFolderEditPlan | null,
  layout: FolderEditLayout = emptyFolderEditLayout,
  pending: readonly FolderEditPendingAddition[] = [],
): FolderEditResultEntry[] {
  const entries = new Map<string, FolderEditResultEntry>();
  const leaving: FolderEditResultEntry[] = [];
  for (const file of currentFiles) {
    const key = currentFileKey(file.path);
    const kept = currentSelection.has(file.path);
    const placed = kept ? layout.placements[key] : undefined;
    const path = placed ?? file.path;
    const entry: FolderEditResultEntry = {
      key,
      path,
      name: path.split("/").pop() ?? path,
      kind: file.kind,
      sizeBytes: file.sizeBytes,
      state: !kept ? "remove" : placed !== undefined && placed !== file.path ? "add_move" : "keep",
      item: null,
    };
    if (kept) entries.set(pathIdentity(path), entry);
    else leaving.push(entry);
  }
  const added: FolderEditResultEntry[] = [];
  const prefix = plan ? `${normalizePath(plan.saveRoot)}/` : "";
  const planned = new Set<string>();
  for (const item of plan?.items ?? []) {
    planned.add(item.itemKey);
    const target = normalizePath(item.targetPath);
    const path = layout.placements[item.itemKey] ?? (target.startsWith(prefix) ? target.slice(prefix.length) : target);
    const state = resultStateForItem(item);
    const existing = entries.get(pathIdentity(path));
    if (state === "same" && existing) {
      if (existing.state === "keep") existing.state = "same";
      continue;
    }
    if ((state === "add_local" || state === "add_remote") && existing?.state === "keep") existing.state = "replaced";
    added.push({
      key: item.itemKey,
      path,
      name: path.split("/").pop() ?? path,
      kind: item.kind,
      sizeBytes: item.sizeBytes,
      state,
      item,
    });
  }
  for (const addition of pending) {
    if (planned.has(addition.key)) continue;
    const path = layout.placements[addition.key] ?? addition.path;
    added.push({
      key: addition.key,
      path,
      name: path.split("/").pop() ?? path,
      kind: addition.kind,
      sizeBytes: addition.sizeBytes,
      state: "pending",
      item: null,
    });
  }
  return [...entries.values(), ...leaving, ...added];
}

/** Whether a result entry can be moved within the final folder. */
export function folderEditEntryMovable(entry: FolderEditResultEntry) {
  return (
    entry.state !== "remove" && entry.state !== "moved" && entry.state !== "excluded" && !inLyricsFolder(entry.path)
  );
}

/**
 * The keys of the files the final folder can place: the selected files of
 * every place except those added as lyrics, whose lyrics role decides where
 * they go. A placement of any other key is stale.
 */
export function folderEditPlacementKeys({
  resources,
  files,
  selection,
  lyrics,
  keyFor,
}: {
  resources: readonly FolderEditResource[];
  files: Readonly<Record<string, readonly FolderEditFile[] | undefined>>;
  selection: FolderEditSelection;
  lyrics: FolderEditLyricsRoles;
  keyFor: (resource: FolderEditResource, path: string) => string;
}): Set<string> {
  const keys = new Set<string>();
  for (const resource of resources) {
    const selected = selection[resource.id];
    for (const file of files[resource.id] ?? []) {
      if (!selected?.has(file.path) || lyrics[resource.id]?.[file.path] !== undefined) continue;
      keys.add(keyFor(resource, file.path));
    }
  }
  return keys;
}

const collidingStates: ReadonlySet<FolderEditResultState> = new Set([
  "keep",
  "same",
  "add_move",
  "add_local",
  "add_remote",
  "pending",
]);

/**
 * The path two files of the final folder would share because one of them was
 * placed there, or null. A file that lands on another at its own path is a
 * conflict the preview offers resolutions for instead.
 */
export function folderEditCollision(
  entries: readonly FolderEditResultEntry[],
  placements: Readonly<Record<string, string>>,
): string | null {
  const byPath = new Map<string, FolderEditResultEntry[]>();
  for (const entry of entries) {
    if (!collidingStates.has(entry.state)) continue;
    const identity = pathIdentity(entry.path);
    byPath.set(identity, [...(byPath.get(identity) ?? []), entry]);
  }
  for (const group of byPath.values()) {
    if (group.length > 1 && group.some((entry) => placements[entry.key] !== undefined)) return group[0].path;
  }
  return null;
}

/**
 * The local places merged into the edited folder: those still listed, and
 * not on an offline storage pool, whose files cannot be read or deleted.
 */
export function folderEditMerges(resources: readonly FolderEditResource[], merged: ReadonlySet<number>): number[] {
  return resources
    .filter((resource) => resource.kind === "local" && !resource.offline && merged.has(resource.folderId))
    .map((resource) => resource.folderId);
}

/** Whether a local place can be merged: its files are loaded and its storage pool is online. */
export function folderEditCanMerge(resource: FolderEditResource, files: { status: string } | undefined) {
  return resource.kind === "local" && !resource.offline && files?.status === "ready";
}

/** How far a merge check has come: the most files it compared and the fewest it still had to. */
export type FolderEditMergeCheckProgress = Pick<
  WorkFolderEditMergeCheck,
  "checkedFiles" | "pendingFiles" | "pendingBytes"
>;

/**
 * Folds one round of a merge check into the furthest the check has come, and
 * reports whether the round got further.
 */
export function folderEditMergeCheckProgress(
  furthest: FolderEditMergeCheckProgress | null,
  check: FolderEditMergeCheckProgress,
): { progress: FolderEditMergeCheckProgress; advanced: boolean } {
  if (!furthest) {
    const { checkedFiles, pendingFiles, pendingBytes } = check;
    return { progress: { checkedFiles, pendingFiles, pendingBytes }, advanced: true };
  }
  return {
    progress: {
      checkedFiles: Math.max(furthest.checkedFiles, check.checkedFiles),
      pendingFiles: Math.min(furthest.pendingFiles, check.pendingFiles),
      pendingBytes: Math.min(furthest.pendingBytes, check.pendingBytes),
    },
    advanced:
      check.checkedFiles > furthest.checkedFiles ||
      check.pendingFiles < furthest.pendingFiles ||
      check.pendingBytes < furthest.pendingBytes,
  };
}

export type FolderEditReadiness = "idle" | "refreshing" | "blocked" | "ready";

/**
 * Whether the edit can be applied. An edit that only removes files needs no
 * server preview; one that adds files waits for a current preview without
 * conflicts.
 */
export function folderEditReadiness({
  request,
  plan,
  planCurrent,
}: {
  request: WorkFolderEditRequest;
  plan: WorkFolderEditPlan | null;
  planCurrent: boolean;
}): FolderEditReadiness {
  if (!folderEditNeedsPlan(request)) return request.removeLocationIds.length > 0 ? "ready" : "idle";
  if (!plan || !planCurrent) return "refreshing";
  if (plan.summary.conflict > 0) return "blocked";
  const { add, move, folders, merge } = plan.summary;
  return add > 0 || move > 0 || folders > 0 || merge > 0 || request.removeLocationIds.length > 0 ? "ready" : "idle";
}

/** Whether the edit waits for the server's preview: anything but removals alone. */
export function folderEditNeedsPlan(request: WorkFolderEditRequest) {
  return (
    request.additions.length > 0 ||
    (request.moves?.length ?? 0) > 0 ||
    (request.folders?.length ?? 0) > 0 ||
    (request.mergeFolderIds?.length ?? 0) > 0
  );
}

/** The key a Fetch plan gives the item of a file of the fetched edition. */
export function fetchItemKey(path: string) {
  return `remote:${path}`;
}

/**
 * The places a Fetch into a new folder can take files from: the fetched
 * edition on its source first, then every edition a configured source offers,
 * then the family's local folders.
 */
export function fetchComposeResources(
  preparation: RemoteFetchPreparation | null,
  fetch: FetchComposeTarget,
): FolderEditResource[] {
  const editions = preparation?.editions ?? [];
  const editionCode = fetch.editionCode.toUpperCase();
  const fetched = editions.find((edition) => edition.primaryCode.toUpperCase() === editionCode);
  const primary: FolderEditResource = {
    id: remoteResourceId(fetch.sourceId, editionCode),
    kind: "remote",
    editionCode,
    language: fetched?.metadataLanguage || fetched?.editionLabel || "",
    origin: fetched?.origin ?? false,
    folderId: 0,
    workId: fetched?.workId ?? 0,
    rootPath: "",
    sourceId: fetch.sourceId,
    sourceName: fetch.sourceName,
    remoteCode: fetch.remoteCode,
  };
  const family = folderEditResources(
    { workId: 0, primaryCode: editionCode, editions, warnings: [] },
    { workId: 0, folderId: 0, rootPath: "" },
  ).filter((resource) => resource.kind !== "current" && resource.id !== primary.id);
  return [
    primary,
    ...family.filter((resource) => resource.kind === "remote"),
    ...family.filter((resource) => resource.kind === "local"),
  ];
}

/**
 * Turns the selection into a Fetch into a new folder: the fetched edition's
 * selected files are the Fetch, and everything else selected, including the
 * fetched edition's files added as lyrics, follows once the folder exists.
 */
export function fetchComposeRequest({
  fetch,
  resources,
  files,
  selection,
  lyrics,
  decisions,
  minFreeBytes,
  layout = emptyFolderEditLayout,
}: {
  fetch: FetchComposeTarget;
  resources: readonly FolderEditResource[];
  files: Readonly<Record<string, readonly FolderEditFile[] | undefined>>;
  selection: FolderEditSelection;
  lyrics: FolderEditLyricsRoles;
  decisions: Readonly<Record<string, RemoteFetchFileDecision>>;
  minFreeBytes: number;
  layout?: FolderEditLayout;
}): ComposedFetchRequest {
  const primaryId = remoteResourceId(fetch.sourceId, fetch.editionCode);
  const paths: string[] = [];
  const additions: WorkFolderEditAddition[] = [];
  for (const resource of resources) {
    const selected = selection[resource.id];
    for (const file of files[resource.id] ?? []) {
      if (!selected?.has(file.path)) continue;
      const language = lyrics[resource.id]?.[file.path];
      if (resource.id === primaryId && language === undefined) {
        paths.push(file.path);
        continue;
      }
      const addition = folderEditAddition(resource, file.path, language);
      const placed = layout.placements[folderEditItemKey(addition)];
      additions.push(
        language === undefined && placed !== undefined && placed !== file.path
          ? { ...addition, targetPath: placed }
          : addition,
      );
    }
  }
  // A placed file of the fetched edition is renamed to its place; a decision
  // made for it at its own path no longer applies.
  const placedDecisions: Record<string, RemoteFetchFileDecision> = { ...decisions };
  for (const path of paths) {
    const placed = layout.placements[fetchItemKey(path)];
    if (placed !== undefined && placed !== path) {
      placedDecisions[fetchItemKey(path)] = {
        itemKey: fetchItemKey(path),
        sourceId: 0,
        resolution: "rename",
        targetPath: placed,
      };
    }
  }
  const request: ComposedFetchRequest = {
    paths,
    decisions: decisionsFor(placedDecisions, new Set(paths.map(fetchItemKey))),
    minFreeBytes,
  };
  if (additions.length > 0) {
    request.followUp = {
      additions,
      decisions: decisionsFor(decisions, new Set(additions.map(folderEditItemKey))),
    };
  }
  return request;
}

function fetchResultState(item: RemoteWorkSavePlanItem): FolderEditResultState {
  if (item.targetConflict || item.action === "conflict") return "conflict";
  if (item.action === "exclude") return "excluded";
  if (item.action === "skip") return "same";
  if (item.action === "copy_local") return "add_local";
  return "add_remote";
}

/**
 * The new folder as the Fetch and what follows it will make it. A placed file
 * shows at its place at once, and its rename to that place is not a decision
 * to review; a selected file the preview does not cover yet shows as pending.
 */
export function fetchComposeResult(
  plan: ComposedFetchPlan | null,
  layout: FolderEditLayout = emptyFolderEditLayout,
  pending: readonly FolderEditPendingAddition[] = [],
  /** The keys the request still holds; a stale preview shows nothing else. */
  keys?: ReadonlySet<string>,
): FolderEditResultEntry[] {
  const prefix = plan ? `${normalizePath(plan.saveRoot)}/` : "";
  const below = (target: string) => {
    const path = normalizePath(target);
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
  };
  const entry = (
    item: RemoteWorkSavePlanItem & { remoteCode?: string },
    state: FolderEditResultState,
  ): FolderEditResultEntry => {
    const placed = layout.placements[item.itemKey];
    const path = placed ?? below(item.targetPath);
    const shown =
      placed !== undefined && item.resolution === "rename" ? { ...item, resolution: "auto" as const } : item;
    return {
      key: item.itemKey,
      path,
      name: path.split("/").pop() ?? path,
      kind: item.kind,
      sizeBytes: item.sizeBytes,
      state,
      item: shown,
    };
  };
  const fetchedCode = plan ? plan.editionCode || plan.primaryCode : "";
  const wanted = (item: { itemKey: string }) => !keys || keys.has(item.itemKey);
  const entries = plan
    ? [
        ...plan.items.filter(wanted).map((item) => entry({ ...item, remoteCode: fetchedCode }, fetchResultState(item))),
        ...(plan.followUp?.items ?? []).filter(wanted).map((item) => entry(item, resultStateForItem(item))),
      ]
    : [];
  const planned = new Set(entries.map((shown) => shown.key));
  for (const addition of pending) {
    if (planned.has(addition.key)) continue;
    const path = layout.placements[addition.key] ?? addition.path;
    entries.push({
      key: addition.key,
      path,
      name: path.split("/").pop() ?? path,
      kind: addition.kind,
      sizeBytes: addition.sizeBytes,
      state: "pending",
      item: null,
    });
  }
  return entries;
}

/** How many files the Fetch and what follows it put into the new folder. */
export function fetchComposeAddCount(plan: ComposedFetchPlan | null) {
  return (plan?.summary.promote ?? 0) + (plan?.followUp?.summary.add ?? 0);
}

/**
 * Whether the Fetch can start. It fetches at least one file of its edition,
 * and waits for a current preview without conflicts in either part or a
 * folder that needs review.
 */
export function fetchComposeReadiness({
  request,
  plan,
  planCurrent,
}: {
  request: ComposedFetchRequest;
  plan: ComposedFetchPlan | null;
  planCurrent: boolean;
}): FolderEditReadiness {
  if (request.paths.length === 0) return "idle";
  if (!plan || !planCurrent) return "refreshing";
  if (plan.summary.conflict > 0 || (plan.followUp?.summary.conflict ?? 0) > 0 || plan.fetchRoot.conflict) {
    return "blocked";
  }
  return fetchComposeAddCount(plan) > 0 ? "ready" : "idle";
}
