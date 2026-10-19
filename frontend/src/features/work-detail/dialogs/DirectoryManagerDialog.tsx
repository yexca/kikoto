import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Captions,
  ChevronDown,
  ChevronRight,
  CopyCheck,
  Folder,
  FolderCog,
  FolderPlus,
  ListChecks,
  Loader2,
  Search,
  ShieldAlert,
  Trash2,
} from "lucide-react";

import { LibraryOfflineNotice } from "@/components/library-offline/LibraryOfflineNotice";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogHeader } from "@/components/ui/dialog";
import { FloatingSelect } from "@/components/ui/floating-select";
import { ConfirmMediaBatchDeleteDialog } from "@/features/work-detail/dialogs/ConfirmMediaBatchDeleteDialog";
import {
  compactLibraryPath,
  directoryManagerDuplicates,
  directoryManagerFormatGroups,
  directoryManagerLocationGroups,
  directoryManagerSelectionState,
  selectedBytes,
  withTargetKeys,
  type DirectoryManagerOptions,
  type DirectoryManagerSelectionGroup,
  type DuplicateFileMark,
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
  folderLyricsFiles,
  splitManagedLyrics,
  type FolderLyricsFile,
} from "@/features/work-detail/lyrics/managedLyricsModel";
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
import { api, type DuplicateFileGroup } from "@/lib/api";
import { isLocalOffline } from "@/lib/localAvailability";

/** Marks of the listed local files that have an identical file, by location id. */
const DuplicateMarksContext = createContext<ReadonlyMap<number, DuplicateFileMark>>(new Map());
/** The listed files have copies in more than one location, so a row names a copy kept only in the cache. */
const MixedLocationsContext = createContext(false);

type DuplicateFileCheck =
  | { status: "idle" | "error" }
  | { status: "running"; checkedFiles: number; pendingFiles: number }
  | { status: "done"; groups: DuplicateFileGroup[] };

/**
 * Runs the identical-file check of a work's family on demand. The server does
 * a bounded share per request, so the check repeats until it is complete and
 * stops when the dialog closes or the check is cancelled.
 */
function useDuplicateFileCheck(workId: number) {
  const [check, setCheck] = useState<DuplicateFileCheck>({ status: "idle" });
  const run = useRef(0);
  useEffect(
    () => () => {
      run.current += 1;
    },
    [],
  );
  const start = async () => {
    const current = ++run.current;
    setCheck({ status: "running", checkedFiles: 0, pendingFiles: 0 });
    try {
      for (;;) {
        const result = await api.findWorkDuplicateFiles(workId);
        if (current !== run.current) return;
        if (result.complete) {
          setCheck({ status: "done", groups: result.groups });
          return;
        }
        setCheck({ status: "running", checkedFiles: result.checkedFiles, pendingFiles: result.pendingFiles });
      }
    } catch {
      if (current === run.current) setCheck({ status: "error" });
    }
  };
  const reset = () => {
    run.current += 1;
    setCheck({ status: "idle" });
  };
  return { check, start, reset };
}

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
  wholeFolderSelected,
  canForgetWork,
}: {
  selectedTargets: MediaDeleteTarget[];
  /** The work root and every file in it are selected. */
  wholeFolderSelected: boolean;
  canForgetWork: boolean;
}) {
  const selectedRootTarget = selectedTargets.find((target) => target.kind === "local_root") ?? null;
  const selectedWorkIDs = new Set(selectedTargets.map((target) => target.workId).filter((id) => id > 0));
  return Boolean(
    canForgetWork &&
    selectedRootTarget &&
    wholeFolderSelected &&
    selectedWorkIDs.size === 1 &&
    selectedRootTarget.workId > 0,
  );
}

