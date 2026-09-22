import {
  api,
  ApiError,
  type DirectoryRoutingRule,
  type LibrarySource,
  type ListeningStatus,
  type RemoteTrack,
  type RemoteWorkDetail,
  type SourcePresenceItem,
  type WorkDetail,
} from "@/lib/api";
import { useTranslation } from "react-i18next";
import { MediaContextActionBar, WorkIdentityActionBar } from "@/features/work-detail/WorkDetailActionBars";
import {
  buildSourceTabs,
  type RemoteSourceAvailability,
  remoteSourceTabKey,
  type SourceTabInfo,
} from "@/features/work-detail/source/sourceContextModel";
import {
  DetailSkeletonActions,
  DirectorySkeleton,
  UnifiedWorkDetailPage,
  type UnifiedWorkDetailPresentation,
  useCompactDetailLayout,
} from "@/pages/library/detail/WorkDetailLayout";
import { dlsiteWorkURL, type RemoteWorkPreview, safeExternalHTTPURL } from "@/pages/library/libraryDetailShared";
import {
  buildRemoteTree,
  buildTree,
  countTreeFiles,
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
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { FilePreviewDialog, type FilePreviewState } from "@/features/work-detail/dialogs/FilePreviewDialog";
import {
  DirectoryLoadErrorPanel,
  DirectoryMessage,
  type DirectoryMode,
  LocalSourceStatePanel,
  RemoteSourceStatePanel,
  SourceDirectoryPanel,
  TrackedUnforkedPanel,
} from "@/pages/library/detail/directory/SourceDirectoryPanels";
import i18n from "@/i18n";
import {
  type ActiveSourceInfoModel,
  emptyRemoteWorkPreview,
  listeningStatusLabel,
  remoteDetailActionCode,
  trackedPresenceForRemoteSource,
} from "@/pages/library/detail/workDetailHelpers";
import { resolveMetadataVariant } from "@/features/work-detail/metadataPresentationModel";
import { DirectoryManagerDialog } from "@/features/work-detail/dialogs/DirectoryManagerDialog";
import { toastFromError, useToast } from "@/components/ui/toast";
import { useRemoteFetchWorkspace } from "@/features/work-detail/workflows/useRemoteFetchWorkspace";
import { useLibraryPlayer } from "@/player/PlayerProvider";
import {
  captureInitialPlaybackTrack,
  currentPlaybackDirectoryPath,
  type PlaybackRouteSnapshot,
  playbackTrackMatchesRemoteWork,
} from "@/features/work-detail/media/playbackDirectoryRouting";
import {
  announceRemoteTrackCreated,
  isMatchingRemoteTrack,
  REMOTE_TRACK_TERMINAL_EVENT,
  type RemoteTrackTerminalDetail,
} from "@/app/remoteTrackWorkflows";
import { NotFoundPage } from "@/app/NotFoundPage";
import { RemoteFetchWorkspaceDialog } from "@/features/work-detail/workflows/RemoteFetchWorkspaceDialog";
import { defaultDirectoryRoutingRules } from "@/pages/library/detail/directory/directoryModel";

type RemoteOnlyDetailActionsProps = {
  detail: RemoteWorkDetail | null;
  source: LibrarySource;
  busy: boolean;
  primaryRemoteSelected: boolean;
  availabilityLoading: boolean;
  hasTrackedSource: boolean;
  materializedWorkID: number | null;
  onEnsureListWork: () => Promise<number | null>;
  onListSaved: () => Promise<void>;
  onMark: (status: ListeningStatus) => void;
  onTrack: () => void;
  onUntrack: () => void;
  onFetch: () => void;
};

function RemoteOnlyDetailActions({
  detail,
  source,
  busy,
  primaryRemoteSelected,
  availabilityLoading,
  hasTrackedSource,
  materializedWorkID,
  onEnsureListWork,
  onListSaved,
  onMark,
  onTrack,
  onUntrack,
  onFetch,
}: RemoteOnlyDetailActionsProps) {
  const { t } = useTranslation();
  const identityActions = detail ? (
    <WorkIdentityActionBar
      busy={busy}
      listeningStatus="none"
      favorite={false}
      listWorkId={detail.workId}
      onEnsureListWork={onEnsureListWork}
      onListSaved={onListSaved}
      onMark={onMark}
    />
  ) : (
    <DetailSkeletonActions />
  );
  const mediaActions =
    detail && primaryRemoteSelected ? (
      <MediaContextActionBar
        busy={busy}
        mode="remote_source"
        contextKey={`${remoteSourceTabKey(source.id)}:${hasTrackedSource ? "tracked" : "available"}`}
        onTrack={onTrack}
        trackDisabled={availabilityLoading || hasTrackedSource}
        trackDisabledReason={
          availabilityLoading ? t("detailActions.loadingTrackingState") : t("detailActions.alreadyTracked")
        }
        onUntrack={hasTrackedSource && materializedWorkID ? onUntrack : undefined}
        onFetch={onFetch}
        remoteSourceWorkUrl={safeExternalHTTPURL(detail.publicWorkUrl)}
        remoteSourceName={detail.sourceName}
        sourceLabel={detail.sourceName}
        sourceStatus={t("content.available")}
      />
    ) : undefined;
  return (
    <>
      {identityActions}
      {mediaActions}
    </>
  );
}

type RemoteOnlyDirectoryPanelProps = {
  detail: RemoteWorkDetail | null;
  displaySourceName: string;
  displayRemoteCode: string;
  tabs: SourceTabInfo[];
  activeKey: string;
  activeTab: SourceTabInfo | null;
  activeTrackedPresence: SourcePresenceItem | null;
  activeTrackedForked: boolean;
  activeRemoteAvailability: RemoteSourceAvailability | null;
  primaryRemoteSelected: boolean;
  message: string;
  treeError: string;
  isDetailLoading: boolean;
  treeLoading: boolean;
  directoryMode: DirectoryMode;
  root: TreeNode;
  directoryStats: TreeStats;
  directoryRoutingRules: DirectoryRoutingRule[];
  currentLocationId: number | null;
  currentPlaybackKey: string | null;
  autoRoutePath?: string[] | null;
  routeStateKey?: string;
  remoteAvailability: RemoteSourceAvailability[];
  hasMaterializedWork: boolean;
  selectionModal: ReactNode;
  onActiveKeyChange: (key: string) => void;
  onDirectoryModeChange: (mode: DirectoryMode) => void;
  onRetry: () => void;
  onSelectRemote: (remote: RemoteSourceAvailability) => void;
  onPlayRemote: (tracks: TreeTrack[], locationId: number) => void;
  onPlayMaterialized: (tracks: TreeTrack[], locationId: number) => void;
  onQueueRemote: (track: TreeTrack, next: boolean) => void;
  onQueueMaterialized: (track: TreeTrack, next: boolean) => void;
  onPreview: (preview: FilePreviewState) => void;
};

function remoteOnlyDirectoryDescription(props: RemoteOnlyDirectoryPanelProps) {
  if (props.primaryRemoteSelected) {
    return primaryRemoteOnlyDirectoryDescription(props);
  }
  return alternateRemoteOnlyDirectoryDescription(props);
}

function primaryRemoteOnlyDirectoryDescription(props: RemoteOnlyDirectoryPanelProps) {
  if (props.detail && !props.message && !props.treeError) {
    return i18n.t("libraryDetail.remoteFilesPreviewDescription", { source: props.detail.sourceName });
  }
  return (
    props.message ||
    props.treeError ||
    i18n.t("libraryDetail.loadingRemoteFilesFrom", { source: props.displaySourceName })
  );
}

function alternateRemoteOnlyDirectoryDescription(props: RemoteOnlyDirectoryPanelProps) {
  if (props.activeTab?.kind === "tracked" && props.activeTrackedForked) {
    const sourceName =
      props.activeTrackedPresence?.fileSourceName ||
      props.activeTrackedPresence?.fileSourceCode ||
      i18n.t("libraryDetail.sourceInfo");
    return i18n.t("libraryDetail.browsingTrackedFork", { source: sourceName });
  }
  if (props.activeTab?.kind === "local" && props.activeTab.status === "available") {
    return i18n.t("libraryDetail.browsingLocalFiles");
  }
  return (
    props.activeRemoteAvailability?.summary.error ||
    i18n.t("libraryDetail.sourceNotSelectedPreview", {
      source: props.activeTab?.label ?? i18n.t("libraryDetail.sourceInfo"),
    })
  );
}

function remoteOnlyPrimaryDirectoryEmptyState(props: RemoteOnlyDirectoryPanelProps) {
  const error = props.message || props.treeError;
  if (error) {
    return <DirectoryLoadErrorPanel message={error} onRetry={props.onRetry} />;
  }
  if (props.isDetailLoading || props.treeLoading) {
    return <DirectorySkeleton />;
  }
  return null;
}

function remoteOnlyDirectoryEmptyState(props: RemoteOnlyDirectoryPanelProps) {
  if (props.primaryRemoteSelected) {
    return remoteOnlyPrimaryDirectoryEmptyState(props);
  }
  if (props.activeTab?.kind === "local" && props.activeTab.status !== "available") {
    return (
      <LocalSourceStatePanel
        status={props.activeTab.status}
        remoteSources={props.remoteAvailability}
        onSelectRemote={props.onSelectRemote}
      />
    );
  }
  if (props.activeTab?.kind === "tracked" && !props.activeTrackedForked) {
    return <TrackedUnforkedPanel presence={props.activeTrackedPresence} remoteSources={props.remoteAvailability} />;
  }
  if (props.activeRemoteAvailability) {
    return <RemoteSourceStatePanel remote={props.activeRemoteAvailability} />;
  }
  return null;
}

function remoteOnlyDirectoryPlayback(props: RemoteOnlyDirectoryPanelProps) {
  if (props.primaryRemoteSelected) {
    return {
      onPlayFolder: props.onPlayRemote,
      onPlayNext: (track: TreeTrack) => props.onQueueRemote(track, true),
      onAppendQueue: (track: TreeTrack) => props.onQueueRemote(track, false),
    };
  }
  if (props.hasMaterializedWork) {
    return {
      onPlayFolder: props.onPlayMaterialized,
      onPlayNext: (track: TreeTrack) => props.onQueueMaterialized(track, true),
      onAppendQueue: (track: TreeTrack) => props.onQueueMaterialized(track, false),
    };
  }
  return {};
}

function RemoteOnlyDirectoryPanel(props: RemoteOnlyDirectoryPanelProps) {
  const error = props.message || props.treeError;
  const loading = remoteOnlyDirectoryLoading(props);
  const playback = remoteOnlyDirectoryPlayback(props);
  const emptyState = remoteOnlyDirectoryEmptyState(props);
  return (
    <SourceDirectoryPanel
      title={i18n.t("libraryDetail.directory")}
      description={remoteOnlyDirectoryDescription(props)}
      statsLabel={formatTreeStats(props.directoryStats)}
      tabs={props.tabs}
      activeKey={props.activeKey}
      onActiveKeyChange={props.onActiveKeyChange}
      directoryMode={props.directoryMode}
      onDirectoryModeChange={props.onDirectoryModeChange}
      root={props.root}
      directoryRoutingRules={props.directoryRoutingRules}
      currentLocationId={props.currentLocationId}
      currentPlaybackKey={props.currentPlaybackKey}
      autoRoutePath={props.autoRoutePath}
      routeStateKey={props.routeStateKey}
      emptyLabel={
        props.primaryRemoteSelected
          ? i18n.t("libraryDetail.noRemoteFiles")
          : i18n.t("libraryDetail.sourcePreviewNotLoaded")
      }
      toolbar={error ? <DirectoryMessage message={error} /> : undefined}
      emptyState={emptyState}
      loadingMessage={
        loading ? i18n.t("libraryDetail.remoteDirectoryLoading", { code: props.displayRemoteCode }) : undefined
      }
      selectionModal={props.selectionModal}
      onPreview={props.onPreview}
      {...playback}
    />
  );
}

type RemoteOnlyDirectoryLoadingState = Pick<
  RemoteOnlyDirectoryPanelProps,
  "primaryRemoteSelected" | "message" | "treeError" | "isDetailLoading" | "treeLoading"
>;

function remoteOnlyDirectoryLoading(props: RemoteOnlyDirectoryLoadingState) {
  return (
    props.primaryRemoteSelected && !props.message && !props.treeError && (props.isDetailLoading || props.treeLoading)
  );
}

function remoteOnlySourceInfo(
  displaySourceName: string,
  tabs: SourceTabInfo[],
  activeKey: string,
  stats: TreeStats,
  primaryRemoteSelected: boolean,
  message: string,
  treeError: string,
  isDetailLoading: boolean,
  treeLoading: boolean,
  detail: RemoteWorkDetail | null,
): ActiveSourceInfoModel {
  const activeTab = tabs.find((tab) => tab.key === activeKey);
  const activeSource = activeTab
    ? { kind: activeTab.kind, status: activeTab.status, statusLabel: activeTab.statusLabel }
    : { kind: "remote" as const, status: "degraded" as const, statusLabel: i18n.t("libraryDetail.loadingSource") };
  return {
    label: displaySourceName,
    ...activeSource,
    stats,
    loading: remoteOnlyDirectoryLoading({
      primaryRemoteSelected,
      message,
      treeError,
      isDetailLoading,
      treeLoading,
    }),
    metadataDurationSeconds: detail ? detail.durationSeconds : null,
  };
}

function remoteOnlyTranslations(editions: RemoteWorkDetail["languageEditions"]): WorkDetail["translations"] {
  return editions.map((edition) => ({
    workId: null,
    primaryCode: edition.remoteCode,
    title: edition.label,
    metadataLanguage: edition.language,
    editionLabel: edition.label,
    origin: edition.origin,
    official: !edition.origin,
    translationKind: edition.origin ? "origin" : "official",
    current: edition.current,
    hasMedia: true,
    mediaState: "indexed_available",
    localAvailable: false,
  }));
}

type RemoteOnlyPresentationIdentity = {
  coverUrl: string;
  title: string;
  circle: string;
  circleExternalId: string;
  rating: number | null;
  ratingCount: number | null;
  sales: number | null;
  releaseDate: string;
  ageRating: string;
  voiceActors: string[];
  tags: string[];
};

function remoteOnlyPreviewIdentity(preview: RemoteWorkPreview | null, code: string): RemoteOnlyPresentationIdentity {
  const fallback = preview ?? emptyRemoteWorkPreview;
  return {
    coverUrl: fallback.coverUrl,
    title: preview ? fallback.title : code,
    circle: fallback.circle,
    circleExternalId: fallback.circleExternalId,
    rating: fallback.rating,
    ratingCount: null,
    sales: fallback.sales,
    releaseDate: fallback.releaseDate || i18n.t("libraryDetail.unknownReleaseDate"),
    ageRating: fallback.ageRating,
    voiceActors: fallback.voiceActors,
    tags: fallback.tags,
  };
}

function remoteOnlyPresentationIdentity(
  remoteIdentity: RemoteWorkDetail | null,
  preview: RemoteWorkPreview | null,
  code: string,
): RemoteOnlyPresentationIdentity {
  const fallback = remoteOnlyPreviewIdentity(preview, code);
  if (!remoteIdentity) return fallback;
  return {
    coverUrl: remoteIdentity.coverUrl,
    title: remoteIdentity.title,
    circle: remoteIdentity.circle,
    circleExternalId: remoteIdentity.circleRef?.externalId ?? fallback.circleExternalId,
    rating: remoteIdentity.rating ?? fallback.rating,
    ratingCount: remoteIdentity.ratingCount ?? null,
    sales: remoteIdentity.sales ?? fallback.sales,
    releaseDate: remoteIdentity.releaseDate || fallback.releaseDate,
    ageRating: remoteIdentity.ageRating,
    voiceActors: remoteIdentity.voiceActors,
    tags: remoteIdentity.tags,
  };
}

function remoteOnlyPresentationMetadata(
  remoteIdentity: RemoteWorkDetail | null,
  activeMetadataVariant: ReturnType<typeof resolveMetadataVariant>,
  identity: RemoteOnlyPresentationIdentity,
) {
  const editions = remoteIdentity ? remoteIdentity.languageEditions : [];
  const origin = editions.find((edition) => edition.origin);
  const current = editions.find((edition) => edition.current);
  return {
    title: activeMetadataVariant ? activeMetadataVariant.title : identity.title,
    tags: activeMetadataVariant ? activeMetadataVariant.tags : identity.tags,
    baseCode: origin ? origin.remoteCode : "",
    language: activeMetadataVariant ? activeMetadataVariant.language : current ? current.language : "",
    presentation: remoteIdentity ? remoteIdentity.metadataPresentation : undefined,
    activeVariantKey: activeMetadataVariant ? activeMetadataVariant.key : "",
    translations: remoteOnlyTranslations(editions),
  };
}

function remoteOnlyPresentationCode(
  displayPrimaryCode: string,
  remoteIdentity: RemoteWorkDetail | null,
  preview: RemoteWorkPreview | null,
  code: string,
) {
  const fallback = preview ?? emptyRemoteWorkPreview;
  return displayPrimaryCode || remoteIdentity?.remoteId || fallback.remoteId || code;
}

function remoteOnlyWorkDetailPresentation({
  remoteIdentity,
  detail,
  preview,
  code,
  displayPrimaryCode,
  displayRemoteCode,
  activeMetadataVariant,
  sourceInfo,
  loading,
  onMetadataVariantSelect,
  onVersionSelect,
}: {
  remoteIdentity: RemoteWorkDetail | null;
  detail: RemoteWorkDetail | null;
  preview: RemoteWorkPreview | null;
  code: string;
  displayPrimaryCode: string;
  displayRemoteCode: string;
  activeMetadataVariant: ReturnType<typeof resolveMetadataVariant>;
  sourceInfo: ActiveSourceInfoModel;
  loading: boolean;
  onMetadataVariantSelect: (key: string) => void;
  onVersionSelect: (code: string) => void;
}): UnifiedWorkDetailPresentation {
  const identity = remoteOnlyPresentationIdentity(remoteIdentity, preview, code);
  const metadata = remoteOnlyPresentationMetadata(remoteIdentity, activeMetadataVariant, identity);
  const presentationCode = remoteOnlyPresentationCode(displayPrimaryCode, remoteIdentity, preview, code);
  return {
    coverUrl: identity.coverUrl,
    fallbackCode: presentationCode,
    code: presentationCode,
    dlsiteUrl: detail ? dlsiteWorkURL(detail.primaryCode) : "",
    title: metadata.title,
    circle: identity.circle,
    circleExternalId: identity.circleExternalId,
    series: "",
    seriesTitleId: "",
    seriesCircleExternalId: "",
    ratingLabel: i18n.t("libraryDetail.rating"),
    rating: identity.rating,
    ratingCount: identity.ratingCount,
    sales: identity.sales,
    baseCode: metadata.baseCode,
    metadataLanguage: metadata.language,
    metadataPresentation: metadata.presentation,
    activeMetadataVariantKey: metadata.activeVariantKey,
    onMetadataVariantSelect,
    translations: metadata.translations,
    activeVersionCode: displayRemoteCode,
    onVersionSelect: (translation) => onVersionSelect(translation.primaryCode),
    remoteVersions: true,
    dlsiteFetchedAt: "",
    releaseDate: identity.releaseDate,
    ageRating: identity.ageRating,
    sourceInfo,
    voiceActors: identity.voiceActors,
    voiceCredits: [],
    tags: metadata.tags,
    loading,
  };
}

function remoteOnlyDisplayState(
  identityDetail: RemoteWorkDetail | null,
  detail: RemoteWorkDetail | null,
  preview: RemoteWorkPreview | null,
  source: LibrarySource,
  code: string,
  selectedMetadataVariantKey: string,
) {
  const remoteIdentity = identityDetail ?? detail;
  return {
    remoteIdentity,
    activeMetadataVariant: resolveMetadataVariant(remoteIdentity?.metadataPresentation, selectedMetadataVariantKey),
    displaySourceName: remoteIdentity?.sourceName ?? source.displayName,
    displayPrimaryCode: remoteIdentity?.primaryCode || preview?.primaryCode || code,
    displayRemoteCode: detail ? remoteDetailActionCode(detail) : preview?.remoteCode || preview?.primaryCode || code,
  };
}

function remoteOnlyActiveSourceState(
  sourceID: number,
  activeKey: string,
  tabs: SourceTabInfo[],
  availability: RemoteSourceAvailability[],
) {
  const primaryRemoteSelected = activeKey === remoteSourceTabKey(sourceID);
  const activeTab = tabs.find((tab) => tab.key === activeKey) ?? null;
  const activeTrackedPresence = activeTab?.kind === "tracked" ? (activeTab.presence ?? null) : null;
  return {
    primaryRemoteSelected,
    activeTab,
    activeTrackedPresence,
    activeTrackedForked: Boolean(activeTrackedPresence && activeTab?.status === "available"),
    activeRemoteAvailability: availability.find((item) => remoteSourceTabKey(item.source.id) === activeKey) ?? null,
    primaryRemoteAvailability: availability.find((item) => item.source.id === sourceID) ?? null,
  };
}

function remoteOnlyMaterializedState({
  trackedWork,
  sourceID,
  displayRemoteCode,
  primaryRemoteAvailability,
  detail,
  primaryRemoteSelected,
  remoteTree,
  materializedTree,
  remoteStats,
}: {
  trackedWork: WorkDetail | null;
  sourceID: number;
  displayRemoteCode: string;
  primaryRemoteAvailability: RemoteSourceAvailability | null;
  detail: RemoteWorkDetail | null;
  primaryRemoteSelected: boolean;
  remoteTree: TreeNode;
  materializedTree: TreeNode;
  remoteStats: TreeStats;
}) {
  const trackedSourcePresence = trackedPresenceForRemoteSource(trackedWork, sourceID, displayRemoteCode);
  const visibleTree = primaryRemoteSelected ? remoteTree : materializedTree;
  return {
    hasTrackedSource: Boolean(trackedSourcePresence || primaryRemoteAvailability?.summary.hasTracked),
    materializedWorkID: trackedWork?.id ?? primaryRemoteAvailability?.summary.workId ?? detail?.workId ?? null,
    visibleTree,
    visibleDirectoryStats: primaryRemoteSelected ? remoteStats : treeStats(visibleTree),
  };
}

function RemoteOnlyDetailOverlays({
  manageOpen,
  tree,
  filePreview,
  onManageClose,
  onPreviewClose,
}: {
  manageOpen: boolean;
  tree: TreeNode;
  filePreview: FilePreviewState | null;
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
      {filePreview && <FilePreviewDialog preview={filePreview} onClose={onPreviewClose} />}
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
  const { t } = useTranslation();
  const [detail, setDetail] = useState<RemoteWorkDetail | null>(null);
  const [identityDetail, setIdentityDetail] = useState<RemoteWorkDetail | null>(null);
  const [selectedMetadataVariantKey, setSelectedMetadataVariantKey] = useState("");
  const [trackedWork, setTrackedWork] = useState<WorkDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [message, setMessage] = useState("");
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState("");
  const [remoteRetryToken, setRemoteRetryToken] = useState(0);
  const [filePreview, setFilePreview] = useState<FilePreviewState | null>(null);
  const [activeRemoteTab, setActiveRemoteTab] = useState<string>(remoteSourceTabKey(source.id));
  const [remoteAvailability, setRemoteAvailability] = useState<RemoteSourceAvailability[]>(() =>
    sources
      .filter((candidate) => candidate.sourceType.startsWith("kikoeru"))
      .map((candidate) => ({
        source: candidate,
        summary: {
          sourceId: candidate.id,
          sourceCode: candidate.code,
          displayName: candidate.displayName,
          status: "unknown" as const,
          remoteId: "",
          primaryCode: code,
          title: preview?.title ?? "",
          coverUrl: preview?.coverUrl ?? "",
          workId: null,
          hasRemote: false,
          hasTracked: false,
          hasCache: false,
          hasLocal: false,
          error: "",
          elapsedMs: 0,
        },
      })),
  );
  const [availabilityLoading, setAvailabilityLoading] = useState(true);
  const [isFetching, setIsFetching] = useState(false);
  const [directoryMode, setDirectoryMode] = useState<DirectoryMode>("browse");
  const [isManageOpen, setIsManageOpen] = useState(false);
  const [mobileDetailTab, setMobileDetailTab] = useState<"info" | "directory">("directory");
  const isCompactDetailLayout = useCompactDetailLayout();
  const [directoryRoutingRules, setDirectoryRoutingRules] =
    useState<DirectoryRoutingRule[]>(defaultDirectoryRoutingRules);
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
  const fetchWorkspace = useRemoteFetchWorkspace({ onWorksChanged });
  const directoryStats = useMemo(() => treeStats(tree), [tree]);
  const trackCount = useMemo(() => countTreeFiles(tree), [tree]);
  const remotePlayableTracks = useMemo(() => flattenTracks(tree), [tree]);
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
  const autoPlaybackRouteKey = `remote:${source.id}:${code}`;
  const [manualPlaybackRouteKey, setManualPlaybackRouteKey] = useState("");
  useEffect(() => setManualPlaybackRouteKey(""), [autoPlaybackRouteKey]);
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
    () => (autoPlaybackRoutingEnabled ? currentPlaybackDirectoryPath(visibleTree, autoPlaybackTrack) : null),
    [autoPlaybackRoutingEnabled, autoPlaybackTrack, visibleTree],
  );
  const autoRouteStateKey = `${autoPlaybackRouteKey}:${autoPlaybackRoutingEnabled ? "automatic" : "manual"}`;

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

  useEffect(() => {
    let cancelled = false;
    setAvailabilityLoading(true);
    api
      .getSourceAvailability(code)
      .then(async (result) => {
        if (cancelled) return;
        setRemoteAvailability((current) =>
          current.map((item) => {
            const summary = result.sources.find((candidate) => candidate.sourceId === item.source.id);
            return summary ? { ...item, summary } : item;
          }),
        );
        const summary = result.sources.find((candidate) => candidate.sourceId === source.id);
        if (!summary?.workId) {
          setTrackedWork(null);
          return;
        }
        try {
          const nextWork = await api.getWork(summary.workId);
          if (!cancelled) setTrackedWork(nextWork);
        } catch {
          // Availability still controls Track state when materialized detail cannot be loaded.
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setAvailabilityLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [code, remoteRetryToken, source.id]);

  useEffect(() => {
    setDetail(null);
    setIdentityDetail(null);
    setSelectedMetadataVariantKey("");
    setTrackedWork(null);
    setNotFound(false);
    setMessage("");
    setTreeLoading(false);
    setTreeError("");
    fetchWorkspace.close();
  }, [source.id, code]);

  useEffect(() => {
    setNotFound(false);
    setMessage("");
    setTreeError("");
    setTreeLoading(true);
    const controller = new AbortController();
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 20_000);
    void loadRemoteOnlyDetail({
      sourceID: source.id,
      code,
      signal: controller.signal,
      didTimeOut: () => timedOut,
      onMetadata: (next) => {
        setDetail((current) => ({ ...next, tracks: current?.tracks ?? [] }));
        setIdentityDetail(next);
        setRemoteAvailability((items) =>
          items.map((item) =>
            item.source.id === source.id
              ? {
                  ...item,
                  summary: {
                    ...item.summary,
                    status: "available",
                    remoteId: next.remoteId,
                    primaryCode: next.primaryCode,
                    title: next.title,
                    coverUrl: next.coverUrl,
                    workId: next.workId,
                    hasRemote: true,
                  },
                }
              : item,
          ),
        );
      },
      onTracks: (tracks) => {
        setDetail((current) => (current ? { ...current, tracks } : current));
        setTreeError("");
      },
      onTreeError: setTreeError,
    })
      .then((outcome) => {
        if (outcome.kind === "not_found") {
          setNotFound(true);
          return;
        }
        if (outcome.kind === "failed") {
          setMessage(outcome.message);
          toast.notify({ kind: "error", message: outcome.message });
        }
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (!controller.signal.aborted || timedOut) setTreeLoading(false);
      });
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [source.id, code, remoteRetryToken]);

  const fetchWork = async (reason: string) => {
    if (!detail?.primaryCode) return;
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

  const syncForUserState = async (reason: string) => {
    if (!detail?.primaryCode) return null;
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
    if (!materializedWorkID || !detail) return;
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
      setRemoteAvailability((current) =>
        current.map((item) => {
          const summary = availability.sources.find((candidate) => candidate.sourceId === item.source.id);
          return summary ? { ...item, summary } : item;
        }),
      );
      toast.success(t("libraryDetail.untrackedFromSource", { code: detail.primaryCode, source: sourceName }));
    } catch (error) {
      toast.notify(toastFromError(error, t("errors.unavailable")));
    } finally {
      setIsFetching(false);
    }
  };

  useEffect(() => {
    const reconcileTrack = (event: Event) => {
      const terminal = (event as CustomEvent<RemoteTrackTerminalDetail>).detail;
      if (
        !terminal ||
        (terminal.status !== "succeeded" && terminal.status !== "partial") ||
        !terminal.workId ||
        !isMatchingRemoteTrack(terminal, source.id, code, detail?.primaryCode, detail?.remoteCode)
      )
        return;
      void (async () => {
        const [nextWork, availability] = await Promise.all([
          api.getWork(terminal.workId as number),
          api.getSourceAvailability(terminal.primaryCode || detail?.primaryCode || code).catch(() => null),
          onWorksChanged(),
        ]);
        setTrackedWork(nextWork);
        setDetail((current) => (current ? { ...current, workId: terminal.workId, importStatus: "synced" } : current));
        setIdentityDetail((current) =>
          current ? { ...current, workId: terminal.workId, importStatus: "synced" } : current,
        );
        if (availability) {
          setRemoteAvailability((current) =>
            current.map((item) => {
              const summary = availability.sources.find((candidate) => candidate.sourceId === item.source.id);
              return summary ? { ...item, summary } : item;
            }),
          );
        }
      })().catch((error) => {
        toast.notify(toastFromError(error, t("libraryDetail.trackCompletedReloadFailed")));
      });
    };
    window.addEventListener(REMOTE_TRACK_TERMINAL_EVENT, reconcileTrack);
    return () => window.removeEventListener(REMOTE_TRACK_TERMINAL_EVENT, reconcileTrack);
  }, [code, detail?.primaryCode, detail?.remoteCode, onWorksChanged, source.id, toast]);

  const playRemoteTracks = (tracks: TreeTrack[], locationId: number) => {
    if (!detail || tracks.length === 0) return;
    player.playQueue(
      tracks.map((track) => toRemotePreviewPlayerTrack(track, detail, remoteFiles)),
      locationId,
    );
  };

  const queueRemoteTrack = (track: TreeTrack, next: boolean) => {
    if (!detail) return;
    const queuedTrack = toRemotePreviewPlayerTrack(track, detail, remoteFiles);
    if (next) player.playNext(queuedTrack);
    else player.appendQueue([queuedTrack]);
    toast.info(
      next
        ? t("libraryDetail.playingNext", { title: track.title })
        : t("libraryDetail.addedToQueue", { title: track.title }),
    );
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
    const queuedTrack = toPlayerTrack(track, trackedWork);
    if (next) player.playNext(queuedTrack);
    else player.appendQueue([queuedTrack]);
    toast.info(
      next
        ? t("libraryDetail.playingNext", { title: track.title })
        : t("libraryDetail.addedToQueue", { title: track.title }),
    );
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
    setManualPlaybackRouteKey(autoPlaybackRouteKey);
    setActiveRemoteTab(key);
  };
  const heroActions = (
    <RemoteOnlyDetailActions
      detail={detail}
      source={source}
      busy={isFetching || fetchWorkspace.isBusy}
      primaryRemoteSelected={primaryRemoteSelected}
      availabilityLoading={availabilityLoading}
      hasTrackedSource={hasTrackedSource}
      materializedWorkID={materializedWorkID}
      onEnsureListWork={() => syncForUserState("detail_list_remote")}
      onListSaved={onWorksChanged}
      onMark={(status) => void updateRemoteMark(status)}
      onTrack={() => void fetchWork("manual_track")}
      onUntrack={() => void untrackRemoteSource()}
      onFetch={openSaveWorkspace}
    />
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
      directoryMode={directoryMode}
      root={visibleTree}
      directoryStats={visibleDirectoryStats}
      directoryRoutingRules={directoryRoutingRules}
      currentLocationId={player.currentLocationId}
      currentPlaybackKey={player.currentPlaybackKey}
      autoRoutePath={autoRoutePath}
      routeStateKey={autoRouteStateKey}
      remoteAvailability={remoteAvailability}
      hasMaterializedWork={Boolean(trackedWork)}
      selectionModal={<RemoteFetchWorkspaceDialog workspace={fetchWorkspace} />}
      onActiveKeyChange={selectRemoteSourceTab}
      onDirectoryModeChange={setDirectoryMode}
      onRetry={() => setRemoteRetryToken((value) => value + 1)}
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

type RemoteOnlyDetailLoadOutcome =
  { kind: "loaded" } | { kind: "not_found" } | { kind: "failed"; message: string } | { kind: "cancelled" };

function remoteOnlyLoadCancelled(error: unknown, timedOut: boolean) {
  return error instanceof DOMException && error.name === "AbortError" && !timedOut;
}

function remoteOnlyTreeErrorMessage(error: unknown, timedOut: boolean) {
  if (timedOut) return i18n.t("libraryDetail.remoteDirectoryTimedOut");
  return error instanceof Error ? error.message : i18n.t("libraryDetail.remoteDirectoryFailed");
}

function remoteOnlyDetailErrorOutcome(error: unknown, timedOut: boolean): RemoteOnlyDetailLoadOutcome {
  if (remoteOnlyLoadCancelled(error, timedOut)) return { kind: "cancelled" };
  if (error instanceof ApiError && error.status === 404) return { kind: "not_found" };
  return {
    kind: "failed",
    message: timedOut
      ? i18n.t("libraryDetail.remotePreviewTimedOut")
      : error instanceof Error
        ? error.message
        : i18n.t("libraryDetail.remotePreviewFailed"),
  };
}

async function loadRemoteOnlyDetail({
  sourceID,
  code,
  signal,
  didTimeOut,
  onMetadata,
  onTracks,
  onTreeError,
}: {
  sourceID: number;
  code: string;
  signal: AbortSignal;
  didTimeOut: () => boolean;
  onMetadata: (detail: RemoteWorkDetail) => void;
  onTracks: (tracks: RemoteTrack[]) => void;
  onTreeError: (message: string) => void;
}): Promise<RemoteOnlyDetailLoadOutcome> {
  try {
    const metadata = await api.getRemoteSourceWorkMetadata(sourceID, code, signal);
    if (signal.aborted) return { kind: "cancelled" };
    onMetadata({ ...metadata, tracks: [] });
    try {
      const tracks = await api.getRemoteSourceWorkTracks(sourceID, metadata.remoteCode || code, signal);
      if (!signal.aborted) onTracks(tracks.tracks);
    } catch (error) {
      const timedOut = didTimeOut();
      if (remoteOnlyLoadCancelled(error, timedOut)) return { kind: "cancelled" };
      onTreeError(remoteOnlyTreeErrorMessage(error, timedOut));
    }
    return { kind: "loaded" };
  } catch (error) {
    return remoteOnlyDetailErrorOutcome(error, didTimeOut());
  }
}
