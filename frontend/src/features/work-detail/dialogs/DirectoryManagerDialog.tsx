import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Folder, FolderCog, ShieldAlert, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogHeader } from "@/components/ui/dialog";
import { ConfirmMediaBatchDeleteDialog } from "@/features/work-detail/dialogs/ConfirmMediaBatchDeleteDialog";
import {
  directoryManagerFormatGroups,
  directoryManagerLocationGroups,
  directoryManagerSelectionState,
  selectedBytes,
  withTargetKeys,
  type DirectoryManagerOptions,
  type DirectoryManagerSelectionGroup,
} from "@/features/work-detail/dialogs/directoryManagerModel";
import {
  directoryManageTargets,
  isMediaPathWithinRoot,
  mediaDeleteTargetKey,
  mediaDeleteTargetsForFile,
  sortedFilesDeep,
} from "@/features/work-detail/dialogs/mediaDeleteTargets";
import {
  fileIcon,
  formatFolderStats,
  mediaDeleteTargetKindLabel,
} from "@/features/work-detail/dialogs/mediaFilePresentation";
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

function canForgetSelection({
  selectedTargets,
  fileTargets,
  selectedKeys,
  canForgetWork,
}: {
  selectedTargets: MediaDeleteTarget[];
  fileTargets: MediaDeleteTarget[];
  selectedKeys: Set<string>;
  canForgetWork: boolean;
}) {
  const selectedRootTarget = selectedTargets.find((target) => target.kind === "local_root") ?? null;
  const allFileTargetsSelected =
    fileTargets.length > 0 && fileTargets.every((target) => selectedKeys.has(mediaDeleteTargetKey(target)));
  const selectedWorkIDs = new Set(selectedTargets.map((target) => target.workId).filter((id) => id > 0));
  return Boolean(
    canForgetWork &&
    selectedRootTarget &&
    allFileTargetsSelected &&
    selectedWorkIDs.size === 1 &&
    selectedRootTarget.workId > 0,
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
  const [confirmation, setConfirmation] = useState<{
    mode: MediaCleanupMode;
    step: 1 | 2;
    targets: MediaDeleteTarget[];
  } | null>(null);
  const [showOnlyDeletable, setShowOnlyDeletable] = useState(showCachedFilter);
  const options = useMemo<DirectoryManagerOptions>(
    () => ({ allowCacheDelete, allowLocalDelete }),
    [allowCacheDelete, allowLocalDelete],
  );
  const fileTargets = useMemo(
    () => directoryManageTargets(root, options).map((target) => ({ ...target, workId })),
    [root, options, workId],
  );
  const rootTarget = useMemo<MediaDeleteTarget | null>(() => {
    return directoryManagerRootTarget({ fileTargets, allowLocalDelete, localRoot, workId });
  }, [allowLocalDelete, fileTargets, localRoot, workId]);
  const targets = useMemo(() => (rootTarget ? [...fileTargets, rootTarget] : fileTargets), [fileTargets, rootTarget]);
  const allKeys = useMemo(() => targets.map(mediaDeleteTargetKey), [targets]);
  const formatGroups = useMemo(() => directoryManagerFormatGroups(root, options), [root, options]);
  const locationGroups = useMemo(() => directoryManagerLocationGroups(fileTargets), [fileTargets]);
  const selectedTargets = useMemo(
    () => targets.filter((target) => selectedKeys.has(mediaDeleteTargetKey(target))),
    [targets, selectedKeys],
  );
  const forgetAvailable = Boolean(canForgetWork && rootTarget && onDeleteTargets);
  // Forgetting a work removes its complete folder, so it unlocks only once everything is selected.
  const canReviewForget = canForgetSelection({ selectedTargets, fileTargets, selectedKeys, canForgetWork });
  const toggleKeys = (keys: string[], included: boolean) =>
    setSelectedKeys((current) => withTargetKeys(current, keys, included));
  const startConfirmation = (mode: MediaCleanupMode) => {
    if (mode === "files_and_forget_work" && !canReviewForget) return;
    setConfirmation({ mode, step: 1, targets: selectedTargets });
  };
  const confirmDelete = () => {
    if (!confirmation) return;
    onDeleteTargets?.(confirmation.targets, confirmation.mode);
    setConfirmation(null);
    setSelectedKeys(new Set());
  };
  const hasShortcuts = locationGroups.length > 1 || formatGroups.length > 1 || showCachedFilter;

  return (
    <>
      <Dialog onClose={onClose} size="full" className="max-h-[86vh] max-w-3xl sm:max-h-[86vh]">
        <DialogHeader
          title={title}
          description={description}
          icon={<FolderCog className="h-4 w-4" />}
          onClose={onClose}
          closeLabel={i18n.t("content.close")}
        />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-card">
          {hasShortcuts && (
            <div className="shrink-0 space-y-2 border-b px-4 py-3">
              {locationGroups.length > 1 && (
                <ShortcutRow label={i18n.t("libraryDetail.selectByLocation")}>
                  {locationGroups.map((group) => (
                    <SelectionChip
                      key={group.key}
                      group={group}
                      label={group.key === "cache" ? i18n.t("libraryDetail.cache") : i18n.t("detailActions.local")}
                      selectedKeys={selectedKeys}
                      disabled={deleting}
                      onToggle={toggleKeys}
                    />
                  ))}
                </ShortcutRow>
              )}
              {(formatGroups.length > 1 || showCachedFilter) && (
                <ShortcutRow label={i18n.t("libraryDetail.selectByFormat")}>
                  {formatGroups.length > 1 &&
                    formatGroups.map((group) => (
                      <SelectionChip
                        key={group.key}
                        group={group}
                        label={group.key.toUpperCase()}
                        selectedKeys={selectedKeys}
                        disabled={deleting}
                        onToggle={toggleKeys}
                      />
                    ))}
                  {showCachedFilter && (
                    <label className="ml-auto inline-flex h-8 cursor-pointer items-center gap-2 rounded-md px-1 text-xs text-muted-foreground hover:text-foreground">
                      <Checkbox
                        className="h-4 w-4"
                        checked={showOnlyDeletable}
                        onCheckedChange={setShowOnlyDeletable}
                        aria-label={i18n.t("libraryDetail.cachedOnly")}
                      />
                      <span>{i18n.t("libraryDetail.cachedOnly")}</span>
                    </label>
                  )}
                </ShortcutRow>
              )}
            </div>
          )}
          <div className="app-scroll min-h-0 flex-1 overflow-auto p-2">
            <DirectoryManagerTree
              root={root}
              emptyLabel={emptyLabel}
              selectedKeys={selectedKeys}
              options={options}
              showOnlyDeletable={showOnlyDeletable}
              rootTarget={rootTarget}
              allKeys={allKeys}
              disabled={deleting}
              onToggle={toggleKeys}
            />
          </div>
        </div>
        <DirectoryManagerFooter
          selectedTargets={selectedTargets}
          total={targets.length}
          allKeys={allKeys}
          selectedKeys={selectedKeys}
          forgetAvailable={forgetAvailable}
          canReviewForget={canReviewForget}
          deleting={deleting}
          onToggleAll={toggleKeys}
          onStartConfirmation={startConfirmation}
        />
      </Dialog>
      {confirmation && (
        <ConfirmMediaBatchDeleteDialog
          targets={confirmation.targets}
          mode={confirmation.mode}
          step={confirmation.step}
          deleting={deleting}
          onCancel={() => setConfirmation(null)}
          onContinue={() => setConfirmation({ ...confirmation, step: 2 })}
          onConfirm={confirmDelete}
        />
      )}
    </>
  );
}

function ShortcutRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden"
      role="group"
      aria-label={label}
    >
      <span className="shrink-0 text-2xs font-medium uppercase tracking-wide text-muted-foreground sm:w-24">
        {label}
      </span>
      {children}
    </div>
  );
}

