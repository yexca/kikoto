import type { ReactNode } from "react";

import type { DirectoryRoutingRule, RemoteWorkDetail, SourcePresenceItem } from "@/lib/api";
import type { RemoteSourceAvailability, SourceTabInfo } from "@/features/work-detail/source/sourceContextModel";
import { DirectorySkeleton } from "@/features/work-detail/WorkDetailLayout";
import {
  formatTreeStats,
  type TreeNode,
  type TreeStats,
  type TreeTrack,
} from "@/features/work-detail/media/mediaTreeModel";
import type { FilePreviewRequest } from "@/features/work-detail/dialogs/FilePreviewDialog";
import {
  DirectoryLoadErrorPanel,
  DirectoryMessage,
  LocalSourceStatePanel,
  RemoteSourceStatePanel,
  SourceDirectoryPanel,
  TrackedUnforkedPanel,
} from "@/features/work-detail/directory/SourceDirectoryPanels";
import i18n from "@/i18n";
import { remoteOnlyDirectoryLoading } from "@/features/work-detail/remoteOnlyWorkDetailModel";

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
  onRetry: () => void;
  onSelectRemote: (remote: RemoteSourceAvailability) => void;
  onPlayRemote: (tracks: TreeTrack[], locationId: number) => void;
  onPlayMaterialized: (tracks: TreeTrack[], locationId: number) => void;
  onQueueRemote: (track: TreeTrack, next: boolean) => void;
  onQueueMaterialized: (track: TreeTrack, next: boolean) => void;
  onPreview: (request: FilePreviewRequest) => void;
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

export function RemoteOnlyDirectoryPanel(props: RemoteOnlyDirectoryPanelProps) {
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
