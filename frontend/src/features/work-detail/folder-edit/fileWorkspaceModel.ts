import type { DuplicateFile, DuplicateFileGroup } from "../../../lib/api";
import { naturalNameCompare } from "../../../lib/naturalNameOrder";
import { inLyricsFolder, parentFolder, pathIdentity } from "./folderEditLayout";
import {
  currentFileKey,
  type FolderEditFile,
  type FolderEditResource,
  type FolderEditResultEntry,
} from "./folderEditModel";

/**
 * What a place of the file workspace may do in an edit. The edited folder is
 * the only place an edit writes; another local folder and a remote edition are
 * sources whose files are copied or downloaded into it.
 */
export type FileWorkspacePlace = "target" | "local" | "remote";

export function fileWorkspacePlace(resource: Pick<FolderEditResource, "kind">): FileWorkspacePlace {
  if (resource.kind === "current") return "target";
  return resource.kind === "local" ? "local" : "remote";
}

/** What makes a file of the edited folder redundant: another file with the same content. */
export type FolderDuplicateMark = {
  /** A file with the same content, from outside the edited folder when there is one. */
  counterpart: DuplicateFile;
  /** The counterpart is in another folder or edition. */
  elsewhere: boolean;
};

export type FolderDuplicates = {
  /** A mark per path of the edited folder that has an identical file. */
  marks: Map<string, FolderDuplicateMark>;
  /** Paths whose content also exists outside the edited folder. */
  elsewhere: string[];
  /** Paths repeated inside the edited folder: every copy except the first of each set. */
  repeated: string[];
};

/**
 * Relates identical-file groups to the edited folder's files. A set that also
 * has a copy outside the folder makes every copy in it redundant; a set that
 * exists only inside it keeps its first file.
 */
export function folderEditDuplicates(groups: readonly DuplicateFileGroup[], files: readonly FolderEditFile[]) {
  const listed = new Map(
    files.filter((file) => file.locationId !== null).map((file) => [file.locationId as number, file.path]),
  );
  const duplicates: FolderDuplicates = { marks: new Map(), elsewhere: [], repeated: [] };
  for (const group of groups) {
    const inside = group.files.filter((file) => listed.has(file.locationId));
    const outside = group.files.filter((file) => !listed.has(file.locationId));
    if (inside.length === 0 || inside.length + outside.length < 2) continue;
    inside.forEach((file, index) => {
      const path = listed.get(file.locationId);
      const counterpart = outside[0] ?? inside.find((other) => other.locationId !== file.locationId);
      if (path === undefined || !counterpart) return;
      duplicates.marks.set(path, { counterpart, elsewhere: outside.length > 0 });
      if (outside.length > 0) duplicates.elsewhere.push(path);
      else if (index > 0) duplicates.repeated.push(path);
    });
  }
  return duplicates;
}

/**
 * The folders of the final folder that files can go to, parents first and in
 * name order: every folder that holds a file the folder keeps or gains, and
 * every folder the edit creates. Kikoto's lyrics folder takes files only
 * through lyrics roles, so it is not one of them.
 */
export function finalFolderPaths(entries: readonly FolderEditResultEntry[], created: readonly string[]): string[] {
  const folders = new Set<string>();
  const add = (folder: string) => {
    for (let current = folder; current && !folders.has(current); current = parentFolder(current)) folders.add(current);
  };
  for (const entry of entries) {
    if (entry.state === "remove" || entry.state === "excluded" || entry.state === "moved") continue;
    add(parentFolder(entry.path));
  }
  for (const folder of created) add(folder);
  return [...folders].filter((folder) => !inLyricsFolder(folder)).sort(naturalNameCompare);
}

/** The last two segments of a library path, enough to recognize a file without its full location. */
export function compactLibraryPath(path: string) {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).slice(-2).join("/");
}

/**
 * One file or folder the edit deletes when it is applied. A cleared file is
 * kept again by selecting it; a file replaced by an incoming one is kept by
 * keeping it over the incoming file; a merged folder is kept by not merging it.
 */
