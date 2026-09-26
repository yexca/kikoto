import { playbackURL, remoteMediaPlaybackURL } from "./mediaPlayback";
import { playbackKeyForLocation, remotePlaybackKey } from "./playbackIdentity";
import type { PlayerTrack } from "./playerTypes";

export function playerTrackAudioURL(track: PlayerTrack, compatibilityMode = false) {
  if (track.locationType === "remote_stream" && track.remoteSourceId && track.remoteWorkCode && track.remotePath) {
    return remoteMediaPlaybackURL(track.remoteSourceId, track.remoteWorkCode, track.remotePath, "audio");
  }
  return playbackURL(track.streamUrl, "audio", compatibilityMode, !compatibilityMode);
}

export function trackPlaybackKey(track: PlayerTrack | null) {
  if (!track) return null;
  if (track.playbackKey) return track.playbackKey;
  if (track.remoteSourceId && track.remoteWorkCode && track.remotePath) {
    return remotePlaybackKey(track.remoteSourceId, track.remoteWorkCode, track.remotePath);
  }
  return playbackKeyForLocation(track.locationId);
}

/**
 * Identifies one load of a queue item's source. It changes whenever the audio
 * element must load again: another item, location, stream, or an explicit retry.
 */
export function playbackInstanceKey(track: PlayerTrack | null, reloadToken: number) {
  const playbackKey = trackPlaybackKey(track);
  if (!track || !playbackKey) return null;
  return `${track.queueItemId ?? ""}:${playbackKey}:${track.locationId}:${track.streamUrl}:${reloadToken}`;
}

/** Compatibility (transcoded) playback only applies to files the server reads itself. */
export function supportsCompatibilityPlayback(track: Pick<PlayerTrack, "locationType"> | null | undefined) {
  return track?.locationType === "local" || track?.locationType === "cache";
}
