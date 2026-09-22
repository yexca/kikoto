import {
  availableForkSources,
  type DetailSourceIntent,
  type ReforkTarget,
  remoteAvailabilityRouteCode,
  type RemoteSourceAvailability,
  remoteSourceCanBrowse,
  remoteSourceTabKey,
  type SourceTabInfo,
  type TrackedPresenceOption,
} from "@/features/work-detail/source/sourceContextModel";
import {
  api,
  type DirectoryRoutingRule,
  type FavoriteList,
  type LibrarySource,
  type ListeningStatus,
  type RemoteWorkDetail,
  type SourcePresenceItem,
  type VoiceCredit,
  type WorkDetail,
  type WorkMetadataPresentation,
  type WorkMetadataSyncStatus,
} from "@/lib/api";
import {
  directoryLoadErrorMessage,
  safeExternalHTTPURL,
  sourcePresenceActionCode,
  type WorkPreview,
} from "@/features/work-detail/workDetailShared";
import { useWorkPlaybackCursor } from "@/features/work-detail/media/useWorkPlaybackCursor";
import {
  buildRemoteTree,
  buildTree,
  buildWorkResumeQueue,
  emptyTree,
  flattenTracks,
  flattenTreeFiles,
  formatTreeStats,
  toPlayerTrack,
  toRemotePreviewPlayerTrack,
  type TreeNode,
  treeStats,
  type TreeStats,
  type TreeTrack,
} from "@/features/work-detail/media/mediaTreeModel";
import i18n from "@/i18n";
import {
  type ActiveSourceInfoModel,
  languageLabel,
  openActivityRun,
  remoteDetailActionCode,
  trackedPresenceForRemoteSource,
  workHasNoSource,
} from "@/features/work-detail/workDetailHelpers";
import {
  type DetailActionMode,
  MediaContextActionBar,
  WorkIdentityActionBar,
} from "@/features/work-detail/WorkDetailActionBars";
import {
  detailHeroModel,
  DetailSkeletonActions,
  DirectorySkeleton,
  UnifiedWorkDetailPage,
  type UnifiedWorkDetailPresentation,
  useCompactDetailLayout,
} from "@/features/work-detail/WorkDetailLayout";
import { useTranslation } from "react-i18next";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { FilePreviewDialog, type FilePreviewState } from "@/features/work-detail/dialogs/FilePreviewDialog";
import {
  DirectoryLoadErrorPanel,
  DirectoryMessage,
  type DirectoryMode,
  DirectoryOperationBanner,
  LocalSourceStatePanel,
  NoSourceDirectoryPanel,
  RemoteSourceStatePanel,
  SourceDirectoryPanel,
  TrackedUnforkedPanel,
} from "@/features/work-detail/directory/SourceDirectoryPanels";
import { Tags } from "lucide-react";
import { UserTagRow } from "@/components/UserTagRow";
import { mergeRemoteWorkVersions, workVersionAvailableForScope } from "@/features/work-detail/workVersionModel";
import { resolveMetadataVariant } from "@/features/work-detail/metadataPresentationModel";
import { toastFromError, useToast } from "@/components/ui/toast";
import {
  type MediaCleanupCompletion,
  type MediaCleanupMode,
  type MediaDeleteTarget,
  useMediaCleanupWorkflow,
} from "@/features/work-detail/workflows/useMediaCleanupWorkflow";
import { DirectoryManagerDialog } from "@/features/work-detail/dialogs/DirectoryManagerDialog";
import { WorkMetadataEditorModal } from "@/features/work-detail/metadata";
import { ReforkConfirmDialog } from "@/features/work-detail/dialogs/ReforkConfirmDialog";
import type { ClientPrincipalID } from "@/lib/clientStorageScope";
import { useAuth } from "@/auth/AuthProvider";
import { useWorkSourceContext } from "@/features/work-detail/source/useWorkSourceContext";
import { isActiveWorkflowStatus, useWorkflowRunWatcher } from "@/hooks/useWorkflowRunWatcher";
import { useMediaTree } from "@/features/work-detail/media/useMediaTree";
import { useLibraryPlayer } from "@/player/PlayerProvider";
import {
  captureInitialPlaybackTrack,
  currentPlaybackDirectoryPath,
  type PlaybackRouteSnapshot,
  playbackSourceSelection,
  playbackTrackMatchesPersistedWork,
} from "@/features/work-detail/media/playbackDirectoryRouting";
import { useRemoteFetchWorkspace } from "@/features/work-detail/workflows/useRemoteFetchWorkspace";
import { invalidateCachedWorkMedia, setCachedWorkMedia } from "@/features/work-detail/media/workMediaCache";
import { metadataSyncResultURL } from "@/lib/metadataMaintenance";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import {
  announceRemoteTrackCreated,
  isMatchingRemoteTrack,
  REMOTE_TRACK_TERMINAL_EVENT,
  type RemoteTrackTerminalDetail,
} from "@/app/remoteTrackWorkflows";
import { PageHeaderBackAction } from "@/app/pageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { RemoteFetchWorkspaceDialog } from "@/features/work-detail/workflows/RemoteFetchWorkspaceDialog";
import { defaultDirectoryRoutingRules } from "@/features/work-detail/directory/directoryModel";

function persistedFetchTarget(
  selectedRemoteSource: RemoteSourceAvailability | null | undefined,
  selectedTrackedRemoteSource: RemoteSourceAvailability | null | undefined,
  selectedRemoteWorkCode: string,
  selectedTrackedPresence: SourcePresenceItem | null,
  work: WorkDetail | null,
  code: string,
) {
  const remote = selectedRemoteSource ?? selectedTrackedRemoteSource ?? undefined;
  if (selectedRemoteSource) return { remote, code: selectedRemoteWorkCode };
  if (selectedTrackedPresence) {
    return { remote, code: sourcePresenceActionCode(selectedTrackedPresence, work?.primaryCode ?? code) };
  }
  return { remote, code: work?.primaryCode ?? code };
}

function hasResumablePlaybackCursor(cursor: ReturnType<typeof useWorkPlaybackCursor>["cursor"]) {
  return Boolean(cursor && !cursor.completed && Number.isFinite(cursor.positionSeconds) && cursor.positionSeconds > 0);
}

function persistedMediaTreeInput({
  mediaLoading,
  localDirectoryWork,
  work,
  selectedTrackedForked,
  selectedTrackedSourceID,
  selectedSource,
  selectedRemoteSource,
  selectedRemoteSourceID,
  selectedRemoteDetail,
  selectedTrackedPresence,
}: {
  mediaLoading: boolean;
  localDirectoryWork: WorkDetail | null;
  work: WorkDetail | null;
  selectedTrackedForked: boolean;
  selectedTrackedSourceID: number | null;
  selectedSource: SourceTabInfo | null | undefined;
  selectedRemoteSource: RemoteSourceAvailability | null | undefined;
  selectedRemoteSourceID: number | null;
  selectedRemoteDetail: RemoteWorkDetail | null;
  selectedTrackedPresence: SourcePresenceItem | null;
}) {
  return {
    mediaLoading,
    localItems: localDirectoryWork?.mediaItems ?? [],
    localCode: localDirectoryWork?.primaryCode ?? work?.primaryCode ?? "",
    fileSourceId: selectedTrackedForked ? selectedTrackedSourceID : (selectedSource?.fileSourceId ?? null),
    selectionKey: `${selectedSource?.key ?? ""}:${selectedTrackedSourceID ?? selectedRemoteSourceID ?? 0}`,
    remoteSelected: Boolean(selectedRemoteSource),
    remoteDetail: selectedRemoteDetail,
    trackedUnavailable: Boolean(selectedTrackedPresence && !selectedTrackedForked),
    emptyTree,
    buildLocalTree: buildTree,
    buildRemoteTree,
  };
}