export type PendingDeletion =
  | {
      kind: "cleared";
      key: string;
      /** The file's own path in the edited folder. */
      path: string;
      name: string;
      fileKind: string;
      sizeBytes: number | null;
    }
  | {
      kind: "replaced";
      key: string;
      path: string;
      name: string;
      fileKind: string;
      sizeBytes: number | null;
      /** The incoming file that takes its place, whose decision keeps it instead. */
      incoming: { itemKey: string; targetPath: string };
    }
  | {
      kind: "merged";
      key: string;
      resource: FolderEditResource;
      /** How many files the folder holds and their size, once its files are loaded. */
      files: number | null;
      sizeBytes: number;
    };

export type PendingDeletionGroup = {
  /** The folder of the edited folder a file is in, by its path below it; merged folders form their own group. */
  key: string;
  folder: string;
  merged: boolean;
  items: PendingDeletion[];
};

export type PendingDeletions = {
  groups: PendingDeletionGroup[];
  files: number;
  sizeBytes: number;
};

/**
 * Everything an edit deletes, grouped by folder: the edited folder's files
 * that are cleared or replaced, and each merged folder as a whole. It lists
 * the edit as it stands before it is applied; nothing in it can be restored
 * once the edit runs.
 */
export function folderEditPendingDeletions({
  currentFiles,
  currentSelection,
  result,
  merged,
}: {
  currentFiles: readonly FolderEditFile[];
  currentSelection: ReadonlySet<string>;
  result: readonly FolderEditResultEntry[];
  /** The merged folders, with their files when they are loaded. */
  merged: readonly { resource: FolderEditResource; files: readonly FolderEditFile[] | null }[];
}): PendingDeletions {
  const items: PendingDeletion[] = [];
  for (const file of currentFiles) {
    if (currentSelection.has(file.path)) continue;
    items.push({
      kind: "cleared",
      key: currentFileKey(file.path),
      path: file.path,
      name: file.name,
      fileKind: file.kind,
      sizeBytes: file.sizeBytes,
    });
  }
  const incoming = new Map<string, FolderEditResultEntry>();
  for (const entry of result) {
    if (entry.item && (entry.state === "add_local" || entry.state === "add_remote")) {
      incoming.set(pathIdentity(entry.path), entry);
    }
  }
  const prefix = currentFileKey("");
  for (const entry of result) {
    if (entry.state !== "replaced") continue;
    const by = incoming.get(pathIdentity(entry.path));
    if (!by?.item) continue;
    const path = entry.key.startsWith(prefix) ? entry.key.slice(prefix.length) : entry.path;
    items.push({
      kind: "replaced",
      key: entry.key,
      path,
      name: entry.name,
      fileKind: entry.kind,
      sizeBytes: entry.sizeBytes,
      incoming: { itemKey: by.item.itemKey, targetPath: by.path },
    });
  }
  const byFolder = new Map<string, PendingDeletionGroup>();
  for (const item of items) {
    if (item.kind === "merged") continue;
    const folder = parentFolder(item.path);
    const group = byFolder.get(folder) ?? { key: `folder:${folder}`, folder, merged: false, items: [] };
    group.items.push(item);
    byFolder.set(folder, group);
  }
  const groups = [...byFolder.values()].sort((left, right) => left.folder.localeCompare(right.folder));
  for (const group of groups) group.items.sort((left, right) => pendingPath(left).localeCompare(pendingPath(right)));
  let files = items.length;
  let sizeBytes = items.reduce((sum, item) => sum + (item.kind === "merged" ? 0 : (item.sizeBytes ?? 0)), 0);
  if (merged.length > 0) {
    const mergedItems: PendingDeletion[] = merged.map(({ resource, files: folderFiles }) => ({
      kind: "merged",
      key: `merged:${resource.id}`,
      resource,
      files: folderFiles ? folderFiles.length : null,
      sizeBytes: (folderFiles ?? []).reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0),
    }));
    for (const item of mergedItems) {
      if (item.kind !== "merged") continue;
      files += item.files ?? 0;
      sizeBytes += item.sizeBytes;
    }
    groups.push({ key: "merged", folder: "", merged: true, items: mergedItems });
  }
  return { groups, files, sizeBytes };
}

function pendingPath(item: PendingDeletion) {
  return item.kind === "merged" ? item.resource.rootPath : item.path;
}
