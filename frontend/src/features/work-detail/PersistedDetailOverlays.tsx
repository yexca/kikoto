import type { ReactNode } from "react";

import type { ReforkTarget, RemoteSourceAvailability } from "@/features/work-detail/source/sourceContextModel";
import {
  api,
  type LibrarySource,
  type SourcePresenceItem,
  type WorkDetail,
  type WorkFolderEditResult,
  type WorkFolderLocation,
  type WorkMetadataSyncRunResult,
} from "@/lib/api";
import type { TreeNode } from "@/features/work-detail/media/mediaTreeModel";
import i18n from "@/i18n";
import { FilePreviewDialog, type FilePreviewRequest } from "@/features/work-detail/dialogs/FilePreviewDialog";
import { toastFromError, type useToast } from "@/components/ui/toast";
import type { MediaCleanupMode, MediaDeleteTarget } from "@/features/work-detail/workflows/useMediaCleanupWorkflow";
import { DirectoryManagerDialog } from "@/features/work-detail/dialogs/DirectoryManagerDialog";
import { FolderEditDialog, type FolderEditFolders } from "@/features/work-detail/folder-edit/FolderEditDialog";
import type { FolderEditInitialRemote } from "@/features/work-detail/folder-edit/useFolderEditWorkspace";
import { LyricsManagerDialog, type LyricsManagerRequest } from "@/features/work-detail/lyrics/LyricsManagerDialog";
import { WorkMetadataEditorModal, type MetadataEditorSection } from "@/features/work-detail/metadata";
import { ReforkConfirmDialog } from "@/features/work-detail/dialogs/ReforkConfirmDialog";
import { useAuth } from "@/auth/AuthProvider";

export function PersistedFilePreviewOverlay({
  preview,
  work,
  toast,
  onClose,
  onMetadataSaved,
}: {
  preview: FilePreviewRequest | null;
  work: WorkDetail | null;
  toast: ReturnType<typeof useToast>;
  onClose: () => void;
  onMetadataSaved: () => Promise<void>;
}) {
  if (!preview) return null;
  const onSetCover = work
    ? async (locationId: number) => {
        try {
          await api.setWorkCoverOverride(work.id, locationId);
          toast.success(i18n.t("libraryDetail.coverOverrideSaved"));
          onClose();
          await onMetadataSaved();
        } catch (error) {
          toast.notify(toastFromError(error, i18n.t("libraryDetail.coverOverrideSaveFailed")));
        }
      }
    : undefined;
  return <FilePreviewDialog request={preview} onClose={onClose} onSetCover={onSetCover} />;
}

export function PersistedDirectoryManagerOverlay({
  open,
  root,
  selectedTrackedPresence,
  showNoSourceDirectory,
  selectedRemoteSource,
  deleting,
  onDeleteTargets,
  workID,
  localRoot,
  localFolders = [],
  onSelectLocalFolder,
  onClose,
}: {
  open: boolean;
  root: TreeNode;
  selectedTrackedPresence: SourcePresenceItem | null;
  showNoSourceDirectory: boolean;
  selectedRemoteSource: RemoteSourceAvailability | null | undefined;
  deleting: boolean;
  onDeleteTargets: (targets: MediaDeleteTarget[], mode: MediaCleanupMode) => void;
  workID: number;
  localRoot: { folderId: number; path: string; offline?: boolean } | null;
  /** The work's local folders when it has several; file management then shows one at a time. */
  localFolders?: { id: number; rootPath: string; availability?: string }[];
  onSelectLocalFolder?: (folderId: number) => void;
  onClose: () => void;
}) {
  if (!open) return null;
  const title = selectedTrackedPresence ? i18n.t("libraryDetail.manageCache") : i18n.t("libraryDetail.manageFiles");
  const description = selectedTrackedPresence ? i18n.t("libraryDetail.reviewCachedFiles") : undefined;
  const emptyLabel = selectedTrackedPresence
    ? i18n.t("libraryDetail.noCachedFiles")
    : showNoSourceDirectory
      ? i18n.t("libraryDetail.noSourceLinked")
      : selectedRemoteSource
        ? i18n.t("libraryDetail.noRemoteFiles")
        : i18n.t("libraryDetail.noLocalFiles");
  return (
    <DirectoryManagerDialog
      root={root}
      title={title}
      description={description}
      emptyLabel={emptyLabel}
      onClose={onClose}
      deleting={deleting}
      onDeleteTargets={onDeleteTargets}
      workId={workID}
      allowCacheDelete={!selectedRemoteSource}
      allowLocalDelete={!selectedRemoteSource && !selectedTrackedPresence}
      localRoot={localRoot}
      localFolders={localFolders}
      onSelectLocalFolder={onSelectLocalFolder}
      showCachedFilter={Boolean(selectedTrackedPresence)}
    />
  );
}

