import { useMemo, useState } from "react";

import type { FolderEditInitialRemote } from "@/features/work-detail/folder-edit/useFolderEditWorkspace";
import type { LyricsManagerRequest } from "@/features/work-detail/lyrics/LyricsManagerDialog";
import { buildTree, emptyTree, type TreeNode } from "@/features/work-detail/media/mediaTreeModel";
import { activeLocalFolders, mediaItemsInLocalFolder } from "@/features/work-detail/persistedWorkDetailModel";
import type { useWorkSourceContext } from "@/features/work-detail/source/useWorkSourceContext";
import type { WorkDetail } from "@/lib/api";
import { isLocalOffline } from "@/lib/localAvailability";

type SourceContext = ReturnType<typeof useWorkSourceContext>;

/**
 * File management for a persisted work's shown edition: the manager dialog
 * and the local folder it works on, the folder edit, and the lyrics manager.
 * A work a scan found in several folders has several active local folders,
 * and management works on one at a time, starting with the work's main one.
 */
export function usePersistedFileManagement({
  localDirectoryWork,
  selectedSource,
  selectedTrackedPresence,
  selectedTrackedSourceID,
  tree,
  canEditFolders,
  canFetchIntoFolder,
}: {
  localDirectoryWork: WorkDetail | null;
  selectedSource: SourceContext["selectedSource"];
  selectedTrackedPresence: SourceContext["selectedTrackedPresence"];
  selectedTrackedSourceID: SourceContext["selectedTrackedSourceID"];
  /** The shown directory, which the manager lists unless it narrows to one folder or source. */
  tree: TreeNode;
  canEditFolders: boolean;
  /** Whether remote files may be fetched into an existing folder through the folder edit. */
  canFetchIntoFolder: boolean;
}) {
  const [isManageOpen, setIsManageOpen] = useState(false);
  const [manageFolderID, setManageFolderID] = useState(0);
  const [folderEdit, setFolderEdit] = useState<{
    folderId: number;
    initialRemote: FolderEditInitialRemote | null;
    fromManage: boolean;
  } | null>(null);
  const [lyricsManagerRequest, setLyricsManagerRequest] = useState<LyricsManagerRequest | null>(null);

  const localFolders = useMemo(
    () => activeLocalFolders(localDirectoryWork, selectedSource?.fileSourceId),
    [localDirectoryWork, selectedSource?.fileSourceId],
  );
  const manageFolder =
    localFolders.find((folder) => folder.id === manageFolderID) ??
    localFolders.find((folder) => folder.primary) ??
    localFolders[0] ??
    null;
  const localRoot = useMemo(
    () =>
      manageFolder
        ? {
            folderId: manageFolder.id,
            path: manageFolder.rootPath,
            offline: isLocalOffline(manageFolder.availability),
          }
        : null,
    [manageFolder],
  );
  const managementTree = useMemo(() => {
    if (!isManageOpen) return emptyTree();
    if (selectedTrackedPresence && localDirectoryWork && selectedTrackedSourceID) {
      return buildTree(localDirectoryWork.mediaItems, selectedTrackedSourceID, localDirectoryWork.primaryCode);
    }
    // A folder on an offline storage pool lists nothing to act on. Its files
    // may have copies in another folder, which must never stand in for them.
    if (manageFolder && isLocalOffline(manageFolder.availability) && selectedSource?.kind === "local") {
      return emptyTree();
    }
    if (localDirectoryWork && manageFolder && localFolders.length > 1 && selectedSource?.kind === "local") {
      return buildTree(
        mediaItemsInLocalFolder(localDirectoryWork.mediaItems, manageFolder.rootPath),
        manageFolder.fileSourceId,
        localDirectoryWork.primaryCode,
      );
    }
    return tree;
  }, [
    isManageOpen,
    localDirectoryWork,
    localFolders.length,
    manageFolder,
    selectedSource?.kind,
    selectedTrackedPresence,
    selectedTrackedSourceID,
    tree,
  ]);
  // A work that already has a local folder takes remote files through the
  // folder edit, next to its other local and remote editions.
  const editableFolders = useMemo(
    () =>
      (localDirectoryWork?.localFolders ?? []).filter(
        (folder) =>
          folder.workId === localDirectoryWork?.id &&
          folder.state === "active" &&
          !isLocalOffline(folder.availability) &&
          folder.rootPath.trim() !== "",
      ),
    [localDirectoryWork],
  );
  const fetchEditFolder = canFetchIntoFolder
    ? (editableFolders.find((folder) => folder.primary) ?? editableFolders[0] ?? null)
    : null;
  const editedFolder = folderEdit
    ? (editableFolders.find((folder) => folder.id === folderEdit.folderId) ?? null)
    : null;
  const localFolderManaged = selectedSource?.kind === "local" && !selectedTrackedPresence;
  // The lyrics manager handles lyrics files only for a manager of the listed
  // local folder, and only while that folder's storage pool is online.
  const canManageLyricsFiles = canEditFolders && localFolderManaged && !localRoot?.offline;

  const openFromManager = (open: () => void) => {
    setIsManageOpen(false);
    open();
  };

  return {
    isManageOpen,
    openManager: () => setIsManageOpen(true),
    closeManager: () => setIsManageOpen(false),
    localFolders,
    manageFolder,
    localRoot,
    managementTree,
    selectManageFolder: setManageFolderID,
    editedFolder,
    folderEdit,
    /** Opens the folder edit with a remote's files, when the work has a folder to take them. */
    editFolderWithRemote: (remote: FolderEditInitialRemote) => {
      if (!fetchEditFolder) return false;
      setFolderEdit({ folderId: fetchEditFolder.id, initialRemote: remote, fromManage: false });
      return true;
    },
    /** Edits the managed folder from the manager, which the edit's Back returns to. */
    editFiles:
      canEditFolders && manageFolder && localFolderManaged
        ? () =>
            openFromManager(() => setFolderEdit({ folderId: manageFolder.id, initialRemote: null, fromManage: true }))
        : undefined,
    backFromFolderEdit: folderEdit?.fromManage
      ? () => {
          setFolderEdit(null);
          setIsManageOpen(true);
        }
      : undefined,
    closeFolderEdit: () => setFolderEdit(null),
    lyricsManagerRequest,
    openLyricsManager: setLyricsManagerRequest,
    closeLyricsManager: () => setLyricsManagerRequest(null),
    /** Opens the lyrics manager on the given files, or on the managed folder. */
    manageAsLyrics: canManageLyricsFiles
      ? (files: { folderId?: number; path: string }[]) =>
          openFromManager(() =>
            setLyricsManagerRequest({
              tab: "files",
              folderId: files[0]?.folderId,
              paths: files.map((file) => file.path),
            }),
          )
      : undefined,
    manageLyrics: canManageLyricsFiles
      ? () => openFromManager(() => setLyricsManagerRequest({ tab: "files", folderId: manageFolder?.id }))
      : undefined,
  };
}
