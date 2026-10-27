import { useMemo, useState } from "react";

import { forgetWorkTargets } from "@/features/work-detail/dialogs/mediaDeleteTargets";
import type { FolderEditInitialRemote } from "@/features/work-detail/folder-edit/useFolderEditWorkspace";
import type { LyricsManagerRequest } from "@/features/work-detail/lyrics/LyricsManagerDialog";
import { buildTree, emptyTree, type TreeNode } from "@/features/work-detail/media/mediaTreeModel";
import { activeLocalFolders, mediaItemsInLocalFolder } from "@/features/work-detail/persistedWorkDetailModel";
import type { useWorkSourceContext } from "@/features/work-detail/source/useWorkSourceContext";
import i18n from "@/i18n";
import type { WorkDetail } from "@/lib/api";
import { isLocalOffline } from "@/lib/localAvailability";

type SourceContext = ReturnType<typeof useWorkSourceContext>;

/**
 * File management for a persisted work's shown edition. A manager of local
 * files manages a local folder in the file workspace, which also takes a
 * remote's files when Fetch adds them to the work's folder; everyone else, and
 * a tracked source's cache, gets the list that deletes files. A work a scan
 * found in several folders has several active local folders, and management
 * works on one at a time, starting with the work's main one.
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
  /** The shown directory, which the list shows unless it narrows to one folder or source. */
  tree: TreeNode;
  canEditFolders: boolean;
  /** Whether remote files may be fetched into an existing folder through the workspace. */
  canFetchIntoFolder: boolean;
}) {
  const [isListOpen, setIsListOpen] = useState(false);
  const [manageFolderID, setManageFolderID] = useState(0);
  const [workspace, setWorkspace] = useState<{
    folderId: number;
    initialRemote: FolderEditInitialRemote | null;
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
    if (!isListOpen) return emptyTree();
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
    isListOpen,
    localDirectoryWork,
    localFolders.length,
    manageFolder,
    selectedSource?.kind,
    selectedTrackedPresence,
    selectedTrackedSourceID,
    tree,
  ]);
  // The work's own folders, online or not, which the workspace edits one at a time.
  const workFolders = useMemo(
    () =>
      (localDirectoryWork?.localFolders ?? []).filter(
        (folder) =>
          folder.workId === localDirectoryWork?.id && folder.state === "active" && folder.rootPath.trim() !== "",
      ),
    [localDirectoryWork],
  );
  // A work that already has a local folder takes remote files through the
  // workspace, next to its other local and remote editions.
  const editableFolders = workFolders.filter((folder) => !isLocalOffline(folder.availability));
  const fetchEditFolder = canFetchIntoFolder
    ? (editableFolders.find((folder) => folder.primary) ?? editableFolders[0] ?? null)
    : null;
  const workspaceFolder = workspace ? (workFolders.find((folder) => folder.id === workspace.folderId) ?? null) : null;
  // The workspace switches among the folders the selected local source lists, or among all of the work's.
  const workspaceFolders = localFolders.length > 0 ? localFolders : workFolders;
  const localFolderManaged = selectedSource?.kind === "local" && !selectedTrackedPresence;
  const lyricsFolderId = workspaceFolder?.id ?? manageFolder?.id;

  return {
    isListOpen,
    /** Opens Manage files: the workspace for a manager of the selected local folder, the list otherwise. */
    openManager: () => {
      if (canEditFolders && localFolderManaged && manageFolder) {
        setWorkspace({ folderId: manageFolder.id, initialRemote: null });
      } else {
        setIsListOpen(true);
      }
    },
    closeManager: () => {
      setIsListOpen(false);
      setWorkspace(null);
    },
    localFolders,
    manageFolder,
    localRoot,
    managementTree,
    selectManageFolder: setManageFolderID,
    workspaceFolder,
    workspaceFolders,
    initialRemote: workspace?.initialRemote ?? null,
    /** Shows another of the work's folders in the workspace. */
    selectWorkspaceFolder: (folderId: number) => {
      setManageFolderID(folderId);
      setWorkspace({ folderId, initialRemote: null });
    },
    /** Opens the workspace with a remote's files, when the work has a folder to take them. */
    editFolderWithRemote: (remote: FolderEditInitialRemote) => {
      if (!fetchEditFolder) return false;
      setWorkspace({ folderId: fetchEditFolder.id, initialRemote: remote });
      return true;
    },
    /** What forgetting the work deletes: the workspace's folder and every copy of its files. */
    forgetTargets: () =>
      localDirectoryWork && workspaceFolder
        ? forgetWorkTargets(
            buildTree(
              mediaItemsInLocalFolder(localDirectoryWork.mediaItems, workspaceFolder.rootPath),
              workspaceFolder.fileSourceId,
              localDirectoryWork.primaryCode,
            ),
            workspaceFolder,
            localDirectoryWork.id,
            i18n.t("libraryDetail.workRoot"),
          )
        : [],
    lyricsManagerRequest,
    openLyricsManager: setLyricsManagerRequest,
    closeLyricsManager: () => setLyricsManagerRequest(null),
    /** Opens the lyrics manager over the workspace on the lyrics Kikoto manages in its folder. */
    manageLyrics: canEditFolders
      ? () => setLyricsManagerRequest({ tab: "files", folderId: lyricsFolderId })
      : undefined,
    /** Opens the lyrics manager over the workspace on its folder's other lyrics. */
    manageFolderLyrics: canEditFolders
      ? () => setLyricsManagerRequest({ tab: "files", folderId: lyricsFolderId, folderLyrics: true })
      : undefined,
  };
}
