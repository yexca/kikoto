import type { LyricsChoice } from "./lyricsMatching";
import type { LyricsPreferenceTarget, PlayerTrack } from "./playerTypes";

export function lyricsPreferenceKey(target: LyricsPreferenceTarget) {
  return target.mediaItemId > 0 ? `media:${target.mediaItemId}` : `preview:${target.playbackKey ?? target.mediaItemId}`;
}

export function preferredLyricsMediaItemID(target: LyricsPreferenceTarget, overrides: Record<string, number | null>) {
  const key = lyricsPreferenceKey(target);
  return Object.prototype.hasOwnProperty.call(overrides, key)
    ? overrides[key]
    : (target.preferredLyricsMediaItemId ?? null);
}

export function applyLyricsChoiceToTrack(
  track: PlayerTrack,
  target: LyricsPreferenceTarget,
  choice: LyricsChoice | null,
) {
  const choices = target.lyricsChoices ?? track.lyricsChoices ?? [];
  const autoLocationID = target.autoLyricsLocationId ?? track.autoLyricsLocationId ?? null;
  const activeChoice = choice ?? choices.find((candidate) => candidate.locationId === autoLocationID) ?? null;
  return {
    ...track,
    lyricsChoices: choices,
    autoLyricsLocationId: autoLocationID,
    preferredLyricsMediaItemId: choice?.mediaItemId ?? null,
    lyricsLocationId: activeChoice?.locationId ?? null,
    lyricsTitle: activeChoice?.title ?? "",
  };
}

export function applyLyricsPreferenceOverride(track: PlayerTrack, overrides: Record<string, number | null>) {
  const preferenceKey = lyricsPreferenceKey(track);
  if (!Object.prototype.hasOwnProperty.call(overrides, preferenceKey)) return track;
  const preferredMediaItemID = overrides[preferenceKey];
  if (preferredMediaItemID === null) return applyLyricsChoiceToTrack(track, track, null);
  const choice = track.lyricsChoices?.find((candidate) => candidate.mediaItemId === preferredMediaItemID);
  return choice
    ? applyLyricsChoiceToTrack(track, track, choice)
    : { ...track, preferredLyricsMediaItemId: preferredMediaItemID };
}

/**
 * Whether a lyric choice is stored on the server. The library keeps one choice
 * per audio media item; for a video track, a remote preview, or anything else
 * the choice applies to the current session only.
 */
export function lyricsPreferencePersists(target: LyricsPreferenceTarget) {
  if (target.mediaItemId <= 0 || (target.kind !== undefined && target.kind !== "audio")) return false;
  return target.lyricsPreferencePersistable ?? target.progressRecordable ?? false;
}

/** A lyrics timing offset stays within 30 seconds either way. */
export const LYRICS_OFFSET_LIMIT_MS = 30_000;

export function clampLyricsOffset(offsetMs: number) {
  if (!Number.isFinite(offsetMs)) return 0;
  return Math.max(-LYRICS_OFFSET_LIMIT_MS, Math.min(LYRICS_OFFSET_LIMIT_MS, Math.round(offsetMs)));
}

/** Applies an offset the listener changed in this session to a track queued from older page data. */
export function applyLyricsOffsetOverride(track: PlayerTrack, overrides: Record<string, number>) {
  const preferenceKey = lyricsPreferenceKey(track);
  return Object.prototype.hasOwnProperty.call(overrides, preferenceKey)
    ? { ...track, lyricsOffsetMs: overrides[preferenceKey] }
    : track;
}
