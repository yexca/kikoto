import { FolderCog, RefreshCw, ShieldAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "@/auth/AuthProvider";
import { LibraryOfflineNotice } from "@/components/library-offline/LibraryOfflineNotice";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogHeader } from "@/components/ui/dialog";
import { FloatingSelect } from "@/components/ui/floating-select";
import { ConfirmMediaBatchDeleteDialog } from "@/features/work-detail/dialogs/ConfirmMediaBatchDeleteDialog";
import type { PendingDeletion } from "@/features/work-detail/folder-edit/fileWorkspaceModel";
import {
  CURRENT_FOLDER_RESOURCE,
  currentFileKey,
  folderEditResourceItemKey,
  withFolderEditPaths,
  type FolderEditResource,
  type FolderEditResultEntry,
  type FolderEditTarget,
} from "@/features/work-detail/folder-edit/folderEditModel";
import { FolderEditMergeConfirmDialog } from "@/features/work-detail/folder-edit/FolderEditMergeConfirmDialog";
import type { FolderWorkspaceManage } from "@/features/work-detail/folder-edit/folderWorkspace";
import { FolderLyricsNote, ManagedLyricsTag } from "@/features/work-detail/folder-edit/FolderWorkspaceTools";
import { FolderWorkspaceView } from "@/features/work-detail/folder-edit/FolderWorkspaceView";
import { IdenticalFolderCount } from "@/features/work-detail/folder-edit/IdenticalFiles";
import {
  useFolderEditWorkspace,
  type FolderEditInitialRemote,
} from "@/features/work-detail/folder-edit/useFolderEditWorkspace";
import { useIdenticalFiles } from "@/features/work-detail/folder-edit/useIdenticalFiles";
import { managedLyricsLanguage } from "@/features/work-detail/lyrics/managedLyricsModel";
import { isLyricsFilePath } from "@/features/work-detail/lyrics/remoteLyricsModel";
import type { MediaCleanupMode, MediaDeleteTarget } from "@/features/work-detail/workflows/useMediaCleanupWorkflow";
import type { MediaItem, WorkFolderEditResult } from "@/lib/api";
import { isLocalOffline } from "@/lib/localAvailability";
import { lyricsRootFolderName } from "@/lib/lyricsLanguage";
import { cn } from "@/lib/tailwindClassNames";

const noSelection: ReadonlySet<string> = new Set();

/** The work's folders, and what Manage files does to the work as a whole. */
export type FolderEditFolders = {
  /** The work's local folders when it has several; the workspace edits one at a time. */
  folders: { id: number; rootPath: string; availability?: string }[];
  onSelectFolder: (folderId: number) => void;
  /**
   * Deletes the folder entirely and forgets the work. Present only while the
   * viewer may forget the work and this is its only folder.
   */
  forget?: {
    targets: () => MediaDeleteTarget[];
    deleting: boolean;
    onConfirm: (targets: MediaDeleteTarget[], mode: MediaCleanupMode) => void;
  };
  /** Opens Manage lyrics on the lyrics Kikoto manages in this folder. */
  onManageLyrics?: () => void;
  /** Opens Manage lyrics on this folder's other lyrics, to make them lyrics of a language. */
  onManageFolderLyrics?: () => void;
  canCheckDuplicates: boolean;
  /** Indexes the edited folder again, for files changed outside Kikoto; the page reloads the work after it. */
  refresh?: { refreshing: boolean; onRefresh: () => void };
};

/**
 * Manage files of one local folder of a work: where files can come from, the
 * files of the chosen place, the folder as it will be, and everything the edit
 * deletes. The folder is the only place the edit changes; clearing a file of
 * it deletes the file when the edit is applied.
 */
