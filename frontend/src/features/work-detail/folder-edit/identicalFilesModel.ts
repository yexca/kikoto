import type { DuplicateFileGroup } from "../../../lib/api";
import { naturalNameCompare } from "../../../lib/naturalNameOrder";
import { baseName, folderContains } from "./folderEditLayout";
import type { FolderEditFile, FolderEditResource } from "./folderEditModel";

/**
 * One copy of a set of identical files. A copy in the edited folder can be
 * kept or deleted with the edit; a copy anywhere else is only a reference,
 * because the edit changes nothing outside the edited folder.
 */
export type IdenticalCopy = {
  place: "target" | "local";
  /** The path below the folder that holds the copy. */
  path: string;
  name: string;
  /** The work code of the edition whose folder holds the copy. */
  workCode: string;
  /** The workspace place that shows the copy, when the workspace lists its folder. */
  resourceId: string | null;
  /** The folder that holds a copy outside the edited folder, as a library path. */
  folder: string;
};

/**
 * A set of identical files with at least one copy in the edited folder. When
 * a copy is outside it, every copy inside is redundant; otherwise one copy
 * inside is kept.
 */
export type IdenticalSet = {
  key: string;
  sizeBytes: number;
  kind: "elsewhere" | "repeated";
  /** The copies in the edited folder, the suggested one to keep first. */
  inside: IdenticalCopy[];
  outside: IdenticalCopy[];
  /** The copy of the edited folder suggested to keep, for a set repeated only inside it. */
  suggestedKeep: string | null;
};

export type IdenticalFiles = {
  /** Sets with a copy elsewhere first, then sets repeated in the edited folder, each in path order. */
  sets: IdenticalSet[];
  /** The set of each path of the edited folder that has an identical copy. */
  byPath: Map<string, IdenticalSet>;
};

// What file managers add to a copied file's name, matched at the end of its
// name without the extension, or at its start for "Copy of".
const copyMarks = [
  /\s*[(（]\s*(?:copy(?:\s*\d+)?|\d+)\s*[)）]$/iu,
  /\s*[-_–]\s*(?:copy|コピー|副本|复制|複製|복사본)(?:\s*[(（]?\d+[)）]?)?$/iu,
  /\s+(?:copy|副本)(?:\s+\d+)?$/iu,
  /\s*の?コピー(?:\s*[(（]?\d+[)）]?)?$/u,
  /^copy\s+of\s+/iu,
];

/** Whether a file's name carries a mark that a file manager adds to a copy, such as " (1)" or " - Copy". */
export function hasCopyMark(name: string) {
  const dot = name.lastIndexOf(".");
  const stem = (dot > 0 ? name.slice(0, dot) : name).trim();
  return copyMarks.some((mark) => mark.test(stem));
}

function depth(path: string) {
  return path.split("/").length;
}

/**
 * Orders copies of the edited folder by how likely each is the original: a
 * name without a copy mark first, then the copy in the fewest folders, then
 * the first by path. The first copy is the one suggested to keep.
 */
export function compareKeepCandidates(left: string, right: string) {
  const marked = Number(hasCopyMark(baseName(left))) - Number(hasCopyMark(baseName(right)));
  if (marked !== 0) return marked;
  const levels = depth(left) - depth(right);
  if (levels !== 0) return levels;
  return naturalNameCompare(left, right);
}