export function DirectoryManagerDialog({
  root: givenRoot,
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
  onEditFiles,
  onManageAsLyrics,
  onManageLyrics,
  showCachedFilter = false,
  workId = 0,
  canForgetWork = false,
  duplicateWorkId = 0,
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
  /** Opens the edit that adds files from other editions and sources to the listed folder. */
  onEditFiles?: () => void;
  /** Declares the language of the selected lyrics files of the listed folder, which Kikoto then manages. */
  onManageAsLyrics?: (files: FolderLyricsFile[]) => void;
  /**
   * Opens the lyrics manager on its files. When it is given, the lyrics Kikoto
   * manages in the listed folder are handled there and not listed here.
   */
  onManageLyrics?: () => void;
  showCachedFilter?: boolean;
  workId?: number;
  canForgetWork?: boolean;
  /** The work whose family is checked for identical local files; zero hides the check. */
  duplicateWorkId?: number;
}) {
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const listedFolderPath = allowLocalDelete && onManageLyrics ? localRoot?.path : undefined;
  const split = useMemo(
    () => (listedFolderPath ? splitManagedLyrics(givenRoot, listedFolderPath) : { listed: givenRoot, managed: [] }),
    [givenRoot, listedFolderPath],
  );
  // The lyrics Kikoto manages stay out of the list until the viewer asks for them.
  const [showManagedLyrics, setShowManagedLyrics] = useState(false);
  const root = showManagedLyrics ? givenRoot : split.listed;
  const duplicateCheck = useDuplicateFileCheck(duplicateWorkId);
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
  const managedLyricsTargets = useMemo(
    () =>
      split.managed
        .flatMap((file) => mediaDeleteTargetsForFile(file, { allowLocalDelete: true }))
        .map((target) => ({ ...target, workId })),
    [split.managed, workId],
  );
  // While they have no row here, the managed lyrics go only with the whole folder.
  const managedTargets = showManagedLyrics ? noTargets : managedLyricsTargets;
  const rootTarget = useMemo<MediaDeleteTarget | null>(() => {
    return directoryManagerRootTarget({
      fileTargets: [...fileTargets, ...managedTargets],
      allowLocalDelete,
      localRoot,
      workId,
    });
  }, [allowLocalDelete, fileTargets, localRoot, managedTargets, workId]);
  const targets = useMemo(() => (rootTarget ? [...fileTargets, rootTarget] : fileTargets), [fileTargets, rootTarget]);
  const allKeys = useMemo(() => targets.map(mediaDeleteTargetKey), [targets]);
  const formatGroups = useMemo(() => directoryManagerFormatGroups(root, options), [root, options]);
  const locationGroups = useMemo(() => directoryManagerLocationGroups(fileTargets), [fileTargets]);
  const wholeFolderSelected = Boolean(rootTarget) && allKeys.every((key) => selectedKeys.has(key));
  const selectedTargets = useMemo(() => {
    const selected = targets.filter((target) => selectedKeys.has(mediaDeleteTargetKey(target)));
    return wholeFolderSelected ? [...managedTargets, ...selected] : selected;
  }, [managedTargets, targets, selectedKeys, wholeFolderSelected]);
  const lyricsCandidates = useMemo(
    () =>
      onManageAsLyrics && allowLocalDelete && localRoot
        ? folderLyricsFiles(
            fileTargets.filter((target) => selectedKeys.has(mediaDeleteTargetKey(target))),
            { id: localRoot.folderId, rootPath: localRoot.path },
          )
        : [],
    [allowLocalDelete, fileTargets, localRoot, onManageAsLyrics, selectedKeys],
  );
  const duplicateGroups = duplicateCheck.check.status === "done" ? duplicateCheck.check.groups : null;
  const duplicates = useMemo(
    () => (duplicateGroups ? directoryManagerDuplicates(duplicateGroups, fileTargets) : null),
    [duplicateGroups, fileTargets],
  );
  const canCheckDuplicates = duplicateWorkId > 0 && Boolean(allowLocalDelete) && fileTargets.length > 0;
  const forgetAvailable = Boolean(canForgetWork && rootTarget && onDeleteTargets);
  // Forgetting a work removes its complete folder, so it unlocks only once everything is selected.
  const canReviewForget = canForgetSelection({ selectedTargets, wholeFolderSelected, canForgetWork });
  const toggleKeys = (keys: string[], included: boolean) =>
    setSelectedKeys((current) => withTargetKeys(current, keys, included));
  // Rows that appear inside a selected folder join its selection; rows that go take theirs along.
  const showManagedLyricsRows = (shown: boolean) => {
    setShowManagedLyrics(shown);
    toggleKeys(managedLyricsTargets.map(mediaDeleteTargetKey), shown && wholeFolderSelected);
  };
  const startConfirmation = (mode: MediaCleanupMode) => {
    if (mode === "files_and_forget_work" && !canReviewForget) return;
    setConfirmation({ mode, step: 1, targets: selectedTargets });
  };
  const confirmDelete = () => {
    if (!confirmation) return;
    onDeleteTargets?.(confirmation.targets, confirmation.mode);
    setConfirmation(null);
    setSelectedKeys(new Set());
    // The marks describe the files as they were; a deletion makes them stale.
    duplicateCheck.reset();
  };
  const canSwitchFolder = localFolders.length > 1 && Boolean(onSelectLocalFolder);
  const hasQuickSelect = locationGroups.length > 1 || formatGroups.length > 1 || canCheckDuplicates;
  const hasToolbar = canSwitchFolder || hasQuickSelect || showCachedFilter || Boolean(onEditFiles);
  const [quickSelectOpen, setQuickSelectOpen] = useState(false);
  const checkingDuplicates = duplicateCheck.check.status === "running";

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
                    {checkingDuplicates ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <ListChecks className="h-4 w-4" aria-hidden="true" />
                    )}
                    {i18n.t("libraryDetail.quickSelect")}
                    <ChevronDown
                      className={`h-3.5 w-3.5 transition-transform ${quickSelectOpen ? "rotate-180" : ""}`}
                      aria-hidden="true"
                    />
                  </Button>
                )}
                {onEditFiles && (
                  <Button
                    variant="toolbar"
                    size="sm"
                    disabled={deleting || Boolean(localRoot?.offline)}
                    title={localRoot?.offline ? i18n.t("libraryOffline.editBlocked") : i18n.t("folderEdit.description")}
                    onClick={onEditFiles}
                  >
                    <FolderPlus className="h-4 w-4" aria-hidden="true" />
                    {i18n.t("folderEdit.editFiles")}
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
                {canCheckDuplicates && (
                  <ShortcutRow label={i18n.t("libraryDetail.identicalFiles")}>
                    <DuplicateFileControls
                      check={duplicateCheck.check}
                      duplicates={duplicates}
                      selectedKeys={selectedKeys}
                      disabled={deleting}
                      onStart={() => void duplicateCheck.start()}
                      onStop={duplicateCheck.reset}
                      onToggle={toggleKeys}
                    />
                  </ShortcutRow>
                )}
              </div>
            )}
            <DuplicateMarksContext.Provider value={duplicates?.marks ?? noDuplicateMarks}>
              <MixedLocationsContext.Provider value={locationGroups.length > 1}>
                <DirectoryManagerTree
                  root={root}
                  // The notice already says why an offline folder lists nothing.
                  emptyLabel={localRoot?.offline ? "" : emptyLabel}
                  selectedKeys={selectedKeys}
                  options={options}
                  showOnlyDeletable={showOnlyDeletable}
                  rootTarget={rootTarget}
                  allKeys={allKeys}
                  disabled={deleting}
                  onToggle={toggleKeys}
                />
              </MixedLocationsContext.Provider>
            </DuplicateMarksContext.Provider>
            {split.managed.length > 0 && (
              <ManagedLyricsNote
                files={split.managed.length}
                sizeBytes={selectedBytes(managedLyricsTargets)}
                shown={showManagedLyrics}
                deletedWithFolder={wholeFolderSelected}
                disabled={deleting}
                onShownChange={showManagedLyricsRows}
                onManageLyrics={onManageLyrics}
              />
            )}
          </div>
        </div>
        <DirectoryManagerFooter
          selectedTargets={selectedTargets}
          total={targets.length + (wholeFolderSelected ? managedTargets.length : 0)}
          forgetAvailable={forgetAvailable}
          canReviewForget={canReviewForget}
          deleting={deleting}
          onStartConfirmation={startConfirmation}
          lyricsCandidates={lyricsCandidates.length}
          onManageAsLyrics={
            onManageAsLyrics && allowLocalDelete && localRoot ? () => onManageAsLyrics(lyricsCandidates) : undefined
          }
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

