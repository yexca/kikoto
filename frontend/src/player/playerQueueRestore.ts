import type {
  PlaybackQueueResolution,
  PlaybackQueueResolveItem,
  PlaybackQueueResolvedItem,
  PlaybackQueueWork,
} from "@/lib/api";
import { resolvedTrackLyrics } from "./playbackQueueTracks";
import type { PlayerTrack } from "./playerTypes";
import { applyTrackLocation } from "./trackLocations";

/** The most items one resolve request names; the server refuses more. */
const PLAYBACK_QUEUE_RESOLVE_LIMIT = 1000;

export type ResolvePlaybackQueue = (
  items: PlaybackQueueResolveItem[],
  options?: { titlesOnly?: boolean },
) => Promise<PlaybackQueueResolution>;

/** Whether a queued track is a library work file the server can resolve. */
export function resolvableQueueTrack(track: PlayerTrack) {
  return track.workId > 0 && track.mediaItemId > 0 && !track.record;
}

/**
 * Resolves queued tracks in as few requests as the server's limit allows and
 * returns each track's resolution, in queue order, keyed by its position.
 */
export async function resolveQueueTracks(
  tracks: PlayerTrack[],
  resolve: ResolvePlaybackQueue,
  options: { titlesOnly?: boolean } = {},
) {
  const positions = tracks.flatMap((track, index) => (resolvableQueueTrack(track) ? [index] : []));
  const resolved = new Map<number, PlaybackQueueResolvedItem>();
  const works = new Map<number, PlaybackQueueWork>();
  for (let start = 0; start < positions.length; start += PLAYBACK_QUEUE_RESOLVE_LIMIT) {
    const part = positions.slice(start, start + PLAYBACK_QUEUE_RESOLVE_LIMIT);
    const response = await resolve(
      part.map((index) => {
        const track = tracks[index];
        return {
          mediaItemId: track.mediaItemId,
          workId: track.workId,
          locationId: track.locationId,
          ...(track.locationChosen ? { locationChosen: true } : {}),
        };
      }),
      options,
    );
    part.forEach((index, offset) => {
      const item = response.items[offset];
      if (item) resolved.set(index, item);
    });
    for (const work of response.works) works.set(work.id, work);
  }
  return { resolved, works };
}

/**
 * Keeps the item the listener is already playing on the location it plays
 * from, when that location is still available, so a refreshed queue does not
 * reload it from another location and restart it from the beginning.
 */
export function keepPlayingTrackLocation(tracks: PlayerTrack[], playing: PlayerTrack | undefined): PlayerTrack[] {
  if (!playing?.queueItemId) return tracks;
  return tracks.map((track) => {
    if (track.queueItemId !== playing.queueItemId || track.locationId === playing.locationId) return track;
    const location = track.locations?.find((candidate) => candidate.locationId === playing.locationId);
    if (!location) return track;
    const kept = applyTrackLocation(track, location);
    return track.locationChosen ? { ...kept, locationChosen: true } : kept;
  });
}

/**
 * Refreshes a restored queue against the library in one request. A playable
 * item takes its current locations, names, lyrics, and work information and
 * moves to the location the server chooses: its best one, unless the listener
 * picked its location in the player or it already plays from one as good. An
 * item that is missing or cannot play now leaves the queue. When the library
 * cannot be reached, the queue stays as it was saved.
 */
export async function revalidatePersistedQueue(
  tracks: PlayerTrack[],
  resolve: ResolvePlaybackQueue,
): Promise<PlayerTrack[]> {
  let resolution: Awaited<ReturnType<typeof resolveQueueTracks>>;
  try {
    resolution = await resolveQueueTracks(tracks, resolve);
  } catch {
    return tracks;
  }
  const { resolved, works } = resolution;
  return tracks.flatMap((track, index) => {
    const item = resolved.get(index);
    if (!item) return [track];
    if (item.status !== "playable" || !item.track) return [];
    const server = item.track;
    const location = server.locations.find((candidate) => candidate.locationId === server.locationId);
    if (!location) return [];
    const work = works.get(track.workId);
    const updated: PlayerTrack = {
      ...track,
      kind: server.kind === "video" ? "video" : "audio",
      durationSeconds: server.durationSeconds ?? track.durationSeconds,
      sizeBytes: server.sizeBytes ?? track.sizeBytes,
      progress: server.progress,
      locations: server.locations,
      workCode: work?.primaryCode || track.workCode,
      workTitle: work?.title || track.workTitle,
      coverUrl: work?.coverUrl || track.coverUrl,
      circle: work?.circle || track.circle,
      voiceActors: work?.voiceActors ?? track.voiceActors,
      displayTitle: server.displayTitle,
      ...resolvedTrackLyrics(server, track.lyricsLocationId),
      lyricsPreferencePersistable: server.lyricsPreferencePersistable,
    };
    const moved = applyTrackLocation(updated, location);
    return [
      track.locationChosen && location.locationId === track.locationId ? { ...moved, locationChosen: true } : moved,
    ];
  });
}
