import type { FileDisplayNames, FileDisplayNamesChange } from "@/lib/api";
import { naturalNameCompare } from "@/lib/naturalNameOrder";

/** One file or folder of the name editor, in directory order. */
export type DisplayNameRow = {
  key: string;
  kind: "folder" | "file";
  /** The file or folder below the work folder. */
  path: string;
  depth: number;
  /** The real name without a file's extension. */
  baseName: string;
  /** A file's real extension, which every display name of it keeps; empty for a folder. */
  extension: string;
  mediaItemId?: number;
  names: Record<string, string>;
  /** Languages whose stored name was accepted from an LLM translation. */
  llmLanguages: readonly string[];
};

/** Drafts by row key; a row without a draft keeps its stored name. */
export type DisplayNameDrafts = Record<string, string>;

export function splitFileExtension(name: string) {
  const index = name.lastIndexOf(".");
  return index > 0
    ? { baseName: name.slice(0, index), extension: name.slice(index) }
    : { baseName: name, extension: "" };
}

/** Folders and files as the directory nests them: each folder, its files, then its subfolders, in natural order. */
export function displayNameRows(entries: Pick<FileDisplayNames, "folders" | "files">): DisplayNameRow[] {
  type Branch = { folders: Map<string, Branch>; files: DisplayNameRow[]; row: DisplayNameRow | null };
  const root: Branch = { folders: new Map(), files: [], row: null };
  const branchAt = (path: string) => {
    let branch = root;
    for (const part of path.split("/")) {
      let next = branch.folders.get(part);
      if (!next) {
        next = { folders: new Map(), files: [], row: null };
        branch.folders.set(part, next);
      }
      branch = next;
    }
    return branch;
  };
  for (const folder of entries.folders) {
    const parts = folder.path.split("/");
    branchAt(folder.path).row = {
      key: `folder:${folder.path}`,
      kind: "folder",
      path: folder.path,
      depth: parts.length - 1,
      baseName: parts[parts.length - 1],
      extension: "",
      names: folder.names,
      llmLanguages: folder.llmLanguages ?? [],
    };
  }
  for (const file of entries.files) {
    if (!file.mediaItemId) continue;
    const parts = file.path.split("/");
    const parent = parts.length > 1 ? branchAt(parts.slice(0, -1).join("/")) : root;
    parent.files.push({
      key: `file:${file.mediaItemId}`,
      kind: "file",
      path: file.path,
      depth: parts.length - 1,
      ...splitFileExtension(parts[parts.length - 1]),
      mediaItemId: file.mediaItemId,
      names: file.names,
      llmLanguages: file.llmLanguages ?? [],
    });
  }
  const rows: DisplayNameRow[] = [];
  const visit = (branch: Branch) => {
    if (branch.row) rows.push(branch.row);
    rows.push(...branch.files.sort((left, right) => naturalNameCompare(left.path, right.path)));
    for (const name of [...branch.folders.keys()].sort(naturalNameCompare)) visit(branch.folders.get(name)!);
  };
  visit(root);
  return rows;
}

/** A folder of the editor with the files directly in it. The work folder, and a folder without a name of its own, have no folder row. */
export type DisplayNameGroup = { path: string; folder: DisplayNameRow | null; files: DisplayNameRow[] };

export function parentFolderPath(path: string) {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : "";
}

/** The rows by folder, in row order: each folder row opens a group that its files follow. */
export function displayNameGroups(rows: DisplayNameRow[]): DisplayNameGroup[] {
  const groups: DisplayNameGroup[] = [];
  for (const row of rows) {
    if (row.kind === "folder") {
      groups.push({ path: row.path, folder: row, files: [] });
      continue;
    }
    const path = parentFolderPath(row.path);
    const last = groups[groups.length - 1];
    if (last?.path === path) last.files.push(row);
    else groups.push({ path, folder: null, files: [row] });
  }
  return groups;
}

/** Whether a row's real path or stored name in a language contains the filter, ignoring case. */
export function displayNameMatches(row: DisplayNameRow, query: string, language: string) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [row.path, row.names[language] ?? ""].some((text) => text.toLocaleLowerCase().includes(needle));
}

/** How many rows show a display name in a language once the drafts are saved. */
export function namedRowCount(rows: DisplayNameRow[], drafts: DisplayNameDrafts, language: string) {
  return rows.filter((row) => displayNameValue(row, drafts, language).trim() !== "").length;
}

/** Whether a row's draft would change its stored name in a language. */
export function displayNameChanged(row: DisplayNameRow, drafts: DisplayNameDrafts, language: string) {
  const draft = drafts[row.key];
  return draft !== undefined && draft.trim() !== (row.names[language] ?? "");
}

/** The value a row's field holds in a language: its draft, else its stored name. */
export function displayNameValue(row: DisplayNameRow, drafts: DisplayNameDrafts, language: string) {
  return drafts[row.key] ?? row.names[language] ?? "";
}

/** The save one language's drafts make, or null when they change nothing. */
export function displayNameChange(
  rows: DisplayNameRow[],
  drafts: DisplayNameDrafts,
  language: string,
): FileDisplayNamesChange | null {
  const change: FileDisplayNamesChange = { language, files: [], folders: [] };
  for (const row of rows) {
    if (!displayNameChanged(row, drafts, language)) continue;
    const name = drafts[row.key].trim();
    if (row.kind === "file" && row.mediaItemId) change.files.push({ mediaItemId: row.mediaItemId, name });
    else if (row.kind === "folder") change.folders.push({ path: row.path, name });
  }
  return change.files.length + change.folders.length > 0 ? change : null;
}

/** The real names of the rows, one per line, to translate elsewhere. */
export function realNamesText(rows: DisplayNameRow[]) {
  return rows.map((row) => row.baseName).join("\n");
}

/** The names of the rows in a language, one per line, as the text view edits them. */
export function displayNamesText(rows: DisplayNameRow[], drafts: DisplayNameDrafts, language: string) {
  return rows.map((row) => displayNameValue(row, drafts, language)).join("\n");
}

/**
 * The drafts the text view's text makes from the drafts it started with: each
 * line names the row at its position, and an empty line leaves the row its
 * real name. A row past the last line keeps its starting draft, and lines past
 * the last row are ignored.
 */
export function textDisplayNames(rows: DisplayNameRow[], base: DisplayNameDrafts, text: string): DisplayNameDrafts {
  const lines = textLines(text, rows.length);
  const next = { ...base };
  rows.forEach((row, index) => {
    if (index < lines.length) next[row.key] = lines[index];
  });
  return next;
}

/**
 * The lines of a text for `entries` entries, every line an entry's name, an
 * empty one included. Empty lines past the last entry, such as the one a
 * pasted list's final line break leaves, are not counted.
 */
export function textLines(text: string, entries: number) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > entries && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** A name is one path segment of at most 255 characters. */
export function displayNameInvalid(value: string) {
  const name = value.trim();
  return [...name].length > 255 || name === "." || name === ".." || /[/\\\p{Cc}]/u.test(name);
}