function SelectionChip({
  group,
  label,
  selectedKeys,
  disabled,
  onToggle,
}: {
  group: DirectoryManagerSelectionGroup;
  label: string;
  selectedKeys: Set<string>;
  disabled: boolean;
  onToggle: (keys: string[], included: boolean) => void;
}) {
  const state = directoryManagerSelectionState(group.targetKeys, selectedKeys);
  const active = state.checked || state.indeterminate;
  return (
    <label
      className={`inline-flex h-8 shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap rounded-md border px-2.5 text-xs transition-colors ${
        active ? "border-primary/40 bg-primary/5" : "bg-background hover:bg-muted"
      }`}
    >
      <Checkbox
        className="h-4 w-4"
        checked={state.checked}
        indeterminate={state.indeterminate}
        disabled={disabled}
        onCheckedChange={() => onToggle(group.targetKeys, !state.checked)}
        aria-label={i18n.t("libraryDetail.includeExtension", { extension: label })}
      />
      <span className="font-medium">{label}</span>
      <span className="tabular-nums text-muted-foreground">
        {i18n.t("libraryDetail.filesCount", { count: group.files })}
        {group.sizeBytes > 0 ? ` · ${formatBytes(group.sizeBytes)}` : ""}
      </span>
    </label>
  );
}

