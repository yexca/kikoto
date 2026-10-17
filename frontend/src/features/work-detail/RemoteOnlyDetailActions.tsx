import { useTranslation } from "react-i18next";

import type { LibrarySource, ListeningStatus, RemoteWorkDetail } from "@/lib/api";
import {
  MediaContextActionBar,
  type SourceActionLayout,
  WorkIdentityActionBar,
} from "@/features/work-detail/WorkDetailActionBars";
import { remoteSourceTabKey } from "@/features/work-detail/source/sourceContextModel";
import { DetailSkeletonActions } from "@/features/work-detail/WorkDetailLayout";
import { safeExternalHTTPURL } from "@/features/work-detail/workDetailShared";

export type RemoteOnlyDetailActionsProps = {
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
  /** Checked before the mark menu opens. */
  canMark: () => boolean;
  onTrack: () => void;
  onUntrack: () => void;
  /** Checked at the first untrack click. */
  canUntrack: () => boolean;
  onFetch: () => void;
};

export function RemoteOnlyIdentityActions({
  detail,
  busy,
  onEnsureListWork,
  onListSaved,
  onMark,
  canMark,
}: RemoteOnlyDetailActionsProps) {
  if (!detail) return <DetailSkeletonActions />;
  return (
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
  );
}

export function RemoteOnlySourceActions({
  detail,
  source,
  busy,
  primaryRemoteSelected,
  availabilityLoading,
  hasTrackedSource,
  materializedWorkID,
  onTrack,
  onUntrack,
  canUntrack,
  onFetch,
  layout,
}: RemoteOnlyDetailActionsProps & { layout: SourceActionLayout }) {
  const { t } = useTranslation();
  if (!detail || !primaryRemoteSelected) return null;
  return (
    <MediaContextActionBar
      layout={layout}
      busy={busy}
      mode="remote_source"
      contextKey={`${remoteSourceTabKey(source.id)}:${hasTrackedSource ? "tracked" : "available"}`}
      onTrack={onTrack}
      trackDisabled={availabilityLoading || hasTrackedSource}
      trackDisabledReason={
        availabilityLoading ? t("detailActions.loadingTrackingState") : t("detailActions.alreadyTracked")
      }
      onUntrack={hasTrackedSource && materializedWorkID ? onUntrack : undefined}
      canUntrack={canUntrack}
      onFetch={onFetch}
      remoteSourceWorkUrl={safeExternalHTTPURL(detail.publicWorkUrl)}
      remoteSourceName={detail.sourceName}
      sourceLabel={detail.sourceName}
      sourceStatus={t("content.available")}
    />
  );
}