const noDuplicateMarks: ReadonlyMap<number, DuplicateFileMark> = new Map();
const noTargets: MediaDeleteTarget[] = [];

/** The identical-file check: its start button, its progress, and the selections it offers. */
function DuplicateFileControls({
  check,
  duplicates,
  selectedKeys,
  disabled,
  onStart,
  onStop,
  onToggle,
}: {
  check: DuplicateFileCheck;
  duplicates: ReturnType<typeof directoryManagerDuplicates> | null;
  selectedKeys: Set<string>;
  disabled: boolean;
  onStart: () => void;
  onStop: () => void;
  onToggle: (keys: string[], included: boolean) => void;
}) {
  if (check.status === "running") {
    return (
      <>
        <span className="text-xs tabular-nums text-muted-foreground" role="status">
          {i18n.t("libraryDetail.identicalChecking", { checked: check.checkedFiles, pending: check.pendingFiles })}
        </span>
        <Button variant="ghost" size="sm" className="h-8" onClick={onStop}>
          {i18n.t("libraryDetail.identicalStop")}
        </Button>
      </>
    );
  }
  const found = duplicates ? duplicates.elsewhere.files + duplicates.repeated.files : 0;
  return (
    <>
      <Button variant="outline" size="sm" className="h-8 shrink-0" disabled={disabled} onClick={onStart}>
        <Search className="h-4 w-4" />
        {check.status === "done" ? i18n.t("libraryDetail.identicalCheckAgain") : i18n.t("libraryDetail.identicalFind")}
      </Button>
      {check.status === "idle" && (
        <span className="text-xs text-muted-foreground">{i18n.t("libraryDetail.identicalHint")}</span>
      )}
      {check.status === "error" && (
        <span className="text-xs text-muted-foreground" role="status">
          {i18n.t("libraryDetail.identicalFailed")}
        </span>
      )}
      {duplicates && found === 0 && (
        <span className="text-xs text-muted-foreground" role="status">
          {i18n.t("libraryDetail.identicalNone")}
        </span>
      )}
      {duplicates && duplicates.elsewhere.files > 0 && (
        <SelectionChip
          group={duplicates.elsewhere}
          label={i18n.t("libraryDetail.identicalElsewhere")}
          selectedKeys={selectedKeys}
          disabled={disabled}
          onToggle={onToggle}
        />
      )}
      {duplicates && duplicates.repeated.files > 0 && (
        <SelectionChip
          group={duplicates.repeated}
          label={i18n.t("libraryDetail.identicalRepeated")}
          selectedKeys={selectedKeys}
          disabled={disabled}
          onToggle={onToggle}
        />
      )}
    </>
  );
}