export function FolderEditDialog({
  workId,
  folder,
  currentItems,
  initialRemote,
  localOnly = false,
  manage,
  onClose,
  onApplied,
}: {
  workId: number;
  folder: { id: number; rootPath: string; availability?: string };
  currentItems: MediaItem[];
  initialRemote?: FolderEditInitialRemote | null;
  /** Lists only local places, for a custom work that no remote source has. */
  localOnly?: boolean;
  manage: FolderEditFolders;
  onClose: () => void;
  onApplied: (result: WorkFolderEditResult) => void;
}) {
  const { t } = useTranslation();
  // A folder on an offline storage pool cannot be read, refreshed, or changed until its disk is back.
  if (isLocalOffline(folder.availability)) {
    return (
      <Dialog onClose={onClose} size="workspace" marker="folder-edit">
        <DialogHeader
          title={t("libraryDetail.manageFiles")}
          icon={<FolderCog className="h-4 w-4" />}
          onClose={onClose}
          closeLabel={t("content.close")}
        />
        <ManageToolbar folder={folder} manage={{ ...manage, refresh: undefined }} disabled={false} changed={false} />
        <DialogBody>
          <LibraryOfflineNotice detail={t("libraryOffline.editBlocked")} />
        </DialogBody>
      </Dialog>
    );
  }
  return (
    <FolderEditWorkspaceDialog
      workId={workId}
      folder={folder}
      currentItems={currentItems}
      initialRemote={initialRemote}
      localOnly={localOnly}
      manage={manage}
      onClose={onClose}
      onApplied={onApplied}
    />
  );
}

