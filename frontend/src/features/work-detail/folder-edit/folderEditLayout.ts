import { lyricsRootFolderName } from "@/lib/lyricsLanguage";

/**
 * How the final folder of a workspace is arranged beyond each file's own
 * path: the path below the folder that a placed file takes, by the key of its
 * result entry, and the folders the user created. A file of the edited folder
 * that is placed elsewhere is moved there; an added file lands there.
 */
export type FolderEditLayout = {
  placements: Readonly<Record<string, string>>;
  folders: readonly string[];
};

export const emptyFolderEditLayout: FolderEditLayout = { placements: {}, folders: [] };

/** A file of the final folder at its current path. */
export type FolderEditPlaced = { key: string; path: string };

/** Why a folder name was refused. */
export type FolderEditNameError = "empty" | "invalid" | "taken" | "reserved";

function normalize(path: string) {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function identity(path: string) {
  return normalize(path).normalize("NFC").toLowerCase();
}

export function joinFolderPath(folder: string, name: string) {
  return folder ? `${folder}/${name}` : name;
}

export function parentFolder(path: string) {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

export function baseName(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Whether a path below a work folder lies in Kikoto's lyrics folder, which only lyrics roles arrange. */
export function inLyricsFolder(path: string) {
  const first = normalize(path).split("/")[0] ?? "";
  return first.toLowerCase() === lyricsRootFolderName.toLowerCase();
}

/** Whether folder is path itself or one of its folders. */
export function folderContains(folder: string, path: string) {
  return folder === "" || path === folder || path.startsWith(`${folder}/`);
}

/** The same name with " (2)", " (3)" and so on before its extension, for a file; at its end, for a folder. */
function numbered(path: string, index: number, isFolder: boolean) {
  const folder = parentFolder(path);
  const name = baseName(path);
  const dot = isFolder ? -1 : name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  return joinFolderPath(folder, `${stem} (${index})${extension}`);
}

function freePath(path: string, taken: ReadonlySet<string>, isFolder = false) {
  if (!taken.has(identity(path))) return path;
  for (let index = 2; ; index++) {
    const candidate = numbered(path, index, isFolder);
    if (!taken.has(identity(candidate))) return candidate;
  }
}

/** Every folder above the files and the created folders, without the root. */
export function layoutFolders(files: readonly FolderEditPlaced[], folders: readonly string[]) {
  const all = new Set<string>();
  const add = (folder: string) => {
    for (let current = normalize(folder); current; current = parentFolder(current)) all.add(current);
  };
  for (const file of files) add(parentFolder(normalize(file.path)));
  for (const folder of folders) add(folder);
  return [...all];
}

/**
 * Places files at the paths they ask for. A path another file holds, or that
 * a folder holds, is numbered until it is free; files are placed in order,
 * so the first keeps the name.
 */
function relocate(
  layout: FolderEditLayout,
  files: readonly FolderEditPlaced[],
  moving: readonly FolderEditPlaced[],
  folders: readonly string[] = layout.folders,
): FolderEditLayout {
  const movingKeys = new Set(moving.map((file) => file.key));
  const staying = files.filter((file) => !movingKeys.has(file.key));
  const taken = new Set(staying.map((file) => identity(file.path)));
  for (const folder of layoutFolders(staying, folders)) taken.add(identity(folder));
  const placements: Record<string, string> = { ...layout.placements };
  for (const file of moving) {
    const path = freePath(normalize(file.path), taken);
    taken.add(identity(path));
    for (let folder = parentFolder(path); folder; folder = parentFolder(folder)) taken.add(identity(folder));
    placements[file.key] = path;
  }
  return { placements, folders };
}

/** Moves files into a folder of the final folder, keeping their names. */
export function moveFilesTo(
  layout: FolderEditLayout,
  files: readonly FolderEditPlaced[],
  keys: readonly string[],
  folder: string,
  /** The names of files not yet in the final folder, such as files dragged in from another place. */
  names: Readonly<Record<string, string>> = {},
): FolderEditLayout {
  const byKey = new Map(files.map((file) => [file.key, file]));
  const moving = keys.flatMap((key) => {
    const name = names[key] ?? (byKey.has(key) ? baseName(byKey.get(key)!.path) : "");
    return name ? [{ key, path: joinFolderPath(folder, name) }] : [];
  });
  return relocate(layout, files, moving);
}

/**
 * Places files that arrive together with their relative paths below a folder,
 * such as a folder dragged in from another place.
 */
export function placeFilesBelow(
  layout: FolderEditLayout,
  files: readonly FolderEditPlaced[],
  arriving: readonly FolderEditPlaced[],
  folder: string,
): FolderEditLayout {
  return relocate(
    layout,
    files,
    arriving.map((file) => ({ key: file.key, path: joinFolderPath(folder, normalize(file.path)) })),
  );
}

function remapFolders(folders: readonly string[], from: string, to: string | null) {
  const next: string[] = [];
  for (const folder of folders) {
    if (!folderContains(from, folder)) next.push(folder);
    else if (to !== null) next.push(to + folder.slice(from.length));
  }
  return [...new Set(next.filter(Boolean))];
}

/**
 * Moves a folder with everything in it into another folder. Moving it into
 * itself or one of its own folders does nothing. When the target already has
 * a folder of that name the two are combined; a file of that name makes the
 * moved folder take a numbered name.
 */
export function moveFolderTo(
  layout: FolderEditLayout,
  files: readonly FolderEditPlaced[],
  folder: string,
  target: string,
): FolderEditLayout {
  if (folderContains(folder, target) || parentFolder(folder) === target) return layout;
  const fileNames = new Set(
    files.filter((file) => !folderContains(folder, file.path)).map((file) => identity(file.path)),
  );
  const destination = freePath(joinFolderPath(target, baseName(folder)), fileNames, true);
  return relocateFolder(layout, files, folder, destination);
}

function relocateFolder(
  layout: FolderEditLayout,
  files: readonly FolderEditPlaced[],
  folder: string,
  destination: string,
) {
  const moving = files
    .filter((file) => folderContains(folder, file.path))
    .map((file) => ({ key: file.key, path: destination + file.path.slice(folder.length) }));
  const folders = remapFolders(layout.folders, folder, destination);
  // A folder that held nothing but was created stays a folder at its new place.
  if (!moving.length && !folders.some((path) => folderContains(destination, path))) folders.push(destination);
  return relocate(layout, files, moving, folders);
}

/** Checks a new folder name inside a folder. */
export function folderNameError(
  files: readonly FolderEditPlaced[],
  folders: readonly string[],
  parent: string,
  name: string,
  /** A folder being renamed, which may keep its name. */
  self?: string,
): FolderEditNameError | null {
  const trimmed = name.trim();
  if (!trimmed) return "empty";
  if (/[\\/]/.test(trimmed) || trimmed === "." || trimmed === "..") return "invalid";
  const path = joinFolderPath(parent, trimmed);
  if (inLyricsFolder(path)) return "reserved";
  if (self !== undefined && identity(path) === identity(self)) return null;
  const taken = new Set([...files.map((file) => identity(file.path)), ...layoutFolders(files, folders).map(identity)]);
  return taken.has(identity(path)) ? "taken" : null;
}

/** Creates an empty folder; a name check comes first. */
export function addFolder(layout: FolderEditLayout, parent: string, name: string): FolderEditLayout {
  return { ...layout, folders: [...layout.folders, joinFolderPath(parent, name.trim())] };
}

/** Renames a folder; a name check comes first. */
export function renameFolder(
  layout: FolderEditLayout,
  files: readonly FolderEditPlaced[],
  folder: string,
  name: string,
): FolderEditLayout {
  const destination = joinFolderPath(parentFolder(folder), name.trim());
  if (destination === folder) return layout;
  return relocateFolder(layout, files, folder, destination);
}

/**
 * Removes a folder. What it holds moves up into the folder that holds it,
 * where a name already taken there is numbered.
 */
export function deleteFolder(
  layout: FolderEditLayout,
  files: readonly FolderEditPlaced[],
  folder: string,
): FolderEditLayout {
  const parent = parentFolder(folder);
  const lift = (path: string) => joinFolderPath(parent, path.slice(folder.length + 1));
  const moving = files
    .filter((file) => folderContains(folder, file.path))
    .map((file) => ({ key: file.key, path: lift(file.path) }));
  const folders = layout.folders.flatMap((path) => {
    if (path === folder) return [];
    return folderContains(folder, path) ? [lift(path)] : [path];
  });
  return relocate(layout, files, moving, [...new Set(folders)]);
}

/** Whether a folder holds anything: a file or a created folder. */
export function folderHasContent(files: readonly FolderEditPlaced[], folders: readonly string[], folder: string) {
  return (
    files.some((file) => folderContains(folder, parentFolder(file.path)) && file.path !== folder) ||
    folders.some((path) => path !== folder && folderContains(folder, path))
  );
}

/** Drops placements of files the edit no longer holds, and created folders a file now fills. */
export function prunedLayout(layout: FolderEditLayout, keys: ReadonlySet<string>): FolderEditLayout {
  const placements: Record<string, string> = {};
  for (const [key, path] of Object.entries(layout.placements)) if (keys.has(key)) placements[key] = path;
  return { placements, folders: layout.folders };
}
