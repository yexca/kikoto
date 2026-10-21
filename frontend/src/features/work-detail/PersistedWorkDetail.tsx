import {
  availableForkSources,
  type DetailSourceIntent,
  remoteSourceTabKey,
} from "@/features/work-detail/source/sourceContextModel";
import {
  api,
  type LibrarySource,
  type ListeningStatus,
  type WorkDetail,
  type WorkMetadataSyncRunResult,
} from "@/lib/api";
import type { WorkPreview } from "@/features/work-detail/workDetailShared";
import { useWorkPlaybackCursor } from "@/features/work-detail/media/useWorkPlaybackCursor";
import { buildTree, emptyTree, treeStats } from "@/features/work-detail/media/mediaTreeModel";
import i18n from "@/i18n";
import { openActivityRun, openDetailTagSearch, workHasNoSource } from "@/features/work-detail/workDetailHelpers";
import type { MetadataActionPlacement, SourceActionLayout } from "@/features/work-detail/WorkDetailActionBars";
import {
  detailHeroModel,
  UnifiedWorkDetailPage,
  useCompactDetailLayout,
} from "@/features/work-detail/WorkDetailLayout";
import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useState } from "react";
import type { FilePreviewRequest } from "@/features/work-detail/dialogs/FilePreviewDialog";
import { FileDisplayNamesDialog } from "@/features/work-detail/dialogs/FileDisplayNamesDialog";
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
import { isLocalOffline } from "@/lib/localAvailability";
import { isCustomWorkCode } from "@/lib/workCode";
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
import { invalidateCachedWorkMedia, setCachedWorkMedia } from "@/features/work-detail/media/workMediaCache";
import { PageHeaderBackAction } from "@/app/pageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { FetchComposeDialog } from "@/features/work-detail/folder-edit/FetchComposeDialog";
import type { FetchComposeTarget } from "@/features/work-detail/folder-edit/folderEditModel";
import { LazyRemoteFetchWorkspaceDialog } from "@/features/work-detail/workflows/LazyRemoteFetchWorkspaceDialog";
import { useDirectoryRoutingRules } from "@/features/work-detail/directory/useDirectoryRoutingRules";
import { usePersistedWorkPlayback } from "@/features/work-detail/media/usePersistedWorkPlayback";
import {
  hasResumablePlaybackCursor,
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
  PersistedMetadataAction,
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
import { useWorkFavoriteLists } from "@/features/work-detail/useWorkFavoriteLists";
import { usePersistedFileManagement } from "@/features/work-detail/usePersistedFileManagement";

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
  onRatingChange,
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
  onRatingChange: (workID: number, rating: number | null) => Promise<void>;
  onPlay: () => void;
  onWorkReload: (workID: number, includeMedia?: boolean) => Promise<void>;
  onWorksChanged: () => Promise<void>;
}) {
  const auth = useAuth();
  const toast = useToast();
  const { t } = useTranslation();
  // A custom work has no provider metadata and no remote source has it, so
  // the page offers only its local folders and manual metadata.
  const customWork = work ? Boolean(work.customWork) : isCustomWorkCode(code);
  const detailSources = useMemo(() => (customWork ? [] : sources), [customWork, sources]);
  const sourceContext = useWorkSourceContext({
    code,
    work,
    sources: detailSources,
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
  const [metadataEditorSection, setMetadataEditorSection] = useState<MetadataEditorSection | null>(null);
  const [preview, setPreview] = useState<FilePreviewRequest | null>(null);
  const [isRefreshingLocalFiles, setIsRefreshingLocalFiles] = useState(false);
  const [selectedMetadataVariantKey, setSelectedMetadataVariantKey] = useState("");
  const directoryRoutingRules = useDirectoryRoutingRules();
  const workFavoriteLists = useWorkFavoriteLists(work);
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
  const canEditFolders = !auth.demoMode && auth.hasPermission("downloads:manage");
  // Display names are shared metadata, edited by whoever edits the library's metadata.
  const canEditFileNames = !auth.demoMode && auth.hasPermission("library:write");
  const [fileNamesOpen, setFileNamesOpen] = useState(false);
  const files = usePersistedFileManagement({
    localDirectoryWork,
    selectedSource,
    selectedTrackedPresence,
    selectedTrackedSourceID,
    tree,
    canEditFolders,
    canFetchIntoFolder: canEditFolders && auth.hasPermission("remote:fetch"),
  });
  const { localFolders } = files;
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
  const otherLocalEditionCount = (localDirectoryWork?.translations ?? []).filter(
    (edition) => edition.workId && edition.workId !== localDirectoryWork?.id && edition.localAvailable,
  ).length;
  const canManageLocalCopies =
    !auth.demoMode && auth.hasPermission("downloads:manage") && selectedSource?.kind === "local";
  const fetchWorkspace = useRemoteFetchWorkspace({ onWorksChanged });
  // A manager of local files builds a new folder from several places; the
  // single-edition Fetch stays for everyone else.
  const canComposeFetch = canEditFolders && auth.hasPermission("remote:fetch") && auth.hasPermission("metadata:sync");
  const [composeFetch, setComposeFetch] = useState<FetchComposeTarget | null>(null);
  const openStandardFetch = () => {
    if (!fetchRemote) return;
    void fetchWorkspace.open({
      sourceId: fetchRemote.source.id,
      remoteCode: fetchRemoteCode,
      canonicalCode: work?.primaryCode ?? code,
      sourceDisplayName: fetchRemote.source.displayName,
      detail: fetchRemote.detail,
    });
  };
  const openFetchWorkspace = () => {
    if (!fetchRemote) return;
    if (files.editFolderWithRemote({ sourceId: fetchRemote.source.id, remoteCode: fetchRemoteCode })) return;
    if (canComposeFetch && fetchRemoteCode) {
      setComposeFetch({
        sourceId: fetchRemote.source.id,
        sourceName: fetchRemote.source.displayName,
        remoteCode: fetchRemoteCode,
        editionCode: fetchRemoteCode.toUpperCase(),
      });
      return;
    }
    openStandardFetch();
  };
  /** Reloads the shown edition with its media, then the library. */
  const reloadShownEdition = async () => {
    if (activeEdition) {
      editions.replaceActiveEdition(await api.getWork(activeEdition.id));
    } else if (work) {
      await onWorkReload(work.id, true);
    }
    await onWorksChanged();
  };
  const mediaCleanup = useMediaCleanupWorkflow({
    onAccepted: files.closeManager,
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
      await reloadShownEdition();
    },
  });
  const folderEditWorkflow = useFolderEditWorkflow({
    onCompleted: async () => {
      const edited = localDirectoryWork ?? work;
      if (edited) invalidateCachedWorkMedia(edited.id, principalID);
      await reloadShownEdition();
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

  const playback = usePersistedWorkPlayback({
    work,
    localDirectoryWork,
    selectedRemoteDetail,
    tree,
    playbackTree,
    playbackCursor,
    hasResumableCursor,
    displayTitle: playbackDisplayTitle,
    coverUrl: playbackCoverUrl,
    onPlay,
    onShowEdition: editions.showEdition,
  });

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

  /** Reloads the shown edition's media after a change to how it presents its files. */
  const localMediaSaved = async () => {
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

  const rateDetailWork = async (rating: number | null) => {
    if (!work) return;
    await onRatingChange(work.id, rating);
  };

  const ensureDetailListWork = async () => {
    if (!work) return null;
    return work.id;
  };

  const favoriteSaved = async (_favorite: boolean, savedWorkID: number) => {
    await workFavoriteLists.reloadAfterSave(savedWorkID);
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
  const fetchSelectionModal = (
    <>
      <LazyRemoteFetchWorkspaceDialog workspace={fetchWorkspace} />
      {composeFetch && (
        <FetchComposeDialog
          // A different edition or source is a different Fetch.
          key={`${composeFetch.sourceId}:${composeFetch.remoteCode}`}
          fetch={composeFetch}
          onClose={() => setComposeFetch(null)}
          onApplied={async () => {
            setComposeFetch(null);
            await onWorksChanged();
          }}
          onOpenStandardFetch={() => {
            setComposeFetch(null);
            openStandardFetch();
          }}
        />
      )}
    </>
  );
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
    favoriteLists: workFavoriteLists.favoriteLists,
    favoriteSelected: workFavoriteLists.favoriteSelected,
    playbackCursorLoading,
    hasResumableCursor,
    isSyncingDetail,
    fetchBusy: fetchWorkspace.isBusy,
    isRefreshingLocalFiles,
    cleanupBusy: mediaCleanup.isBusy,
    isResuming: playback.isResuming,
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
    onResume: () => void playback.resumePlayback(),
    onMark: (status) => void markDetailWork(status),
    onRate: (rating) => void rateDetailWork(rating),
    onEditMetadata: () => setMetadataEditorSection("title"),
    onTrack: () => void tracking.track(),
    onUntrack: () => void tracking.untrack(),
    canUntrack: tracking.requireTrack,
    onFork: tracking.requestFork,
    onFetch: openFetchWorkspace,
    onManage: files.openManager,
    onManageLyrics: localDirectoryWork?.mediaItems.some((item) => item.kind === "audio")
      ? () => files.openLyricsManager({ tab: "assign" })
      : undefined,
    onEditFileNames:
      canEditFileNames &&
      localDirectoryWork?.mediaItems.some((item) =>
        item.locations.some((location) => location.locationType === "local" && location.availability === "available"),
      )
        ? () => setFileNamesOpen(true)
        : undefined,
    onRefreshLocalFiles: () => void refreshLocalFiles(),
  };
  const heroActions = <PersistedIdentityActions {...detailActionProps} />;
  const renderSourceActions = (layout: SourceActionLayout) => (
    <PersistedMediaActions {...detailActionProps} layout={layout} />
  );
  const renderMetadataAction = (placement: MetadataActionPlacement) => (
    <PersistedMetadataAction {...detailActionProps} placement={placement} />
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
              offlineFolderCount: localFolders.filter((folder) => isLocalOffline(folder.availability)).length,
              editionCount: otherLocalEditionCount,
              onManageFiles: files.openManager,
              onManageLyrics: detailActionProps.onManageLyrics,
            }
          : null
      }
      selectedRemoteDetail={selectedRemoteDetail}
      selectionModal={fetchSelectionModal}
      onActiveKeyChange={changeSourceKey}
      onTrackedPresenceChange={changeTrackedPresence}
      customWork={customWork}
      onCheckSources={customWork ? undefined : () => void tracking.checkSources()}
      onRetry={retryDirectory}
      onSelectRemote={(remote) => changeSourceKey(remoteSourceTabKey(remote.source.id))}
      onOpenCleanupRun={() => {
        if (mediaCleanup.activeRunId) openActivityRun(mediaCleanup.activeRunId);
      }}
      onPlayLocal={playback.playTracks}
      onPlayRemote={playback.playRemoteTracks}
      onQueue={playback.queueTrack}
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
    metadataSync: customWork ? undefined : work?.metadataSync,
    canSyncMetadata: canSyncMetadata && !customWork,
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
      renderMetadataAction={renderMetadataAction}
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
        open={files.isManageOpen}
        root={files.managementTree}
        selectedTrackedPresence={selectedTrackedPresence}
        showNoSourceDirectory={showNoSourceDirectory}
        selectedRemoteSource={selectedRemoteSource}
        deleting={mediaCleanup.isSubmitting}
        onDeleteTargets={mediaCleanup.submit}
        workID={localDirectoryWork?.id ?? work?.id ?? 0}
        // Forgetting a work removes it entirely, which one of several folders must not do.
        canForgetWork={canForgetWork && localFolders.length <= 1}
        localRoot={files.localRoot}
        localFolders={localFolders.length > 1 ? localFolders : []}
        onSelectLocalFolder={files.selectManageFolder}
        onEditFiles={files.editFiles}
        onManageAsLyrics={files.manageAsLyrics}
        onManageLyrics={files.manageLyrics}
        onClose={files.closeManager}
      />
      <PersistedFolderEditOverlay
        work={localDirectoryWork}
        folder={files.editedFolder}
        initialRemote={files.folderEdit?.initialRemote ?? null}
        onBack={files.backFromFolderEdit}
        onClose={files.closeFolderEdit}
        onApplied={(result) => {
          files.closeFolderEdit();
          folderEditWorkflow.accepted(result);
        }}
      />
      <PersistedLyricsManagerOverlay
        request={files.lyricsManagerRequest}
        work={localDirectoryWork}
        onClose={files.closeLyricsManager}
        onSaved={localMediaSaved}
      />
      {fileNamesOpen && localDirectoryWork && (
        <FileDisplayNamesDialog
          workId={localDirectoryWork.id}
          onClose={() => setFileNamesOpen(false)}
          onSaved={localMediaSaved}
        />
      )}
      <PersistedMetadataEditorOverlay
        section={metadataEditorSection}
        work={work}
        sources={sources}
        selectedMetadataVariantKey={selectedMetadataVariantKey}
        canSyncMetadata={canSyncMetadata}
        refreshActions={
          !customWork && (canSyncMetadata || auth.demoMode) ? (
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
