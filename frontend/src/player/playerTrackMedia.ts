import { audioHlsPlayback, mediaHlsPlaylistURL, playbackURL, remoteMediaPlaybackURL } from "./mediaPlayback";
import { audioNeedsConversion } from "./nextTrackPreload";
import { playbackKeyForLocation, remotePlaybackKey } from "./playbackIdentity";
import type { PlayerTrack } from "./playerTypes";

/**
 * Where the player element loads a track from. "direct" is the original file,
 * "hls" a playlist whose segments the server converts as they are needed, and
 * "prepared" one complete conversion for a browser without HLS playback.
 */
export type PlayerAudioSource = {
  delivery: "direct" | "hls" | "prepared";
  url: string;
};

export function playerTrackAudioSource(track: PlayerTrack, compatibilityMode = false): PlayerAudioSource {
  if (track.record) return recordAudioSource(track, track.record.assetId, compatibilityMode);
  if (track.locationType === "remote_stream" && track.remoteSourceId && track.remoteWorkCode && track.remotePath) {
    return {
      delivery: "direct",
      url: remoteMediaPlaybackURL(track.remoteSourceId, track.remoteWorkCode, track.remotePath, "audio"),
    };
  }
  if (!supportsCompatibilityPlayback(track) || !audioNeedsConversion(track.title, compatibilityMode)) {
    return { delivery: "direct", url: playbackURL(track.streamUrl, "audio", false, true) };
  }
  // A video file plays only its audio, never video segments.
  if (track.locationId > 0 && audioHlsPlayback()) {
    return {
      delivery: "hls",
      url: mediaHlsPlaylistURL(track.locationId, track.kind === "video" ? "audio" : undefined),
    };
  }
  return { delivery: "prepared", url: playbackURL(track.streamUrl, "audio", true, false) };
}

/**
 * A Record file plays as it is when the browser decodes it, and otherwise
 * through its own audio HLS encode, the sound alone for a video. A browser
 * without HLS playback gets the file itself.
 */
function recordAudioSource(track: PlayerTrack, assetId: number, compatibilityMode: boolean): PlayerAudioSource {
  if (!audioNeedsConversion(track.title, compatibilityMode) || !audioHlsPlayback()) {
    return { delivery: "direct", url: track.streamUrl };
  }
  return { delivery: "hls", url: recordAudioHlsPlaylistURL(assetId) };
}

export function recordAudioHlsPlaylistURL(assetId: number) {
  return `/api/records/assets/${encodeURIComponent(String(assetId))}/hls/index.m3u8?profile=audio`;
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
  return (
    track?.locationType === "local" || track?.locationType === "cache" || track?.locationType === RECORD_LOCATION_TYPE
  );
}

/** The location type of a Record file in the player. */
export const RECORD_LOCATION_TYPE = "record";
