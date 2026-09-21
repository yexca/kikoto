import type { TreeNode, TreeTrack } from "@/features/work-detail/media/mediaTreeModel";
import type { MediaDeleteTarget } from "@/features/work-detail/workflows/useMediaCleanupWorkflow";

export function directoryManageTargets(
  root: TreeNode,
  options: { allowCacheDelete?: boolean; allowLocalDelete?: boolean },
) {
  return sortedFilesDeep(root).flatMap((file) => mediaDeleteTargetsForFile(file, options));
}

export function mediaDeleteTargetsForFile(
  file: TreeTrack,
  options: { allowCacheDelete?: boolean; allowLocalDelete?: boolean },
) {
  const targets: MediaDeleteTarget[] = [];
  if (options.allowCacheDelete && file.cacheAvailable && file.cacheLocationId !== null) {
    targets.push({
      kind: "cache",
      locationId: file.cacheLocationId,
      workId: 0,
      title: file.title,
      path: file.cachePath,
      sizeBytes: file.sizeBytes,
    });
  }
  if (options.allowLocalDelete && file.localAvailable && file.localLocationId !== null) {
    targets.push({
      kind: "local",
      locationId: file.localLocationId,
      workId: 0,
      title: file.title,
      path: file.localPath,
      sizeBytes: file.sizeBytes,
    });
  }
  return targets;
}

export function mediaDeleteTargetKey(target: MediaDeleteTarget) {
  return `${target.kind}:${target.folderId ?? target.locationId}`;
}

export function isMediaPathWithinRoot(root: string, candidate: string) {
  const normalizedRoot = root
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  const normalizedCandidate = candidate
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

export function sortedFilesDeep(node: TreeNode) {
  const files = [...node.files];
  for (const child of node.children.values()) {
    files.push(...sortedFilesDeep(child));
  }
  return files.sort((a, b) =>
    (a.sourcePath || a.title).localeCompare(b.sourcePath || b.title, undefined, { numeric: true, sensitivity: "base" }),
  );
}
