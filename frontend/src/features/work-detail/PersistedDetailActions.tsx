import { useTranslation } from "react-i18next";

import {
  type RemoteSourceAvailability,
  remoteSourceCanBrowse,
  type SourceTabInfo,
} from "@/features/work-detail/source/sourceContextModel";
import type { FavoriteList, ListeningStatus, RemoteWorkDetail, SourcePresenceItem, WorkDetail } from "@/lib/api";
import { safeExternalHTTPURL } from "@/features/work-detail/workDetailShared";
import {
  type DetailActionMode,
  MediaContextActionBar,
  type SourceActionLayout,
  WorkIdentityActionBar,
} from "@/features/work-detail/WorkDetailActionBars";
import { DetailSkeletonActions } from "@/features/work-detail/WorkDetailLayout";

export type PersistedDetailActionsProps = {
  work: WorkDetail | null;
  favoriteLists: FavoriteList[];
  favoriteSelected: boolean;
  playbackCursorLoading: boolean;
  hasResumableCursor: boolean;
  isSyncingDetail: boolean;
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
  onEditMetadata: () => void;
  onTrack: () => void;
  onUntrack: () => void;
  /** Checked at the first untrack click. */
  canUntrack: () => boolean;
  onFork: (remote: RemoteSourceAvailability) => void;
  onFetch: () => void;
  onManage: () => void;
  onManageLyrics?: () => void;
  onRefreshLocalFiles: () => void;
};

export function PersistedIdentityActions(props: PersistedDetailActionsProps) {
  if (!props.work) return <DetailSkeletonActions />;
  const busy =
    props.isSyncingDetail || props.fetchBusy || props.isRefreshingLocalFiles || props.cleanupBusy || props.isResuming;
  return (
    <WorkIdentityActionBar
      busy={busy}
      listeningStatus={props.work.listeningStatus}
      favorite={props.favoriteLists.length > 0 ? props.favoriteSelected : props.work.favorite}
      memberLists={props.favoriteLists.filter((list) => list.kind !== "marked" && list.selected)}
      listWorkId={props.work.id}
      onEnsureListWork={props.onEnsureListWork}
      onListSaved={props.onListSaved}
      onResume={!props.playbackCursorLoading && props.hasResumableCursor ? props.onResume : undefined}
      onMark={props.onMark}
      onEditMetadata={props.onEditMetadata}
    />
  );
}

function persistedMediaActionBindings(props: PersistedDetailActionsProps) {
  const canFetch = Boolean(props.fetchRemote && remoteSourceCanBrowse(props.fetchRemote.summary));
  return {
    onTrack: props.selectedRemoteSource ? props.onTrack : undefined,
    trackDisabled: props.selectedRemoteSource ? !props.canTrackRemote : undefined,
    onUntrack: props.hasTrackedSourceForAction ? props.onUntrack : undefined,
    canUntrack: props.canUntrack,
    onFetch: canFetch ? props.onFetch : undefined,
    onManageCache: props.selectedTrackedPresence ? props.onManage : undefined,
    manageCacheDisabled: Boolean(props.selectedTrackedPresence) && !props.trackedCacheAvailable,
    onManageFiles: props.actionMode === "local" ? props.onManage : undefined,
    onManageLyrics: props.actionMode === "local" ? props.onManageLyrics : undefined,
    onRefreshLocalFiles:
      props.actionMode === "local" && props.selectedSource?.kind === "local" ? props.onRefreshLocalFiles : undefined,
  };
}

export function PersistedMediaActions({
  layout,
  ...props
}: PersistedDetailActionsProps & { layout: SourceActionLayout }) {
  const { t } = useTranslation();
  if (!props.work) return null;
  const busy = props.isSyncingDetail || props.fetchBusy || props.isRefreshingLocalFiles || props.cleanupBusy;
  const actions = persistedMediaActionBindings(props);
  return (
    <MediaContextActionBar
      layout={layout}
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
