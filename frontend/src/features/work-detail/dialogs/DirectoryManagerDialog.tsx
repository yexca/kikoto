import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Folder, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogHeader } from "@/components/ui/dialog";
import { ConfirmMediaBatchDeleteDialog } from "@/features/work-detail/dialogs/ConfirmMediaBatchDeleteDialog";
import {
  directoryManageTargets,
  isMediaPathWithinRoot,
  mediaDeleteTargetKey,
  mediaDeleteTargetsForFile,
  sortedFilesDeep,
} from "@/features/work-detail/dialogs/mediaDeleteTargets";
import { fileIcon, formatFolderStats } from "@/features/work-detail/dialogs/mediaFilePresentation";
import {
  formatBytes,
  formatDuration,
  playableFiles,
  sortedTreeChildren,
  sortedTreeFiles,
  treeStats,
  type TreeNode,
  type TreeTrack,
} from "@/features/work-detail/media/mediaTreeModel";
import type { MediaCleanupMode, MediaDeleteTarget } from "@/features/work-detail/workflows/useMediaCleanupWorkflow";
import i18n from "@/i18n";

function directoryManagerRootTarget({
  fileTargets,
  allowLocalDelete,
  localRoot,
  workId,
}: {
  fileTargets: MediaDeleteTarget[];
  allowLocalDelete?: boolean;
  localRoot: { folderId: number; path: string } | null;
  workId: number;
}): MediaDeleteTarget | null {
  const representative = fileTargets.find(
    (target) => target.kind === "local" && localRoot && isMediaPathWithinRoot(localRoot.path, target.path),
  );
  if (!allowLocalDelete || !localRoot || !representative) return null;
  return {
    kind: "local_root",
    locationId: representative.locationId,
    folderId: localRoot.folderId,
    expectedPath: localRoot.path,
    title: i18n.t("libraryDetail.workRoot"),
    path: localRoot.path,
    sizeBytes: null,
    workId,
  };
}

function directoryManagerExtensionState(targets: MediaDeleteTarget[], selectedKeys: Set<string>, extension: string) {
  const matching = targets.filter((target) => target.path.toLowerCase().endsWith(`.${extension}`));
  const selected = matching.filter((target) => selectedKeys.has(mediaDeleteTargetKey(target))).length;
  return {
    count: matching.length,
    checked: matching.length > 0 && selected === matching.length,
    indeterminate: selected > 0 && selected < matching.length,
  };
}

function directoryManagerSelectionModel({
  targets,
  fileTargets,
  selectedKeys,
  canForgetWork,
}: {
  targets: MediaDeleteTarget[];
  fileTargets: MediaDeleteTarget[];
  selectedKeys: Set<string>;
  canForgetWork: boolean;
}) {
  const selectedTargets = targets.filter((target) => selectedKeys.has(mediaDeleteTargetKey(target)));
  const selectedRootTarget = selectedTargets.find((target) => target.kind === "local_root") ?? null;
  const allFileTargetsSelected =
    fileTargets.length > 0 && fileTargets.every((target) => selectedKeys.has(mediaDeleteTargetKey(target)));
  const selectedWorkIDs = new Set(selectedTargets.map((target) => target.workId).filter((id) => id > 0));
  return {
    selectedTargets,
    selectedSignature: selectedTargets.map(mediaDeleteTargetKey).sort().join("|"),
    allSelected: targets.length > 0 && selectedTargets.length === targets.length,
    canReviewForget: Boolean(
      canForgetWork &&
      selectedRootTarget &&
      allFileTargetsSelected &&
      selectedWorkIDs.size === 1 &&
      selectedRootTarget.workId > 0,
    ),
  };
}

function useDirectoryManagerPreview(selectedTargets: MediaDeleteTarget[], selectedSignature: string) {
  const [previewTargets, setPreviewTargets] = useState<MediaDeleteTarget[]>([]);
  const previewSignature = previewTargets.map(mediaDeleteTargetKey).sort().join("|");
  const previewRefreshing = selectedTargets.length > 0 && selectedSignature !== previewSignature;

  useEffect(() => {
    const timer = window.setTimeout(() => setPreviewTargets(selectedTargets), selectedTargets.length === 0 ? 0 : 600);
    return () => window.clearTimeout(timer);
  }, [selectedSignature, selectedTargets]);

  return { previewTargets, previewRefreshing };
}

