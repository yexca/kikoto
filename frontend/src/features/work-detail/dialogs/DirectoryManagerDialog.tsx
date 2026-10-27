import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Folder, FolderCog, ListChecks, Trash2 } from "lucide-react";

import { LibraryOfflineNotice } from "@/components/library-offline/LibraryOfflineNotice";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogHeader } from "@/components/ui/dialog";
import { FloatingSelect } from "@/components/ui/floating-select";
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
import { isLocalOffline } from "@/lib/localAvailability";

/** The listed files have copies in more than one location, so a row names a copy kept only in the cache. */
const MixedLocationsContext = createContext(false);

/**
 * Lists the files of a source for deletion: cache copies of a tracked source,
 * or the files of a local folder for viewers who do not manage local files.
 * A manager of local files gets the file workspace instead.
 */
export function DirectoryManagerDialog({
  root,
  title = i18n.t("libraryDetail.manageFiles"),
  description,
  emptyLabel,
  onClose,
  deleting = false,
  onDeleteTargets,
  allowCacheDelete,
  allowLocalDelete,
  localRoot = null,
  localFolders = [],
  onSelectLocalFolder,
  showCachedFilter = false,
  workId = 0,
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
  /** The listed folder; offline while its storage pool is offline, when its files cannot be changed. */
  localRoot?: { folderId: number; path: string; offline?: boolean } | null;
  /** The work's local folders when it has several; the dialog lists the one named by localRoot. */
  localFolders?: { id: number; rootPath: string; availability?: string }[];
  onSelectLocalFolder?: (folderId: number) => void;
  showCachedFilter?: boolean;
  workId?: number;
}) {
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [confirmation, setConfirmation] = useState<{ step: 1 | 2; targets: MediaDeleteTarget[] } | null>(null);
  const [showOnlyDeletable, setShowOnlyDeletable] = useState(showCachedFilter);
  const options = useMemo<DirectoryManagerOptions>(
    () => ({ allowCacheDelete, allowLocalDelete }),
    [allowCacheDelete, allowLocalDelete],
  );
  const targets = useMemo(
    () => directoryManageTargets(root, options).map((target) => ({ ...target, workId })),
    [root, options, workId],
  );
  const allKeys = useMemo(() => targets.map(mediaDeleteTargetKey), [targets]);
  const formatGroups = useMemo(() => directoryManagerFormatGroups(root, options), [root, options]);
  const locationGroups = useMemo(() => directoryManagerLocationGroups(targets), [targets]);
  const selectedTargets = useMemo(
    () => targets.filter((target) => selectedKeys.has(mediaDeleteTargetKey(target))),
    [targets, selectedKeys],
  );
  const toggleKeys = (keys: string[], included: boolean) =>
    setSelectedKeys((current) => withTargetKeys(current, keys, included));
  const confirmDelete = () => {
    if (!confirmation) return;
    onDeleteTargets?.(confirmation.targets, "files_only");
    setConfirmation(null);
    setSelectedKeys(new Set());
  };
  const canSwitchFolder = localFolders.length > 1 && Boolean(onSelectLocalFolder);
  const hasQuickSelect = locationGroups.length > 1 || formatGroups.length > 1;
  const hasToolbar = canSwitchFolder || hasQuickSelect || showCachedFilter;
  const [quickSelectOpen, setQuickSelectOpen] = useState(false);

  return (
    <>
      <Dialog onClose={onClose} size="full" className="max-h-[min(86vh,var(--dialog-max-height))] max-w-3xl">
        <DialogHeader
          title={title}
          description={description}
          icon={<FolderCog className="h-4 w-4" />}
          onClose={onClose}
          closeLabel={i18n.t("content.close")}
        />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-card">
          {hasToolbar && (
            <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
              {canSwitchFolder && (
                <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                  {i18n.t("libraryDetail.manageFolder")}
                </span>
              )}
              {canSwitchFolder && (
                <FloatingSelect
                  value={String(localRoot?.folderId ?? "")}
                  options={localFolders.map((folder) => ({
                    value: String(folder.id),
                    label: isLocalOffline(folder.availability)
                      ? `${i18n.t("libraryOffline.badge")} · ${folder.rootPath}`
                      : folder.rootPath,
                  }))}
                  onValueChange={(value) => {
                    // A selection belongs to the folder it was made in.
                    setSelectedKeys(new Set());
                    onSelectLocalFolder?.(Number(value));
                  }}
                  ariaLabel={i18n.t("libraryDetail.manageFolder")}
                  disabled={deleting}
                  className="h-8 min-w-0 flex-1 text-xs sm:max-w-xs"
                />
              )}
              <div className="ml-auto flex shrink-0 items-center gap-2">
                {showCachedFilter && (
                  <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md px-1 text-xs text-muted-foreground hover:text-foreground">
                    <Checkbox
                      className="h-4 w-4"
                      checked={showOnlyDeletable}
                      onCheckedChange={setShowOnlyDeletable}
                      aria-label={i18n.t("libraryDetail.cachedOnly")}
                    />
                    <span>{i18n.t("libraryDetail.cachedOnly")}</span>
                  </label>
                )}
                {hasQuickSelect && (
                  <Button
                    variant="toolbar"
                    size="sm"
                    aria-expanded={quickSelectOpen}
                    aria-controls="directory-manager-quick-select"
                    onClick={() => setQuickSelectOpen((open) => !open)}
                  >
                    <ListChecks className="h-4 w-4" aria-hidden="true" />
                    {i18n.t("libraryDetail.quickSelect")}
                    <ChevronDown
                      className={`h-3.5 w-3.5 transition-transform ${quickSelectOpen ? "rotate-180" : ""}`}
                      aria-hidden="true"
                    />
                  </Button>
                )}
              </div>
            </div>
          )}
          <div className="app-scroll min-h-0 flex-1 overflow-auto px-2 pb-2">
            {localRoot?.offline && <LibraryOfflineNotice className="mx-2 mt-3" />}
            {hasQuickSelect && quickSelectOpen && (
              <div
                id="directory-manager-quick-select"
                className="-mx-2 space-y-3 border-b bg-muted/30 px-4 py-3"
                role="group"
                aria-label={i18n.t("libraryDetail.quickSelect")}
              >
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
                {formatGroups.length > 1 && (
                  <ShortcutRow label={i18n.t("libraryDetail.selectByFormat")}>
                    {formatGroups.map((group) => (
                      <SelectionChip
                        key={group.key}
                        group={group}
                        label={group.key.toUpperCase()}
                        selectedKeys={selectedKeys}
                        disabled={deleting}
                        onToggle={toggleKeys}
                      />
                    ))}
                  </ShortcutRow>
                )}
              </div>
            )}
            <MixedLocationsContext.Provider value={locationGroups.length > 1}>
              <DirectoryManagerTree
                root={root}
                // The notice already says why an offline folder lists nothing.
                emptyLabel={localRoot?.offline ? "" : emptyLabel}
                selectedKeys={selectedKeys}
                options={options}
                showOnlyDeletable={showOnlyDeletable}
                allKeys={allKeys}
                disabled={deleting}
                onToggle={toggleKeys}
              />
            </MixedLocationsContext.Provider>
          </div>
        </div>
        <DirectoryManagerFooter
          selectedTargets={selectedTargets}
          total={targets.length}
          deleting={deleting}
          onReview={() => setConfirmation({ step: 1, targets: selectedTargets })}
        />
      </Dialog>
      {confirmation && (
        <ConfirmMediaBatchDeleteDialog
          targets={confirmation.targets}
          mode="files_only"
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
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2" role="group" aria-label={label}>
      <span className="shrink-0 text-2xs font-medium uppercase tracking-wide text-muted-foreground sm:w-24">
        {label}
      </span>
      <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
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

/** How much of a folder is selected; an untouched folder shows nothing. */
function SelectionCount({ selected, total }: { selected: number; total: number }) {
  if (total === 0 || selected === 0) return null;
  return (
    <span className="min-w-10 shrink-0 text-right text-xs font-medium tabular-nums text-primary">
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
  allKeys,
  disabled,
  onToggle,
}: {
  root: TreeNode;
  emptyLabel: string;
  selectedKeys: Set<string>;
  options: DirectoryManagerOptions;
  showOnlyDeletable: boolean;
  allKeys: string[];
  disabled: boolean;
  onToggle: (keys: string[], included: boolean) => void;
}) {
  const hasFiles = useMemo(() => sortedFilesDeep(root).length > 0, [root]);
  if (!hasFiles) {
    if (!emptyLabel) return null;
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
  // The list's head selects everything.
  const state = directoryManagerSelectionState(allKeys, selectedKeys);
  const label = i18n.t("libraryDetail.selectAll");
  return (
    <div>
      <div className="sticky top-0 z-10 -mx-2 mb-1 border-b bg-card px-2 py-1">
        <label
          className={`flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-2 text-sm font-medium ${rowClassName(state.checked)}`}
        >
          <Checkbox
            checked={state.checked}
            indeterminate={state.indeterminate}
            disabled={disabled || allKeys.length === 0}
            onCheckedChange={() => onToggle(allKeys, !state.checked)}
            aria-label={label}
          />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <span className="hidden shrink-0 text-xs font-normal text-muted-foreground sm:inline">
            {formatFolderStats(treeStats(root), 0)}
          </span>
          <SelectionCount selected={state.selected} total={state.total} />
        </label>
      </div>
      {children}
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
  const mixedLocations = useContext(MixedLocationsContext);
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
        {targets.length === 1 && mixedLocations && targets[0].kind === "cache" && (
          <span className="text-2xs text-muted-foreground">{mediaDeleteTargetKindLabel(targets[0])}</span>
        )}
        {/* A file with several copies chooses among them; the checkbox alone covers a single copy. */}
        {targets.length > 1 &&
          targets.map((target) => {
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

/** The selection's size and the review of its deletion. */
function DirectoryManagerFooter({
  selectedTargets,
  total,
  deleting,
  onReview,
}: {
  selectedTargets: MediaDeleteTarget[];
  total: number;
  deleting: boolean;
  onReview: () => void;
}) {
  const bytes = selectedBytes(selectedTargets);
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-3 border-t bg-card px-4 py-3">
      <span className="min-w-0 text-xs tabular-nums text-muted-foreground" aria-live="polite">
        {i18n.t("libraryDetail.selectedDeletableCount", { selected: selectedTargets.length, total })}
        {bytes > 0 ? ` · ${formatBytes(bytes)}` : ""}
      </span>
      <Button size="sm" disabled={selectedTargets.length === 0 || deleting} onClick={onReview}>
        <Trash2 className="h-4 w-4" />
        {deleting ? i18n.t("libraryDetail.deleting") : i18n.t("libraryDetail.reviewFileDeletion")}
      </Button>
    </div>
  );
}
