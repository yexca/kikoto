import type { MediaItem } from "@/lib/api";

import type { PlayerTrack } from "./playerTypes";

function lastPathSegment(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/**
 * The display name the viewer's metadata languages give a media item's file,
 * read from the location the track plays or, failing that, any location that
 * has one. Undefined when the file shows its real name.
 */
export function mediaItemDisplayTitle(item: MediaItem, locationId: number): string | undefined {
  const named = item.locations.filter((location) => location.displayPath);
  const location = named.find((candidate) => candidate.id === locationId) ?? named[0];
  if (!location?.displayPath) return undefined;
  const shown = lastPathSegment(location.displayPath);
  return shown && shown !== lastPathSegment(location.path) ? shown : undefined;
}

/**
 * Gives queued tracks the display names of freshly loaded media. Only the
 * names change, so playback, positions, and locations are untouched. A track
 * whose work or media item was not loaded keeps its name. Returns the same
 * array when no name changes.
 */
export function withQueueDisplayTitles(
  tracks: PlayerTrack[],
  mediaByWork: ReadonlyMap<number, MediaItem[]>,
): PlayerTrack[] {
  let changed = false;
  const next = tracks.map((track) => {
    const item = mediaByWork.get(track.workId)?.find((candidate) => candidate.id === track.mediaItemId);
    if (!item) return track;
    const displayTitle = mediaItemDisplayTitle(item, track.locationId);
    if (displayTitle === track.displayTitle) return track;
    changed = true;
    return { ...track, displayTitle };
  });
  return changed ? next : tracks;
}
