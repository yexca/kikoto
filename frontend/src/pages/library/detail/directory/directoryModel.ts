// Pure directory tree ordering, visibility, and playback directory recommendation.

import type { DirectoryRoutingRule } from "@/lib/api";
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

function folderNameHasPriority(name: string) {
  const lower = name.toLowerCase();
  return ["本編", "honhen", "main", "mp3"].some((value) => lower.includes(value.toLowerCase()));
}

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

type VisibleTreeRow =
  | { type: "folder"; node: TreeNode; depth: number }
  | { type: "file"; file: TreeTrack; parent: TreeNode; depth: number };

export function initialExpandedTreePaths(root: TreeNode, rules: DirectoryRoutingRule[]) {
  const paths = new Set<string>();
  const recommended = recommendedDirectoryCandidate(root, rules);
  if (recommended) {
    let cursor: TreeNode | null = root;
    for (const part of recommended.path) {
      cursor = cursor?.children.get(part) ?? null;
      if (!cursor) break;
      paths.add(cursor.path);
    }
    return paths;
  }
  for (const folder of sortedFolders(root)) {
    if (folderNameHasPriority(folder.name) || folderContainsActiveAudio(folder)) {
      paths.add(folder.path);
      for (const child of sortedFolders(folder)) {
        if (folderNameHasPriority(child.name)) paths.add(child.path);
      }
    }
  }
  return paths;
}

function folderContainsActiveAudio(node: TreeNode) {
  if (playableFiles(node.files).length > 0) return true;
  return sortedFolders(node).some(
    (child) => folderNameHasPriority(child.name) && playableFiles(child.files).length > 0,
  );
}

export function flattenVisibleTreeRows(root: TreeNode, expandedPaths: Set<string>) {
  const rows: VisibleTreeRow[] = [];
  const visit = (node: TreeNode, depth: number) => {
    rows.push({ type: "folder", node, depth });
    if (!expandedPaths.has(node.path)) return;
    for (const child of sortedFolders(node)) {
      visit(child, depth + 1);
    }
    for (const file of sortedFiles(node)) {
      rows.push({ type: "file", file, parent: node, depth: depth + 1 });
    }
  };
  for (const folder of sortedFolders(root)) {
    visit(folder, 0);
  }
  for (const file of sortedFiles(root)) {
    rows.push({ type: "file", file, parent: root, depth: 0 });
  }
  return rows;
}

export function nodeAtPath(root: TreeNode, path: string[]) {
  let cursor: TreeNode | undefined = root;
  for (const part of path) {
    cursor = cursor?.children.get(part);
    if (!cursor) return null;
  }
  return cursor;
}

export function folderSummary(node: TreeNode) {
  const stats = treeStats(node);
  return formatFolderStats(stats, playableFiles(node.files).length);
}

export function fileKindLabel(kind: string) {
  if (kind === "audio") return i18n.t("libraryDetail.audio");
  if (kind === "video") return i18n.t("libraryDetail.video");
  if (kind === "image") return i18n.t("libraryDetail.image");
  if (kind === "text") return i18n.t("libraryDetail.text");
  return i18n.t("libraryDetail.file");
}

export function previewForFile(file: TreeTrack): FilePreviewState | null {
  if (file.kind === "image" && file.assetUrl) {
    return {
      kind: "image",
      title: file.title,
      url: file.assetUrl,
      locationId: file.locationId,
      canSetCover: file.locationType === "local" && file.locationId > 0,
    };
  }
  if (file.kind === "video" && file.streamUrl) {
    return {
      kind: "video",
      title: file.title,
      url: file.streamUrl,
      locationId: file.locationId,
      durationSeconds: file.durationSeconds,
      canTranscode: file.locationType === "local" || file.locationType === "cache",
    };
  }
  if (file.kind === "text" && (file.locationId > 0 || file.streamUrl || file.downloadUrl)) {
    return {
      kind: "text",
      title: file.title,
      locationId: file.locationId,
      url: file.textPreviewUrl || (file.locationId > 0 ? undefined : file.streamUrl || file.downloadUrl || undefined),
    };
  }
  return null;
}
