import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { NotFoundPage } from "@/app/NotFoundPage";
import { announceRemoteTrackCreated } from "@/app/remoteTrackWorkflows";
import { REMOTE_TRACK_PERMISSIONS, usePermissionGate } from "@/auth/usePermissionGate";
import { toastFromError, useToast } from "@/components/ui/toast";
import { DirectoryManagerDialog } from "@/features/work-detail/dialogs/DirectoryManagerDialog";
import { FilePreviewDialog, type FilePreviewRequest } from "@/features/work-detail/dialogs/FilePreviewDialog";
import { useDirectoryRoutingRules } from "@/features/work-detail/directory/useDirectoryRoutingRules";
import {
  buildRemoteTree,
  buildTree,
  emptyTree,
  flattenTreeFiles,
  toPlayerTrack,
  toRemotePreviewPlayerTrack,
  type TreeNode,
  treeStats,
  type TreeTrack,
} from "@/features/work-detail/media/mediaTreeModel";
import { playbackTrackMatchesRemoteWork } from "@/features/work-detail/media/playbackDirectoryRouting";
import { queuePlayerTrack } from "@/features/work-detail/media/queuePlayerTrack";
import { usePlaybackAutoRouting, usePlaybackRoutePath } from "@/features/work-detail/media/usePlaybackAutoRouting";
import {
  type RemoteOnlyDetailActionsProps,
  RemoteOnlyIdentityActions,
  RemoteOnlySourceActions,
} from "@/features/work-detail/RemoteOnlyDetailActions";
import { RemoteOnlyDirectoryPanel } from "@/features/work-detail/RemoteOnlyDirectoryPanel";
import {
  remoteOnlyActiveSourceState,
  remoteOnlyDisplayState,
  remoteOnlyMaterializedState,
  remoteOnlySourceInfo,
  remoteOnlyWorkDetailPresentation,
} from "@/features/work-detail/remoteOnlyWorkDetailModel";
import {
  buildSourceTabs,
  remoteSourceTabKey,
  type SourceTabInfo,
} from "@/features/work-detail/source/sourceContextModel";
import { useRemoteOnlyWorkDetailData } from "@/features/work-detail/useRemoteOnlyWorkDetailData";
import type { SourceActionLayout } from "@/features/work-detail/WorkDetailActionBars";
import {
  listeningStatusLabel,
  remoteDetailActionCode,
  trackedPresenceForRemoteSource,
} from "@/features/work-detail/workDetailHelpers";
import { UnifiedWorkDetailPage, useCompactDetailLayout } from "@/features/work-detail/WorkDetailLayout";
import type { RemoteWorkPreview } from "@/features/work-detail/workDetailShared";
import { LazyRemoteFetchWorkspaceDialog } from "@/features/work-detail/workflows/LazyRemoteFetchWorkspaceDialog";
import { useRemoteFetchWorkspace } from "@/features/work-detail/workflows/useRemoteFetchWorkspace";
import i18n from "@/i18n";
import { api, type LibrarySource, type ListeningStatus, type RemoteWorkDetail } from "@/lib/api";
import { useLibraryPlayer } from "@/player/PlayerProvider";

function RemoteOnlyDetailOverlays({
  manageOpen,
  tree,
  filePreview,
  onManageClose,
  onPreviewClose,
}: {
  manageOpen: boolean;
  tree: TreeNode;
  filePreview: FilePreviewRequest | null;
  onManageClose: () => void;
  onPreviewClose: () => void;
}) {
  return (
    <>
      {manageOpen && (
        <DirectoryManagerDialog
          root={tree}
          emptyLabel={i18n.t("libraryDetail.noRemoteFiles")}
          onClose={onManageClose}
        />
      )}
      {filePreview && <FilePreviewDialog request={filePreview} onClose={onPreviewClose} />}
    </>
  );
}