function FolderEditWorkspaceDialog({
  workId,
  folder,
  currentItems,
  initialRemote,
  localOnly,
  manage,
  onClose,
  onApplied,
}: {
  workId: number;
  folder: { id: number; rootPath: string; availability?: string };
  currentItems: MediaItem[];
  initialRemote?: FolderEditInitialRemote | null;
  localOnly: boolean;
  manage: FolderEditFolders;
  onClose: () => void;
  onApplied: (result: WorkFolderEditResult) => void;
}) {
  const { t } = useTranslation();
  const auth = useAuth();
  const target = useMemo<FolderEditTarget>(
    () => ({ workId, folderId: folder.id, rootPath: folder.rootPath }),
    [folder.id, folder.rootPath, workId],
  );
  const workspace = useFolderEditWorkspace({
    target,
    currentItems,
    initialRemote,
    canAssign: !auth.demoMode && auth.hasPermission("library:write"),
    localOnly,
    onApplied,
  });
  const [confirmation, setConfirmation] = useState<{ step: 1 | 2; targets: MediaDeleteTarget[] } | null>(null);
  const [reviewingMerge, setReviewingMerge] = useState(false);
  const removalTargets = useMemo<MediaDeleteTarget[]>(
    () =>
      workspace.removedFiles
        .filter((file) => file.locationId !== null)
        .map((file) => ({
          kind: "local",
          locationId: file.locationId!,
          workId,
          title: file.name,
          path: `${target.rootPath.replace(/\/+$/, "")}/${file.path}`,
          sizeBytes: file.sizeBytes,
        })),
    [target.rootPath, workId, workspace.removedFiles],
  );
  const merging = (workspace.request.mergeFolderIds?.length ?? 0) > 0;
  // A merge deletes folders, so it always takes its own review; the review
  // also counts the files the edit removes from this folder.
  const startApply = () => {
    if (merging) setReviewingMerge(true);
    else if (removalTargets.length > 0) setConfirmation({ step: 1, targets: removalTargets });
    else void workspace.apply();
  };
  const hints = (resource: FolderEditResource) =>
    resource.kind === "current"
      ? t("folderEdit.currentHint")
      : resource.kind === "local"
        ? t("folderEdit.localHint")
        : t("folderEdit.remoteHint", { source: resource.sourceName });
  const moveCount = workspace.request.moves?.length ?? 0;
  const statusReady = [
    t("folderEdit.statusReady", { add: workspace.addCount, remove: workspace.removeCount }),
    ...(moveCount > 0 ? [t("folderEdit.statusMove", { count: moveCount })] : []),
    ...(merging ? [t("folderEdit.statusMerge", { count: workspace.request.mergeFolderIds?.length ?? 0 })] : []),
  ].join(" · ");

  const kept = workspace.selection[CURRENT_FOLDER_RESOURCE] ?? noSelection;
  const setKept = (paths: readonly string[], keep: boolean) =>
    workspace.setSelected(CURRENT_FOLDER_RESOURCE, withFolderEditPaths(kept, paths, keep));
  const identical = useIdenticalFiles({
    workId,
    files: workspace.currentFiles,
    resources: workspace.resources,
    kept,
    setKept: (next) => workspace.setSelected(CURRENT_FOLDER_RESOURCE, next),
    disabled: workspace.applying,
  });
  const folderLyricsCount = useMemo(
    () =>
      workspace.currentFiles.filter((file) => isLyricsFilePath(file.path) && managedLyricsLanguage(file.path) === null)
        .length,
    [workspace.currentFiles],
  );
  const keep = (item: PendingDeletion) => {
    if (item.kind === "cleared") setKept([item.path], true);
    else if (item.kind === "replaced")
      workspace.setDecision({
        itemKey: item.incoming.itemKey,
        sourceId: 0,
        resolution: "keep_local",
        targetPath: item.incoming.targetPath,
      });
    else workspace.merge?.setMerged(item.resource, false);
  };
  // A file of this folder is deleted with the edit; a file the edit adds is simply not added.
  const discard = (entry: FolderEditResultEntry) => {
    const own = currentFileKey("");
    if (entry.key.startsWith(own)) {
      setKept([entry.key.slice(own.length)], false);
      return;
    }
    for (const resource of workspace.resources) {
      const state = workspace.files[resource.id];
      if (resource.kind === "current" || state?.status !== "ready") continue;
      const file = state.files.find((candidate) => folderEditResourceItemKey(resource, candidate.path) === entry.key);
      if (!file) continue;
      const selected = workspace.selection[resource.id] ?? noSelection;
      workspace.setSelected(resource.id, withFolderEditPaths(selected, [file.path], false));
      return;
    }
  };
  // While the folder is read again, the workspace holds still as it does while an edit is applied.
  const refreshing = manage.refresh?.refreshing ?? false;
  const shownWorkspace = refreshing ? { ...workspace, applying: true } : workspace;
  const manageExtras: FolderWorkspaceManage = {
    toolbar: (
      <ManageToolbar
        folder={folder}
        manage={manage}
        disabled={workspace.applying || refreshing}
        changed={workspace.undo?.canUndo ?? false}
      />
    ),
    thisFolderTools:
      manage.onManageFolderLyrics && folderLyricsCount > 0 ? (
        <FolderLyricsNote count={folderLyricsCount} onOpen={manage.onManageFolderLyrics} />
      ) : undefined,
    identical: manage.canCheckDuplicates && workspace.currentFiles.length > 0 ? identical : undefined,
    folderNote: (path, files) => {
      const count = identical.count > 0 ? files.filter((file) => identical.paths.has(file)).length : 0;
      if (path !== lyricsRootFolderName && count === 0) return null;
      return (
        <>
          {count > 0 && <IdenticalFolderCount count={count} />}
          {path === lyricsRootFolderName && <ManagedLyricsTag onManageLyrics={manage.onManageLyrics} />}
        </>
      );
    },
    pending: workspace.pendingDeletions,
    onKeep: keep,
    onDiscard: discard,
  };

  return (
    <>
      <FolderWorkspaceView
        workspace={shownWorkspace}
        title={t("libraryDetail.manageFiles")}
        description={t("fileWorkspace.description")}
        icon={<FolderCog className="h-4 w-4" />}
        marker="folder-edit"
        hints={hints}
        emptyResult={t("folderEdit.emptyResult")}
        statusIdle={t("folderEdit.statusIdle")}
        statusReady={statusReady}
        applyingLabel={refreshing ? t("fileWorkspace.refreshing") : t("folderEdit.applying")}
        applyLabel={t("folderEdit.apply")}
        initialPane="select"
        manage={manageExtras}
        onClose={onClose}
        onApply={startApply}
      />
      {reviewingMerge && (
        <FolderEditMergeConfirmDialog
          workId={workId}
          request={workspace.request}
          merges={workspace.mergePlan}
          removeCount={removalTargets.length}
          applying={workspace.applying}
          onCancel={() => setReviewingMerge(false)}
          onConfirm={(reviewed) => {
            setReviewingMerge(false);
            void workspace.apply(reviewed);
          }}
        />
      )}
      {confirmation && (
        <ConfirmMediaBatchDeleteDialog
          targets={confirmation.targets}
          mode="files_only"
          step={confirmation.step}
          deleting={workspace.applying}
          onCancel={() => setConfirmation(null)}
          onContinue={() => setConfirmation({ ...confirmation, step: 2 })}
          onConfirm={() => {
            setConfirmation(null);
            void workspace.apply();
          }}
        />
      )}
    </>
  );
}

