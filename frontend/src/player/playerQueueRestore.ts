import type { MediaItem } from "../lib/api";
import type { PlayerTrack, PlayerTrackLocation } from "./PlayerProvider";
import { applyTrackLocation, preferredTrackLocation } from "./trackLocations";

type WorkMediaResult = { kind: "loaded"; mediaItems: MediaItem[] } | { kind: "missing" } | { kind: "unavailable" };

function isNotFoundError(error: unknown) {
  return typeof error === "object" && error !== null && "status" in error && error.status === 404;
}

export async function revalidatePersistedQueue(
  tracks: PlayerTrack[],
  loadWorkMedia: (workId: number) => Promise<MediaItem[]>,
): Promise<PlayerTrack[]> {
  const workIDs = Array.from(new Set(tracks.map((track) => track.workId).filter((workId) => workId > 0)));
  const results = new Map<number, WorkMediaResult>();
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, workIDs.length) }, async () => {
    while (cursor < workIDs.length) {
      const workID = workIDs[cursor++];
      try {
        results.set(workID, { kind: "loaded", mediaItems: await loadWorkMedia(workID) });
      } catch (error) {
        results.set(
          workID,
          isNotFoundError(error) ? { kind: "missing" } : { kind: "unavailable" },
        );
      }
    }
  });
  await Promise.all(workers);

  return tracks.flatMap((track) => {
    const result = results.get(track.workId);
    if (!result || result.kind === "unavailable") return [track];
    if (result.kind === "missing") return [];
    const mediaItem = result.mediaItems.find((item) => item.id === track.mediaItemId);
    if (!mediaItem) return [];
    const locations: PlayerTrackLocation[] = mediaItem.locations
      .filter((location) => location.streamUrl && ["available", "remote"].includes(location.availability))
      .map((location) => ({
        locationId: location.id,
        locationType: location.locationType,
        streamUrl: location.streamUrl,
        sourceId: location.fileSourceId,
        sourceName: location.fileSourceName,
        availability: location.availability,
      }));
    if (locations.length === 0) return [];
    const updated = {
      ...track,
      durationSeconds: mediaItem.durationSeconds ?? track.durationSeconds,
      sizeBytes: mediaItem.sizeBytes ?? track.sizeBytes,
      progress: mediaItem.progress,
      locations,
    };
    const selected =
      locations.find((location) => location.locationId === track.locationId) ?? preferredTrackLocation(updated);
    return [selected ? applyTrackLocation(updated, selected) : updated];
  });
}