export function RemoteOnlyWorkDetailController({
  source,
  sources,
  code,
  preview,
  onBack,
  onWorksChanged,
}: {
  source: LibrarySource;
  sources: LibrarySource[];
  code: string;
  preview: RemoteWorkPreview | null;
  onBack: () => void;
  onWorksChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const requireTrack = usePermissionGate(REMOTE_TRACK_PERMISSIONS, { deferDemo: true });
  const { t } = useTranslation();
  const fetchWorkspace = useRemoteFetchWorkspace({ onWorksChanged });
  const {
    detail,
    setDetail,
    identityDetail,
    selectedMetadataVariantKey,
    setSelectedMetadataVariantKey,
    trackedWork,
    setTrackedWork,
    notFound,
    message,
    setMessage,
    treeLoading,
    setTreeLoading,
    treeError,
    setTreeError,
    remoteAvailability,
    applyAvailability,
    availabilityLoading,
    retry: retryRemote,
  } = useRemoteOnlyWorkDetailData({ source, sources, code, preview, onWorksChanged, onReset: fetchWorkspace.close });
  const [filePreview, setFilePreview] = useState<FilePreviewRequest | null>(null);
  const [activeRemoteTab, setActiveRemoteTab] = useState<string>(remoteSourceTabKey(source.id));
  const [isFetching, setIsFetching] = useState(false);
  const [isManageOpen, setIsManageOpen] = useState(false);
  const [mobileDetailTab, setMobileDetailTab] = useState<"info" | "directory">("directory");
  const isCompactDetailLayout = useCompactDetailLayout();
  const directoryRoutingRules = useDirectoryRoutingRules();
  const { remoteIdentity, activeMetadataVariant, displaySourceName, displayPrimaryCode, displayRemoteCode } =
    remoteOnlyDisplayState(identityDetail, detail, preview, source, code, selectedMetadataVariantKey);
  const isDetailLoading = !detail;
  const tree = useMemo(
    () =>
      detail
        ? buildRemoteTree(detail.tracks, { sourceId: detail.sourceId, workCode: remoteDetailActionCode(detail) })
        : emptyTree(),
    [detail],
  );
  const directoryStats = useMemo(() => treeStats(tree), [tree]);
  const remoteFiles = useMemo(() => flattenTreeFiles(tree), [tree]);
  const remoteTabs = useMemo<SourceTabInfo[]>(
    () =>
      buildSourceTabs(
        trackedWork?.mediaItems ?? [],
        remoteAvailability.map((item) =>
          item.source.id === source.id
            ? {
                ...item,
                detail: detail ?? undefined,
                error: message,
                treeError,
                treeLoading,
                summary: {
                  ...item.summary,
                  status: detail && !treeError ? "available" : message || treeError ? "error" : item.summary.status,
                  primaryCode: detail?.primaryCode || item.summary.primaryCode,
                  title: detail?.title || item.summary.title,
                  coverUrl: detail?.coverUrl || item.summary.coverUrl,
                },
              }
            : item,
        ),
        trackedWork?.sourcePresence ?? [],
        undefined,
      ),
    [detail, message, remoteAvailability, source.id, trackedWork, treeError, treeLoading],
  );
  const player = useLibraryPlayer();
  const {
    primaryRemoteSelected,
    activeTab: activeRemoteTabInfo,
    activeTrackedPresence,
    activeTrackedForked,
    activeRemoteAvailability,
    primaryRemoteAvailability,
  } = remoteOnlyActiveSourceState(source.id, activeRemoteTab, remoteTabs, remoteAvailability);
  const materializedTree = useMemo(() => {
    if (!trackedWork) return emptyTree();
    if (activeRemoteTabInfo?.kind === "tracked" && activeTrackedForked) {
      return buildTree(trackedWork.mediaItems, activeTrackedPresence?.fileSourceId ?? null, trackedWork.primaryCode);
    }
    if (
      activeRemoteTabInfo?.kind === "local" &&
      activeRemoteTabInfo.status === "available" &&
      activeRemoteTabInfo.fileSourceId
    ) {
      return buildTree(trackedWork.mediaItems, activeRemoteTabInfo.fileSourceId, trackedWork.primaryCode);
    }
    return emptyTree();
  }, [activeRemoteTabInfo, activeTrackedForked, activeTrackedPresence?.fileSourceId, trackedWork]);
  const { hasTrackedSource, materializedWorkID, visibleTree, visibleDirectoryStats } = remoteOnlyMaterializedState({
    trackedWork,
    sourceID: source.id,
    displayRemoteCode,
    primaryRemoteAvailability,
    detail,
    primaryRemoteSelected,
    remoteTree: tree,
    materializedTree,
    remoteStats: directoryStats,
  });
  const playbackMatchesWork = playbackTrackMatchesRemoteWork(player.currentTrack, detail, code, source.id);
  const playbackRouting = usePlaybackAutoRouting({
    routeKey: `remote:${source.id}:${code}`,
    currentTrack: player.currentTrack,
    isPlaying: player.isPlaying,
    matchesWork: playbackMatchesWork,
  });
  const autoRoutePath = usePlaybackRoutePath(playbackRouting, visibleTree);

  const fetchWork = async (reason: string) => {
    if (!detail?.primaryCode || !requireTrack()) return;
    setIsFetching(true);
    setMessage("");
    try {
      const requestedCode = remoteDetailActionCode(detail);
      const result = await api.trackRemoteSourceWork(source.id, requestedCode, reason);
      announceRemoteTrackCreated(source.id, requestedCode, result);
      toast.notify({
        kind: "info",
        message: result.deduplicated
          ? t("libraryDetail.trackAlreadyQueued", { runId: result.runId })
          : t("libraryDetail.trackQueued", { runId: result.runId }),
      });
    } catch (error) {
      toast.notify(toastFromError(error, t("libraryDetail.trackQueueFailed")));
    } finally {
      setIsFetching(false);
    }
  };

  /** A mark or list adds a work that is not yet in the Library, which is tracking. */
  const syncForUserState = async (reason: string) => {
    if (!detail?.primaryCode || !requireTrack()) return null;
    setIsFetching(true);
    setMessage("");
    try {
      const result = await api.syncRemoteSourceWork(source.id, remoteDetailActionCode(detail), reason);
      await onWorksChanged();
      setDetail((current) => (current ? { ...current, workId: result.workId, importStatus: "synced" } : current));
      return result.workId;
    } catch (error) {
      toast.notify(toastFromError(error, t("errors.unavailable")));
      return null;
    } finally {
      setIsFetching(false);
    }
  };

  const updateRemoteMark = async (status: ListeningStatus) => {
    if (!detail?.primaryCode) return;
    const workID = detail.workId ?? (await syncForUserState("detail_mark_interest"));
    if (!workID) return;
    try {
      const result = await api.updateWorkUserState(workID, { listeningStatus: status });
      toast.success(
        t("library.markedAs", {
          code: detail.primaryCode,
          status: listeningStatusLabel(result.listeningStatus, t),
        }),
      );
      await onWorksChanged();
    } catch (error) {
      toast.notify(toastFromError(error, t("errors.unavailable")));
    }
  };

  const openSaveWorkspace = () => {
    if (!detail) return;
    void fetchWorkspace.open({
      sourceId: source.id,
      remoteCode: remoteDetailActionCode(detail),
      canonicalCode: detail.primaryCode,
      sourceDisplayName: source.displayName,
      detail,
    });
  };

  const untrackRemoteSource = async () => {
    if (!materializedWorkID || !detail || !requireTrack()) return;
    setIsFetching(true);
    setMessage("");
    try {
      const currentWork = trackedWork ?? (await api.getWork(materializedWorkID));
      const presence = trackedPresenceForRemoteSource(currentWork, source.id, remoteDetailActionCode(detail));
      if (!presence?.fileSourceId) throw new Error("Tracked source could not be resolved.");
      const ownerWorkID = presence.workId || currentWork.id;
      const sourceName = presence.fileSourceName || presence.fileSourceCode || detail.sourceName;
      await api.untrackWorkSource(ownerWorkID, presence.fileSourceId);
      const [nextWork, availability] = await Promise.all([
        api.getWork(currentWork.id),
        api.getSourceAvailability(detail.primaryCode || code),
        onWorksChanged(),
      ]);
      setTrackedWork(nextWork);
      applyAvailability(availability);
      toast.success(t("libraryDetail.untrackedFromSource", { code: detail.primaryCode, source: sourceName }));
    } catch (error) {
      toast.notify(toastFromError(error, t("errors.unavailable")));
    } finally {
      setIsFetching(false);
    }
  };

  const playRemoteTracks = (tracks: TreeTrack[], locationId: number) => {
    if (!detail || tracks.length === 0) return;
    player.playQueue(
      tracks.map((track) => toRemotePreviewPlayerTrack(track, detail, remoteFiles)),
      locationId,
    );
  };

  const queueRemoteTrack = (track: TreeTrack, next: boolean) => {
    if (!detail) return;
    queuePlayerTrack(player, toast, toRemotePreviewPlayerTrack(track, detail, remoteFiles), track.title, next);
  };

  const playMaterializedTracks = (tracks: TreeTrack[], locationId: number) => {
    if (!trackedWork || tracks.length === 0) return;
    player.playQueue(
      tracks.map((track) => toPlayerTrack(track, trackedWork)),
      locationId,
    );
  };

  const queueMaterializedTrack = (track: TreeTrack, next: boolean) => {
    if (!trackedWork) return;
    queuePlayerTrack(player, toast, toPlayerTrack(track, trackedWork), track.title, next);
  };

  if (notFound) {
    return (
      <NotFoundPage
        title={i18n.t("library.remoteSourceUnavailableTitle")}
        message={i18n.t("libraryDetail.remoteWorkUnavailableFrom", { code, source: source.displayName })}
        onBack={onBack}
        onOpenLibrary={() => {
          window.history.pushState({}, "", "/");
          window.dispatchEvent(new Event("kikoto:navigation"));
        }}
      />
    );
  }

  const sourceInfo = remoteOnlySourceInfo(
    displaySourceName,
    remoteTabs,
    activeRemoteTab,
    visibleDirectoryStats,
    primaryRemoteSelected,
    message,
    treeError,
    isDetailLoading,
    treeLoading,
    detail,
  );
  const selectRemoteSourceTab = (key: string) => {
    playbackRouting.disable();
    setActiveRemoteTab(key);
  };
  const detailActionProps: RemoteOnlyDetailActionsProps = {
    detail,
    source,
    busy: isFetching || fetchWorkspace.isBusy,
    primaryRemoteSelected,
    availabilityLoading,
    hasTrackedSource,
    materializedWorkID,
    onEnsureListWork: () => syncForUserState("detail_list_remote"),
    onListSaved: onWorksChanged,
    onMark: (status) => void updateRemoteMark(status),
    canMark: () => Boolean(detail?.workId) || requireTrack(),
    onTrack: () => void fetchWork("manual_track"),
    onUntrack: () => void untrackRemoteSource(),
    canUntrack: requireTrack,
    onFetch: openSaveWorkspace,
  };
  const heroActions = <RemoteOnlyIdentityActions {...detailActionProps} />;
  const renderSourceActions = (layout: SourceActionLayout) => (
    <RemoteOnlySourceActions {...detailActionProps} layout={layout} />
  );
  const directoryPanel = (
    <RemoteOnlyDirectoryPanel
      detail={detail}
      displaySourceName={displaySourceName}
      displayRemoteCode={displayRemoteCode}
      tabs={remoteTabs}
      activeKey={activeRemoteTab}
      activeTab={activeRemoteTabInfo}
      activeTrackedPresence={activeTrackedPresence}
      activeTrackedForked={activeTrackedForked}
      activeRemoteAvailability={activeRemoteAvailability}
      primaryRemoteSelected={primaryRemoteSelected}
      message={message}
      treeError={treeError}
      isDetailLoading={isDetailLoading}
      treeLoading={treeLoading}
      root={visibleTree}
      directoryStats={visibleDirectoryStats}
      directoryRoutingRules={directoryRoutingRules}
      currentLocationId={player.currentLocationId}
      currentPlaybackKey={player.currentPlaybackKey}
      autoRoutePath={autoRoutePath}
      routeStateKey={playbackRouting.routeStateKey}
      remoteAvailability={remoteAvailability}
      hasMaterializedWork={Boolean(trackedWork)}
      selectionModal={<LazyRemoteFetchWorkspaceDialog workspace={fetchWorkspace} />}
      onActiveKeyChange={selectRemoteSourceTab}
      onRetry={retryRemote}
      onSelectRemote={(next) => selectRemoteSourceTab(remoteSourceTabKey(next.source.id))}
      onPlayRemote={playRemoteTracks}
      onPlayMaterialized={playMaterializedTracks}
      onQueueRemote={queueRemoteTrack}
      onQueueMaterialized={queueMaterializedTrack}
      onPreview={setFilePreview}
    />
  );
  const presentation = remoteOnlyWorkDetailPresentation({
    remoteIdentity,
    detail,
    preview,
    code,
    displayPrimaryCode,
    displayRemoteCode,
    activeMetadataVariant,
    sourceInfo,
    loading: isDetailLoading,
    onMetadataVariantSelect: setSelectedMetadataVariantKey,
    onVersionSelect: (editionCode) => void selectRemoteLanguageEdition(editionCode),
  });

  const selectRemoteLanguageEdition = async (editionCode: string) => {
    if (!detail || editionCode.toUpperCase() === remoteDetailActionCode(detail).toUpperCase()) return;
    setIsFetching(true);
    setTreeLoading(true);
    setTreeError("");
    try {
      const metadata = await api.getRemoteSourceWorkMetadata(source.id, editionCode);
      const nextDetail: RemoteWorkDetail = { ...metadata, tracks: [] };
      setDetail(nextDetail);
      fetchWorkspace.close();
      const tracks = await api.getRemoteSourceWorkTracks(source.id, metadata.remoteCode || editionCode);
      setDetail((current) => (current ? { ...current, tracks: tracks.tracks } : current));
    } catch (error) {
      setTreeError(error instanceof Error ? error.message : t("libraryDetail.remoteDirectoryFailed"));
      toast.notify(
        toastFromError(
          error,
          t("libraryDetail.editionUnavailableFromNamedSource", { code: editionCode, source: source.displayName }),
        ),
      );
    } finally {
      setIsFetching(false);
      setTreeLoading(false);
    }
  };

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
      <RemoteOnlyDetailOverlays
        manageOpen={isManageOpen}
        tree={tree}
        filePreview={filePreview}
        onManageClose={() => setIsManageOpen(false)}
        onPreviewClose={() => setFilePreview(null)}
      />
    </UnifiedWorkDetailPage>
  );
}
