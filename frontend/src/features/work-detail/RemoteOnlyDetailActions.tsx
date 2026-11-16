import { useTranslation } from "react-i18next";

import type { LibrarySource, ListeningStatus, RemoteWorkDetail } from "@/lib/api";
import type { HeroPlayback } from "@/features/work-detail/heroPlaybackModel";
import {
  HeroPrimaryAction,
  MediaContextActionBar,
  WorkIdentityActionBar,
} from "@/features/work-detail/WorkDetailActionBars";
import { remoteSourceTabKey } from "@/features/work-detail/source/sourceContextModel";
import { DetailSkeletonActions, HeroActionGroups } from "@/features/work-detail/WorkDetailLayout";
import { safeExternalHTTPURL } from "@/features/work-detail/workDetailShared";

export type RemoteOnlyDetailActionsProps = {
  detail: RemoteWorkDetail | null;
  source: LibrarySource;
  busy: boolean;
  heroPlayback: HeroPlayback;
  primaryRemoteSelected: boolean;
  availabilityLoading: boolean;
  hasTrackedSource: boolean;
  materializedWorkID: number | null;
  /** The viewer may Track and Untrack. */
  canTrack: boolean;
  /** The viewer may Fetch. */
  canFetch: boolean;
  onEnsureListWork: () => Promise<number | null>;
  onListSaved: () => Promise<void>;
  onPlay: (playback: Extract<HeroPlayback, { kind: "play" }>) => void;
  onMark: (status: ListeningStatus) => void;
  /** Checked before the mark menu opens. */
  canMark: () => boolean;
  onTrack: () => void;
  onUntrack: () => void;
  /** Checked at the first untrack click. */
  canUntrack: () => boolean;
  onFetch: () => void;
};

/** Play, then Mark and List; a work outside the Library has no saved playback, rating, or management. */
export function RemoteOnlyHeroActions({
  detail,
  busy,
  heroPlayback,
  onEnsureListWork,
  onListSaved,
  onPlay,
  onMark,
  canMark,
}: RemoteOnlyDetailActionsProps) {
  if (!detail) return <DetailSkeletonActions />;
  return (
    <HeroActionGroups primary={<HeroPrimaryAction playback={heroPlayback} busy={false} onPlay={onPlay} />}>
      <WorkIdentityActionBar
        busy={busy}
        listeningStatus="none"
        favorite={false}
        listWorkId={detail.workId}
        onEnsureListWork={onEnsureListWork}
        onListSaved={onListSaved}
        onMark={onMark}
        canMark={canMark}
      />
    </HeroActionGroups>
  );
}

/** The remote source's actions, listed in Source info. */
export function RemoteOnlySourceActions({
  detail,
  source,
  busy,
  primaryRemoteSelected,
  availabilityLoading,
  hasTrackedSource,
  materializedWorkID,
  canTrack,
  canFetch,
  onTrack,
  onUntrack,
  canUntrack,
  onFetch,
}: RemoteOnlyDetailActionsProps) {
  const { t } = useTranslation();
  if (!detail || !primaryRemoteSelected) return null;
  return (
    <MediaContextActionBar
      busy={busy}
      mode="remote_source"
      contextKey={`${remoteSourceTabKey(source.id)}:${hasTrackedSource ? "tracked" : "available"}`}
      onTrack={canTrack ? onTrack : undefined}
      trackDisabled={availabilityLoading || hasTrackedSource}
      trackDisabledReason={
        availabilityLoading ? t("detailActions.loadingTrackingState") : t("detailActions.alreadyTracked")
      }
      onUntrack={canTrack && hasTrackedSource && materializedWorkID ? onUntrack : undefined}
      canUntrack={canUntrack}
      onFetch={canFetch ? onFetch : undefined}
      remoteSourceWorkUrl={safeExternalHTTPURL(detail.publicWorkUrl)}
      remoteSourceName={detail.sourceName}
      sourceLabel={detail.sourceName}
    />
  );
}