function normalize(path: string) {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/** The workspace place and the path inside it of a file outside the edited folder. */
function locate(
  file: DuplicateFileGroup["files"][number],
  resources: readonly FolderEditResource[],
): Pick<IdenticalCopy, "path" | "resourceId" | "folder"> {
  const full = normalize(file.path);
  for (const resource of resources) {
    if (resource.kind !== "local" || resource.workId !== file.workId) continue;
    const root = normalize(resource.rootPath);
    if (root && folderContains(root, full) && full !== root) {
      return { path: full.slice(root.length + 1), resourceId: resource.id, folder: root };
    }
  }
  const slash = full.lastIndexOf("/");
  return { path: baseName(full), resourceId: null, folder: slash < 0 ? "" : full.slice(0, slash) };
}

/**
 * Relates the identical-file groups of a work's family to the edited folder's
 * files, by their local file locations. A group without a copy in the edited
 * folder is left out.
 */
export function identicalFiles(
  groups: readonly DuplicateFileGroup[],
  files: readonly FolderEditFile[],
  resources: readonly FolderEditResource[],
): IdenticalFiles {
  const listed = new Map(
    files.filter((file) => file.locationId !== null).map((file) => [file.locationId as number, file.path]),
  );
  const sets: IdenticalSet[] = [];
  for (const group of groups) {
    const inside: IdenticalCopy[] = [];
    const outside: IdenticalCopy[] = [];
    for (const file of group.files) {
      const path = listed.get(file.locationId);
      if (path !== undefined) {
        inside.push({
          place: "target",
          path,
          name: baseName(path),
          workCode: file.workCode,
          resourceId: null,
          folder: "",
        });
      } else {
        const where = locate(file, resources);
        outside.push({ place: "local", name: baseName(where.path), workCode: file.workCode, ...where });
      }
    }
    if (inside.length === 0 || inside.length + outside.length < 2) continue;
    inside.sort((left, right) => compareKeepCandidates(left.path, right.path));
    const kind = outside.length > 0 ? "elsewhere" : "repeated";
    sets.push({
      key: `set:${group.files[0].locationId}`,
      sizeBytes: group.sizeBytes,
      kind,
      inside,
      outside,
      suggestedKeep: kind === "repeated" ? inside[0].path : null,
    });
  }
  const order = (set: IdenticalSet) =>
    [...set.inside].sort((left, right) => naturalNameCompare(left.path, right.path))[0].path;
  sets.sort((left, right) =>
    left.kind !== right.kind ? (left.kind === "elsewhere" ? -1 : 1) : naturalNameCompare(order(left), order(right)),
  );
  const byPath = new Map<string, IdenticalSet>();
  for (const set of sets) for (const copy of set.inside) byPath.set(copy.path, set);
  return { sets, byPath };
}

/**
 * Where a set stands in the edit. `keep` is the copy of the edited folder that
 * stays for a repeated set: the only copy left when the edit deletes all the
 * others, else the chosen one, else the suggested one. `planned` are the
 * copies the suggestion deletes: every copy inside for a set with a copy
 * elsewhere, and every copy but `keep` otherwise.
 */
export function identicalSetState(set: IdenticalSet, kept: ReadonlySet<string>, chosen?: string) {
  const deleting = set.inside.filter((copy) => !kept.has(copy.path)).map((copy) => copy.path);
  const remaining = set.inside.filter((copy) => kept.has(copy.path));
  let keep: string | null = null;
  if (set.kind === "repeated") {
    if (remaining.length === 1 && deleting.length > 0) keep = remaining[0].path;
    else if (chosen && set.inside.some((copy) => copy.path === chosen)) keep = chosen;
    else keep = set.suggestedKeep;
  }
  const planned = set.inside.filter((copy) => copy.path !== keep).map((copy) => copy.path);
  const applied = deleting.length === planned.length && planned.every((path) => !kept.has(path));
  return {
    keep,
    planned,
    deleting,
    status: deleting.length === 0 ? ("none" as const) : applied ? ("applied" as const) : ("partial" as const),
    /** Every copy is deleted and none exists elsewhere, so the content is lost. */
    lost: set.kind === "repeated" && remaining.length === 0,
  };
}

export type IdenticalSetState = ReturnType<typeof identicalSetState>;

/** The kept files of the edited folder once a set follows its plan: `keep` stays and the planned copies go. */
export function withIdenticalPlan(kept: ReadonlySet<string>, set: IdenticalSet, keep: string | null) {
  const next = new Set(kept);
  for (const copy of set.inside) {
    if (copy.path === keep) next.add(copy.path);
    else next.delete(copy.path);
  }
  return next;
}
