// Pure directory tree ordering, visibility, and playback directory recommendation.

import type { DirectoryRoutingRule, MediaProgress } from "@/lib/api";
import {
  playableFiles,
  sortedTreeChildren,
  sortedTreeFiles,
  type TreeNode,
  treeStats,
  type TreeTrack,
} from "@/features/work-detail/media/mediaTreeModel";
import { formatFolderStats } from "@/features/work-detail/dialogs/mediaFilePresentation";
import i18n from "@/i18n";
import type { FilePreviewState } from "@/features/work-detail/dialogs/FilePreviewDialog";

export const defaultDirectoryRoutingRules: DirectoryRoutingRule[] = [
  {
    id: "main",
    label: "Main story",
    weight: 40,
    aliases: ["本編", "本篇", "honhen", "main"],
    negativeAliases: ["特典", "bonus", "おまけ"],
    enabled: true,
  },
  {
    id: "with_se",
    label: "SEあり",
    weight: 30,
    aliases: ["SEあり", "SE有", "SE付き", "効果音あり", "with se"],
    negativeAliases: ["SEなし", "SE無", "効果音なし", "without se"],
    enabled: true,
  },
  {
    id: "mp3",
    label: "mp3",
    weight: 20,
    aliases: ["mp3"],
    negativeAliases: ["wav", "flac"],
    enabled: true,
  },
];

type DirectoryCandidate = {
  node: TreeNode;
  path: string[];
  score: number;
  positiveMatches: string[];
  negativeMatches: string[];
  audioCount: number;
  durationSeconds: number;
  order: number;
};

export type DirectoryRouteMatch = {
  path: string[];
  pathLabel: string;
  positiveMatches: string[];
  negativeMatches: string[];
};

export function recommendedDirectoryPath(root: TreeNode, rules: DirectoryRoutingRule[]) {
  return recommendedDirectoryCandidate(root, rules)?.path ?? [];
}

function recommendedDirectoryCandidate(root: TreeNode, rules: DirectoryRoutingRule[]) {
  const candidates = directoryCandidates(root, rules);
  if (candidates.length === 0) return null;
  return candidates.sort(
    (left, right) =>
      right.score - left.score ||
      right.audioCount - left.audioCount ||
      right.durationSeconds - left.durationSeconds ||
      left.path.length - right.path.length ||
      left.order - right.order,
  )[0];
}

export function directoryRouteSummary(root: TreeNode, rules: DirectoryRoutingRule[]): DirectoryRouteMatch | null {
  const candidate = recommendedDirectoryCandidate(root, rules);
  if (!candidate) return null;
  return {
    path: candidate.path,
    pathLabel: candidate.path.length > 0 ? `/${candidate.path.join("/")}` : "/",
    positiveMatches: candidate.positiveMatches,
    negativeMatches: candidate.negativeMatches,
  };
}

function directoryCandidates(root: TreeNode, rules: DirectoryRoutingRule[]) {
  const candidates: DirectoryCandidate[] = [];
  let order = 0;
  const visit = (node: TreeNode, path: string[]) => {
    const playable = playableFiles(node.files);
    if (playable.length > 0) {
      const match = scoreDirectoryCandidate(node, path, playable, rules);
      candidates.push({
        node,
        path,
        score: match.score,
        positiveMatches: match.positiveMatches,
        negativeMatches: match.negativeMatches,
        audioCount: playable.length,
        durationSeconds: playable.reduce((sum, file) => sum + (file.durationSeconds ?? 0), 0),
        order,
      });
      order += 1;
    }
    for (const child of sortedFolders(node)) {
      visit(child, [...path, child.name]);
    }
  };
  visit(root, []);
  return candidates;
}

