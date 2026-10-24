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

/** Folders and files as the directory nests them: each folder's subfolders, then its files, in natural order. */
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
    for (const name of [...branch.folders.keys()].sort(naturalNameCompare)) {
      const child = branch.folders.get(name)!;
      if (child.row) rows.push(child.row);
      visit(child);
    }
    rows.push(...branch.files.sort((left, right) => naturalNameCompare(left.path, right.path)));
  };
  visit(root);
  return rows;
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
    const draft = drafts[row.key];
    if (draft === undefined) continue;
    const name = draft.trim();
    if (name === (row.names[language] ?? "")) continue;
    if (row.kind === "file" && row.mediaItemId) change.files.push({ mediaItemId: row.mediaItemId, name });
    else if (row.kind === "folder") change.folders.push({ path: row.path, name });
  }
  return change.files.length + change.folders.length > 0 ? change : null;
}

/** The real names of the rows, one per line, to translate elsewhere and paste back. */
export function realNamesText(rows: DisplayNameRow[]) {
  return rows.map((row) => row.baseName).join("\n");
}

/**
 * Applies pasted names to the rows in order, one line per row. A blank line
 * leaves its row alone, and lines past the last row are ignored.
 */
export function pasteDisplayNames(rows: DisplayNameRow[], drafts: DisplayNameDrafts, text: string): DisplayNameDrafts {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const next = { ...drafts };
  rows.forEach((row, index) => {
    const line = lines[index]?.trim();
    if (line) next[row.key] = line;
  });
  return next;
}

/** A name is one path segment of at most 255 characters. */
export function displayNameInvalid(value: string) {
  const name = value.trim();
  return [...name].length > 255 || name === "." || name === ".." || /[/\\\p{Cc}]/u.test(name);
}
