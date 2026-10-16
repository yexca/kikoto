import {
  availableForkSources,
  type DetailSourceIntent,
  remoteSourceTabKey,
} from "@/features/work-detail/source/sourceContextModel";
import {
  api,
  type DirectoryRoutingRule,
  type FavoriteList,
  type LibrarySource,
  type ListeningStatus,
  type WorkDetail,
  type WorkMetadataSyncRunResult,
  type WorkProgressSummary,
} from "@/lib/api";
import type { WorkPreview } from "@/features/work-detail/workDetailShared";
import { useWorkPlaybackCursor } from "@/features/work-detail/media/useWorkPlaybackCursor";
import {
  buildTree,
  buildWorkResumeQueue,
  emptyTree,
  flattenTracks,
  flattenTreeFiles,
  toPlayerTrack,
  toRemotePreviewPlayerTrack,
  type TreeNode,
  treeStats,
  type TreeTrack,
} from "@/features/work-detail/media/mediaTreeModel";
import i18n from "@/i18n";
import { openActivityRun, openDetailTagSearch, workHasNoSource } from "@/features/work-detail/workDetailHelpers";
import type { SourceActionLayout } from "@/features/work-detail/WorkDetailActionBars";
import {
  detailHeroModel,
  UnifiedWorkDetailPage,
  useCompactDetailLayout,
} from "@/features/work-detail/WorkDetailLayout";
import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useState } from "react";
import type { FilePreviewRequest } from "@/features/work-detail/dialogs/FilePreviewDialog";
import { UserTagRow } from "@/components/UserTagRow";
import { resolveMetadataVariant } from "@/features/work-detail/metadataPresentationModel";
import { toastFromError, useToast } from "@/components/ui/toast";
import {
  type MediaCleanupCompletion,
  useMediaCleanupWorkflow,
} from "@/features/work-detail/workflows/useMediaCleanupWorkflow";
import { useMetadataSyncWorkflow } from "@/features/work-detail/workflows/useMetadataSyncWorkflow";
import { WorkMetadataRefreshControl, type MetadataEditorSection } from "@/features/work-detail/metadata";
import type { ClientPrincipalID } from "@/lib/clientStorageScope";
import { useAuth } from "@/auth/AuthProvider";
import { useWorkSourceContext } from "@/features/work-detail/source/useWorkSourceContext";
import { useSourceTrackingActions } from "@/features/work-detail/source/useSourceTrackingActions";
import { useMediaTree } from "@/features/work-detail/media/useMediaTree";
import { useLibraryPlayer } from "@/player/PlayerProvider";
import { playbackTrackMatchesPersistedWork } from "@/features/work-detail/media/playbackDirectoryRouting";
import {
  usePlaybackAutoRouting,
  usePlaybackRoutePath,
  usePlaybackSourceSelection,
} from "@/features/work-detail/media/usePlaybackAutoRouting";
import { useRemoteFetchWorkspace } from "@/features/work-detail/workflows/useRemoteFetchWorkspace";
import { useFolderEditWorkflow } from "@/features/work-detail/folder-edit/useFolderEditWorkflow";
import type { FolderEditInitialRemote } from "@/features/work-detail/folder-edit/useFolderEditWorkspace";
import type { LyricsManagerRequest } from "@/features/work-detail/lyrics/LyricsManagerDialog";
import { invalidateCachedWorkMedia, setCachedWorkMedia } from "@/features/work-detail/media/workMediaCache";
import { PageHeaderBackAction } from "@/app/pageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { LazyRemoteFetchWorkspaceDialog } from "@/features/work-detail/workflows/LazyRemoteFetchWorkspaceDialog";
import { defaultDirectoryRoutingRules } from "@/features/work-detail/directory/directoryModel";
import {
  activeLocalFolders,
  hasResumablePlaybackCursor,
  mediaItemsInLocalFolder,
  persistedActiveSourceLabel,
  persistedDetailActionMode,
  persistedDirectoryDescription,
  persistedDirectoryLoadState,
  persistedDisplayTranslations,
  persistedFetchTarget,
  persistedMediaTreeInput,
  persistedSourceInfo,
  persistedWorkDetailPresentation,
} from "@/features/work-detail/persistedWorkDetailModel";
import {
  type PersistedDetailActionsProps,
  PersistedIdentityActions,
  PersistedMediaActions,
} from "@/features/work-detail/PersistedDetailActions";
import { PersistedDirectoryPanel } from "@/features/work-detail/PersistedDirectoryPanel";
import {
  PersistedDirectoryManagerOverlay,
  PersistedFolderEditOverlay,
  PersistedFilePreviewOverlay,
  PersistedLyricsManagerOverlay,
  PersistedMetadataEditorOverlay,
  PersistedReforkOverlay,
} from "@/features/work-detail/PersistedDetailOverlays";
import { useWorkEditionSelection } from "@/features/work-detail/useWorkEditionSelection";