function SelectionCount({ selected, total }: { selected: number; total: number }) {
  if (total === 0) return null;
  return (
    <span
      className={`min-w-10 shrink-0 text-right text-xs tabular-nums ${
        selected > 0 ? "font-medium text-primary" : "text-muted-foreground"
      }`}
    >
      {selected}/{total}
    </span>
  );
}

function rowClassName(checked: boolean) {
  return checked ? "bg-primary/5" : "hover:bg-muted/60";
}

function DirectoryManagerTree({
  root,
  emptyLabel,
  selectedKeys,
  options,
  showOnlyDeletable,
  rootTarget,
  allKeys,
  disabled,
  onToggle,
}: {
  root: TreeNode;
  emptyLabel: string;
  selectedKeys: Set<string>;
  options: DirectoryManagerOptions;
  showOnlyDeletable: boolean;
  rootTarget: MediaDeleteTarget | null;
  allKeys: string[];
  disabled: boolean;
  onToggle: (keys: string[], included: boolean) => void;
}) {
  const hasFiles = useMemo(() => sortedFilesDeep(root).length > 0, [root]);
  if (!hasFiles) {
    return <div className="px-2 py-10 text-center text-sm text-muted-foreground">{emptyLabel}</div>;
  }
  const children = (
    <DirectoryManagerNodeChildren
      node={root}
      depth={0}
      selectedKeys={selectedKeys}
      options={options}
      showOnlyDeletable={showOnlyDeletable}
      disabled={disabled}
      onToggle={onToggle}
    />
  );
  if (!rootTarget) return children;
  const state = directoryManagerSelectionState(allKeys, selectedKeys);
  return (
    <div>
      <div
        className={`flex min-h-10 items-center gap-2 rounded-md px-2 text-sm font-medium ${rowClassName(state.checked)}`}
      >
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <Checkbox
          checked={state.checked}
          indeterminate={state.indeterminate}
          disabled={disabled}
          onCheckedChange={() => onToggle(allKeys, !state.checked)}
          aria-label={i18n.t("libraryDetail.selectWorkRoot", { path: rootTarget.path })}
        />
        <Folder className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate" title={rootTarget.path}>
          {rootTarget.path}
        </span>
        <span className="hidden shrink-0 text-xs font-normal text-muted-foreground sm:inline">
          {formatFolderStats(treeStats(root), 0)}
        </span>
        <SelectionCount selected={state.selected} total={state.total} />
      </div>
      <div className="ml-4 border-l pl-1.5">{children}</div>
    </div>
  );
}

