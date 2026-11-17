import type { RecordAsset, RecordProgress } from "@/lib/api";
import { RECORD_LOCATION_TYPE } from "@/player/playerTrackMedia";
import type { PlayerTrack } from "@/player/playerTypes";

/** Record files take negative location ids in the player, apart from library locations. */
export function recordTrackLocationId(assetId: number) {
  return -assetId;
}

/**
 * A Record audio file, or the sound of a Record video, as a global player
 * track. It belongs to no work: the folder names it under its title, its
 * picture is the file's own thumbnail (embedded cover art for audio), and
 * nothing is shown when there is none. It has no lyrics and stays out of the
 * restored queue and listening history.
 */
export function recordPlayerTrack(asset: RecordAsset, folderName: string, progress?: RecordProgress): PlayerTrack {
  const locationId = recordTrackLocationId(asset.id);
  const streamUrl = asset.streamUrl ?? "";
  return {
    mediaItemId: 0,
    locationId,
    title: asset.name,
    kind: asset.kind === "video" ? "video" : "audio",
    folderPath: "",
    locationType: RECORD_LOCATION_TYPE,
    streamUrl,
    sizeBytes: asset.sizeBytes ?? null,
    durationSeconds: asset.durationSeconds ?? null,
    availability: "available",
    workId: 0,
    workCode: "",
    workTitle: folderName,
    coverUrl: asset.thumbnailUrl ?? "",
    circle: "",
    progress: progress
      ? {
          positionSeconds: progress.positionSeconds,
          durationSeconds: progress.durationSeconds ?? null,
          completed: progress.completed,
          lastPlayedAt: progress.lastPlayedAt ?? null,
        }
      : null,
    progressRecordable: false,
    lyricsLocationId: null,
    lyricsTitle: "",
    playbackKey: `record:${asset.id}`,
    locations: [
      {
        locationId,
        locationType: RECORD_LOCATION_TYPE,
        streamUrl,
        sourceId: 0,
        sourceName: "",
        availability: "available",
      },
    ],
    record: { assetId: asset.id, folderId: asset.folderId },
  };
}
