import { useTranslation } from "react-i18next";

import { workMemberLists } from "@/components/favorite-list/favoriteListPickerModel";
import { type RemoteSourceAvailability, remoteSourceCanBrowse } from "@/features/work-detail/source/sourceContextModel";
import type { FavoriteList, ListeningStatus, RemoteWorkDetail, SourcePresenceItem, WorkDetail } from "@/lib/api";
import type { HeroPlayback } from "@/features/work-detail/heroPlaybackModel";
import { safeExternalHTTPURL } from "@/features/work-detail/workDetailShared";
import {
  type DetailActionMode,
  HeroPrimaryAction,
  MediaContextActionBar,
  WorkIdentityActionBar,
  WorkManageMenu,
} from "@/features/work-detail/WorkDetailActionBars";
import { DetailSkeletonActions, HeroActionGroups } from "@/features/work-detail/WorkDetailLayout";

export type PersistedDetailActionsProps = {
  work: WorkDetail | null;
  favoriteLists: FavoriteList[];
  favoriteSelected: boolean;
  heroPlayback: HeroPlayback;
  isSyncingDetail: boolean;
  fetchBusy: boolean;
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
  selectedTrackedPresence: SourcePresenceItem | null;
  trackedCacheAvailable: boolean;
  /** The viewer may Track, Untrack, and Fork. */
  canTrack: boolean;
  /** The viewer may Fetch. */
  canFetch: boolean;
  /** The viewer may manage a tracked source's cache. */
  canManageCache: boolean;
  onEnsureListWork: () => Promise<number | null>;
  onListSaved: (favorite: boolean, workID: number) => void;
  onResume: () => void;
  onPlay: (playback: Extract<HeroPlayback, { kind: "play" }>) => void;
  onMark: (status: ListeningStatus) => void;
  onRate: (rating: number | null) => void;
  onTrack: () => void;
  onUntrack: () => void;
  /** Checked at the first untrack click. */
  canUntrack: () => boolean;
  onFork: (remote: RemoteSourceAvailability) => void;
  onFetch: () => void;
  onManage: () => void;
  /** Each management entry is absent when the viewer may not use it or the work has nothing for it. */
  onEditMetadata?: () => void;
  onManageFiles?: () => void;
  onManageLyrics?: () => void;
  onEditFileNames?: () => void;
  onTranslateWithAI?: () => void;
};

function identityActionsBusy(props: PersistedDetailActionsProps) {
  return props.isSyncingDetail || props.fetchBusy || props.cleanupBusy || props.isResuming;
}

/** Play or Resume, then Mark, rating, List, and the Manage menu. */
export function PersistedHeroActions(props: PersistedDetailActionsProps) {
  if (!props.work) return <DetailSkeletonActions />;
  const busy = identityActionsBusy(props);
  return (
    <HeroActionGroups
      primary={
        <HeroPrimaryAction
          playback={props.heroPlayback}
          busy={props.isResuming}
          onResume={props.onResume}
          onPlay={props.onPlay}
        />
      }
    >
      <WorkIdentityActionBar
        busy={busy}
        listeningStatus={props.work.listeningStatus}
        favorite={props.favoriteLists.length > 0 ? props.favoriteSelected : props.work.favorite}
        memberLists={workMemberLists(props.favoriteLists)}
        listWorkId={props.work.id}
        onEnsureListWork={props.onEnsureListWork}
        onListSaved={props.onListSaved}
        onMark={props.onMark}
        userRating={props.work.userRating}
        onRate={props.onRate}
      />
      <WorkManageMenu
        busy={busy}
        onEditMetadata={props.onEditMetadata}
        onManageFiles={props.onManageFiles}
        onManageLyrics={props.onManageLyrics}
        onEditFileNames={props.onEditFileNames}
        onTranslateWithAI={props.onTranslateWithAI}
      />
    </HeroActionGroups>
  );
}

function persistedMediaActionBindings(props: PersistedDetailActionsProps) {
  const canFetch = props.canFetch && Boolean(props.fetchRemote && remoteSourceCanBrowse(props.fetchRemote.summary));
  return {
    onTrack: props.canTrack && props.selectedRemoteSource ? props.onTrack : undefined,
    trackDisabled: props.selectedRemoteSource ? !props.canTrackRemote : undefined,
    onUntrack: props.canTrack && props.hasTrackedSourceForAction ? props.onUntrack : undefined,
    canUntrack: props.canUntrack,
    onFork: props.canTrack ? props.onFork : undefined,
    onFetch: canFetch ? props.onFetch : undefined,
    onManageCache: props.canManageCache && props.selectedTrackedPresence ? props.onManage : undefined,
    manageCacheDisabled: Boolean(props.selectedTrackedPresence) && !props.trackedCacheAvailable,
  };
}

/** The selected source's actions, listed in Source info. */
export function PersistedMediaActions(props: PersistedDetailActionsProps) {
  const { t } = useTranslation();
  if (!props.work) return null;
  const busy = props.isSyncingDetail || props.fetchBusy || props.cleanupBusy;
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
      remoteSourceWorkUrl={safeExternalHTTPURL(props.selectedRemoteDetail?.publicWorkUrl)}
      remoteSourceName={props.selectedRemoteSource?.source.displayName ?? props.selectedRemoteDetail?.sourceName}
      sourceLabel={props.activeSourceLabel}
      sourceDetailsLoading={props.selectedSourceDetailsLoading}
      {...actions}
    />
  );
}
