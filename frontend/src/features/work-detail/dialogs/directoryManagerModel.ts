import {
  mediaDeleteTargetKey,
  mediaDeleteTargetsForFile,
  sortedFilesDeep,
} from "@/features/work-detail/dialogs/mediaDeleteTargets";
import type { TreeNode } from "@/features/work-detail/media/mediaTreeModel";
import type { MediaDeleteTarget } from "@/features/work-detail/workflows/useMediaCleanupWorkflow";

export type DirectoryManagerOptions = { allowCacheDelete?: boolean; allowLocalDelete?: boolean };

/** A one-click selection shortcut: every deletable copy that shares a format or location. */
export type DirectoryManagerSelectionGroup = {
  key: string;
  files: number;
  sizeBytes: number;
  targetKeys: string[];
};

export type DirectoryManagerSelectionState = {
  selected: number;
  total: number;
  checked: boolean;
  indeterminate: boolean;
};

export function fileExtension(name: string) {
  const baseName = name.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = baseName.lastIndexOf(".");
  return dot > 0 && dot < baseName.length - 1 ? baseName.slice(dot + 1).toLowerCase() : "";
}

/** Groups deletable files by extension, largest group first, so formats can be removed together. */
export function directoryManagerFormatGroups(root: TreeNode, options: DirectoryManagerOptions) {
  const groups = new Map<string, DirectoryManagerSelectionGroup>();
  for (const file of sortedFilesDeep(root)) {
    const targets = mediaDeleteTargetsForFile(file, options);
    const extension = fileExtension(file.sourcePath || file.title);
    if (targets.length === 0 || !extension) continue;
    const group = groups.get(extension) ?? { key: extension, files: 0, sizeBytes: 0, targetKeys: [] };
    group.files += 1;
    group.sizeBytes += file.sizeBytes ?? 0;
    group.targetKeys.push(...targets.map(mediaDeleteTargetKey));
    groups.set(extension, group);
  }
  return [...groups.values()].sort((a, b) => b.sizeBytes - a.sizeBytes || a.key.localeCompare(b.key));
}

/** Groups file copies by where they are stored; the work root folder is not a file copy. */
export function directoryManagerLocationGroups(targets: MediaDeleteTarget[]) {
  return (["local", "cache"] as const)
    .map((kind): DirectoryManagerSelectionGroup => {
      const matching = targets.filter((target) => target.kind === kind);
      return {
        key: kind,
        files: matching.length,
        sizeBytes: selectedBytes(matching),
        targetKeys: matching.map(mediaDeleteTargetKey),
      };
    })
    .filter((group) => group.files > 0);
}

export function directoryManagerSelectionState(
  targetKeys: string[],
  selectedKeys: Set<string>,
): DirectoryManagerSelectionState {
  const selected = targetKeys.filter((key) => selectedKeys.has(key)).length;
  return {
    selected,
    total: targetKeys.length,
    checked: targetKeys.length > 0 && selected === targetKeys.length,
    indeterminate: selected > 0 && selected < targetKeys.length,
  };
}

export function withTargetKeys(selectedKeys: Set<string>, targetKeys: string[], included: boolean) {
  const next = new Set(selectedKeys);
  for (const key of targetKeys) {
    if (included) next.add(key);
    else next.delete(key);
  }
  return next;
}

export function selectedBytes(targets: MediaDeleteTarget[]) {
  return targets.reduce((sum, target) => sum + (target.sizeBytes ?? 0), 0);
}
