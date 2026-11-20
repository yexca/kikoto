import type { PlayerTrack } from "./playerTypes";

/** The key a resolved display name applies to: one work file at one location. */
export function queueDisplayTitleKey(track: Pick<PlayerTrack, "workId" | "mediaItemId" | "locationId">) {
  return `${track.workId}:${track.mediaItemId}:${track.locationId}`;
}

/**
 * Gives queued tracks the display names the server resolved, by
 * `queueDisplayTitleKey`; an undefined name shows the file's real name. Only
 * the names change, so playback, positions, and locations are untouched. A
 * track without a resolved name keeps its name. Returns the same array when
 * no name changes.
 */
export function withQueueDisplayTitles(
  tracks: PlayerTrack[],
  titles: ReadonlyMap<string, string | undefined>,
): PlayerTrack[] {
  let changed = false;
  const next = tracks.map((track) => {
    const key = queueDisplayTitleKey(track);
    if (!titles.has(key)) return track;
    const displayTitle = titles.get(key);
    if (displayTitle === track.displayTitle) return track;
    changed = true;
    return { ...track, displayTitle };
  });
  return changed ? next : tracks;
}
