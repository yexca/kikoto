import type { PlayMode } from "./playerTypes";

/** Start warming the next track this many seconds before the current one ends. */
export const NEXT_TRACK_PRELOAD_WINDOW_SECONDS = 45;

/**
 * Returns the queue index that end-of-track advancement will play next, or
 * null when playback stops or repeats the current item.
 */
export function nextAutoAdvanceIndex(currentIndex: number, queueLength: number, mode: PlayMode): number | null {
  if (mode === "single" || queueLength < 2 || currentIndex < 0 || currentIndex >= queueLength) return null;
  if (currentIndex < queueLength - 1) return currentIndex + 1;
  return mode === "loop" ? 0 : null;
}

/**
 * The next track is preloaded once the current track is playing near its end,
 * or as soon as the browser has already buffered the current track completely.
 */
export function shouldPreloadNextTrack({
  playing,
  currentTime,
  duration,
  bufferedEnd,
}: {
  playing: boolean;
  currentTime: number;
  duration: number;
  bufferedEnd: number;
}) {
  if (!playing || !Number.isFinite(duration) || duration <= 0) return false;
  if (Number.isFinite(currentTime) && duration - currentTime <= NEXT_TRACK_PRELOAD_WINDOW_SECONDS) return true;
  return Number.isFinite(bufferedEnd) && bufferedEnd >= duration - 0.5;
}

/** Reads the end of the buffered range that contains the playback position. */
export function bufferedEndAt(media: Pick<HTMLMediaElement, "buffered" | "currentTime">) {
  const ranges = media.buffered;
  for (let index = 0; index < ranges.length; index += 1) {
    if (ranges.start(index) <= media.currentTime + 0.5 && ranges.end(index) >= media.currentTime) {
      return ranges.end(index);
    }
  }
  return 0;
}
