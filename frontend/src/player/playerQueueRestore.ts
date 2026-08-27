import type { MediaItem } from "../lib/api";
import type { PlayerTrack, PlayerTrackLocation } from "./PlayerProvider";
import { applyTrackLocation, preferredTrackLocation } from "./trackLocations";

type WorkMediaResult = { kind: "loaded"; mediaItems: MediaItem[] } | { kind: "missing" } | { kind: "unavailable" };
type WorkPresentation = {
  primaryCode: string;
  title: string;
  coverUrl: string;
  circle: string;
};

function isNotFoundError(error: unknown) {
  return typeof error === "object" && error !== null && "status" in error && error.status === 404;
}

export async function revalidatePersistedQueue(
  tracks: PlayerTrack[],
  loadWorkMedia: (workId: number) => Promise<MediaItem[]>,
  loadWorkPresentation?: (workId: number) => Promise<WorkPresentation>,
): Promise<PlayerTrack[]> {
  const workIDs = Array.from(new Set(tracks.map((track) => track.workId).filter((workId) => workId > 0)));
  const results = new Map<number, WorkMediaResult>();
  const presentations = new Map<number, WorkPresentation>();
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, workIDs.length) }, async () => {
    while (cursor < workIDs.length) {
      const workID = workIDs[cursor++];
      const presentationPromise = loadWorkPresentation
        ? loadWorkPresentation(workID).catch(() => null)
        : Promise.resolve(null);
      const mediaPromise = loadWorkMedia(workID)
        .then<WorkMediaResult>((mediaItems) => ({ kind: "loaded", mediaItems }))
        .catch<WorkMediaResult>((error) => (isNotFoundError(error) ? { kind: "missing" } : { kind: "unavailable" }));
      const [result, presentation] = await Promise.all([mediaPromise, presentationPromise]);
      results.set(workID, result);
      if (presentation) presentations.set(workID, presentation);
    }
  });
  await Promise.all(workers);

  return tracks.flatMap((track) => {
    const result = results.get(track.workId);
    if (!result || result.kind === "unavailable") return [track];
    if (result.kind === "missing") return [];
    const mediaItem = result.mediaItems.find((item) => item.id === track.mediaItemId);
    if (!mediaItem) return [];
    const presentation = presentations.get(track.workId);
    const locations: PlayerTrackLocation[] = mediaItem.locations
      .filter(
        (location) =>
          (location.streamUrl || (location.locationType === "remote_stream" && location.downloadUrl)) &&
          ["available", "remote"].includes(location.availability),
      )
      .map((location) => ({
        locationId: location.id,
        locationType: location.locationType,
        streamUrl:
          location.locationType === "remote_stream" && (mediaItem.kind === "audio" || mediaItem.kind === "video")
            ? `/api/media/${location.id}/stream`
            : location.streamUrl || location.downloadUrl,
        sourceId: location.fileSourceId,
        sourceName: location.fileSourceName,
        availability: location.availability,
      }));
    if (locations.length === 0) return [];
    const updated = {
      ...track,
      kind: mediaItem.kind === "video" ? ("video" as const) : ("audio" as const),
      durationSeconds: mediaItem.durationSeconds ?? track.durationSeconds,
      sizeBytes: mediaItem.sizeBytes ?? track.sizeBytes,
      progress: mediaItem.progress,
      locations,
      workCode: presentation?.primaryCode || track.workCode,
      workTitle: presentation?.title || track.workTitle,
      coverUrl: presentation?.coverUrl || track.coverUrl,
      circle: presentation?.circle || track.circle,
    };
    const selected =
      locations.find((location) => location.locationId === track.locationId) ?? preferredTrackLocation(updated);
    return [selected ? applyTrackLocation(updated, selected) : updated];
  });
}