async function resolvePersistedResumeContext(
  cursor: WorkProgressSummary,
  localDirectoryWork: WorkDetail | null,
  playbackTree: TreeNode,
) {
  const resumeWork =
    cursor.mediaWorkId && cursor.mediaWorkId !== localDirectoryWork?.id
      ? await api.getWork(cursor.mediaWorkId)
      : localDirectoryWork;
  if (!resumeWork) throw new Error(i18n.t("libraryDetail.savedTrackUnavailable"));
  return {
    resumeWork,
    resumeTree:
      resumeWork.id === localDirectoryWork?.id
        ? playbackTree
        : buildTree(resumeWork.mediaItems, null, resumeWork.primaryCode),
  };
}

function persistedPersonalTags(work: WorkDetail | null, onSave: (tags: string[]) => Promise<void>) {
  if (!work) return undefined;
  return (
    <UserTagRow
      tags={work.userTags ?? []}
      scope="work"
      onSave={onSave}
      variant="chip"
      listLabel={i18n.t("libraryDetail.myTags")}
      onTagOpen={(name) => openDetailTagSearch("user_tag", name)}
      className="contents"
    />
  );
}

export function PersistedWorkDetailController({
  code,
  work,
  workPreview,
  mediaLoading,
  mediaError,
  sources,
  initialSourceIntent,
  initialTrackedSourceID,
  initialRemoteCode,
  principalID,
  canForgetWork,
  canSyncMetadata,
  onBack,
  onStatusChange,
  onPlay,
  onWorkReload,
  onWorksChanged,
}: {
  code: string;
  work: WorkDetail | null;
  workPreview: WorkPreview | null;
  mediaLoading: boolean;
  mediaError: string;
  sources: LibrarySource[];
  initialSourceIntent: DetailSourceIntent;
  initialTrackedSourceID: number | null;
  initialRemoteCode: string;
  principalID: ClientPrincipalID;
  canForgetWork: boolean;
  canSyncMetadata: boolean;
  onBack: () => void;
  onStatusChange: (workID: number, status: ListeningStatus) => Promise<void>;
  onPlay: () => void;
  onWorkReload: (workID: number, includeMedia?: boolean) => Promise<void>;
  onWorksChanged: () => Promise<void>;
}) {
  const auth = useAuth();
  const toast = useToast();
  const { t } = useTranslation();
  const sourceContext = useWorkSourceContext({
    code,
    work,
    sources,
    initialSourceIntent,
    initialTrackedSourceID,
    initialRemoteCode,
  });
  const {
    remoteSources,
    sourceTabs,
    setActiveSourceKey,
    selectSource,
    selectTrackedPresence,
    selectRemoteEdition,
    trackedPresenceOptions,
    selectedTrackedPresenceKey,
    selectedSource,
    resolvedActiveSourceKey,
    selectedRemoteSource,
    selectedTrackedPresence,
    selectedTrackedForked,
    selectedTrackedSourceID,
    selectedTrackedRemoteSource,
    selectedRemoteDetail,
    selectedRemoteTreeLoading,
    selectedRemoteTreeError,
    selectedRemoteSourceID,
    selectedRemoteWorkCode,
    isCheckingSources,
    sourceCheckedAt,
    refreshAvailability,
  } = sourceContext;
  const [isManageOpen, setIsManageOpen] = useState(false);
  const [manageFolderID, setManageFolderID] = useState(0);
  const [folderEdit, setFolderEdit] = useState<{
    folderId: number;
    initialRemote: FolderEditInitialRemote | null;
    fromManage: boolean;
  } | null>(null);
  const [lyricsManagerRequest, setLyricsManagerRequest] = useState<LyricsManagerRequest | null>(null);
  const [metadataEditorSection, setMetadataEditorSection] = useState<MetadataEditorSection | null>(null);
  const [preview, setPreview] = useState<FilePreviewRequest | null>(null);
  const [isRefreshingLocalFiles, setIsRefreshingLocalFiles] = useState(false);
  const [favoriteLists, setFavoriteLists] = useState<FavoriteList[]>([]);
  const [selectedMetadataVariantKey, setSelectedMetadataVariantKey] = useState("");
  const [isResuming, setIsResuming] = useState(false);
  const [directoryRoutingRules, setDirectoryRoutingRules] =
    useState<DirectoryRoutingRule[]>(defaultDirectoryRoutingRules);
  const [mobileDetailTab, setMobileDetailTab] = useState<"info" | "directory">("directory");
  const isCompactDetailLayout = useCompactDetailLayout();
  const player = useLibraryPlayer();
  const playbackRouting = usePlaybackAutoRouting({
    routeKey: `persisted:${code}:${initialSourceIntent}:${initialTrackedSourceID ?? 0}:${initialRemoteCode}`,
    currentTrack: player.currentTrack,
    isPlaying: player.isPlaying,
    matchesWork: playbackTrackMatchesPersistedWork(player.currentTrack, work, workPreview, code),
  });
  usePlaybackSourceSelection({
    routing: playbackRouting,
    active: initialSourceIntent === "local",
    sourceTabs,
    trackedPresenceOptions,
    resolvedActiveSourceKey,
    selectedTrackedPresenceKey,
    selectSource,
    selectTrackedPresence,
  });
  const editions = useWorkEditionSelection({
    work,
    principalID,
    onSelectionStart: playbackRouting.disable,
    onLocalEditionSelected: () => setActiveSourceKey("local"),
  });
  const { activeEdition, activeEditionCode, editionLoadingCode, editionError } = editions;
  useEffect(() => setSelectedMetadataVariantKey(""), [principalID, work?.id]);
  const tracking = useSourceTrackingActions({
    work,
    sourceContext,
    onWorkReload,
    onWorksChanged,
    onUntrackStart: playbackRouting.disable,
  });
  const metadataSync = useMetadataSyncWorkflow({ work, blocked: tracking.isBusy, onWorkReload, onWorksChanged });
  const isSyncingDetail = metadataSync.isSubmitting || tracking.isBusy;
  const metadataSyncBusy = metadataSync.isBusy || tracking.isBusy;
  const localDirectoryWork = activeEdition ?? work;
  const activeMetadataVariant = resolveMetadataVariant(work?.metadataPresentation, selectedMetadataVariantKey);
  const playbackDisplayTitle = activeMetadataVariant?.title ?? work?.title;
  const playbackCoverUrl = work?.coverUrl || workPreview?.coverUrl || "";
  // A work a scan found in several folders has several active local folders.
  const localFolders = useMemo(
    () => activeLocalFolders(localDirectoryWork, selectedSource?.fileSourceId),
    [localDirectoryWork, selectedSource?.fileSourceId],
  );
  // File management works on one folder at a time, starting with the work's main one.
  const manageFolder =
    localFolders.find((folder) => folder.id === manageFolderID) ??
    localFolders.find((folder) => folder.primary) ??
    localFolders[0] ??
    null;
  const localRoot = useMemo(
    () => (manageFolder ? { folderId: manageFolder.id, path: manageFolder.rootPath } : null),
    [manageFolder],
  );
  const { tree, isDirectoryLoading } = useMediaTree(
    persistedMediaTreeInput({
      mediaLoading: mediaLoading || editionLoadingCode !== "",
      localDirectoryWork: editionLoadingCode ? null : localDirectoryWork,
      work,
      selectedTrackedForked,
      selectedTrackedSourceID,
      selectedSource,
      selectedRemoteSource,
      selectedRemoteSourceID,
      selectedRemoteDetail,
      selectedTrackedPresence,
    }),
  );
  const autoRoutePath = usePlaybackRoutePath(playbackRouting, tree);
  const directoryStats = useMemo(() => treeStats(tree), [tree]);
  const playbackTree = useMemo(
    () =>
      localDirectoryWork ? buildTree(localDirectoryWork.mediaItems, null, localDirectoryWork.primaryCode) : emptyTree(),
    [localDirectoryWork],
  );
  const { cursor: playbackCursor, isLoading: playbackCursorLoading } = useWorkPlaybackCursor(work?.id ?? null);
  const hasResumableCursor = hasResumablePlaybackCursor(playbackCursor);
  const { remote: fetchRemote, code: fetchRemoteCode } = persistedFetchTarget(
    selectedRemoteSource,
    selectedTrackedRemoteSource,
    selectedRemoteWorkCode,
    selectedTrackedPresence,
    work,
    code,
  );
  const trackedCacheAvailable = useMemo(
    () =>
      Boolean(
        selectedTrackedSourceID &&
        localDirectoryWork?.mediaItems.some((item) =>
          item.locations.some(
            (location) =>
              location.fileSourceId === selectedTrackedSourceID &&
              location.locationType === "cache" &&
              location.availability === "available",
          ),
        ),
      ),
    [localDirectoryWork?.mediaItems, selectedTrackedSourceID],
  );
  const managementTree = useMemo(() => {
    if (!isManageOpen) return emptyTree();
    if (selectedTrackedPresence && localDirectoryWork && selectedTrackedSourceID) {
      return buildTree(localDirectoryWork.mediaItems, selectedTrackedSourceID, localDirectoryWork.primaryCode);
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
  const otherLocalEditionCount = (localDirectoryWork?.translations ?? []).filter(
    (edition) => edition.workId && edition.workId !== localDirectoryWork?.id && edition.localAvailable,
  ).length;
  const canManageLocalCopies =
    !auth.demoMode && auth.hasPermission("downloads:manage") && selectedSource?.kind === "local";
  const fetchWorkspace = useRemoteFetchWorkspace({ onWorksChanged });
  // A work that already has a local folder takes remote files through the
  // folder edit, next to its other local and remote editions.
  const editableFolders = useMemo(
    () =>
      (localDirectoryWork?.localFolders ?? []).filter(
        (folder) =>
          folder.workId === localDirectoryWork?.id && folder.state === "active" && folder.rootPath.trim() !== "",
      ),
    [localDirectoryWork],
  );
  const canEditFolders = !auth.demoMode && auth.hasPermission("downloads:manage");
  const fetchEditFolder =
    canEditFolders && auth.hasPermission("remote:fetch")
      ? (editableFolders.find((folder) => folder.primary) ?? editableFolders[0] ?? null)
      : null;
  const editedFolder = folderEdit
    ? (editableFolders.find((folder) => folder.id === folderEdit.folderId) ?? null)
    : null;
  const openFetchWorkspace = () => {
    if (!fetchRemote) return;
    if (fetchEditFolder) {
      setFolderEdit({
        folderId: fetchEditFolder.id,
        initialRemote: { sourceId: fetchRemote.source.id, remoteCode: fetchRemoteCode },
        fromManage: false,
      });
      return;
    }
    void fetchWorkspace.open({
      sourceId: fetchRemote.source.id,
      remoteCode: fetchRemoteCode,
      canonicalCode: work?.primaryCode ?? code,
      sourceDisplayName: fetchRemote.source.displayName,
      detail: fetchRemote.detail,
    });
  };
  const mediaCleanup = useMediaCleanupWorkflow({
    onAccepted: () => setIsManageOpen(false),
    onCompleted: async ({ workForgotten, partial }: MediaCleanupCompletion) => {
      // Leave first: refreshing the library drops the forgotten work, and the
      // detail would otherwise reload into its not-found state.
      if (workForgotten && !partial) {
        onBack();
        await onWorksChanged();
        return;
      }
      // Reload the detail and its media cache before the library refresh can
      // reopen the work from media cached before the deletion.
      if (activeEdition) {
        editions.replaceActiveEdition(await api.getWork(activeEdition.id));
      } else if (work) {
        await onWorkReload(work.id, true);
      }
      await onWorksChanged();
    },
  });
  const folderEditWorkflow = useFolderEditWorkflow({
    onCompleted: async () => {
      const edited = localDirectoryWork ?? work;
      if (edited) invalidateCachedWorkMedia(edited.id, principalID);
      if (activeEdition) {
        editions.replaceActiveEdition(await api.getWork(activeEdition.id));
      } else if (work) {
        await onWorkReload(work.id, true);
      }
      await onWorksChanged();
    },
  });
  const workHasNoLinkedSource = Boolean(work && workHasNoSource(work));
  const showNoSourceDirectory = workHasNoLinkedSource && !selectedRemoteSource && !selectedTrackedPresence;
  const directoryDescription = persistedDirectoryDescription({
    selectedTrackedPresence,
    selectedTrackedForked,
    selectedSource,
    selectedRemoteSource,
    workHasNoLinkedSource,
  });
  // A smart list's rule match is in the list without being a favorite; a work
  // added to a smart list by hand is both, which the work's own flag reports.
  const favoriteSelected =
    favoriteLists.some((list) => list.kind === "user" && list.selected) ||
    (Boolean(work?.favorite) && favoriteLists.some((list) => list.kind === "smart" && list.selected));
  const isDetailLoading = !work;
  const actionMode = persistedDetailActionMode(
    selectedRemoteSource,
    selectedTrackedPresence,
    selectedTrackedForked,
    selectedSource,
  );
  const {
    sourceDetailsLoading: selectedSourceDetailsLoading,
    mediaLoadError: directoryMediaError,
    showSkeleton: showDirectorySkeleton,
  } = persistedDirectoryLoadState({
    work,
    selectedRemoteSource,
    selectedRemoteDetail,
    selectedRemoteTreeError,
    selectedRemoteTreeLoading,
    mediaError: mediaError || editionError,
    isDirectoryLoading,
  });

  const saveWorkUserTags = async (tags: string[]) => {
    if (!work) return;
    try {
      await api.setWorkUserTags(work.id, tags);
      await Promise.all([onWorkReload(work.id), onWorksChanged()]);
    } catch (error) {
      toast.notify(toastFromError(error, t("libraryDetail.myTagsUpdateFailed")));
      throw error;
    }
  };

  useEffect(() => {
    if (!work?.id) return;
    let cancelled = false;
    api
      .getWorkFavoriteLists(work.id)
      .then((lists) => {
        if (!cancelled) setFavoriteLists(lists);
      })
      .catch(() => {
        if (!cancelled) setFavoriteLists([]);
      });
    return () => {
      cancelled = true;
    };
  }, [work?.id, work?.favorite]);

  useEffect(() => {
    let cancelled = false;
    api
      .getRuntimeSettings()
      .then((settings) => {
        if (!cancelled) setDirectoryRoutingRules(settings.directoryRoutingRules ?? defaultDirectoryRoutingRules);
      })
      .catch(() => {
        if (!cancelled) setDirectoryRoutingRules(defaultDirectoryRoutingRules);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const playTracks = (tracks: TreeTrack[], locationId: number) => {
    if (!localDirectoryWork || tracks.length === 0) return;
    onPlay();
    player.playQueue(
      tracks.map((track) => ({
        ...toPlayerTrack(track, localDirectoryWork, playbackCoverUrl),
        ...(playbackDisplayTitle ? { workTitle: playbackDisplayTitle } : {}),
      })),
      locationId,
    );
  };

  const resumePlayback = async () => {
    if (!work || !playbackCursor || !hasResumableCursor) return;
    setIsResuming(true);
    try {
      const { resumeWork, resumeTree } = await resolvePersistedResumeContext(
        playbackCursor,
        localDirectoryWork,
        playbackTree,
      );
      const resumeQueue = buildWorkResumeQueue(flattenTracks(resumeTree), resumeWork, playbackCursor, playbackCoverUrl);
      if (!resumeQueue) throw new Error(t("libraryDetail.savedTrackUnavailable"));
      if (resumeWork.id !== localDirectoryWork?.id) editions.showEdition(resumeWork);
      onPlay();
      player.playQueue(
        resumeQueue.tracks.map((track) => ({
          ...track,
          ...(playbackDisplayTitle ? { workTitle: playbackDisplayTitle } : {}),
        })),
        resumeQueue.locationId,
        resumeQueue.positionSeconds,
      );
    } catch (error) {
      toast.notify(toastFromError(error, t("libraryDetail.savedPlaybackResumeFailed")));
    } finally {
      setIsResuming(false);
    }
  };

  const playRemoteTracks = (tracks: TreeTrack[], locationId: number) => {
    if (!selectedRemoteDetail || tracks.length === 0) return;
    player.playQueue(
      tracks.map((track) => ({
        ...toRemotePreviewPlayerTrack(track, selectedRemoteDetail, flattenTreeFiles(tree)),
        ...(playbackDisplayTitle ? { workTitle: playbackDisplayTitle } : {}),
      })),
      locationId,
    );
  };

  const queueTrack = (track: TreeTrack, next: boolean) => {
    const queuedTrack = selectedRemoteDetail
      ? {
          ...toRemotePreviewPlayerTrack(track, selectedRemoteDetail, flattenTreeFiles(tree)),
          ...(playbackDisplayTitle ? { workTitle: playbackDisplayTitle } : {}),
        }
      : localDirectoryWork
        ? {
            ...toPlayerTrack(track, localDirectoryWork, playbackCoverUrl),
            ...(playbackDisplayTitle ? { workTitle: playbackDisplayTitle } : {}),
          }
        : null;
    if (!queuedTrack) return;
    if (next) player.playNext(queuedTrack);
    else player.appendQueue([queuedTrack]);
    toast.info(
      next
        ? t("libraryDetail.playingNext", { title: track.title })
        : t("libraryDetail.addedToQueue", { title: track.title }),
    );
  };

  const refreshLocalFiles = async () => {
    const target = localDirectoryWork ?? work;
    if (!target || selectedSource?.kind !== "local") return;
    setIsRefreshingLocalFiles(true);
    try {
      const result = await api.refreshWorkLocalFiles(target.id, selectedSource.fileSourceId);
      invalidateCachedWorkMedia(target.id, principalID);
      if (result.workId !== target.id) invalidateCachedWorkMedia(result.workId, principalID);
      const refreshed = await api.getWork(result.workId);
      if (activeEdition || result.workId !== work?.id) {
        setCachedWorkMedia(refreshed.id, principalID, refreshed.mediaItems);
        editions.showEdition(refreshed);
      } else {
        await onWorkReload(result.workId, true);
      }
      await onWorksChanged();
      toast.success(t("libraryDetail.localFilesRefreshed", { count: result.indexedFiles }));
    } catch (error) {
      toast.notify(toastFromError(error, t("libraryDetail.localFilesRefreshFailed")));
    } finally {
      setIsRefreshingLocalFiles(false);
    }
  };

  const lyricsAssignmentsSaved = async () => {
    const target = localDirectoryWork ?? work;
    if (!target) return;
    invalidateCachedWorkMedia(target.id, principalID);
    if (activeEdition) {
      const refreshed = await api.getWork(target.id);
      setCachedWorkMedia(refreshed.id, principalID, refreshed.mediaItems);
      editions.replaceActiveEdition(refreshed);
    } else {
      await onWorkReload(target.id, true);
    }
  };

  const markDetailWork = async (status: ListeningStatus) => {
    if (!work) return;
    await onStatusChange(work.id, status);
  };

  const ensureDetailListWork = async () => {
    if (!work) return null;
    return work.id;
  };

  const favoriteSaved = async (_favorite: boolean, savedWorkID: number) => {
    if (work && savedWorkID === work.id) {
      const lists = await api.getWorkFavoriteLists(work.id);
      setFavoriteLists(lists);
    }
    await onWorksChanged();
  };

  const metadataSaved = async () => {
    if (!work) return;
    await onWorkReload(work.id);
    await onWorksChanged();
  };

  const metadataLinkChanged = async (result: { sync?: WorkMetadataSyncRunResult }) => {
    // A new link queues a refresh from the linked code; the run watcher reloads
    // the detail again when that refresh finishes.
    if (result.sync && result.sync.runId > 0 && result.sync.status !== "unavailable") {
      metadataSync.watchRun(result.sync.runId);
    }
    await metadataSaved();
  };

  const selectDisplayedEdition = async (translation: WorkDetail["translations"][number]) => {
    playbackRouting.disable();
    if (!selectedRemoteDetail) {
      await editions.selectEdition(translation);
      return;
    }
    const availableFromSelectedRemote = (selectedRemoteDetail.languageEditions ?? []).some(
      (edition) => edition.remoteCode.toUpperCase() === translation.primaryCode.toUpperCase(),
    );
    if (!availableFromSelectedRemote) {
      await editions.selectEdition(translation);
      return;
    }
    editions.setActiveEditionCode(translation.primaryCode);
    const selected = await selectRemoteEdition(translation.primaryCode);
    if (!selected) {
      editions.setActiveEditionCode(selectedRemoteDetail.remoteCode);
      toast.error(t("libraryDetail.editionUnavailableFromSource", { code: translation.primaryCode }));
    }
  };

  const changeSourceKey = (key: string) => {
    playbackRouting.disable();
    selectSource(key);
    const nextSource = sourceTabs.find((source) => source.key === key);
    if (nextSource?.kind !== "local") editions.resetToWorkEdition();
  };

  const changeTrackedPresence = (key: string) => {
    const option = trackedPresenceOptions.find((candidate) => candidate.key === key);
    if (!option) return;
    playbackRouting.disable();
    selectTrackedPresence(key);
    editions.resetToWorkEdition();
    const search = new URLSearchParams(window.location.search);
    search.set("view", "tracked");
    if (option.presence.fileSourceId) search.set("trackedSource", String(option.presence.fileSourceId));
    else search.delete("trackedSource");
    window.history.replaceState(window.history.state ?? {}, "", `${window.location.pathname}?${search.toString()}`);
  };

  const retryDirectory = () => {
    if (selectedRemoteSource) {
      if (tracking.canCheckSources) void refreshAvailability().catch(() => undefined);
      selectSource(remoteSourceTabKey(selectedRemoteSource.source.id));
    } else if (work && !editions.retryFailedEdition()) {
      void onWorkReload(work.id, true);
    }
  };

  if (!work && !workPreview) {
    return (
      <div className="space-y-4">
        <PageHeaderBackAction label={t("common.back")} onBack={onBack} />
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            {t("libraryDetail.remoteDirectoryLoading", { code })}
          </CardContent>
        </Card>
      </div>
    );
  }

  const hero = detailHeroModel(code, work, workPreview);

  const personalTags = persistedPersonalTags(work, saveWorkUserTags);
  const fetchSelectionModal = <LazyRemoteFetchWorkspaceDialog workspace={fetchWorkspace} />;
  const activeSourceLabel = persistedActiveSourceLabel(selectedTrackedPresence, selectedSource);
  const sourceInfo = persistedSourceInfo({
    label: activeSourceLabel,
    selectedSource,
    directoryStats,
    isDirectoryLoading,
    selectedSourceDetailsLoading,
    selectedRemoteDetail,
    fallbackDurationSeconds: hero.durationSeconds,
  });
  const detailActionProps: PersistedDetailActionsProps = {
    work,
    favoriteLists,
    favoriteSelected,
    playbackCursorLoading,
    hasResumableCursor,
    isSyncingDetail,
    fetchBusy: fetchWorkspace.isBusy,
    isRefreshingLocalFiles,
    cleanupBusy: mediaCleanup.isBusy,
    isResuming,
    actionMode,
    sourceContextKey: `${resolvedActiveSourceKey}:${selectedTrackedPresenceKey}`,
    selectedRemoteSource,
    canTrackRemote: tracking.canTrackRemote,
    selectedSourceDetailsLoading,
    selectedRemoteHasTracked: tracking.selectedRemoteHasTracked,
    hasTrackedSourceForAction: tracking.hasTrackedSource,
    forkSources: availableForkSources(remoteSources),
    currentForkSource: tracking.currentForkSource,
    fetchRemote,
    selectedRemoteDetail,
    activeSourceLabel,
    sourceStatus: sourceInfo.statusLabel,
    selectedTrackedPresence,
    trackedCacheAvailable,
    selectedSource,
    onEnsureListWork: ensureDetailListWork,
    onListSaved: favoriteSaved,
    onResume: () => void resumePlayback(),
    onMark: (status) => void markDetailWork(status),
    onEditMetadata: () => setMetadataEditorSection("title"),
    onTrack: () => void tracking.track(),
    onUntrack: () => void tracking.untrack(),
    canUntrack: tracking.requireTrack,
    onFork: tracking.requestFork,
    onFetch: openFetchWorkspace,
    onManage: () => setIsManageOpen(true),
    onManageLyrics: localDirectoryWork?.mediaItems.some((item) => item.kind === "audio")
      ? () => setLyricsManagerRequest({ tab: "assign" })
      : undefined,
    onRefreshLocalFiles: () => void refreshLocalFiles(),
  };
  // The lyrics manager handles lyrics files only for a manager of the listed local folder.
  const canManageLyricsFiles = canEditFolders && selectedSource?.kind === "local" && !selectedTrackedPresence;
  const heroActions = <PersistedIdentityActions {...detailActionProps} />;
  const renderSourceActions = (layout: SourceActionLayout) => (
    <PersistedMediaActions {...detailActionProps} layout={layout} />
  );
  const directoryPanel = (
    <PersistedDirectoryPanel
      activeEdition={activeEdition}
      description={directoryDescription}
      tabs={sourceTabs}
      activeKey={resolvedActiveSourceKey}
      trackedPresenceOptions={trackedPresenceOptions}
      selectedTrackedPresenceKey={selectedTrackedPresenceKey}
      checkingSources={isCheckingSources}
      checkedAt={sourceCheckedAt}
      root={tree}
      directoryStats={directoryStats}
      directoryRoutingRules={directoryRoutingRules}
      currentLocationId={player.currentLocationId}
      currentPlaybackKey={player.currentPlaybackKey}
      autoRoutePath={autoRoutePath}
      routeStateKey={playbackRouting.routeStateKey}
      showNoSourceDirectory={showNoSourceDirectory}
      selectedRemoteSource={selectedRemoteSource}
      selectedSource={selectedSource}
      selectedTrackedForked={selectedTrackedForked}
      selectedTrackedPresence={selectedTrackedPresence}
      remoteSources={remoteSources}
      showDirectorySkeleton={showDirectorySkeleton}
      directoryMediaError={directoryMediaError}
      cleanupRunId={mediaCleanup.activeRunId}
      cleanupRunStatus={mediaCleanup.runStatus}
      localCopies={
        canManageLocalCopies && (localFolders.length > 1 || otherLocalEditionCount > 0)
          ? {
              folderCount: localFolders.length,
              editionCount: otherLocalEditionCount,
              onManageFiles: () => setIsManageOpen(true),
              onManageLyrics: detailActionProps.onManageLyrics,
            }
          : null
      }
      selectedRemoteDetail={selectedRemoteDetail}
      selectionModal={fetchSelectionModal}
      onActiveKeyChange={changeSourceKey}
      onTrackedPresenceChange={changeTrackedPresence}
      onCheckSources={() => void tracking.checkSources()}
      onRetry={retryDirectory}
      onSelectRemote={(remote) => changeSourceKey(remoteSourceTabKey(remote.source.id))}
      onOpenCleanupRun={() => {
        if (mediaCleanup.activeRunId) openActivityRun(mediaCleanup.activeRunId);
      }}
      onPlayLocal={playTracks}
      onPlayRemote={playRemoteTracks}
      onQueue={queueTrack}
      onPreview={setPreview}
    />
  );
  const displayTranslations = persistedDisplayTranslations(localDirectoryWork, selectedRemoteDetail);
  const presentation = persistedWorkDetailPresentation({
    hero,
    work,
    activeMetadataVariant,
    sourceInfo,
    displayTranslations,
    activeEditionCode: editionLoadingCode || activeEditionCode,
    selectedRemoteDetail,
    personalTags,
    loading: isDetailLoading,
    metadataSync: work?.metadataSync,
    canSyncMetadata,
    metadataSyncBusy,
    onSyncMetadata: () => void metadataSync.sync(),
    onLinkMetadata: () => setMetadataEditorSection("source"),
    onMetadataVariantSelect: setSelectedMetadataVariantKey,
    onVersionSelect: (translation) => void selectDisplayedEdition(translation),
  });

  return (
    <UnifiedWorkDetailPage
      presentation={presentation}
      compact={isCompactDetailLayout}
      mobileTab={mobileDetailTab}
      onMobileTabChange={setMobileDetailTab}
      actions={heroActions}
      renderSourceActions={renderSourceActions}
      directory={directoryPanel}
      onBack={onBack}
    >
      <PersistedFilePreviewOverlay
        preview={preview}
        work={work}
        toast={toast}
        onClose={() => setPreview(null)}
        onMetadataSaved={metadataSaved}
      />
      <PersistedDirectoryManagerOverlay
        open={isManageOpen}
        root={managementTree}
        selectedTrackedPresence={selectedTrackedPresence}
        showNoSourceDirectory={showNoSourceDirectory}
        selectedRemoteSource={selectedRemoteSource}
        deleting={mediaCleanup.isSubmitting}
        onDeleteTargets={mediaCleanup.submit}
        workID={localDirectoryWork?.id ?? work?.id ?? 0}
        // Forgetting a work removes it entirely, which one of several folders must not do.
        canForgetWork={canForgetWork && localFolders.length <= 1}
        localRoot={localRoot}
        localFolders={localFolders.length > 1 ? localFolders : []}
        onSelectLocalFolder={setManageFolderID}
        onEditFiles={
          canEditFolders && manageFolder && selectedSource?.kind === "local" && !selectedTrackedPresence
            ? () => {
                setIsManageOpen(false);
                setFolderEdit({ folderId: manageFolder.id, initialRemote: null, fromManage: true });
              }
            : undefined
        }
        onManageAsLyrics={
          canManageLyricsFiles
            ? (files) => {
                setIsManageOpen(false);
                setLyricsManagerRequest({
                  tab: "files",
                  folderId: files[0]?.folderId,
                  paths: files.map((file) => file.path),
                });
              }
            : undefined
        }
        onManageLyrics={
          canManageLyricsFiles
            ? () => {
                setIsManageOpen(false);
                setLyricsManagerRequest({ tab: "files", folderId: manageFolder?.id });
              }
            : undefined
        }
        onClose={() => setIsManageOpen(false)}
      />
      <PersistedFolderEditOverlay
        work={localDirectoryWork}
        folder={editedFolder}
        initialRemote={folderEdit?.initialRemote ?? null}
        onBack={
          folderEdit?.fromManage
            ? () => {
                setFolderEdit(null);
                setIsManageOpen(true);
              }
            : undefined
        }
        onClose={() => setFolderEdit(null)}
        onApplied={(result) => {
          setFolderEdit(null);
          folderEditWorkflow.accepted(result);
        }}
      />
      <PersistedLyricsManagerOverlay
        request={lyricsManagerRequest}
        work={localDirectoryWork}
        onClose={() => setLyricsManagerRequest(null)}
        onSaved={lyricsAssignmentsSaved}
      />
      <PersistedMetadataEditorOverlay
        section={metadataEditorSection}
        work={work}
        sources={sources}
        selectedMetadataVariantKey={selectedMetadataVariantKey}
        canSyncMetadata={canSyncMetadata}
        refreshActions={
          canSyncMetadata || auth.demoMode ? (
            <WorkMetadataRefreshControl
              sources={sources}
              busy={metadataSyncBusy}
              disabled={auth.demoMode}
              onRefresh={(sourceId) => void metadataSync.sync(sourceId)}
            />
          ) : undefined
        }
        onClose={() => setMetadataEditorSection(null)}
        onSaved={() => void metadataSaved()}
        onLinkChanged={(result) => void metadataLinkChanged(result)}
      />
      <PersistedReforkOverlay
        target={tracking.reforkTarget}
        busy={isSyncingDetail}
        onClose={tracking.cancelRefork}
        onConfirm={tracking.confirmRefork}
      />
    </UnifiedWorkDetailPage>
  );
}
