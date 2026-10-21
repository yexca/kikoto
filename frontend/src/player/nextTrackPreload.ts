import type { PlayMode } from "./playerTypes";

/** Start warming the next track this many seconds before the current one ends. */
export const NEXT_TRACK_PRELOAD_WINDOW_SECONDS = 45;

/**
 * A browser without HLS gets a converted track as one complete MP3, which the
 * server prepares at a conservative 40 times real time before it serves it. A
 * long next track that needs this starts warming early enough for that
 * preparation to finish.
 */
const TRANSCODE_PREPARATION_SPEED = 40;

/** Extensions the player streams without conversion when compatibility playback is off. */
const directAudioExtensions = new Set([".mp3", ".m4a", ".mp4", ".wav", ".flac", ".oga", ".ogg", ".opus", ".webm"]);

/** Whether the server converts this file for playback: compatibility mode, or a format the browser cannot play. */
export function audioNeedsConversion(fileName: string, compatibility: boolean) {
  if (compatibility) return true;
  const dot = fileName.lastIndexOf(".");
  return dot < 0 || !directAudioExtensions.has(fileName.slice(dot).toLowerCase());
}

/** How many seconds before the current track ends the next track starts warming. */
export function nextTrackPreloadWindowSeconds(
  nextDurationSeconds: number | null | undefined,
  needsPreparation: boolean,
) {
  if (!needsPreparation || !nextDurationSeconds || !Number.isFinite(nextDurationSeconds)) {
    return NEXT_TRACK_PRELOAD_WINDOW_SECONDS;
  }
  return Math.max(NEXT_TRACK_PRELOAD_WINDOW_SECONDS, nextDurationSeconds / TRANSCODE_PREPARATION_SPEED);
}

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
  windowSeconds = NEXT_TRACK_PRELOAD_WINDOW_SECONDS,
}: {
  playing: boolean;
  currentTime: number;
  duration: number;
  bufferedEnd: number;
  windowSeconds?: number;
}) {
  if (!playing || !Number.isFinite(duration) || duration <= 0) return false;
  if (Number.isFinite(currentTime) && duration - currentTime <= windowSeconds) return true;
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