function DirectoryManagerNodeChildren({
  node,
  depth,
  selectedKeys,
  options,
  showOnlyDeletable,
  disabled,
  onToggle,
}: {
  node: TreeNode;
  depth: number;
  selectedKeys: Set<string>;
  options: DirectoryManagerOptions;
  showOnlyDeletable: boolean;
  disabled: boolean;
  onToggle: (keys: string[], included: boolean) => void;
}) {
  const folders = sortedTreeChildren(node).filter(
    (folder) => !showOnlyDeletable || directoryManageTargets(folder, options).length > 0,
  );
  const files = sortedTreeFiles(node).filter(
    (file) => !showOnlyDeletable || mediaDeleteTargetsForFile(file, options).length > 0,
  );
  if (folders.length === 0 && files.length === 0) return null;
  return (
    <div className="space-y-px">
      {folders.map((folder) => (
        <DirectoryManagerFolder
          key={folder.path || folder.name}
          node={folder}
          depth={depth + 1}
          selectedKeys={selectedKeys}
          options={options}
          showOnlyDeletable={showOnlyDeletable}
          disabled={disabled}
          onToggle={onToggle}
        />
      ))}
      {files.map((file) => (
        <ManagedFileRow
          key={`${file.locationType}:${file.locationId}:${file.sourcePath}`}
          file={file}
          selectedKeys={selectedKeys}
          options={options}
          disabled={disabled}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}

function DirectoryManagerFolder({
  node,
  depth,
  selectedKeys,
  options,
  showOnlyDeletable,
  disabled,
  onToggle,
}: {
  node: TreeNode;
  depth: number;
  selectedKeys: Set<string>;
  options: DirectoryManagerOptions;
  showOnlyDeletable: boolean;
  disabled: boolean;
  onToggle: (keys: string[], included: boolean) => void;
}) {
  // Top-level folders start open so format folders such as mp3/ and wav/ are visible at once.
  const [open, setOpen] = useState(depth <= 1);
  const nodeKeys = directoryManageTargets(node, options).map(mediaDeleteTargetKey);
  const state = directoryManagerSelectionState(nodeKeys, selectedKeys);
  const toggleOpen = () => setOpen((value) => !value);
  return (
    <div>
      <div
        className={`flex min-h-10 items-center gap-2 rounded-md px-2 text-sm font-medium ${rowClassName(state.checked)}`}
      >
        <button
          type="button"
          className="-m-0.5 shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
          onClick={toggleOpen}
          aria-expanded={open}
          aria-label={
            open
              ? i18n.t("libraryDetail.collapseFolder", { name: node.name })
              : i18n.t("libraryDetail.expandFolder", { name: node.name })
          }
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <Checkbox
          checked={state.checked}
          indeterminate={state.indeterminate}
          disabled={disabled || nodeKeys.length === 0}
          onCheckedChange={() => onToggle(nodeKeys, !state.checked)}
          aria-label={i18n.t("libraryDetail.selectFolder", { name: node.name })}
        />
        <Folder className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={toggleOpen}>
          {node.name}
        </button>
        <span className="hidden shrink-0 text-xs font-normal text-muted-foreground sm:inline">
          {formatFolderStats(treeStats(node), playableFiles(node.files).length)}
        </span>
        <SelectionCount selected={state.selected} total={state.total} />
      </div>
      {open && (
        <div className="ml-4 border-l pl-1.5 empty:hidden">
          <DirectoryManagerNodeChildren
            node={node}
            depth={depth}
            selectedKeys={selectedKeys}
            options={options}
            showOnlyDeletable={showOnlyDeletable}
            disabled={disabled}
            onToggle={onToggle}
          />
        </div>
      )}
    </div>
  );
}

function ManagedFileRow({
  file,
  selectedKeys,
  options,
  disabled,
  onToggle,
}: {
  file: TreeTrack;
  selectedKeys: Set<string>;
  options: DirectoryManagerOptions;
  disabled: boolean;
  onToggle: (keys: string[], included: boolean) => void;
}) {
  // Local copies lead, matching the location shortcuts above the tree.
  const targets = mediaDeleteTargetsForFile(file, options).sort((a, b) =>
    a.kind === b.kind ? 0 : a.kind === "local" ? -1 : 1,
  );
  const keys = targets.map(mediaDeleteTargetKey);
  const state = directoryManagerSelectionState(keys, selectedKeys);
  const fileMeta = [
    file.kind === "audio" || file.kind === "video" ? formatDuration(file.durationSeconds) : "",
    formatBytes(file.sizeBytes),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      className={`flex min-h-10 items-center gap-2 rounded-md px-2 py-1 text-sm ${rowClassName(state.checked)}`}
      title={file.sourcePath}
    >
      <span className="w-4 shrink-0" aria-hidden="true" />
      <Checkbox
        checked={state.checked}
        indeterminate={state.indeterminate}
        disabled={disabled || targets.length === 0}
        onCheckedChange={() => onToggle(keys, !state.checked)}
        aria-label={i18n.t("libraryDetail.selectFile", { name: file.title })}
      />
      <span className="shrink-0">{fileIcon(file)}</span>
      <div className="min-w-0 flex-1">
        <div className={`truncate ${targets.length === 0 ? "text-muted-foreground" : ""}`}>{file.title}</div>
        {fileMeta && <div className="truncate text-2xs tabular-nums text-muted-foreground">{fileMeta}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {targets.map((target) => {
          const key = mediaDeleteTargetKey(target);
          const selected = selectedKeys.has(key);
          const location = mediaDeleteTargetKindLabel(target);
          return (
            <button
              key={key}
              type="button"
              aria-pressed={selected}
              aria-label={i18n.t("libraryDetail.selectFileCopy", { location, name: file.title })}
              disabled={disabled}
              className={`inline-flex h-6 items-center rounded-full border px-2 text-2xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${
                selected
                  ? "border-primary bg-primary text-primary-foreground"
                  : "bg-background text-muted-foreground hover:border-primary/50 hover:text-foreground"
              }`}
              onClick={() => onToggle([key], !selected)}
            >
              {location}
            </button>
          );
        })}
        {targets.length === 0 && (
          <span className="text-2xs text-muted-foreground">{i18n.t("libraryDetail.noFileAction")}</span>
        )}
      </div>
    </div>
  );
}

function DirectoryManagerFooter({
  selectedTargets,
  total,
  allKeys,
  selectedKeys,
  forgetAvailable,
  canReviewForget,
  deleting,
  onToggleAll,
  onStartConfirmation,
}: {
  selectedTargets: MediaDeleteTarget[];
  total: number;
  allKeys: string[];
  selectedKeys: Set<string>;
  forgetAvailable: boolean;
  canReviewForget: boolean;
  deleting: boolean;
  onToggleAll: (keys: string[], included: boolean) => void;
  onStartConfirmation: (mode: MediaCleanupMode) => void;
}) {
  const all = directoryManagerSelectionState(allKeys, selectedKeys);
  const bytes = selectedBytes(selectedTargets);
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-3 border-t bg-card px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            checked={all.checked}
            indeterminate={all.indeterminate}
            disabled={deleting || total === 0}
            onCheckedChange={() => onToggleAll(allKeys, !all.checked)}
            aria-label={i18n.t("libraryDetail.selectAll")}
          />
          <span className="font-medium">{i18n.t("libraryDetail.selectAll")}</span>
        </label>
        <span className="min-w-0 text-xs tabular-nums text-muted-foreground" aria-live="polite">
          {i18n.t("libraryDetail.selectedDeletableCount", { selected: selectedTargets.length, total })}
          {bytes > 0 ? ` · ${formatBytes(bytes)}` : ""}
        </span>
      </div>
      <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
        {forgetAvailable && (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={!canReviewForget || deleting}
            title={
              canReviewForget
                ? i18n.t("libraryDetail.deleteSelectedThenForget")
                : i18n.t("libraryDetail.selectCompleteWorkRoot")
            }
            onClick={() => onStartConfirmation("files_and_forget_work")}
          >
            <ShieldAlert className="h-4 w-4" />
            {i18n.t("libraryDetail.reviewDeletionForget")}
          </Button>
        )}
        <Button
          size="sm"
          disabled={selectedTargets.length === 0 || deleting}
          onClick={() => onStartConfirmation("files_only")}
        >
          <Trash2 className="h-4 w-4" />
          {deleting ? i18n.t("libraryDetail.deleting") : i18n.t("libraryDetail.reviewFileDeletion")}
        </Button>
      </div>
    </div>
  );
}