/**
 * What Manage files does to the folder and the work as a whole: switching to
 * another of the work's folders, reading the folder from disk again, and
 * forgetting the work, which deletes the whole folder and is kept apart from
 * the edit's own file changes. A refresh waits until the edit has no changes,
 * so it never replaces the files a pending change refers to.
 */
function ManageToolbar({
  folder,
  manage,
  disabled,
  changed,
}: {
  folder: { id: number; rootPath: string };
  manage: FolderEditFolders;
  disabled: boolean;
  /** Whether the edit has changes that are not applied. */
  changed: boolean;
}) {
  const { t } = useTranslation();
  const [forgetting, setForgetting] = useState<{ step: 1 | 2; targets: MediaDeleteTarget[] } | null>(null);
  const { forget, refresh } = manage;
  const canSwitch = manage.folders.length > 1;
  if (!canSwitch && !forget && !refresh) return null;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
      {canSwitch && (
        <>
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
            {t("libraryDetail.manageFolder")}
          </span>
          <FloatingSelect
            value={String(folder.id)}
            options={manage.folders.map((candidate) => ({
              value: String(candidate.id),
              label: isLocalOffline(candidate.availability)
                ? `${t("libraryOffline.badge")} · ${candidate.rootPath}`
                : candidate.rootPath,
            }))}
            onValueChange={(value) => manage.onSelectFolder(Number(value))}
            ariaLabel={t("libraryDetail.manageFolder")}
            disabled={disabled}
            className="h-8 min-w-0 flex-1 text-xs sm:max-w-md"
          />
        </>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-1">
        {refresh && (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            disabled={disabled || changed}
            title={changed ? t("fileWorkspace.refreshBlocked") : t("fileWorkspace.refreshHint")}
            onClick={refresh.onRefresh}
          >
            <RefreshCw className={cn("h-4 w-4", refresh.refreshing && "animate-spin")} />
            {t("fileWorkspace.refresh")}
          </Button>
        )}
        {forget && (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            disabled={disabled || forget.deleting}
            title={t("fileWorkspace.forgetHint")}
            onClick={() => {
              const targets = forget.targets();
              if (targets.length > 0) setForgetting({ step: 1, targets });
            }}
          >
            <ShieldAlert className="h-4 w-4" />
            {t("fileWorkspace.forget")}
          </Button>
        )}
      </div>
      {forget && forgetting && (
        <ConfirmMediaBatchDeleteDialog
          targets={forgetting.targets}
          mode="files_and_forget_work"
          step={forgetting.step}
          deleting={forget.deleting}
          onCancel={() => setForgetting(null)}
          onContinue={() => setForgetting({ ...forgetting, step: 2 })}
          onConfirm={() => {
            setForgetting(null);
            forget.onConfirm(forgetting.targets, "files_and_forget_work");
          }}
        />
      )}
    </div>
  );
}
