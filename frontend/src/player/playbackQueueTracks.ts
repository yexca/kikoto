import type { PlaybackLyricsChoice, PlaybackQueueTrack, PlaybackQueueWork } from "@/lib/api";

import type { LyricsChoice } from "./lyricsMatching";
import { playbackKeyForLocation } from "./playbackIdentity";
import type { PlayerTrack } from "./playerTypes";

/** The lyrics fields of a track the server resolved: its choices, and the one it shows. */
export function resolvedTrackLyrics(
  track: Pick<PlaybackQueueTrack, "lyricsChoices" | "preferredLyricsMediaItemId" | "lyricsOffsetMs">,
  shownLocationId?: number | null,
) {
  const lyricsChoices: LyricsChoice[] = track.lyricsChoices.map((choice: PlaybackLyricsChoice) => ({ ...choice }));
  const automatic = lyricsChoices[0] ?? null;
  const preferredLyricsMediaItemId = track.preferredLyricsMediaItemId;
  // The viewer's saved choice wins; a choice made only in this player, such as
  // one for a video, stays while the file is still a choice.
  const lyrics =
    lyricsChoices.find((choice) => choice.mediaItemId === preferredLyricsMediaItemId) ??
    lyricsChoices.find((choice) => shownLocationId != null && choice.locationId === shownLocationId) ??
    automatic;
  return {
    lyricsChoices,
    autoLyricsLocationId: automatic?.locationId ?? null,
    preferredLyricsMediaItemId,
    lyricsLocationId: lyrics?.locationId ?? null,
    lyricsTitle: lyrics?.title ?? "",
    lyricsOffsetMs: track.lyricsOffsetMs,
  };
}

/** A work file the server resolved, as a new queue item of the player. */
export function toResolvedPlayerTrack(
  track: PlaybackQueueTrack,
  work: PlaybackQueueWork,
  fallbackCoverUrl = "",
): PlayerTrack {
  return {
    mediaItemId: track.mediaItemId,
    locationId: track.locationId,
    title: track.title,
    ...(track.displayTitle ? { displayTitle: track.displayTitle } : {}),
    kind: track.kind === "video" ? "video" : "audio",
    folderPath: track.folderPath,
    locationType: track.locationType,
    streamUrl: track.streamUrl,
    sizeBytes: track.sizeBytes,
    durationSeconds: track.durationSeconds,
    availability: track.availability,
    workId: work.id,
    workCode: work.primaryCode,
    workTitle: work.title,
    coverUrl: work.coverUrl || fallbackCoverUrl,
    circle: work.circle,
    voiceActors: work.voiceActors,
    progress: track.progress,
    progressRecordable: true,
    ...resolvedTrackLyrics(track),
    lyricsPreferencePersistable: track.lyricsPreferencePersistable,
    locations: track.locations,
    playbackKey: playbackKeyForLocation(track.locationId),
  };
}