function scoreDirectoryCandidate(node: TreeNode, path: string[], files: TreeTrack[], rules: DirectoryRoutingRule[]) {
  const text = normalizeDirectoryMatchText(
    [...path, node.name, node.path, ...files.map((file) => file.title), ...files.map((file) => file.baseName)].join(
      " / ",
    ),
  );
  let score = 0;
  const positiveMatches: string[] = [];
  const negativeMatches: string[] = [];
  const enabledRules = rules.filter((rule) => rule.enabled && rule.aliases.length > 0);
  enabledRules.forEach((rule, index) => {
    const weight = Number.isFinite(rule.weight) ? Math.max(1, rule.weight) : Math.max(1, 40 - index * 10);
    const alias = rule.aliases.find((alias) => directoryTextMatches(text, alias));
    if (alias) {
      score += weight;
      positiveMatches.push(alias);
    }
    const negativeAlias = rule.negativeAliases.find((alias) => directoryTextMatches(text, alias));
    if (negativeAlias) {
      score -= Math.ceil(weight * 0.9);
      negativeMatches.push(negativeAlias);
    }
  });
  score += Math.min(10, files.length);
  return { score, positiveMatches, negativeMatches };
}

function normalizeDirectoryMatchText(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[-＿_.[\]()【】]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function directoryTextMatches(text: string, alias: string) {
  const normalized = normalizeDirectoryMatchText(alias);
  return normalized !== "" && text.includes(normalized);
}

export function sortedFolders(node: TreeNode) {
  return sortedTreeChildren(node);
}

export function sortedFiles(node: TreeNode) {
  return sortedTreeFiles(node);
}

export type FolderContentCounts = {
  playable: number;
  images: number;
  files: number;
};

export type FolderNavigatorRow = {
  /** Tree path of the deepest folder in a compacted chain; the expansion key. */
  key: string;
  path: string[];
  /** Folder names merged into this row. Empty for the work root. */
  labelParts: string[];
  depth: number;
  node: TreeNode;
  isRoot: boolean;
  hasChildren: boolean;
  expanded: boolean;
  counts: FolderContentCounts;
};

const fullyExpandedFolderLimit = 12;

export function folderContentCounts(node: TreeNode): FolderContentCounts {
  const counts: FolderContentCounts = { playable: 0, images: 0, files: 0 };
  const visit = (cursor: TreeNode) => {
    counts.playable += playableFiles(cursor.files).length;
    counts.images += cursor.files.filter((file) => file.kind === "image").length;
    counts.files += cursor.files.length;
    for (const child of cursor.children.values()) visit(child);
  };
  visit(node);
  return counts;
}

function countFolders(node: TreeNode): number {
  let count = 0;
  for (const child of node.children.values()) count += 1 + countFolders(child);
  return count;
}

/** True when the tree has a folder worth navigating between. */
export function treeHasFolders(root: TreeNode) {
  return root.children.size > 0;
}

/**
 * Small trees open fully so the work's whole layout is visible at once; larger
 * trees open only the folders leading to the given paths.
 */
export function initialFolderNavigatorExpansion(root: TreeNode, focusPaths: (string[] | null | undefined)[]) {
  const expanded = new Set<string>();
  if (countFolders(root) <= fullyExpandedFolderLimit) {
    const visit = (node: TreeNode) => {
      for (const child of node.children.values()) {
        if (child.children.size > 0) expanded.add(child.path);
        visit(child);
      }
    };
    visit(root);
    return expanded;
  }
  for (const path of focusPaths) {
    let cursor: TreeNode | undefined = root;
    for (const part of path ?? []) {
      cursor = cursor?.children.get(part);
      if (!cursor) break;
      expanded.add(cursor.path);
    }
  }
  return expanded;
}

/** Tree paths of every folder on the way to `path`, including the folder itself. */
export function folderAncestorKeys(root: TreeNode, path: string[]) {
  const keys: string[] = [];
  let cursor: TreeNode | undefined = root;
  for (const part of path) {
    cursor = cursor?.children.get(part);
    if (!cursor) break;
    keys.push(cursor.path);
  }
  return keys;
}

/**
 * Flattens the visible folder navigator. A folder holding nothing but a single
 * subfolder merges with it into one row, like a wrapper folder named after the
 * work, so the navigator starts where the content does.
 */
export function folderNavigatorRows(root: TreeNode, expandedKeys: ReadonlySet<string>): FolderNavigatorRow[] {
  const rows: FolderNavigatorRow[] = [];
  const visit = (node: TreeNode, path: string[], depth: number, isRoot: boolean) => {
    let cursor = node;
    let cursorPath = path;
    const labelParts = isRoot ? [] : [node.name];
    while (cursor.files.length === 0 && cursor.children.size === 1) {
      const only = cursor.children.values().next().value as TreeNode;
      cursor = only;
      cursorPath = [...cursorPath, only.name];
      labelParts.push(only.name);
    }
    const children = sortedFolders(cursor);
    const expanded = isRoot || expandedKeys.has(cursor.path);
    rows.push({
      key: cursor.path,
      path: cursorPath,
      labelParts,
      depth,
      node: cursor,
      isRoot,
      hasChildren: !isRoot && children.length > 0,
      expanded,
      counts: folderContentCounts(cursor),
    });
    if (!expanded) return;
    // The root's folders sit level with it; the root row needs no disclosure.
    const childDepth = isRoot ? depth : depth + 1;
    for (const child of children) visit(child, [...cursorPath, child.name], childDepth, false);
  };
  visit(root, [], 0, true);
  return rows;
}

export type FolderSections = {
  tracks: TreeTrack[];
  images: TreeTrack[];
  documents: TreeTrack[];
  others: TreeTrack[];
};

/** Splits a folder's sorted files into playable tracks, images, text, and everything else. */
export function folderSections(files: TreeTrack[]): FolderSections {
  const tracks = playableFiles(files);
  const playable = new Set(tracks);
  const sections: FolderSections = { tracks, images: [], documents: [], others: [] };
  for (const file of files) {
    if (playable.has(file)) continue;
    if (file.kind === "image") sections.images.push(file);
    else if (file.kind === "text") sections.documents.push(file);
    else sections.others.push(file);
  }
  return sections;
}

/** Local and cached images may render inline; remote images load only on request. */
export function imageThumbnailURL(file: TreeTrack) {
  if (file.kind !== "image" || file.availability !== "available" || !file.assetUrl) return "";
  return file.locationType === "local" || file.locationType === "cache" ? file.assetUrl : "";
}

export function isActiveTreeTrack(
  file: TreeTrack,
  currentLocationId: number | null,
  currentPlaybackKey: string | null,
) {
  return file.playbackKey === currentPlaybackKey || (!file.playbackKey && file.locationId === currentLocationId);
}

/** Folder path of the file the player is on, matched the same way rows mark it active. */
export function activeTrackFolderPath(
  root: TreeNode,
  currentLocationId: number | null,
  currentPlaybackKey: string | null,
): string[] | null {
  if (currentLocationId === null && !currentPlaybackKey) return null;
  const visit = (node: TreeNode, path: string[]): string[] | null => {
    if (node.files.some((file) => isActiveTreeTrack(file, currentLocationId, currentPlaybackKey))) return path;
    for (const child of node.children.values()) {
      const found = visit(child, [...path, child.name]);
      if (found) return found;
    }
    return null;
  };
  return visit(root, []);
}

export type TreePlaybackCursor = MediaProgress & { mediaItemId: number };

/** The newer cursor applies only when it points at a file in this tree. */
export function cursorInTree(root: TreeNode, cursor: TreePlaybackCursor | null): TreePlaybackCursor | null {
  if (!cursor) return null;
  const visit = (node: TreeNode): boolean =>
    node.files.some((file) => file.mediaItemId === cursor.mediaItemId) ||
    Array.from(node.children.values()).some(visit);
  return visit(root) ? cursor : null;
}

/**
 * A work keeps one resume cursor, so a newer cursor in the same tree replaces
 * whichever track held the one the tree was loaded with.
 */
export function treeTrackProgress(file: TreeTrack, liveCursor: TreePlaybackCursor | null): MediaProgress | null {
  if (!liveCursor) return file.progress;
  if (file.mediaItemId !== liveCursor.mediaItemId) return null;
  return {
    positionSeconds: liveCursor.positionSeconds,
    durationSeconds: liveCursor.durationSeconds,
    completed: liveCursor.completed,
    lastPlayedAt: liveCursor.lastPlayedAt,
  };
}

export type TrackListeningState =
  | { kind: "unplayed" }
  | { kind: "played" }
  | { kind: "inProgress"; positionSeconds: number; fraction: number | null; remainingSeconds: number | null };

// A few seconds in is an accidental start, not a place to come back to.
const minimumListeningPositionSeconds = 5;

export function trackListeningState(
  progress: MediaProgress | null | undefined,
  fileDurationSeconds: number | null,
): TrackListeningState {
  if (!progress) return { kind: "unplayed" };
  if (progress.completed) return { kind: "played" };
  if (!(progress.positionSeconds >= minimumListeningPositionSeconds)) return { kind: "unplayed" };
  const duration =
    [progress.durationSeconds, fileDurationSeconds].find(
      (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0,
    ) ?? null;
  if (duration === null) {
    return { kind: "inProgress", positionSeconds: progress.positionSeconds, fraction: null, remainingSeconds: null };
  }
  const position = Math.min(progress.positionSeconds, duration);
  return {
    kind: "inProgress",
    positionSeconds: position,
    fraction: position / duration,
    remainingSeconds: duration - position,
  };
}

export function samePath(left: readonly string[] | null | undefined, right: readonly string[] | null | undefined) {
  if (!left || !right || left.length !== right.length) return false;
  return left.every((part, index) => part === right[index]);
}

/** True when `path` equals `ancestor` or lies inside it. */
export function pathWithin(path: readonly string[] | null | undefined, ancestor: readonly string[]) {
  if (!path || path.length < ancestor.length) return false;
  return ancestor.every((part, index) => part === path[index]);
}

export function nodeAtPath(root: TreeNode, path: string[]) {
  let cursor: TreeNode | undefined = root;
  for (const part of path) {
    cursor = cursor?.children.get(part);
    if (!cursor) return null;
  }
  return cursor;
}

/** Playable count and size of everything inside a folder. */
export function folderSummary(node: TreeNode) {
  const stats = treeStats(node);
  return formatFolderStats(stats, stats.playable);
}

export function fileKindLabel(kind: string) {
  if (kind === "audio") return i18n.t("libraryDetail.audio");
  if (kind === "video") return i18n.t("libraryDetail.video");
  if (kind === "image") return i18n.t("libraryDetail.image");
  if (kind === "text") return i18n.t("libraryDetail.text");
  return i18n.t("libraryDetail.file");
}

/** Whether the download endpoint can serve this file: a local or cached copy that is available. */
export function fileDownloadable(file: TreeTrack) {
  return (
    file.locationId > 0 &&
    file.availability === "available" &&
    (file.locationType === "local" || file.locationType === "cache")
  );
}

export function previewForFile(file: TreeTrack): FilePreviewState | null {
  const base = {
    title: file.title,
    locationId: file.locationId,
    sizeBytes: file.sizeBytes,
    downloadable: fileDownloadable(file),
  };
  if (file.kind === "image" && file.assetUrl) {
    return {
      ...base,
      kind: "image",
      url: file.assetUrl,
      canSetCover: file.locationType === "local" && file.locationId > 0,
      thumbnail: imageThumbnailURL(file) !== "",
    };
  }
  if (file.kind === "video" && file.streamUrl) {
    return {
      ...base,
      kind: "video",
      url: file.streamUrl,
      durationSeconds: file.durationSeconds,
      canTranscode: file.locationType === "local" || file.locationType === "cache",
    };
  }
  if (file.kind === "text" && (file.locationId > 0 || file.streamUrl || file.downloadUrl)) {
    return {
      ...base,
      kind: "text",
      url: file.textPreviewUrl || (file.locationId > 0 ? undefined : file.streamUrl || file.downloadUrl || undefined),
    };
  }
  return null;
}

/** Previews for the files a viewer can step through, in folder order. */
export function previewsForFiles(files: TreeTrack[]) {
  return files.map(previewForFile).filter((preview): preview is FilePreviewState => preview !== null);
}
