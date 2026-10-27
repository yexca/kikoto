import type { TreeNode, TreeTrack } from "@/features/work-detail/media/mediaTreeModel";
import type { MediaDeleteTarget } from "@/features/work-detail/workflows/useMediaCleanupWorkflow";
import { naturalNameCompare } from "@/lib/naturalNameOrder";

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

/**
 * What forgetting a work deletes: every local and cached copy of its files and
 * its complete local folder, which the server requires to forget it. Without a
 * local file inside the folder there is nothing to name the folder by.
 */
export function forgetWorkTargets(
  root: TreeNode,
  folder: { id: number; rootPath: string },
  workId: number,
  /** How the folder itself is named in the deletion review. */
  rootTitle: string,
): MediaDeleteTarget[] {
  const files = directoryManageTargets(root, { allowCacheDelete: true, allowLocalDelete: true }).map((target) => ({
    ...target,
    workId,
  }));
  const representative = files.find(
    (target) => target.kind === "local" && isMediaPathWithinRoot(folder.rootPath, target.path),
  );
  if (!representative) return [];
  return [
    ...files,
    {
      kind: "local_root",
      locationId: representative.locationId,
      folderId: folder.id,
      expectedPath: folder.rootPath,
      title: rootTitle,
      path: folder.rootPath,
      sizeBytes: null,
      workId,
    },
  ];
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
  return files.sort((a, b) => naturalNameCompare(a.sourcePath || a.title, b.sourcePath || b.title));
}
