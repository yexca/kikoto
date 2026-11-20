import { useState } from "react";
import { useTranslation } from "react-i18next";

import { toastFromError, useToast } from "@/components/ui/toast";
import { toPlayerTrack, toRemotePreviewPlayerTrack, type TreeTrack } from "@/features/work-detail/media/mediaTreeModel";
import { queuePlayerTrack } from "@/features/work-detail/media/queuePlayerTrack";
import { api, type RemoteWorkDetail, type WorkDetail, type WorkProgressSummary } from "@/lib/api";
import { toResolvedPlayerTrack } from "@/player/playbackQueueTracks";
import { useLibraryPlayer } from "@/player/PlayerProvider";

/**
 * Playback from a persisted work's detail: its local tracks, the selected
 * remote source's tracks, the saved playback cursor, and single tracks queued
 * next or last. Every queued track carries the displayed title. Resume plays
 * the queue the server builds for the cursor, in the Directory's order.
 */
export function usePersistedWorkPlayback({
  work,
  localDirectoryWork,
  selectedRemoteDetail,
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
  playbackCursor: WorkProgressSummary | null;
  hasResumableCursor: boolean;
  displayTitle: string | undefined;
  coverUrl: string;
  onPlay: () => void;
  /** Shows the edition the saved cursor belongs to, by its work id, when it is another one. */
  onShowEdition: (editionWorkId: number) => void;
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
      const { resume } = await api.getWorkResumeQueue(work.id);
      const start = resume?.tracks[resume.startIndex];
      if (!resume || !start) throw new Error(t("libraryDetail.savedTrackUnavailable"));
      if (resume.mediaWorkId !== localDirectoryWork?.id) onShowEdition(resume.mediaWorkId);
      onPlay();
      player.playQueue(
        resume.tracks.map((track) => titled(toResolvedPlayerTrack(track, resume.work, coverUrl))),
        start.locationId,
        resume.positionSeconds,
      );
    } catch (error) {
      toast.notify(toastFromError(error, t("libraryDetail.savedPlaybackResumeFailed")));
    } finally {
      setIsResuming(false);
    }
  };

  const playRemoteTracks = (tracks: TreeTrack[], locationId: number) => {
    if (!selectedRemoteDetail || tracks.length === 0) return;
    player.playQueue(
      tracks.map((track) => titled(toRemotePreviewPlayerTrack(track, selectedRemoteDetail))),
      locationId,
    );
  };

  const queueTrack = (track: TreeTrack, next: boolean) => {
    const queuedTrack = selectedRemoteDetail
      ? titled(toRemotePreviewPlayerTrack(track, selectedRemoteDetail))
      : localDirectoryWork
        ? titled(toPlayerTrack(track, localDirectoryWork, coverUrl))
        : null;
    if (!queuedTrack) return;
    queuePlayerTrack(player, toast, queuedTrack, next);
  };

  return { isResuming, playTracks, resumePlayback, playRemoteTracks, queueTrack };
}