/**
 * Stands in for the lyrics Kikoto manages in the listed folder, which the
 * lyrics manager handles, and offers to list them with the other files.
 */
function ManagedLyricsNote({
  files,
  sizeBytes,
  shown,
  deletedWithFolder,
  disabled,
  onShownChange,
  onManageLyrics,
}: {
  files: number;
  sizeBytes: number;
  /** The managed lyrics are listed in the tree. */
  shown: boolean;
  deletedWithFolder: boolean;
  disabled: boolean;
  onShownChange: (shown: boolean) => void;
  onManageLyrics?: () => void;
}) {
  const hint = shown
    ? i18n.t("lyricsManager.managedLyricsListed")
    : deletedWithFolder
      ? i18n.t("lyricsManager.deletedWithFolder")
      : i18n.t("lyricsManager.managedByKikotoHint");
  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-dashed px-3 py-2 text-sm"
      role="note"
    >
      <Captions className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1 basis-56">
        <div className="font-medium">{i18n.t("lyricsManager.managedByKikoto")}</div>
        <div className="text-xs text-muted-foreground">
          <span className="tabular-nums">
            {i18n.t("libraryDetail.filesCount", { count: files })}
            {sizeBytes > 0 ? ` · ${formatBytes(sizeBytes)}` : ""}
          </span>
          {" · "}
          {hint}
        </div>
      </div>
      <label className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-md px-1 text-xs text-muted-foreground hover:text-foreground">
        <Checkbox
          className="h-4 w-4"
          checked={shown}
          disabled={disabled}
          onCheckedChange={onShownChange}
          aria-label={i18n.t("lyricsManager.showManagedLyrics")}
        />
        <span>{i18n.t("lyricsManager.showManagedLyrics")}</span>
      </label>
      {onManageLyrics && (
        <Button variant="outline" size="sm" className="h-8 shrink-0" onClick={onManageLyrics}>
          {i18n.t("detailActions.manageLyrics")}
        </Button>
      )}
    </div>
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
  // A folder that holds only managed lyrics still lists its root, which removes the folder.
  if (!hasFiles && !rootTarget) {
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
  // The list's head selects everything; with a work root, that includes the folder itself.
  const state = directoryManagerSelectionState(allKeys, selectedKeys);
  const label = rootTarget
    ? i18n.t("libraryDetail.selectWorkRoot", { path: rootTarget.path })
    : i18n.t("libraryDetail.selectAll");
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
          {rootTarget ? (
            <>
              <Folder className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate" title={rootTarget.path}>
                {rootTarget.path}
              </span>
            </>
          ) : (
            <span className="min-w-0 flex-1 truncate">{i18n.t("libraryDetail.selectAll")}</span>
          )}
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
  const duplicateMarks = useContext(DuplicateMarksContext);
  const mixedLocations = useContext(MixedLocationsContext);
  const duplicate = file.localLocationId !== null ? duplicateMarks.get(file.localLocationId) : undefined;
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
        {duplicate && (
          <div
            className="mt-0.5 flex items-center gap-1 truncate text-2xs text-warning-foreground"
            title={`${duplicate.counterpart.workCode} · ${duplicate.counterpart.path}`}
          >
            <CopyCheck className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="truncate">
              {i18n.t(duplicate.elsewhere ? "libraryDetail.identicalToElsewhere" : "libraryDetail.identicalTo", {
                code: duplicate.counterpart.workCode,
                path: compactLibraryPath(duplicate.counterpart.path),
              })}
            </span>
          </div>
        )}
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

/** The selection's size and the actions that apply to it; actions it does not allow stay out of the way. */
function DirectoryManagerFooter({
  selectedTargets,
  total,
  forgetAvailable,
  canReviewForget,
  deleting,
  onStartConfirmation,
  lyricsCandidates,
  onManageAsLyrics,
}: {
  selectedTargets: MediaDeleteTarget[];
  total: number;
  forgetAvailable: boolean;
  canReviewForget: boolean;
  deleting: boolean;
  onStartConfirmation: (mode: MediaCleanupMode) => void;
  /** How many selected files can be managed as lyrics. */
  lyricsCandidates: number;
  onManageAsLyrics?: () => void;
}) {
  const bytes = selectedBytes(selectedTargets);
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-3 border-t bg-card px-4 py-3">
      <span className="min-w-0 text-xs tabular-nums text-muted-foreground" aria-live="polite">
        {i18n.t("libraryDetail.selectedDeletableCount", { selected: selectedTargets.length, total })}
        {bytes > 0 ? ` · ${formatBytes(bytes)}` : ""}
      </span>
      <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
        {onManageAsLyrics && lyricsCandidates > 0 && (
          <Button
            variant="outline"
            size="sm"
            disabled={deleting}
            title={i18n.t("lyricsManager.manageAsLyricsHint")}
            onClick={onManageAsLyrics}
          >
            <Captions className="h-4 w-4" />
            {i18n.t("lyricsManager.manageAsLyrics")}
            <span className="tabular-nums text-muted-foreground">{lyricsCandidates}</span>
          </Button>
        )}
        {/* Forgetting a work removes its complete folder, so it is offered once everything is selected. */}
        {forgetAvailable && canReviewForget && (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={deleting}
            title={i18n.t("libraryDetail.deleteSelectedThenForget")}
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