function DirectoryManagerSelectionToolbar({
  targets,
  selectedKeys,
  deleting,
  showCachedFilter,
  showOnlyDeletable,
  onSelectAll,
  onClear,
  onSetExtensionIncluded,
  onShowOnlyDeletableChange,
}: {
  targets: MediaDeleteTarget[];
  selectedKeys: Set<string>;
  deleting: boolean;
  showCachedFilter: boolean;
  showOnlyDeletable: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  onSetExtensionIncluded: (extension: string, included: boolean) => void;
  onShowOnlyDeletableChange: (checked: boolean) => void;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" disabled={targets.length === 0 || deleting} onClick={onSelectAll}>
        {i18n.t("remoteFetch.all")}
      </Button>
      {(["mp3", "wav", "flac"] as const).map((extension) => {
        const state = directoryManagerExtensionState(targets, selectedKeys, extension);
        return (
          <label
            key={extension}
            className="inline-flex h-8 items-center gap-2 rounded-md border bg-background px-2 text-xs"
          >
            <Checkbox
              checked={state.checked}
              indeterminate={state.indeterminate}
              disabled={deleting || state.count === 0}
              onCheckedChange={() => onSetExtensionIncluded(extension, !state.checked)}
              aria-label={i18n.t("libraryDetail.includeExtension", { extension: extension.toUpperCase() })}
            />
            <span>{extension.toUpperCase()}</span>
          </label>
        );
      })}
      <Button variant="outline" size="sm" disabled={deleting} onClick={onClear}>
        {i18n.t("libraryDetail.none")}
      </Button>
      {showCachedFilter && (
        <label className="ml-auto inline-flex h-8 items-center gap-2 rounded-md border bg-background px-2 text-xs">
          <Checkbox
            checked={showOnlyDeletable}
            onCheckedChange={onShowOnlyDeletableChange}
            aria-label={i18n.t("libraryDetail.cachedOnly")}
          />
          <span>{i18n.t("libraryDetail.cachedOnly")}</span>
        </label>
      )}
    </div>
  );
}

