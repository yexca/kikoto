import type { RemoteWorkDetail } from "@/lib/api";
import type { PlayerTrack } from "@/player/PlayerProvider";
import {
  remoteSourceTabKey,
  type SourceTabInfo,
  type TrackedPresenceOption,
} from "@/features/work-detail/source/sourceContextModel";
import { treePathForTrack, type TreeNode } from "@/features/work-detail/media/mediaTreeModel";

type PersistedWorkIdentity = {
  id: number;
  primaryCode: string;
  translations?: Array<{ primaryCode: string }>;
};

type WorkPreviewIdentity = {
  id?: number;
  primaryCode?: string;
};

type RemoteWorkIdentity = Pick<RemoteWorkDetail, "workId" | "remoteCode" | "primaryCode" | "remoteId">;

function normalizedPlaybackCode(value: string | null | undefined) {
  return value?.trim().toUpperCase() ?? "";
}

export function playbackTrackMatchesPersistedWork(
  track: PlayerTrack | null,
  work: PersistedWorkIdentity | null,
  preview: WorkPreviewIdentity | null,
  code: string,
) {
  if (!track) return false;
  const routeCode = normalizedPlaybackCode(code);
  const persistedCodes = [
    work?.primaryCode,
    ...(work?.translations ?? []).map((translation) => translation.primaryCode),
  ]
    .map(normalizedPlaybackCode)
    .filter(Boolean);
  const currentWork = work && persistedCodes.includes(routeCode) ? work : null;
  const previewCode = normalizedPlaybackCode(preview?.primaryCode);
  const currentPreview = preview && previewCode === routeCode ? preview : null;
  const workIDs = [currentWork?.id, currentPreview?.id].filter(
    (value): value is number => typeof value === "number" && value > 0,
  );
  if (track.workId > 0 && workIDs.includes(track.workId)) return true;
  const workCodes = [routeCode, ...(currentWork ? persistedCodes : []), ...(currentPreview ? [previewCode] : [])]
    .map(normalizedPlaybackCode)
    .filter(Boolean);
  return [track.workCode, track.remoteWorkCode]
    .map(normalizedPlaybackCode)
    .filter(Boolean)
    .some((trackCode) => workCodes.includes(trackCode));
}

export function playbackTrackMatchesRemoteWork(
  track: PlayerTrack | null,
  detail: RemoteWorkIdentity | null,
  code: string,
  sourceID: number,
) {
  if (!track || track.remoteSourceId !== sourceID) return false;
  const routeCode = normalizedPlaybackCode(code);
  const detailCodes = [detail?.remoteCode, detail?.primaryCode, detail?.remoteId]
    .map(normalizedPlaybackCode)
    .filter(Boolean);
  const currentDetail = detail && detailCodes.includes(routeCode) ? detail : null;
  if (currentDetail?.workId && track.workId > 0 && track.workId === currentDetail.workId) return true;
  const workCodes = [routeCode, ...(currentDetail ? detailCodes : [])].filter(Boolean);
  return [track.remoteWorkCode, track.workCode]
    .map(normalizedPlaybackCode)
    .filter(Boolean)
    .some((trackCode) => workCodes.includes(trackCode));
}

export type PlaybackRouteSnapshot = {
  routeKey: string;
  track: PlayerTrack | null;
};

export function captureInitialPlaybackTrack(
  snapshotRef: { current: PlaybackRouteSnapshot },
  routeKey: string,
  track: PlayerTrack | null,
  isPlaying: boolean,
  matchesWork: boolean,
) {
  if (snapshotRef.current.routeKey !== routeKey) {
    snapshotRef.current = {
      routeKey,
      track: isPlaying && matchesWork ? track : null,
    };
  }
  return snapshotRef.current.track;
}

export function playbackSourceSelection(
  track: PlayerTrack,
  sourceTabs: SourceTabInfo[],
  trackedPresenceOptions: TrackedPresenceOption[],
) {
  if (track.remoteSourceId && track.remoteSourceId > 0) {
    const tracked = trackedPresenceOptions.find(
      (option) => option.presence.fileSourceId === track.remoteSourceId && option.forked,
    );
    if (tracked) return { sourceKey: "tracked", trackedKey: tracked.key };
    const remote = sourceTabs.find(
      (source) => source.kind === "remote" && source.key === remoteSourceTabKey(track.remoteSourceId!),
    );
    if (remote) return { sourceKey: remote.key, trackedKey: null };
  }
  const selectedLocation = track.locations?.find((location) => location.locationId === track.locationId);
  const sourceID = selectedLocation?.sourceId;
  if (typeof sourceID === "number" && sourceID > 0) {
    const local = sourceTabs.find((source) => source.kind === "local" && source.fileSourceId === sourceID);
    if (local) return { sourceKey: local.key, trackedKey: null };
    const tracked = trackedPresenceOptions.find((option) => option.presence.fileSourceId === sourceID && option.forked);
    if (tracked) return { sourceKey: "tracked", trackedKey: tracked.key };
    const remote = sourceTabs.find((source) => source.kind === "remote" && source.key === remoteSourceTabKey(sourceID));
    if (remote) return { sourceKey: remote.key, trackedKey: null };
    return null;
  }
  const local = sourceTabs.find((source) => source.kind === "local");
  return local ? { sourceKey: local.key, trackedKey: null } : null;
}

export function currentPlaybackDirectoryPath(root: TreeNode, track: PlayerTrack | null) {
  if (!track) return null;
  return treePathForTrack(root, { playbackKey: track.playbackKey, locationId: track.locationId });
}
