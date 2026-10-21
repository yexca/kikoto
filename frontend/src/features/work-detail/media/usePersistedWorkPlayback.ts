import { useState } from "react";
import { useTranslation } from "react-i18next";

import { toastFromError, useToast } from "@/components/ui/toast";
import {
  buildTree,
  buildWorkResumeQueue,
  flattenTracks,
  flattenTreeFiles,
  toPlayerTrack,
  toRemotePreviewPlayerTrack,
  type TreeNode,
  type TreeTrack,
} from "@/features/work-detail/media/mediaTreeModel";
import { queuePlayerTrack } from "@/features/work-detail/media/queuePlayerTrack";
import i18n from "@/i18n";
import { api, type RemoteWorkDetail, type WorkDetail, type WorkProgressSummary } from "@/lib/api";
import { useLibraryPlayer } from "@/player/PlayerProvider";

async function resolvePersistedResumeContext(
  cursor: WorkProgressSummary,
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

/**
 * Playback from a persisted work's detail: its local tracks, the selected
 * remote source's tracks, the saved playback cursor, and single tracks queued
 * next or last. Every queued track carries the displayed title.
 */
export function usePersistedWorkPlayback({
  work,
  localDirectoryWork,
  selectedRemoteDetail,
  tree,
  playbackTree,
  playbackCursor,
  hasResumableCursor,
  displayTitle,
  coverUrl,
  onPlay,
  onShowEdition,
}: {
  work: WorkDetail | null;
  /** The shown edition, whose local tracks play. */
  localDirectoryWork: WorkDetail | null;
  selectedRemoteDetail: RemoteWorkDetail | null;
  /** The shown directory, which the remote tracks come from. */
  tree: TreeNode;
  /** The shown edition's whole local tree, which a resume starts from. */
  playbackTree: TreeNode;
  playbackCursor: WorkProgressSummary | null;
  hasResumableCursor: boolean;
  displayTitle: string | undefined;
  coverUrl: string;
  onPlay: () => void;
  /** Shows another edition when the saved cursor belongs to it. */
  onShowEdition: (edition: WorkDetail) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const player = useLibraryPlayer();
  const [isResuming, setIsResuming] = useState(false);
  const titled = <T extends object>(track: T) => (displayTitle ? { ...track, workTitle: displayTitle } : track);

  const playTracks = (tracks: TreeTrack[], locationId: number) => {
    if (!localDirectoryWork || tracks.length === 0) return;
    onPlay();
    player.playQueue(
      tracks.map((track) => titled(toPlayerTrack(track, localDirectoryWork, coverUrl))),
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
      const resumeQueue = buildWorkResumeQueue(flattenTracks(resumeTree), resumeWork, playbackCursor, coverUrl);
      if (!resumeQueue) throw new Error(t("libraryDetail.savedTrackUnavailable"));
      if (resumeWork.id !== localDirectoryWork?.id) onShowEdition(resumeWork);
      onPlay();
      player.playQueue(resumeQueue.tracks.map(titled), resumeQueue.locationId, resumeQueue.positionSeconds);
    } catch (error) {
      toast.notify(toastFromError(error, t("libraryDetail.savedPlaybackResumeFailed")));
    } finally {
      setIsResuming(false);
    }
  };

  const playRemoteTracks = (tracks: TreeTrack[], locationId: number) => {
    if (!selectedRemoteDetail || tracks.length === 0) return;
    player.playQueue(
      tracks.map((track) => titled(toRemotePreviewPlayerTrack(track, selectedRemoteDetail, flattenTreeFiles(tree)))),
      locationId,
    );
  };

  const queueTrack = (track: TreeTrack, next: boolean) => {
    const queuedTrack = selectedRemoteDetail
      ? titled(toRemotePreviewPlayerTrack(track, selectedRemoteDetail, flattenTreeFiles(tree)))
      : localDirectoryWork
        ? titled(toPlayerTrack(track, localDirectoryWork, coverUrl))
        : null;
    if (!queuedTrack) return;
    queuePlayerTrack(player, toast, queuedTrack, next);
  };

  return { isResuming, playTracks, resumePlayback, playRemoteTracks, queueTrack };
}