function DirectoryManagerPreview({
  previewTargets,
  previewRefreshing,
}: {
  previewTargets: MediaDeleteTarget[];
  previewRefreshing: boolean;
}) {
  return (
    <div className="app-scroll min-h-0 overflow-auto p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">{i18n.t("libraryDetail.deletePreview")}</div>
        </div>
        <Badge variant={previewRefreshing ? "outline" : "secondary"}>
          {previewRefreshing
            ? i18n.t("sources.refreshing")
            : i18n.t("libraryDetail.itemsCount", { count: previewTargets.length })}
        </Badge>
      </div>
      {previewRefreshing && (
        <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" /> {i18n.t("libraryDetail.fileOperationInProgress")}
        </div>
      )}
      {previewTargets.length === 0 ? (
        <div className="text-sm text-muted-foreground">{i18n.t("libraryDetail.selectDeletableDescription")}</div>
      ) : (
        <div className="space-y-1">
          {previewTargets.map((target) => (
            <div
              key={mediaDeleteTargetKey(target)}
              className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 border-b py-2 text-xs last:border-b-0"
            >
              <Badge variant="outline" className="row-span-2 h-fit">
                {target.kind}
              </Badge>
              <span className="truncate font-medium" title={target.path}>
                {target.path}
              </span>
              <span className="text-muted-foreground">
                {target.title}
                {target.sizeBytes !== null ? ` · ${formatBytes(target.sizeBytes)}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DirectoryManagerFooter({
  targets,
  selectedCount,
  allSelected,
  canReviewForget,
  previewRefreshing,
  deleting,
  onToggleAll,
  onStartConfirmation,
}: {
  targets: MediaDeleteTarget[];
  selectedCount: number;
  allSelected: boolean;
  canReviewForget: boolean;
  previewRefreshing: boolean;
  deleting: boolean;
  onToggleAll: () => void;
  onStartConfirmation: (mode: MediaCleanupMode) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={targets.length === 0 || deleting} onClick={onToggleAll}>
          {allSelected ? i18n.t("libraryDetail.clearAll") : i18n.t("libraryDetail.selectAll")}
        </Button>
        <span className="text-xs text-muted-foreground">
          {i18n.t("libraryDetail.selectedDeletableCount", { selected: selectedCount, total: targets.length })}
        </span>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={selectedCount === 0 || previewRefreshing || deleting}
          onClick={() => onStartConfirmation("files_only")}
        >
          <Trash2 className="h-4 w-4" />
          {deleting
            ? i18n.t("libraryDetail.deleting")
            : previewRefreshing
              ? i18n.t("libraryDetail.refreshingPreview")
              : i18n.t("libraryDetail.reviewFileDeletion")}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={!canReviewForget || previewRefreshing || deleting}
          title={
            canReviewForget
              ? i18n.t("libraryDetail.deleteSelectedThenForget")
              : i18n.t("libraryDetail.selectCompleteWorkRoot")
          }
          onClick={() => onStartConfirmation("files_and_forget_work")}
        >
          <ShieldAlert className="h-4 w-4" />
          {deleting ? i18n.t("libraryDetail.deleting") : i18n.t("libraryDetail.reviewDeletionForget")}
        </Button>
      </div>
    </div>
  );
}

export function DirectoryManagerDialog({
  root,
  title = i18n.t("libraryDetail.manageFiles"),
  description = i18n.t("libraryDetail.reviewFileOperations"),
  emptyLabel,
  onClose,
  deleting = false,
  onDeleteTargets,
  allowCacheDelete,
  allowLocalDelete,
  localRoot = null,
  showCachedFilter = false,
  workId = 0,
  canForgetWork = false,
}: {
  root: TreeNode;
  title?: string;
  description?: string;
  emptyLabel: string;
  onClose: () => void;
  deleting?: boolean;
  onDeleteTargets?: (targets: MediaDeleteTarget[], mode: MediaCleanupMode) => void;
  allowCacheDelete?: boolean;
  allowLocalDelete?: boolean;
  localRoot?: { folderId: number; path: string } | null;
  showCachedFilter?: boolean;
  workId?: number;
  canForgetWork?: boolean;
}) {
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [confirmStep, setConfirmStep] = useState<0 | 1 | 2>(0);
  const [confirmMode, setConfirmMode] = useState<MediaCleanupMode | null>(null);
  const [showOnlyDeletable, setShowOnlyDeletable] = useState(showCachedFilter);
  const fileTargets = useMemo(
    () => directoryManageTargets(root, { allowCacheDelete, allowLocalDelete }).map((target) => ({ ...target, workId })),
    [root, allowCacheDelete, allowLocalDelete, workId],
  );
  const rootTarget = useMemo<MediaDeleteTarget | null>(() => {
    return directoryManagerRootTarget({ fileTargets, allowLocalDelete, localRoot, workId });
  }, [allowLocalDelete, fileTargets, localRoot, workId]);
  const targets = useMemo(() => (rootTarget ? [...fileTargets, rootTarget] : fileTargets), [fileTargets, rootTarget]);
  const selection = useMemo(
    () => directoryManagerSelectionModel({ targets, fileTargets, selectedKeys, canForgetWork }),
    [targets, fileTargets, selectedKeys, canForgetWork],
  );
  const { previewTargets, previewRefreshing } = useDirectoryManagerPreview(
    selection.selectedTargets,
    selection.selectedSignature,
  );
  const toggleAll = () =>
    setSelectedKeys(selection.allSelected ? new Set() : new Set(targets.map(mediaDeleteTargetKey)));
  const setExtensionIncluded = (extension: string, included: boolean) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      for (const target of targets) {
        if (!target.path.toLowerCase().endsWith(`.${extension}`)) continue;
        const key = mediaDeleteTargetKey(target);
        if (included) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  };
  const toggleTarget = (target: MediaDeleteTarget, selected: boolean) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      const key = mediaDeleteTargetKey(target);
      if (selected) next.add(key);
      else next.delete(key);
      return next;
    });
  };
  const startConfirmation = (mode: MediaCleanupMode) => {
    setConfirmMode(mode);
    setConfirmStep(1);
  };
  const confirmDelete = (mode: MediaCleanupMode) => {
    onDeleteTargets?.(previewTargets, mode);
    setConfirmStep(0);
    setConfirmMode(null);
    setSelectedKeys(new Set());
  };
  return (
    <>
      <Dialog onClose={onClose} size="full" className="max-h-[86vh] max-w-5xl sm:max-h-[86vh]">
        <DialogHeader title={title} description={description} onClose={onClose} closeLabel={i18n.t("content.close")} />
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden bg-card md:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.75fr)]">
          <div className="app-scroll min-h-0 overflow-auto border-b p-3 md:border-b-0 md:border-r">
            <DirectoryManagerSelectionToolbar
              targets={targets}
              selectedKeys={selectedKeys}
              deleting={deleting}
              showCachedFilter={showCachedFilter}
              showOnlyDeletable={showOnlyDeletable}
              onSelectAll={() => setSelectedKeys(new Set(targets.map(mediaDeleteTargetKey)))}
              onClear={() => setSelectedKeys(new Set())}
              onSetExtensionIncluded={setExtensionIncluded}
              onShowOnlyDeletableChange={(checked) => setShowOnlyDeletable(checked)}
            />
            <DirectoryManager
              root={root}
              emptyLabel={emptyLabel}
              selectedKeys={selectedKeys}
              allowCacheDelete={allowCacheDelete}
              allowLocalDelete={allowLocalDelete}
              showOnlyDeletable={showOnlyDeletable}
              onToggleTarget={toggleTarget}
              rootTarget={rootTarget}
            />
          </div>
          <DirectoryManagerPreview previewTargets={previewTargets} previewRefreshing={previewRefreshing} />
        </div>
        <DirectoryManagerFooter
          targets={targets}
          selectedCount={selection.selectedTargets.length}
          allSelected={selection.allSelected}
          canReviewForget={selection.canReviewForget}
          previewRefreshing={previewRefreshing}
          deleting={deleting}
          onToggleAll={toggleAll}
          onStartConfirmation={startConfirmation}
        />
      </Dialog>
      {confirmStep > 0 && (
        <ConfirmMediaBatchDeleteDialog
          targets={previewTargets}
          mode={confirmMode ?? "files_only"}
          step={confirmStep === 2 ? 2 : 1}
          deleting={deleting}
          onCancel={() => {
            setConfirmStep(0);
            setConfirmMode(null);
          }}
          onContinue={() => setConfirmStep(2)}
          onConfirm={() => confirmDelete(confirmMode ?? "files_only")}
        />
      )}
    </>
  );
}

function DirectoryManager({
  root,
  emptyLabel,
  selectedKeys,
  allowCacheDelete,
  allowLocalDelete,
  showOnlyDeletable,
  onToggleTarget,
  rootTarget,
}: {
  root: TreeNode;
  emptyLabel: string;
  selectedKeys: Set<string>;
  allowCacheDelete?: boolean;
  allowLocalDelete?: boolean;
  showOnlyDeletable?: boolean;
  onToggleTarget: (target: MediaDeleteTarget, selected: boolean) => void;
  rootTarget?: MediaDeleteTarget | null;
}) {
  const hasFiles = useMemo(() => sortedFilesDeep(root).length > 0, [root]);
  if (!hasFiles) {
    return <div className="text-sm text-muted-foreground">{emptyLabel}</div>;
  }
  return (
    <div className="space-y-1">
      {rootTarget &&
        (() => {
          const rootTargets = [...directoryManageTargets(root, { allowCacheDelete, allowLocalDelete }), rootTarget];
          const selectedCount = rootTargets.filter((target) => selectedKeys.has(mediaDeleteTargetKey(target))).length;
          const checked = selectedCount === rootTargets.length;
          const mixed = selectedCount > 0 && !checked;
          return (
            <div className="flex min-h-9 items-center gap-2 rounded-md px-2 text-sm font-medium hover:bg-muted">
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
              <Checkbox
                checked={checked}
                indeterminate={mixed}
                onCheckedChange={() => rootTargets.forEach((target) => onToggleTarget(target, !checked))}
                aria-label={i18n.t("libraryDetail.selectWorkRoot", { path: rootTarget.path })}
              />
              <Folder className="h-4 w-4 shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate" title={rootTarget.path}>
                {rootTarget.path}
              </span>
              <span className="text-xs text-muted-foreground">
                {selectedCount}/{rootTargets.length}
              </span>
            </div>
          );
        })()}
      <DirectoryManagerNode
        node={root}
        depth={0}
        selectedKeys={selectedKeys}
        allowCacheDelete={allowCacheDelete}
        allowLocalDelete={allowLocalDelete}
        showOnlyDeletable={showOnlyDeletable}
        onToggleTarget={onToggleTarget}
        isRoot
      />
    </div>
  );
}

function DirectoryManagerNode({
  node,
  depth,
  isRoot,
  selectedKeys,
  allowCacheDelete,
  allowLocalDelete,
  showOnlyDeletable,
  onToggleTarget,
}: {
  node: TreeNode;
  depth: number;
  isRoot?: boolean;
  selectedKeys: Set<string>;
  allowCacheDelete?: boolean;
  allowLocalDelete?: boolean;
  showOnlyDeletable?: boolean;
  onToggleTarget: (target: MediaDeleteTarget, selected: boolean) => void;
}) {
  const [open, setOpen] = useState(isRoot);
  const options = { allowCacheDelete, allowLocalDelete };
  const folders = sortedTreeChildren(node).filter(
    (folder) => !showOnlyDeletable || directoryManageTargets(folder, options).length > 0,
  );
  const files = sortedTreeFiles(node).filter(
    (file) => !showOnlyDeletable || mediaDeleteTargetsForFile(file, options).length > 0,
  );
  const stats = treeStats(node);
  const hasChildren = folders.length > 0 || files.length > 0;
  const nodeTargets = directoryManageTargets(node, options);
  const selectedCount = nodeTargets.filter((target) => selectedKeys.has(mediaDeleteTargetKey(target))).length;
  const checked = nodeTargets.length > 0 && selectedCount === nodeTargets.length;
  const mixed = selectedCount > 0 && selectedCount < nodeTargets.length;
  const toggleNode = () => {
    for (const target of nodeTargets) onToggleTarget(target, !checked);
  };
  return (
    <div className="space-y-1">
      {!isRoot && (
        <div
          className="flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm font-medium hover:bg-muted"
          style={{ paddingLeft: depth * 14 + 8 }}
        >
          <button
            type="button"
            className="rounded p-0.5 hover:bg-background"
            onClick={() => setOpen((value) => !value)}
            aria-label={
              open
                ? i18n.t("libraryDetail.collapseFolder", { name: node.name })
                : i18n.t("libraryDetail.expandFolder", { name: node.name })
            }
          >
            {open ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
          <Checkbox
            checked={checked}
            indeterminate={mixed}
            disabled={nodeTargets.length === 0}
            onCheckedChange={toggleNode}
            aria-label={i18n.t("libraryDetail.selectFolder", { name: node.name })}
          />
          <Folder className="h-4 w-4 shrink-0 text-primary" />
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left"
            onClick={() => setOpen((value) => !value)}
          >
            {node.name}
          </button>
          <span className="shrink-0 text-xs text-muted-foreground">
            {selectedCount}/{nodeTargets.length} · {formatFolderStats(stats, playableFiles(node.files).length)}
          </span>
        </div>
      )}
      {(isRoot || open) && hasChildren && (
        <>
          {folders.map((folder) => (
            <DirectoryManagerNode
              key={folder.path || folder.name}
              node={folder}
              depth={isRoot ? 0 : depth + 1}
              selectedKeys={selectedKeys}
              allowCacheDelete={allowCacheDelete}
              allowLocalDelete={allowLocalDelete}
              showOnlyDeletable={showOnlyDeletable}
              onToggleTarget={onToggleTarget}
            />
          ))}
          {files.map((file) => (
            <ManagedFileRow
              key={`${file.locationType}:${file.locationId}:${file.sourcePath}`}
              file={file}
              depth={isRoot ? 0 : depth + 1}
              selectedKeys={selectedKeys}
              allowCacheDelete={allowCacheDelete}
              allowLocalDelete={allowLocalDelete}
              onToggleTarget={onToggleTarget}
            />
          ))}
        </>
      )}
    </div>
  );
}

function ManagedFileRow({
  file,
  depth,
  selectedKeys,
  allowCacheDelete,
  allowLocalDelete,
  onToggleTarget,
}: {
  file: TreeTrack;
  depth: number;
  selectedKeys: Set<string>;
  allowCacheDelete?: boolean;
  allowLocalDelete?: boolean;
  onToggleTarget: (target: MediaDeleteTarget, selected: boolean) => void;
}) {
  const targets = mediaDeleteTargetsForFile(file, { allowCacheDelete, allowLocalDelete });
  const selectedCount = targets.filter((target) => selectedKeys.has(mediaDeleteTargetKey(target))).length;
  const checked = targets.length > 0 && selectedCount === targets.length;
  const mixed = selectedCount > 0 && selectedCount < targets.length;
  const toggleFile = () => {
    for (const target of targets) onToggleTarget(target, !checked);
  };
  const fileMeta = [
    file.kind === "audio" || file.kind === "video" ? formatDuration(file.durationSeconds) : "",
    formatBytes(file.sizeBytes),
    file.locationType,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      className="grid min-h-10 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm"
      style={{ marginLeft: depth * 14, width: `calc(100% - ${depth * 14}px)` }}
    >
      <Checkbox
        checked={checked}
        indeterminate={mixed}
        disabled={targets.length === 0}
        onCheckedChange={toggleFile}
        aria-label={i18n.t("libraryDetail.selectFile", { name: file.title })}
      />
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          {fileIcon(file)}
          <span className="truncate font-medium">{file.title}</span>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="max-w-full truncate">{file.sourcePath}</span>
          <span>{fileMeta}</span>
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-1">
        {targets.map((target) => (
          <Badge key={mediaDeleteTargetKey(target)} variant="outline">
            {target.kind === "cache" ? i18n.t("libraryDetail.cache") : i18n.t("libraryDetail.local")}
          </Badge>
        ))}
        {targets.length === 0 && (
          <span className="inline-flex h-8 items-center text-xs text-muted-foreground">
            {i18n.t("libraryDetail.noFileAction")}
          </span>
        )}
      </div>
    </div>
  );
}
