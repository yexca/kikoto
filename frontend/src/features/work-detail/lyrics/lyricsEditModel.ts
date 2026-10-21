import {
  folderEditResources,
  localFolderFiles,
  type FolderEditFile,
  type FolderEditResultEntry,
  type FolderEditResultState,
  type FolderEditSelection,
  type FolderEditTarget,
} from "@/features/work-detail/folder-edit/folderEditModel";
import type { LyricsManagerAudio } from "@/features/work-detail/lyrics/lyricsManagerModel";
import { managedLyricsLanguage, pathBelowFolder } from "@/features/work-detail/lyrics/managedLyricsModel";
import { isLyricsFilePath, suggestRemoteLyricsMapping } from "@/features/work-detail/lyrics/remoteLyricsModel";
import type {
  FolderLyricsMode,
  LyricsEditAddition,
  LyricsEditItem,
  LyricsEditPlan,
  LyricsEditRequest,
  MediaItem,
  RemoteFetchFileDecision,
  WorkFolderEditSources,
} from "@/lib/api";
import { editionLyricsLanguage, mediaItemLyricsAssignments } from "@/lib/lyricsLanguage";
import { naturalNameCompare } from "@/lib/naturalNameOrder";

/** The resource that is the lyrics Kikoto manages in the edited folder. */
export const MANAGED_LYRICS_RESOURCE = "current";
/** The resource that is the other lyrics files of the edited folder. */
export const FOLDER_LYRICS_RESOURCE = "folder";

/**
 * A place lyrics files can come from. The managed lyrics are the `current`
 * resource: its selected files stay, and the files cleared there are deleted.
 * The `folder` resource is the edited folder itself, whose files move.
 */
export type LyricsEditResource = {
  id: string;
  kind: "current" | "folder" | "local" | "remote";
  editionCode: string;
  /** The edition's declared language, as its metadata names it. */
  editionLanguage: string;
  origin: boolean;
  /** Local resources: the folder and the edition work that owns it. */
  folderId: number;
  workId: number;
  rootPath: string;
  /** Remote resources: the configured source that offers the edition. */
  sourceId: number;
  sourceName: string;
  /** Local resources: the folder's storage pool is offline, so nothing can be taken from it. */
  offline?: boolean;
  /**
   * The lyrics language the files of this place are taken to be in until the
   * viewer says otherwise, or null when the viewer has to declare it.
   */
  defaultLanguage: string | null;
};

/** The declared lyrics language per resource; null is not declared yet. */
export type LyricsEditLanguages = Readonly<Record<string, string | null | undefined>>;

/**
 * Lists the managed lyrics first, then the edited folder's other lyrics, then
 * every other active local folder of the family, then every edition a
 * configured source reports as available. Another edition's lyrics are taken
 * to be in that edition's language; the language of the work's own local files
 * is never inferred.
 */
export function lyricsEditResources(sources: WorkFolderEditSources, target: FolderEditTarget): LyricsEditResource[] {
  const [current, ...others] = folderEditResources(sources, target);
  const own = { ...current, editionLanguage: current.language, defaultLanguage: null };
  return [
    { ...own, id: MANAGED_LYRICS_RESOURCE, kind: "current" },
    { ...own, id: FOLDER_LYRICS_RESOURCE, kind: "folder" },
    ...others.map((resource): LyricsEditResource => ({
      ...resource,
      kind: resource.kind === "remote" ? "remote" : "local",
      editionLanguage: resource.language,
      defaultLanguage:
        resource.kind === "local" && resource.workId === target.workId
          ? null
          : editionLyricsLanguage(resource.language),
    })),
  ];
}

/** The lyrics files among the files of a place. */
export function lyricsFilesOf(files: readonly FolderEditFile[]): FolderEditFile[] {
  return files.filter((file) => isLyricsFilePath(file.path));
}

/**
 * The lyrics files of a local folder: those in a language's lyrics folder,
 * which Kikoto manages, and the others.
 */
export function folderLyrics(items: MediaItem[], rootPath: string) {
  const managed: FolderEditFile[] = [];
  const loose: FolderEditFile[] = [];
  for (const file of lyricsFilesOf(localFolderFiles(items, rootPath))) {
    (managedLyricsLanguage(file.path) === null ? loose : managed).push(file);
  }
  return { managed, loose };
}