/** Manage files of a local folder for a manager of local files: the file workspace. */
export function PersistedFolderEditOverlay({
  work,
  folder,
  initialRemote,
  manage,
  onClose,
  onApplied,
}: {
  work: WorkDetail | null;
  /** The folder being managed; the overlay is closed while it is null. */
  folder: WorkFolderLocation | null;
  initialRemote: FolderEditInitialRemote | null;
  manage: FolderEditFolders;
  onClose: () => void;
  onApplied: (result: WorkFolderEditResult) => void;
}) {
  if (!work || !folder) return null;
  return (
    <FolderEditDialog
      // A different folder is a different edit.
      key={folder.id}
      workId={work.id}
      folder={folder}
      currentItems={work.mediaItems}
      initialRemote={initialRemote}
      localOnly={Boolean(work.customWork)}
      manage={manage}
      onClose={onClose}
      onApplied={onApplied}
    />
  );
}

export function PersistedLyricsManagerOverlay({
  request,
  work,
  onClose,
  onSaved,
}: {
  /** What the manager opens on; the overlay is closed while it is null. */
  request: LyricsManagerRequest | null;
  work: WorkDetail | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { demoMode, hasPermission } = useAuth();
  if (!request || !work) return null;
  return (
    <LyricsManagerDialog
      work={work}
      readOnly={demoMode || !hasPermission("library:write")}
      canDownload={!demoMode && hasPermission("downloads:manage")}
      canTranscribe={!demoMode && hasPermission("library:write") && hasPermission("workflows:run")}
      demo={demoMode}
      request={request}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

export function PersistedMetadataEditorOverlay({
  section,
  work,
  sources = [],
  selectedMetadataVariantKey,
  canSyncMetadata = false,
  refreshActions,
  onClose,
  onSaved,
  onLinkChanged,
  onTranslateWithAI,
}: {
  section: MetadataEditorSection | null;
  work: WorkDetail | null;
  sources?: LibrarySource[];
  selectedMetadataVariantKey: string;
  canSyncMetadata?: boolean;
  refreshActions?: ReactNode;
  onClose: () => void;
  onSaved: () => void;
  onLinkChanged: (result: { sync?: WorkMetadataSyncRunResult }) => void;
  onTranslateWithAI?: () => void;
}) {
  const { demoMode, hasPermission } = useAuth();
  if (!section || !work) return null;
  return (
    <WorkMetadataEditorModal
      work={work}
      sources={sources}
      selectedMetadataVariantKey={selectedMetadataVariantKey}
      canSyncMetadata={canSyncMetadata}
      readOnly={demoMode || !hasPermission("library:write")}
      initialSection={section}
      refreshActions={refreshActions}
      onClose={onClose}
      onSaved={onSaved}
      onLinkChanged={onLinkChanged}
      onTranslateWithAI={onTranslateWithAI}
    />
  );
}

export function PersistedReforkOverlay({
  target,
  busy,
  onClose,
  onConfirm,
}: {
  target: ReforkTarget | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: (remote: RemoteSourceAvailability) => void;
}) {
  if (!target) return null;
  return (
    <ReforkConfirmDialog
      currentName={target.current?.source.displayName ?? i18n.t("libraryDetail.currentFork")}
      nextName={target.next.source.displayName}
      busy={busy}
      onClose={onClose}
      onConfirm={() => onConfirm(target.next)}
    />
  );
}