async function resolvePersistedResumeContext(
  cursor: NonNullable<ReturnType<typeof useWorkPlaybackCursor>["cursor"]>,
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

async function resolvePersistedTrackedPresence({
  activePresence,
  selectedRemoteSource,
  selectedRemoteWorkCode,
  work,
}: {
  activePresence: SourcePresenceItem | null;
  selectedRemoteSource: RemoteSourceAvailability | null | undefined;
  selectedRemoteWorkCode: string;
  work: WorkDetail;
}) {
  if (activePresence || !selectedRemoteSource?.summary.hasTracked) return activePresence;
  const currentWork = await api.getWork(work.id);
  return trackedPresenceForRemoteSource(currentWork, selectedRemoteSource.source.id, selectedRemoteWorkCode);
}

function persistedDirectoryDescription({
  selectedTrackedPresence,
  selectedTrackedForked,
  selectedSource,
  selectedRemoteSource,
  workHasNoLinkedSource,
}: {
  selectedTrackedPresence: SourcePresenceItem | null;
  selectedTrackedForked: boolean;
  selectedSource: SourceTabInfo | null | undefined;
  selectedRemoteSource: RemoteSourceAvailability | null | undefined;
  workHasNoLinkedSource: boolean;
}) {
  if (selectedTrackedPresence) {
    if (selectedTrackedForked) {
      const sourceName =
        selectedTrackedPresence.fileSourceName ||
        selectedTrackedPresence.fileSourceCode ||
        i18n.t("libraryDetail.sourceInfo");
      return i18n.t("libraryDetail.browsingTrackedFork", { source: sourceName });
    }
    const sourceName =
      selectedTrackedPresence.fileSourceName ||
      selectedTrackedPresence.fileSourceCode ||
      i18n.t("libraryDetail.sourceInfo");
    return i18n.t("libraryDetail.trackedSourceUnforkedDescription", { source: sourceName });
  }
  if (selectedSource?.kind === "tracked") {
    return i18n.t("libraryDetail.workNotTrackedDescription");
  }
  if (selectedRemoteSource) {
    return i18n.t("libraryDetail.remoteFilesPreviewShort", { source: selectedRemoteSource.source.displayName });
  }
  if (workHasNoLinkedSource) {
    return i18n.t("libraryDetail.noLinkedSourceDescription");
  }
  return i18n.t("libraryDetail.fileLocationsGrouped");
}

function persistedDetailActionMode(
  selectedRemoteSource: RemoteSourceAvailability | null | undefined,
  selectedTrackedPresence: SourcePresenceItem | null,
  selectedTrackedForked: boolean,
  selectedSource: SourceTabInfo | null | undefined,
): DetailActionMode {
  if (selectedRemoteSource) return "remote_source";
  if (selectedTrackedPresence) return selectedTrackedForked ? "tracked_forked" : "tracked_unforked";
  return selectedSource?.kind === "tracked" ? "tracked_unforked" : "local";
}

function persistedTrackingActionState({
  work,
  selectedRemoteSource,
  selectedRemoteWorkCode,
  selectedTrackedPresence,
}: {
  work: WorkDetail | null;
  selectedRemoteSource: RemoteSourceAvailability | null | undefined;
  selectedRemoteWorkCode: string;
  selectedTrackedPresence: SourcePresenceItem | null;
}) {
  const selectedRemoteTrackedPresence = selectedRemoteSource
    ? trackedPresenceForRemoteSource(work, selectedRemoteSource.source.id, selectedRemoteWorkCode)
    : null;
  const activeTrackedPresence = selectedTrackedPresence ?? selectedRemoteTrackedPresence;
  const selectedRemoteHasTracked = Boolean(selectedRemoteTrackedPresence || selectedRemoteSource?.summary.hasTracked);
  return {
    activeTrackedPresence,
    selectedRemoteHasTracked,
    hasTrackedSource: Boolean(activeTrackedPresence || selectedRemoteHasTracked),
    canTrackRemote: Boolean(selectedRemoteSource?.detail?.primaryCode && !selectedRemoteHasTracked),
  };
}

function persistedDirectoryLoadState({
  work,
  selectedRemoteSource,
  selectedRemoteDetail,
  selectedRemoteTreeError,
  selectedRemoteTreeLoading,
  mediaError,
  isDirectoryLoading,
}: {
  work: WorkDetail | null;
  selectedRemoteSource: RemoteSourceAvailability | null | undefined;
  selectedRemoteDetail: RemoteWorkDetail | null;
  selectedRemoteTreeError: string;
  selectedRemoteTreeLoading: boolean;
  mediaError: string;
  isDirectoryLoading: boolean;
}) {
  const sourceDetailsLoading = Boolean(
    selectedRemoteSource &&
    !selectedRemoteDetail &&
    !selectedRemoteSource.error &&
    remoteSourceCanBrowse(selectedRemoteSource.summary),
  );
  const mediaLoadError = selectedRemoteSource ? selectedRemoteTreeError : mediaError;
  return {
    sourceDetailsLoading,
    mediaLoadError,
    showSkeleton: !mediaLoadError && (!work || isDirectoryLoading || sourceDetailsLoading || selectedRemoteTreeLoading),
  };
}

type PersistedDetailActionsProps = {
  work: WorkDetail | null;
  favoriteLists: FavoriteList[];
  favoriteSelected: boolean;
  playbackCursorLoading: boolean;
  hasResumableCursor: boolean;
  activeMetadataRunId: number | null;
  isSyncingDetail: boolean;
  canSyncMetadata: boolean;
  fetchBusy: boolean;
  isRefreshingLocalFiles: boolean;
  cleanupBusy: boolean;
  isResuming: boolean;
  actionMode: DetailActionMode;
  sourceContextKey: string;
  selectedRemoteSource: RemoteSourceAvailability | null | undefined;
  canTrackRemote: boolean;
  selectedSourceDetailsLoading: boolean;
  selectedRemoteHasTracked: boolean;
  hasTrackedSourceForAction: boolean;
  forkSources: RemoteSourceAvailability[];
  currentForkSource: RemoteSourceAvailability | null;
  fetchRemote: RemoteSourceAvailability | undefined;
  selectedRemoteDetail: RemoteWorkDetail | null;
  activeSourceLabel: string;
  sourceStatus: string;
  selectedTrackedPresence: SourcePresenceItem | null;
  trackedCacheAvailable: boolean;
  selectedSource: SourceTabInfo | null | undefined;
  onEnsureListWork: () => Promise<number | null>;
  onListSaved: (favorite: boolean, workID: number) => void;
  onResume: () => void;
  onMark: (status: ListeningStatus) => void;
  onSyncMetadata: () => void;
  onEditMetadata: () => void;
  onTrack: () => void;
  onUntrack: () => void;
  onFork: (remote: RemoteSourceAvailability) => void;
  onFetch: () => void;
  onManage: () => void;
  onRefreshLocalFiles: () => void;
};

function PersistedIdentityActions(props: PersistedDetailActionsProps) {
  if (!props.work) return <DetailSkeletonActions />;
  const busy =
    props.isSyncingDetail || props.fetchBusy || props.isRefreshingLocalFiles || props.cleanupBusy || props.isResuming;
  return (
    <WorkIdentityActionBar
      busy={busy}
      listeningStatus={props.work.listeningStatus}
      favorite={props.favoriteLists.length > 0 ? props.favoriteSelected : props.work.favorite}
      listWorkId={props.work.id}
      onEnsureListWork={props.onEnsureListWork}
      onListSaved={props.onListSaved}
      onResume={!props.playbackCursorLoading && props.hasResumableCursor ? props.onResume : undefined}
      onMark={props.onMark}
      onSync={props.canSyncMetadata ? props.onSyncMetadata : undefined}
      onEditMetadata={props.onEditMetadata}
      metadataSyncBusy={props.isSyncingDetail || Boolean(props.activeMetadataRunId)}
    />
  );
}

function persistedMediaActionBindings(props: PersistedDetailActionsProps) {
  const canFetch = Boolean(props.fetchRemote && remoteSourceCanBrowse(props.fetchRemote.summary));
  return {
    onTrack: props.selectedRemoteSource ? props.onTrack : undefined,
    trackDisabled: props.selectedRemoteSource ? !props.canTrackRemote : undefined,
    onUntrack: props.hasTrackedSourceForAction ? props.onUntrack : undefined,
    onFetch: canFetch ? props.onFetch : undefined,
    onManageCache: props.selectedTrackedPresence ? props.onManage : undefined,
    manageCacheDisabled: Boolean(props.selectedTrackedPresence) && !props.trackedCacheAvailable,
    onManageFiles: props.actionMode === "local" ? props.onManage : undefined,
    onRefreshLocalFiles:
      props.actionMode === "local" && props.selectedSource?.kind === "local" ? props.onRefreshLocalFiles : undefined,
  };
}

function PersistedMediaActions(props: PersistedDetailActionsProps) {
  const { t } = useTranslation();
  if (!props.work) return null;
  const busy = props.isSyncingDetail || props.fetchBusy || props.isRefreshingLocalFiles || props.cleanupBusy;
  const actions = persistedMediaActionBindings(props);
  return (
    <MediaContextActionBar
      busy={busy}
      mode={props.actionMode}
      contextKey={props.sourceContextKey}
      trackDisabledReason={
        props.selectedSourceDetailsLoading
          ? t("detailActions.loadingTrackingState")
          : props.selectedRemoteSource?.error
            ? t("detailActions.sourceDetailsUnavailable")
            : props.selectedRemoteHasTracked
              ? t("detailActions.alreadyTracked")
              : t("detailActions.sourceUnavailable")
      }
      untrackDisabled={props.isSyncingDetail}
      forkSources={props.forkSources}
      currentForkSource={props.currentForkSource}
      onFork={props.onFork}
      remoteSourceWorkUrl={safeExternalHTTPURL(props.selectedRemoteDetail?.publicWorkUrl)}
      remoteSourceName={props.selectedRemoteSource?.source.displayName ?? props.selectedRemoteDetail?.sourceName}
      sourceLabel={props.activeSourceLabel}
      sourceStatus={props.sourceStatus}
      sourceDetailsLoading={props.selectedSourceDetailsLoading}
      {...actions}
    />
  );
}

function PersistedDetailActions(props: PersistedDetailActionsProps) {
  return (
    <>
      <PersistedIdentityActions {...props} />
      <PersistedMediaActions {...props} />
    </>
  );
}

type PersistedDirectoryPanelProps = {
  activeEdition: WorkDetail | null;
  description: string;
  tabs: SourceTabInfo[];
  activeKey: string;
  trackedPresenceOptions: TrackedPresenceOption[];
  selectedTrackedPresenceKey: string;
  checkingSources: boolean;
  checkedAt: string;
  directoryMode: DirectoryMode;
  root: TreeNode;
  directoryStats: TreeStats;
  directoryRoutingRules: DirectoryRoutingRule[];
  currentLocationId: number | null;
  currentPlaybackKey: string | null;
  autoRoutePath?: string[] | null;
  routeStateKey?: string;
  showNoSourceDirectory: boolean;
  selectedRemoteSource: RemoteSourceAvailability | null | undefined;
  selectedSource: SourceTabInfo | null | undefined;
  selectedTrackedForked: boolean;
  selectedTrackedPresence: SourcePresenceItem | null;
  remoteSources: RemoteSourceAvailability[];
  showDirectorySkeleton: boolean;
  directoryMediaError: string;
  cleanupRunId: number | null;
  cleanupRunStatus: string;
  message: string;
  selectedRemoteDetail: RemoteWorkDetail | null;
  selectionModal: ReactNode;
  onActiveKeyChange: (key: string) => void;
  onTrackedPresenceChange: (key: string) => void;
  onCheckSources: () => void;
  onDirectoryModeChange: (mode: DirectoryMode) => void;
  onRetry: () => void;
  onSelectRemote: (remote: RemoteSourceAvailability) => void;
  onOpenCleanupRun: () => void;
  onPlayLocal: (tracks: TreeTrack[], locationId: number) => void;
  onPlayRemote: (tracks: TreeTrack[], locationId: number) => void;
  onQueue: (track: TreeTrack, next: boolean) => void;
  onPreview: (preview: FilePreviewState) => void;
};

function persistedDirectoryEmptyLabel(props: PersistedDirectoryPanelProps) {
  if (props.showNoSourceDirectory) return i18n.t("libraryDetail.noSourceLinked");
  if (props.selectedRemoteSource) return i18n.t("libraryDetail.noRemoteFiles");
  return i18n.t("libraryDetail.noLocalFiles");
}

function persistedDirectoryToolbar(props: PersistedDirectoryPanelProps) {
  if (props.cleanupRunId) {
    return (
      <DirectoryOperationBanner
        runId={props.cleanupRunId}
        status={props.cleanupRunStatus}
        onOpen={props.onOpenCleanupRun}
      />
    );
  }
  if (props.message) return <DirectoryMessage message={props.message} />;
  return null;
}

function persistedDirectorySourceState(props: PersistedDirectoryPanelProps) {
  if (props.selectedSource?.kind === "local" && props.selectedSource.status !== "available") {
    return (
      <LocalSourceStatePanel
        status={props.selectedSource.status}
        remoteSources={props.remoteSources}
        onSelectRemote={props.onSelectRemote}
      />
    );
  }
  if (props.selectedRemoteSource && !remoteSourceCanBrowse(props.selectedRemoteSource.summary)) {
    return <RemoteSourceStatePanel remote={props.selectedRemoteSource} />;
  }
  if (props.selectedSource?.kind === "tracked" && !props.selectedTrackedForked) {
    return <TrackedUnforkedPanel presence={props.selectedTrackedPresence} remoteSources={props.remoteSources} />;
  }
  if (props.showNoSourceDirectory) {
    return (
      <NoSourceDirectoryPanel
        checking={props.checkingSources}
        checkedAt={props.checkedAt}
        remoteSources={props.remoteSources}
        onRefresh={props.onCheckSources}
      />
    );
  }
  return null;
}

function persistedDirectoryEmptyState(props: PersistedDirectoryPanelProps) {
  if (props.showDirectorySkeleton) return <DirectorySkeleton />;
  if (props.directoryMediaError) {
    return <DirectoryLoadErrorPanel message={props.directoryMediaError} onRetry={props.onRetry} />;
  }
  return persistedDirectorySourceState(props);
}

function persistedDirectoryLoadingMessage(props: PersistedDirectoryPanelProps) {
  if (!props.selectedRemoteSource || props.selectedRemoteDetail || props.selectedRemoteSource.loading) return "";
  return props.selectedRemoteSource.error || i18n.t("libraryDetail.remoteDirectoryNotLoaded");
}

function PersistedDirectoryPanel(props: PersistedDirectoryPanelProps) {
  const description = props.activeEdition
    ? i18n.t("libraryDetail.showingFilesFrom", {
        code: props.activeEdition.primaryCode,
        language: languageLabel(props.activeEdition.metadataLanguage),
      })
    : props.description;
  const emptyState = persistedDirectoryEmptyState(props);
  return (
    <SourceDirectoryPanel
      title={i18n.t("libraryDetail.directory")}
      description={description}
      statsLabel={formatTreeStats(props.directoryStats)}
      tabs={props.tabs}
      activeKey={props.activeKey}
      onActiveKeyChange={props.onActiveKeyChange}
      trackedPresenceOptions={props.trackedPresenceOptions}
      selectedTrackedPresenceKey={props.selectedTrackedPresenceKey}
      onTrackedPresenceChange={props.onTrackedPresenceChange}
      checkingSources={props.checkingSources}
      checkedAt={props.checkedAt}
      onCheckSources={props.onCheckSources}
      directoryMode={props.directoryMode}
      onDirectoryModeChange={props.onDirectoryModeChange}
      root={props.root}
      directoryRoutingRules={props.directoryRoutingRules}
      currentLocationId={props.currentLocationId}
      currentPlaybackKey={props.currentPlaybackKey}
      autoRoutePath={props.autoRoutePath}
      routeStateKey={props.routeStateKey}
      emptyLabel={persistedDirectoryEmptyLabel(props)}
      toolbar={persistedDirectoryToolbar(props)}
      selectionModal={props.selectionModal}
      emptyState={emptyState}
      loadingMessage={persistedDirectoryLoadingMessage(props)}
      onPlayFolder={props.selectedRemoteDetail ? props.onPlayRemote : props.onPlayLocal}
      onPlayNext={(track) => props.onQueue(track, true)}
      onAppendQueue={(track) => props.onQueue(track, false)}
      onPreview={props.onPreview}
    />
  );
}

function persistedPersonalTags(work: WorkDetail | null, onSave: (tags: string[]) => Promise<void>) {
  if (!work) return undefined;
  return (
    <div className="space-y-2 rounded-lg border bg-card p-3">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Tags className="h-4 w-4" />
        {i18n.t("libraryDetail.myTags")}
      </div>
      <UserTagRow tags={work.userTags ?? []} onSave={onSave} />
    </div>
  );
}

function persistedActiveSourceLabel(
  selectedTrackedPresence: SourcePresenceItem | null,
  selectedSource: SourceTabInfo | null | undefined,
) {
  return (
    selectedTrackedPresence?.fileSourceName ||
    selectedTrackedPresence?.fileSourceCode ||
    selectedSource?.sourceName ||
    selectedSource?.label ||
    i18n.t("libraryDetail.sourceInfo")
  );
}

function persistedSourceInfo({
  label,
  selectedSource,
  directoryStats,
  isDirectoryLoading,
  selectedSourceDetailsLoading,
  selectedRemoteDetail,
  fallbackDurationSeconds,
}: {
  label: string;
  selectedSource: SourceTabInfo | null | undefined;
  directoryStats: TreeStats;
  isDirectoryLoading: boolean;
  selectedSourceDetailsLoading: boolean;
  selectedRemoteDetail: RemoteWorkDetail | null;
  fallbackDurationSeconds: number | null;
}): ActiveSourceInfoModel {
  const source = selectedSource
    ? { kind: selectedSource.kind, status: selectedSource.status, statusLabel: selectedSource.statusLabel }
    : { kind: "no_source" as const, status: "degraded" as const, statusLabel: i18n.t("libraryDetail.loadingSource") };
  return {
    label,
    ...source,
    stats: directoryStats,
    loading: isDirectoryLoading || selectedSourceDetailsLoading,
    metadataDurationSeconds: selectedRemoteDetail?.durationSeconds ?? fallbackDurationSeconds,
  };
}

function persistedDisplayTranslations(
  localDirectoryWork: WorkDetail | null,
  selectedRemoteDetail: RemoteWorkDetail | null,
) {
  const localTranslations = localDirectoryWork?.translations ?? [];
  return selectedRemoteDetail
    ? mergeRemoteWorkVersions(localTranslations, selectedRemoteDetail.languageEditions ?? [])
    : localTranslations;
}

type PersistedPresentationWorkFields = {
  dlsiteUrl: string;
  title: string;
  seriesTitleId: string;
  seriesCircleExternalId: string;
  baseCode: string | undefined;
  metadataLanguage: string | undefined;
  metadataPresentation: WorkMetadataPresentation | undefined;
  activeMetadataVariantKey: string;
  voiceCredits: VoiceCredit[];
  tags: string[];
};

function persistedPresentationWorkFields(
  work: WorkDetail | null,
  activeMetadataVariant: ReturnType<typeof resolveMetadataVariant>,
  hero: ReturnType<typeof detailHeroModel>,
): PersistedPresentationWorkFields {
  if (!work) {
    return {
      dlsiteUrl: "",
      title: hero.title,
      seriesTitleId: "",
      seriesCircleExternalId: "",
      baseCode: undefined,
      metadataLanguage: undefined,
      metadataPresentation: undefined,
      activeMetadataVariantKey: "",
      voiceCredits: [],
      tags: hero.tags,
    };
  }
  return {
    dlsiteUrl: work.dlsiteUrl ?? "",
    title: work.manualOverrides?.title ?? activeMetadataVariant?.title ?? hero.title,
    seriesTitleId: work.seriesTitleId ?? "",
    seriesCircleExternalId: work.seriesCircleExternalId ?? work.circleExternalId ?? "",
    baseCode: work.baseCode,
    metadataLanguage: activeMetadataVariant?.language ?? work.metadataLanguage,
    metadataPresentation: work.metadataPresentation,
    activeMetadataVariantKey: activeMetadataVariant?.key ?? "",
    voiceCredits: work.voiceCredits ?? [],
    tags: activeMetadataVariant?.tags ?? hero.tags,
  };
}

function persistedWorkDetailPresentation({
  hero,
  work,
  activeMetadataVariant,
  sourceInfo,
  displayTranslations,
  activeEditionCode,
  selectedRemoteDetail,
  personalTags,
  loading,
  metadataSync,
  canSyncMetadata,
  metadataSyncBusy,
  onSyncMetadata,
  onMetadataVariantSelect,
  onVersionSelect,
}: {
  hero: ReturnType<typeof detailHeroModel>;
  work: WorkDetail | null;
  activeMetadataVariant: ReturnType<typeof resolveMetadataVariant>;
  sourceInfo: ActiveSourceInfoModel;
  displayTranslations: WorkDetail["translations"];
  activeEditionCode: string;
  selectedRemoteDetail: RemoteWorkDetail | null;
  personalTags: ReactNode;
  loading: boolean;
  metadataSync?: WorkMetadataSyncStatus;
  canSyncMetadata: boolean;
  metadataSyncBusy: boolean;
  onSyncMetadata: () => void;
  onMetadataVariantSelect: (key: string) => void;
  onVersionSelect: (translation: WorkDetail["translations"][number]) => void;
}): UnifiedWorkDetailPresentation {
  const fields = persistedPresentationWorkFields(work, activeMetadataVariant, hero);
  return {
    coverUrl: hero.coverUrl,
    fallbackCode: hero.primaryCode,
    code: hero.primaryCode,
    dlsiteUrl: fields.dlsiteUrl,
    title: fields.title,
    circle: hero.circle,
    circleExternalId: hero.circleExternalId,
    series: hero.series,
    seriesTitleId: fields.seriesTitleId,
    seriesCircleExternalId: fields.seriesCircleExternalId,
    ratingLabel: i18n.t("libraryDetail.dlRating"),
    rating: hero.rating,
    ratingCount: hero.ratingCount,
    sales: hero.sales,
    baseCode: fields.baseCode,
    metadataLanguage: fields.metadataLanguage,
    metadataPresentation: fields.metadataPresentation,
    metadataSync,
    canSyncMetadata,
    metadataSyncBusy,
    onSyncMetadata,
    activeMetadataVariantKey: fields.activeMetadataVariantKey,
    onMetadataVariantSelect,
    translations: displayTranslations,
    activeVersionCode: activeEditionCode || selectedRemoteDetail?.remoteCode || hero.primaryCode,
    onVersionSelect,
    remoteVersions: Boolean(selectedRemoteDetail),
    dlsiteFetchedAt: hero.dlsiteFetchedAt,
    releaseDate: hero.releaseDate || i18n.t("libraryDetail.unknownReleaseDate"),
    ageRating: hero.ageRating,
    sourceInfo,
    voiceActors: hero.voiceActors,
    voiceCredits: fields.voiceCredits,
    tags: fields.tags,
    personalTags,
    loading,
  };
}

function PersistedFilePreviewOverlay({
  preview,
  work,
  toast,
  onClose,
  onMetadataSaved,
}: {
  preview: FilePreviewState | null;
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
  return <FilePreviewDialog preview={preview} onClose={onClose} onSetCover={onSetCover} />;
}

function PersistedDirectoryManagerOverlay({
  open,
  root,
  selectedTrackedPresence,
  showNoSourceDirectory,
  selectedRemoteSource,
  deleting,
  onDeleteTargets,
  workID,
  canForgetWork,
  localRoot,
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
  canForgetWork: boolean;
  localRoot: { folderId: number; path: string } | null;
  onClose: () => void;
}) {
  if (!open) return null;
  const title = selectedTrackedPresence ? i18n.t("libraryDetail.manageCache") : i18n.t("libraryDetail.manageFiles");
  const description = selectedTrackedPresence
    ? i18n.t("libraryDetail.reviewCachedFiles")
    : i18n.t("libraryDetail.reviewFileOperations");
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
      canForgetWork={canForgetWork}
      allowCacheDelete={!selectedRemoteSource}
      allowLocalDelete={!selectedRemoteSource && !selectedTrackedPresence}
      localRoot={localRoot}
      showCachedFilter={Boolean(selectedTrackedPresence)}
    />
  );
}

function PersistedMetadataEditorOverlay({
  open,
  work,
  onClose,
  onSaved,
}: {
  open: boolean;
  work: WorkDetail | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  if (!open || !work) return null;
  return <WorkMetadataEditorModal work={work} onClose={onClose} onSaved={onSaved} />;
}

function PersistedReforkOverlay({
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
  const canViewMetadataActivity = useAuth().hasPermission("workflows:run");
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
    activeSourceKey,
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
  const [directoryMode, setDirectoryMode] = useState<DirectoryMode>("browse");
  const [isManageOpen, setIsManageOpen] = useState(false);
  const [isMetadataEditorOpen, setIsMetadataEditorOpen] = useState(false);
  const [preview, setPreview] = useState<FilePreviewState | null>(null);
  const [isRefreshingLocalFiles, setIsRefreshingLocalFiles] = useState(false);
  const [message, setMessage] = useState("");
  const [isSyncingDetail, setIsSyncingDetail] = useState(false);
  const [activeMetadataRunId, setActiveMetadataRunId] = useState<number | null>(null);
  const metadataRun = useWorkflowRunWatcher(activeMetadataRunId);
  const [favoriteLists, setFavoriteLists] = useState<FavoriteList[]>([]);
  const [activeEdition, setActiveEdition] = useState<WorkDetail | null>(null);
  const [activeEditionCode, setActiveEditionCode] = useState("");
  const [editionLoadingCode, setEditionLoadingCode] = useState("");
  const [editionError, setEditionError] = useState("");
  const [editionErrorCode, setEditionErrorCode] = useState("");
  const editionRequestSeq = useRef(0);
  const [selectedMetadataVariantKey, setSelectedMetadataVariantKey] = useState("");
  const [isResuming, setIsResuming] = useState(false);
  const [reforkTarget, setReforkTarget] = useState<ReforkTarget | null>(null);
  const [directoryRoutingRules, setDirectoryRoutingRules] =
    useState<DirectoryRoutingRule[]>(defaultDirectoryRoutingRules);
  const [mobileDetailTab, setMobileDetailTab] = useState<"info" | "directory">("directory");
  const isCompactDetailLayout = useCompactDetailLayout();
  const localDirectoryWork = activeEdition ?? work;
  const playbackCoverUrl = work?.coverUrl || workPreview?.coverUrl || "";
  const localRoot = useMemo(() => {
    const sourceID = selectedSource?.fileSourceId;
    if (!localDirectoryWork || !sourceID) return null;
    const folders = (localDirectoryWork.localFolders ?? []).filter(
      (folder) =>
        folder.workId === localDirectoryWork.id &&
        folder.fileSourceId === sourceID &&
        folder.state === "active" &&
        folder.rootPath.trim() !== "",
    );
    if (folders.length !== 1) return null;
    return { folderId: folders[0].id, path: folders[0].rootPath };
  }, [localDirectoryWork, selectedSource?.fileSourceId]);
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
  const allTracks = useMemo(() => flattenTracks(tree), [tree]);
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
  const managementTree = useMemo(
    () =>
      !isManageOpen
        ? emptyTree()
        : selectedTrackedPresence && localDirectoryWork && selectedTrackedSourceID
          ? buildTree(localDirectoryWork.mediaItems, selectedTrackedSourceID, localDirectoryWork.primaryCode)
          : tree,
    [isManageOpen, localDirectoryWork, selectedTrackedPresence, selectedTrackedSourceID, tree],
  );
  const player = useLibraryPlayer();
  const playbackMatchesWork = playbackTrackMatchesPersistedWork(player.currentTrack, work, workPreview, code);
  const autoPlaybackRouteKey = `persisted:${code}:${initialSourceIntent}:${initialTrackedSourceID ?? 0}:${initialRemoteCode}`;
  const [manualPlaybackRouteKey, setManualPlaybackRouteKey] = useState("");
  const autoPlaybackRoutingEnabled = manualPlaybackRouteKey !== autoPlaybackRouteKey;
  const autoPlaybackSnapshotRef = useRef<PlaybackRouteSnapshot>({ routeKey: "", track: null });
  const autoPlaybackTrack = captureInitialPlaybackTrack(
    autoPlaybackSnapshotRef,
    autoPlaybackRouteKey,
    player.currentTrack,
    player.isPlaying,
    playbackMatchesWork,
  );
  const autoRoutePath = useMemo(
    () => (autoPlaybackRoutingEnabled ? currentPlaybackDirectoryPath(tree, autoPlaybackTrack) : null),
    [autoPlaybackRoutingEnabled, autoPlaybackTrack, tree],
  );
  const autoRouteStateKey = `${autoPlaybackRouteKey}:${autoPlaybackRoutingEnabled ? "automatic" : "manual"}`;
  const autoSourceSelectionRef = useRef<string | null>(null);
  useEffect(() => {
    setManualPlaybackRouteKey("");
    autoSourceSelectionRef.current = null;
  }, [autoPlaybackRouteKey]);
  useEffect(() => {
    if (!autoPlaybackRoutingEnabled || initialSourceIntent !== "local" || !autoPlaybackTrack) return;
    const selection = playbackSourceSelection(autoPlaybackTrack, sourceTabs, trackedPresenceOptions);
    if (!selection) return;
    if (autoSourceSelectionRef.current === autoPlaybackRouteKey) return;
    autoSourceSelectionRef.current = autoPlaybackRouteKey;
    if (selection.trackedKey) {
      if (selectedTrackedPresenceKey !== selection.trackedKey || resolvedActiveSourceKey !== "tracked") {
        selectTrackedPresence(selection.trackedKey);
      }
      return;
    }
    if (resolvedActiveSourceKey !== selection.sourceKey) selectSource(selection.sourceKey);
  }, [
    autoPlaybackRouteKey,
    autoPlaybackRoutingEnabled,
    autoPlaybackTrack,
    initialSourceIntent,
    resolvedActiveSourceKey,
    selectedTrackedPresenceKey,
    selectSource,
    selectTrackedPresence,
    sourceTabs,
    trackedPresenceOptions,
  ]);
  const disableAutomaticPlaybackRouting = () => setManualPlaybackRouteKey(autoPlaybackRouteKey);
  const fetchWorkspace = useRemoteFetchWorkspace({ onWorksChanged });
  const openFetchWorkspace = () => {
    if (!fetchRemote) return;
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
      await onWorksChanged();
      if (workForgotten && !partial) {
        onBack();
        return;
      }
      if (activeEdition) {
        setActiveEdition(await api.getWork(activeEdition.id));
      } else if (work) {
        await onWorkReload(work.id, true);
      }
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
  const favoriteSelected = favoriteLists.some((list) => list.kind === "user" && list.selected);
  const isDetailLoading = !work;
  const actionMode = persistedDetailActionMode(
    selectedRemoteSource,
    selectedTrackedPresence,
    selectedTrackedForked,
    selectedSource,
  );
  const forkSources = availableForkSources(remoteSources);
  const currentForkSource = selectedTrackedRemoteSource ?? selectedRemoteSource ?? null;
  const {
    activeTrackedPresence: activeTrackedPresenceForAction,
    selectedRemoteHasTracked,
    hasTrackedSource: hasTrackedSourceForAction,
    canTrackRemote,
  } = persistedTrackingActionState({ work, selectedRemoteSource, selectedRemoteWorkCode, selectedTrackedPresence });
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
      toast.success(t("libraryDetail.myTagsUpdated"));
    } catch (error) {
      toast.notify(toastFromError(error, t("libraryDetail.myTagsUpdateFailed")));
      throw error;
    }
  };

  useEffect(() => {
    editionRequestSeq.current += 1;
    setActiveEdition(null);
    setActiveEditionCode("");
    setEditionLoadingCode("");
    setEditionError("");
    setEditionErrorCode("");
    setSelectedMetadataVariantKey("");
  }, [work?.id]);

  useEffect(() => {
    if (!work || activeEditionCode) return;
    const translations = work.translations ?? [];
    const currentVersion = translations.find(
      (translation) => translation.primaryCode.toUpperCase() === work.primaryCode.toUpperCase(),
    );
    if (currentVersion && workVersionAvailableForScope(currentVersion, "local")) return;
    const firstPlayableVersion = translations.find(
      (translation) => translation.workId && workVersionAvailableForScope(translation, "local"),
    );
    if (firstPlayableVersion) {
      void selectEdition(firstPlayableVersion);
    }
  }, [activeEditionCode, work]);

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
      tracks.map((track) => toPlayerTrack(track, localDirectoryWork, playbackCoverUrl)),
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
      if (resumeWork.id !== localDirectoryWork?.id) {
        setActiveEdition(resumeWork);
        setActiveEditionCode(resumeWork.primaryCode);
      }
      onPlay();
      player.playQueue(resumeQueue.tracks, resumeQueue.locationId, resumeQueue.positionSeconds);
    } catch (error) {
      toast.notify(toastFromError(error, t("libraryDetail.savedPlaybackResumeFailed")));
    } finally {
      setIsResuming(false);
    }
  };

  const playRemoteTracks = (tracks: TreeTrack[], locationId: number) => {
    if (!selectedRemoteDetail || tracks.length === 0) return;
    player.playQueue(
      tracks.map((track) => toRemotePreviewPlayerTrack(track, selectedRemoteDetail, flattenTreeFiles(tree))),
      locationId,
    );
  };

  const queueTrack = (track: TreeTrack, next: boolean) => {
    const queuedTrack = selectedRemoteDetail
      ? toRemotePreviewPlayerTrack(track, selectedRemoteDetail, flattenTreeFiles(tree))
      : localDirectoryWork
        ? toPlayerTrack(track, localDirectoryWork, playbackCoverUrl)
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
    setMessage("");
    try {
      const result = await api.refreshWorkLocalFiles(target.id, selectedSource.fileSourceId);
      invalidateCachedWorkMedia(target.id, principalID);
      if (result.workId !== target.id) invalidateCachedWorkMedia(result.workId, principalID);
      const refreshed = await api.getWork(result.workId);
      if (activeEdition || result.workId !== work?.id) {
        setCachedWorkMedia(refreshed.id, principalID, refreshed.mediaItems);
        setActiveEdition(refreshed);
        setActiveEditionCode(refreshed.primaryCode);
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

  const syncDetailMetadata = async () => {
    if (!work?.primaryCode || activeMetadataRunId || isSyncingDetail) return;
    setIsSyncingDetail(true);
    setMessage("");
    try {
      const result = await api.syncWorkMetadata(work.id);
      if (result.runId <= 0 || result.status === "unavailable") {
        await onWorkReload(work.id, true);
        await onWorksChanged();
        toast.notify({
          kind: "warning",
          message: t("libraryDetail.metadataNotRecorded"),
        });
        return;
      }
      setActiveMetadataRunId(result.runId);
      toast.notify({
        kind: "success",
        message: result.deduplicated
          ? t("libraryDetail.metadataRefreshAlreadyQueued", { runId: result.runId })
          : t("libraryDetail.metadataRefreshQueued", { code: result.primaryCode, runId: result.runId }),
        actionLabel: t(canViewMetadataActivity ? "nav.activity" : "nav.workManagement"),
        onAction: () => {
          window.history.pushState({}, "", metadataSyncResultURL(result.runId, false, canViewMetadataActivity));
          window.dispatchEvent(new Event(NAVIGATION_EVENT));
        },
      });
    } catch (error) {
      toast.notify(toastFromError(error, t("libraryDetail.metadataRefreshFailed")));
    } finally {
      setIsSyncingDetail(false);
    }
  };

  useEffect(() => {
    const run = metadataRun.run;
    if (!run || !activeMetadataRunId || isActiveWorkflowStatus(run.status)) return;
    setActiveMetadataRunId(null);
    const needsAttention = (run.metadataIssues?.pending ?? 0) > 0;
    const actionLabel = t(
      needsAttention ? "metadataIssues.openIssues" : canViewMetadataActivity ? "nav.activity" : "nav.workManagement",
    );
    const onAction = () => {
      window.history.pushState({}, "", metadataSyncResultURL(run.id, needsAttention, canViewMetadataActivity));
      window.dispatchEvent(new Event(NAVIGATION_EVENT));
    };
    if (run.status === "succeeded" || run.status === "partial") {
      void (async () => {
        try {
          if (work) await onWorkReload(work.id, true);
          await onWorksChanged();
          toast.notify({
            kind: run.status === "succeeded" ? "success" : "warning",
            message: t("libraryDetail.metadataWorkflowStatus", { runId: run.id, status: run.status }),
            actionLabel,
            onAction,
          });
        } catch (error) {
          toast.notify(toastFromError(error, t("libraryDetail.metadataRefreshedReloadFailed")));
        }
      })();
      return;
    }
    toast.notify({
      kind: "error",
      message: t("libraryDetail.metadataWorkflowStatus", { runId: run.id, status: run.status }),
      actionLabel,
      onAction,
    });
  }, [activeMetadataRunId, metadataRun.run, canViewMetadataActivity, onWorkReload, onWorksChanged, toast, work]);

  useEffect(() => {
    const reconcileTrack = (event: Event) => {
      const terminal = (event as CustomEvent<RemoteTrackTerminalDetail>).detail;
      if (
        !terminal ||
        (terminal.status !== "succeeded" && terminal.status !== "partial") ||
        !terminal.workId ||
        !work ||
        !remoteSources.some((remote) =>
          isMatchingRemoteTrack(
            terminal,
            remote.source.id,
            remote.summary.primaryCode,
            remote.detail?.primaryCode,
            remote.detail?.remoteCode,
            work.primaryCode,
          ),
        )
      )
        return;
      void Promise.all([onWorkReload(terminal.workId, true), onWorksChanged(), refreshAvailability()]).catch(
        (error) => {
          toast.notify(toastFromError(error, t("libraryDetail.trackCompletedReloadFailed")));
        },
      );
    };
    window.addEventListener(REMOTE_TRACK_TERMINAL_EVENT, reconcileTrack);
    return () => window.removeEventListener(REMOTE_TRACK_TERMINAL_EVENT, reconcileTrack);
  }, [onWorkReload, onWorksChanged, refreshAvailability, remoteSources, toast, work]);

  const trackSelectedRemoteSource = async () => {
    if (!selectedRemoteSource?.detail?.primaryCode) return;
    setIsSyncingDetail(true);
    setMessage("");
    try {
      const requestedCode = remoteDetailActionCode(selectedRemoteSource.detail);
      const result = await api.trackRemoteSourceWork(selectedRemoteSource.source.id, requestedCode, "manual_track");
      announceRemoteTrackCreated(selectedRemoteSource.source.id, requestedCode, result);
      toast.notify({
        kind: "info",
        message: result.deduplicated
          ? t("libraryDetail.trackAlreadyQueued", { runId: result.runId })
          : t("libraryDetail.trackQueued", { runId: result.runId }),
      });
    } catch (error) {
      toast.notify(toastFromError(error, t("libraryDetail.trackQueueFailed")));
    } finally {
      setIsSyncingDetail(false);
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

  const refreshSourceAvailability = async () => {
    if (!work?.primaryCode) return;
    setMessage("");
    try {
      const result = await refreshAvailability();
      if (!result) return;
      toast.success(t("libraryDetail.sourceAvailabilityUpdated"));
    } catch (error) {
      toast.notify(toastFromError(error, t("libraryDetail.sourceCheckFailed")));
    }
  };

  const untrackSelectedSource = async () => {
    if (!work) return;
    disableAutomaticPlaybackRouting();
    setIsSyncingDetail(true);
    setMessage("");
    try {
      const presence = await resolvePersistedTrackedPresence({
        activePresence: activeTrackedPresenceForAction,
        selectedRemoteSource,
        selectedRemoteWorkCode,
        work,
      });
      if (!presence?.fileSourceId) throw new Error("Tracked source could not be resolved.");
      const sourceID = presence.fileSourceId;
      const ownerWorkID = presence.workId || work.id;
      const sourceName = presence.fileSourceName || presence.fileSourceCode || t("libraryDetail.sourceInfo");
      await api.untrackWorkSource(ownerWorkID, sourceID);
      toast.success(t("libraryDetail.untrackedFromSource", { code: work.primaryCode, source: sourceName }));
      const remoteToKeep = selectedRemoteSource ?? selectedTrackedRemoteSource;
      if (remoteToKeep) setActiveSourceKey(remoteSourceTabKey(remoteToKeep.source.id));
      await onWorkReload(work.id, true);
      await onWorksChanged();
      try {
        await refreshAvailability();
      } catch {
        // The work detail reload is authoritative; availability can be checked again from Source.
      }
    } catch (error) {
      toast.notify(toastFromError(error, t("errors.unavailable")));
    } finally {
      setIsSyncingDetail(false);
    }
  };

  const forkTrackedSource = async (remote: RemoteSourceAvailability) => {
    if (!work?.primaryCode) return;
    setIsSyncingDetail(true);
    setMessage("");
    try {
      const requestedCode = remoteAvailabilityRouteCode(remote.summary, work.primaryCode);
      const result = await api.trackRemoteSourceWork(remote.source.id, requestedCode, "manual_fork");
      announceRemoteTrackCreated(remote.source.id, requestedCode, result);
      toast.notify({
        kind: "info",
        message: result.deduplicated
          ? t("libraryDetail.forkAlreadyQueued", { runId: result.runId })
          : t("libraryDetail.forkQueued", { runId: result.runId }),
      });
    } catch (error) {
      toast.notify(toastFromError(error, t("libraryDetail.forkQueueFailed")));
    } finally {
      setIsSyncingDetail(false);
    }
  };

  const requestForkSource = (remote: RemoteSourceAvailability) => {
    if (selectedTrackedForked || selectedRemoteSource?.summary.hasRemote) {
      setReforkTarget({ current: currentForkSource, next: remote });
      return;
    }
    void forkTrackedSource(remote);
  };

  const selectEdition = async (translation: WorkDetail["translations"][number]) => {
    if (!translation.workId || !work) return;
    disableAutomaticPlaybackRouting();
    const requestSeq = ++editionRequestSeq.current;
    setEditionError("");
    setEditionErrorCode("");
    if (translation.workId === work.id) {
      setEditionLoadingCode("");
      setActiveEdition(null);
      setActiveEditionCode(translation.primaryCode);
      setActiveSourceKey("local");
      return;
    }
    setEditionLoadingCode(translation.primaryCode);
    try {
      const detail = await api.getWork(translation.workId);
      if (requestSeq !== editionRequestSeq.current) return;
      setCachedWorkMedia(detail.id, principalID, detail.mediaItems);
      setActiveEdition(detail);
      setActiveEditionCode(detail.primaryCode);
      setActiveSourceKey("local");
    } catch (error) {
      if (requestSeq !== editionRequestSeq.current) return;
      setEditionError(directoryLoadErrorMessage(error));
      setEditionErrorCode(translation.primaryCode);
    } finally {
      if (requestSeq === editionRequestSeq.current) setEditionLoadingCode("");
    }
  };

  const selectDisplayedEdition = async (translation: WorkDetail["translations"][number]) => {
    disableAutomaticPlaybackRouting();
    if (!selectedRemoteDetail) {
      await selectEdition(translation);
      return;
    }
    const availableFromSelectedRemote = (selectedRemoteDetail.languageEditions ?? []).some(
      (edition) => edition.remoteCode.toUpperCase() === translation.primaryCode.toUpperCase(),
    );
    if (!availableFromSelectedRemote) {
      await selectEdition(translation);
      return;
    }
    setActiveEditionCode(translation.primaryCode);
    const selected = await selectRemoteEdition(translation.primaryCode);
    if (!selected) {
      setActiveEditionCode(selectedRemoteDetail.remoteCode);
      toast.error(t("libraryDetail.editionUnavailableFromSource", { code: translation.primaryCode }));
    }
  };

  const changeSourceKey = (key: string) => {
    disableAutomaticPlaybackRouting();
    selectSource(key);
    const nextSource = sourceTabs.find((source) => source.key === key);
    if (nextSource?.kind !== "local") {
      setActiveEdition(null);
      setActiveEditionCode(work?.primaryCode ?? "");
    }
  };

  const changeTrackedPresence = (key: string) => {
    const option = trackedPresenceOptions.find((candidate) => candidate.key === key);
    if (!option) return;
    disableAutomaticPlaybackRouting();
    selectTrackedPresence(key);
    setActiveEdition(null);
    setActiveEditionCode(work?.primaryCode ?? "");
    const search = new URLSearchParams(window.location.search);
    search.set("view", "tracked");
    if (option.presence.fileSourceId) search.set("trackedSource", String(option.presence.fileSourceId));
    else search.delete("trackedSource");
    window.history.replaceState(window.history.state ?? {}, "", `${window.location.pathname}?${search.toString()}`);
  };

  if (!work && !workPreview) {
    return (
      <div className="space-y-4">
        <PageHeaderBackAction label={t("detailActions.back")} onBack={onBack} />
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            {t("libraryDetail.remoteDirectoryLoading", { code })}
          </CardContent>
        </Card>
      </div>
    );
  }

  const hero = detailHeroModel(code, work, workPreview);
  const activeMetadataVariant = resolveMetadataVariant(work?.metadataPresentation, selectedMetadataVariantKey);
  const personalTags = persistedPersonalTags(work, saveWorkUserTags);
  const fetchSelectionModal = <RemoteFetchWorkspaceDialog workspace={fetchWorkspace} />;
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
  const heroActions = (
    <PersistedDetailActions
      work={work}
      favoriteLists={favoriteLists}
      favoriteSelected={favoriteSelected}
      playbackCursorLoading={playbackCursorLoading}
      hasResumableCursor={hasResumableCursor}
      activeMetadataRunId={activeMetadataRunId}
      isSyncingDetail={isSyncingDetail}
      canSyncMetadata={canSyncMetadata}
      fetchBusy={fetchWorkspace.isBusy}
      isRefreshingLocalFiles={isRefreshingLocalFiles}
      cleanupBusy={mediaCleanup.isBusy}
      isResuming={isResuming}
      actionMode={actionMode}
      sourceContextKey={`${resolvedActiveSourceKey}:${selectedTrackedPresenceKey}`}
      selectedRemoteSource={selectedRemoteSource}
      canTrackRemote={canTrackRemote}
      selectedSourceDetailsLoading={selectedSourceDetailsLoading}
      selectedRemoteHasTracked={selectedRemoteHasTracked}
      hasTrackedSourceForAction={hasTrackedSourceForAction}
      forkSources={forkSources}
      currentForkSource={currentForkSource}
      fetchRemote={fetchRemote}
      selectedRemoteDetail={selectedRemoteDetail}
      activeSourceLabel={activeSourceLabel}
      sourceStatus={sourceInfo.statusLabel}
      selectedTrackedPresence={selectedTrackedPresence}
      trackedCacheAvailable={trackedCacheAvailable}
      selectedSource={selectedSource}
      onEnsureListWork={ensureDetailListWork}
      onListSaved={favoriteSaved}
      onResume={() => void resumePlayback()}
      onMark={(status) => void markDetailWork(status)}
      onSyncMetadata={() => void syncDetailMetadata()}
      onEditMetadata={() => setIsMetadataEditorOpen(true)}
      onTrack={() => void trackSelectedRemoteSource()}
      onUntrack={() => void untrackSelectedSource()}
      onFork={requestForkSource}
      onFetch={openFetchWorkspace}
      onManage={() => setIsManageOpen(true)}
      onRefreshLocalFiles={() => void refreshLocalFiles()}
    />
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
      directoryMode={directoryMode}
      root={tree}
      directoryStats={directoryStats}
      directoryRoutingRules={directoryRoutingRules}
      currentLocationId={player.currentLocationId}
      currentPlaybackKey={player.currentPlaybackKey}
      autoRoutePath={autoRoutePath}
      routeStateKey={autoRouteStateKey}
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
      message={message}
      selectedRemoteDetail={selectedRemoteDetail}
      selectionModal={fetchSelectionModal}
      onActiveKeyChange={changeSourceKey}
      onTrackedPresenceChange={changeTrackedPresence}
      onCheckSources={() => void refreshSourceAvailability()}
      onDirectoryModeChange={setDirectoryMode}
      onRetry={() => {
        if (selectedRemoteSource) {
          void refreshAvailability();
          selectSource(remoteSourceTabKey(selectedRemoteSource.source.id));
        } else if (work) {
          const failedEdition = work.translations.find(
            (translation) => translation.primaryCode.toUpperCase() === editionErrorCode.toUpperCase(),
          );
          if (failedEdition) void selectEdition(failedEdition);
          else void onWorkReload(work.id, true);
        }
      }}
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
    activeEditionCode,
    selectedRemoteDetail,
    personalTags,
    loading: isDetailLoading,
    metadataSync: work?.metadataSync,
    canSyncMetadata,
    metadataSyncBusy: isSyncingDetail || Boolean(activeMetadataRunId),
    onSyncMetadata: () => void syncDetailMetadata(),
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
        canForgetWork={canForgetWork}
        localRoot={localRoot}
        onClose={() => setIsManageOpen(false)}
      />
      <PersistedMetadataEditorOverlay
        open={isMetadataEditorOpen}
        work={work}
        onClose={() => setIsMetadataEditorOpen(false)}
        onSaved={() => void metadataSaved()}
      />
      <PersistedReforkOverlay
        target={reforkTarget}
        busy={isSyncingDetail}
        onClose={() => setReforkTarget(null)}
        onConfirm={(remote) => {
          setReforkTarget(null);
          void forkTrackedSource(remote);
        }}
      />
    </UnifiedWorkDetailPage>
  );
}