/** The audio files of a local folder with their library lyrics, by path below that folder. */
export function folderAudio(items: MediaItem[], rootPath: string): LyricsManagerAudio[] {
  const audio: LyricsManagerAudio[] = [];
  for (const item of items) {
    if (item.kind !== "audio") continue;
    for (const location of item.locations) {
      const path =
        location.locationType === "local" && location.availability === "available"
          ? pathBelowFolder(rootPath, location.path)
          : null;
      if (path === null) continue;
      audio.push({
        mediaItemId: item.id,
        title: fileName(path),
        path,
        folder: directoryName(path),
        durationSeconds: location.durationSeconds ?? item.durationSeconds,
        assignedLyrics: Object.fromEntries(
          mediaItemLyricsAssignments(item).map((assignment) => [assignment.language, assignment.lyricsMediaItemId]),
        ),
        autoLyricsMediaItemId: null,
      });
      break;
    }
  }
  return audio.sort((left, right) => naturalNameCompare(left.path, right.path));
}

/** The key the server gives the plan item of an addition. */
export function lyricsEditItemKey(addition: LyricsEditAddition) {
  if (addition.kind === "folder") return `folder:${addition.path}`;
  return addition.kind === "local"
    ? `local:${addition.folderId}:${addition.path}`
    : `remote:${addition.sourceId}:${addition.remoteCode.toUpperCase()}:${addition.path}`;
}

function additionFor(resource: LyricsEditResource, path: string, language: string): LyricsEditAddition {
  if (resource.kind === "local") return { kind: "local", folderId: resource.folderId, path, language };
  if (resource.kind === "remote") {
    return { kind: "remote", sourceId: resource.sourceId, remoteCode: resource.editionCode, path, language };
  }
  return { kind: "folder", path, language };
}

/** The language declared for a resource's files, or null while it is not declared. */
export function lyricsEditLanguage(resource: LyricsEditResource, languages: LyricsEditLanguages): string | null {
  const declared = languages[resource.id];
  return declared === undefined ? resource.defaultLanguage : declared;
}

/**
 * Turns the selection into the edit: every selected file of another resource
 * is added in its resource's language, and every cleared managed file is
 * deleted. `undeclared` lists the resources whose selected files wait for a
 * language and are left out.
 */
export function lyricsEditRequest({
  target,
  resources,
  files,
  selection,
  languages,
  decisions,
  folderMode,
}: {
  target: FolderEditTarget;
  resources: readonly LyricsEditResource[];
  files: Readonly<Record<string, readonly FolderEditFile[] | undefined>>;
  selection: FolderEditSelection;
  languages: LyricsEditLanguages;
  decisions: Readonly<Record<string, RemoteFetchFileDecision>>;
  /** Whether the folder's own files are copied or moved into Kikoto's lyrics folder. */
  folderMode: FolderLyricsMode;
}): { request: LyricsEditRequest; undeclared: LyricsEditResource[] } {
  const additions: LyricsEditAddition[] = [];
  const removeLocationIds: number[] = [];
  const undeclared: LyricsEditResource[] = [];
  const managed = files[MANAGED_LYRICS_RESOURCE] ?? [];
  const kept = selection[MANAGED_LYRICS_RESOURCE];
  for (const file of managed) {
    if (!kept?.has(file.path) && file.locationId !== null) removeLocationIds.push(file.locationId);
  }
  const removed = new Set(removeLocationIds);
  for (const resource of resources) {
    if (resource.kind === "current") continue;
    const selected = (files[resource.id] ?? []).filter(
      (file) =>
        selection[resource.id]?.has(file.path) &&
        // A file that is being deleted cannot move as well.
        !(resource.kind === "folder" && file.locationId !== null && removed.has(file.locationId)),
    );
    if (selected.length === 0) continue;
    const language = lyricsEditLanguage(resource, languages);
    if (language === null) {
      undeclared.push(resource);
      continue;
    }
    for (const file of selected) additions.push(additionFor(resource, file.path, language));
  }
  const itemKeys = new Set(additions.map(lyricsEditItemKey));
  return {
    request: {
      folderId: target.folderId,
      additions,
      removeLocationIds,
      decisions: Object.values(decisions)
        .filter((decision) => itemKeys.has(decision.itemKey))
        .sort((left, right) => left.itemKey.localeCompare(right.itemKey)),
      assignments: [],
      folderMode,
    },
    undeclared,
  };
}

/** How many files of a resource the edit changes: deleted for the managed lyrics, added for any other. */
export function lyricsEditResourceChanges(
  resource: LyricsEditResource,
  files: readonly FolderEditFile[] | undefined,
  selected: ReadonlySet<string> | undefined,
) {
  if (!files) return 0;
  const count = files.filter((file) => selected?.has(file.path)).length;
  return resource.kind === "current" ? files.length - count : count;
}

function resultStateForItem(item: LyricsEditItem): FolderEditResultState {
  if (item.targetConflict || item.action === "conflict") return "conflict";
  if (item.action === "exclude") return "excluded";
  if (item.action === "move_local") return "add_move";
  if (item.action === "copy_local") return "add_local";
  if (item.action === "cache_download") return "add_remote";
  return "same";
}

/**
 * The managed lyrics after the edit: the files they keep, the files they
 * lose, and the planned additions. An addition that is already there marks the
 * file instead of appearing twice, one that takes a kept file's place marks
 * that file as replaced, and a managed file that moves to another language
 * marks the place it leaves.
 */
export function lyricsEditResult(
  managed: readonly FolderEditFile[],
  kept: ReadonlySet<string>,
  plan: LyricsEditPlan | null,
): FolderEditResultEntry[] {
  const entries = new Map<string, FolderEditResultEntry>();
  for (const file of managed) {
    entries.set(file.path.toLowerCase(), {
      key: `current:${file.path}`,
      path: file.path,
      name: file.name,
      kind: file.kind,
      sizeBytes: file.sizeBytes,
      state: kept.has(file.path) ? "keep" : "remove",
      item: null,
    });
  }
  const added: FolderEditResultEntry[] = [];
  const below = (path: string) => (plan ? (pathBelowFolder(plan.saveRoot, path) ?? path) : path);
  for (const item of plan?.items ?? []) {
    const path = below(item.targetPath);
    const state = resultStateForItem(item);
    const existing = entries.get(path.toLowerCase());
    if (state === "same" && existing) {
      if (existing.state === "keep") existing.state = "same";
      continue;
    }
    if (state.startsWith("add_") && existing?.state === "keep") existing.state = "replaced";
    if (state === "add_move") {
      const source = entries.get(below(item.localSourcePath).toLowerCase());
      if (source?.state === "keep") source.state = "moved";
    }
    added.push({
      key: item.itemKey,
      path,
      name: fileName(path),
      kind: item.kind,
      sizeBytes: item.sizeBytes,
      state,
      item,
    });
  }
  return [...entries.values(), ...added];
}

export type LyricsEditReadiness = "idle" | "undeclared" | "refreshing" | "blocked" | "ready";

/**
 * Whether the edit can be applied. Selected files without a declared language
 * hold it back; an edit that only deletes needs no server preview; one that
 * adds files waits for a current preview without conflicts.
 */
export function lyricsEditReadiness({
  request,
  undeclared,
  plan,
  planCurrent,
}: {
  request: LyricsEditRequest;
  undeclared: readonly LyricsEditResource[];
  plan: LyricsEditPlan | null;
  planCurrent: boolean;
}): LyricsEditReadiness {
  if (undeclared.length > 0) return "undeclared";
  if (request.additions.length === 0) return request.removeLocationIds.length > 0 ? "ready" : "idle";
  if (!plan || !planCurrent) return "refreshing";
  if (plan.summary.conflict > 0) return "blocked";
  return plan.summary.add > 0 || request.removeLocationIds.length > 0 ? "ready" : "idle";
}

/**
 * Suggests which added file each track of the folder uses, per language: a
 * matching file name first, then track order against the subfolder holding the
 * most files. A track that already has library lyrics in the language keeps
 * them, and a file the plan leaves out is not assigned.
 */
export function lyricsEditAssignments({
  audio,
  additions,
  plan,
}: {
  audio: readonly LyricsManagerAudio[];
  additions: readonly LyricsEditAddition[];
  plan: LyricsEditPlan | null;
}): LyricsEditRequest["assignments"] {
  const left = new Set(
    (plan?.items ?? [])
      .filter((item) => item.action === "conflict" || item.action === "exclude")
      .map((item) => item.itemKey),
  );
  // Files of one place in one language are matched together, so track order means something.
  const groups = new Map<string, LyricsEditAddition[]>();
  for (const addition of additions) {
    const itemKey = lyricsEditItemKey(addition);
    if (left.has(itemKey)) continue;
    const group = `${addition.language}\n${itemKey.slice(0, itemKey.length - addition.path.length)}`;
    groups.set(group, [...(groups.get(group) ?? []), addition]);
  }
  const taken = new Set<string>();
  const assignments: LyricsEditRequest["assignments"] = [];
  for (const group of groups.values()) {
    const language = group[0].language;
    const free = audio.filter(
      (entry) => entry.assignedLyrics[language] === undefined && !taken.has(`${entry.mediaItemId}:${language}`),
    );
    const byPath = new Map(group.map((addition) => [addition.path, addition]));
    const mapping = suggestRemoteLyricsMapping(
      free,
      group.map((addition) => ({
        path: addition.path,
        title: fileName(addition.path),
        folder: directoryName(addition.path),
        sizeBytes: null,
      })),
    );
    for (const [audioMediaItemId, path] of mapping) {
      const addition = path ? byPath.get(path) : undefined;
      if (!addition) continue;
      taken.add(`${audioMediaItemId}:${language}`);
      assignments.push({ audioMediaItemId, itemKey: lyricsEditItemKey(addition) });
    }
  }
  return assignments;
}

function fileName(path: string) {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}

function directoryName(path: string) {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(0, index) : "";
}
