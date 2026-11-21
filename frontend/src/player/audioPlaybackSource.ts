import { api, type AudioPlaybackInfo, type VideoPlaybackInfo } from "@/lib/api";

import { audioHlsPlayback, audioPlaybackCapabilities, playbackURL, remoteMediaPlaybackURL } from "./mediaPlayback";
import type { PlayerTrack } from "./playerTypes";
import { supportsCompatibilityPlayback } from "./playerTrackMedia";

/**
 * Where the player element loads a track from. "direct" is the original file,
 * "hls" a playlist whose segments the server converts as they are needed, and
 * "prepared" one complete conversion for a browser without HLS playback.
 */
export type PlayerAudioSource = {
  delivery: "direct" | "hls" | "prepared";
  url: string;
};

/** Long enough to cover a preload and a retry, short enough that a replaced file is noticed. */
const RESOLVED_SOURCE_TTL_MS = 60_000;
const RESOLVE_TIMEOUT_MS = 10_000;
const CACHE_LIMIT = 64;

type CachedSource = { source: PlayerAudioSource; expiresAt: number };

const cache = new Map<string, CachedSource>();
const pending = new Map<string, Promise<PlayerAudioSource>>();
// Decisions a holder keeps for a later turn, such as the next auto-advance
// track's, never expire while held, however long the current track plays.
const held = new Map<string, number>();

function remoteTrack(track: PlayerTrack) {
  return Boolean(
    track.locationType === "remote_stream" && track.remoteSourceId && track.remoteWorkCode && track.remotePath,
  );
}

/**
 * Whether the server decides how a track plays. A remote stream is never
 * converted, and a location the server does not read itself has nothing to
 * decide, so those tracks play from a fixed URL.
 */
function serverDecides(track: PlayerTrack) {
  return Boolean(track.record) || (!remoteTrack(track) && track.locationId > 0 && supportsCompatibilityPlayback(track));
}

function fixedAudioSource(track: PlayerTrack): PlayerAudioSource {
  if (remoteTrack(track)) {
    return {
      delivery: "direct",
      url: remoteMediaPlaybackURL(track.remoteSourceId!, track.remoteWorkCode!, track.remotePath!, "audio"),
    };
  }
  return { delivery: "direct", url: playbackURL(track.streamUrl, "audio") };
}

/** Identifies what plays for a track: its location, and compatibility playback where the server decides. */
export function audioSourceKey(track: PlayerTrack, compatibility: boolean) {
  if (track.record) return `record:${track.record.assetId}:${compatibility ? 1 : 0}`;
  if (serverDecides(track)) return `media:${track.locationId}:${compatibility ? 1 : 0}`;
  return `fixed:${track.locationType}:${track.locationId}:${track.remoteSourceId ?? ""}:${track.remoteWorkCode ?? ""}:${track.remotePath ?? ""}:${track.streamUrl}`;
}

/**
 * What plays when playback info cannot be had: the stream route, which decides
 * between the file and one complete conversion from the declared capabilities,
 * and a Record file itself.
 */
function fallbackAudioSource(track: PlayerTrack, compatibility: boolean): PlayerAudioSource {
  if (track.record) return { delivery: "direct", url: track.streamUrl };
  if (compatibility) return { delivery: "prepared", url: playbackURL(track.streamUrl, "audio", true) };
  return { delivery: "direct", url: playbackURL(track.streamUrl, "audio") };
}

function remember(key: string, source: PlayerAudioSource, ttlMs: number) {
  cache.delete(key);
  cache.set(key, { source, expiresAt: Date.now() + ttlMs });
  for (const candidate of cache.keys()) {
    if (cache.size <= CACHE_LIMIT) break;
    if (!held.has(candidate)) cache.delete(candidate);
  }
}

/**
 * Keeps a track's decision from expiring until the returned release is
 * called, so the next track's turn finds the decision its preload warmed.
 */
export function holdAudioSource(track: PlayerTrack, compatibility: boolean): () => void {
  const key = audioSourceKey(track, compatibility);
  held.set(key, (held.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (held.get(key) ?? 1) - 1;
    if (count > 0) held.set(key, count);
    else held.delete(key);
  };
}

/**
 * The source of a track when it is known without asking the server: a remote
 * or otherwise fixed track, or one whose playback info was fetched lately.
 */
export function peekAudioSource(track: PlayerTrack, compatibility: boolean): PlayerAudioSource | null {
  const key = audioSourceKey(track, compatibility);
  const hit = cache.get(key);
  if (hit && (hit.expiresAt > Date.now() || held.has(key))) return hit.source;
  if (serverDecides(track)) return null;
  const fixed = fixedAudioSource(track);
  remember(key, fixed, Number.POSITIVE_INFINITY);
  return fixed;
}

/** Forgets the decision for a track whose playback failed, so a retry asks the server again. */
export function forgetAudioSource(track: PlayerTrack, compatibility: boolean) {
  if (!serverDecides(track)) return;
  cache.delete(audioSourceKey(track, compatibility));
}

/** The URL a failed track's playback can be checked at when the element names none. */
export function audioSourceCheckURL(track: PlayerTrack, compatibility: boolean) {
  return (peekAudioSource(track, compatibility) ?? fallbackAudioSource(track, compatibility)).url;
}

/** Forgets every decision; tests start from a clean cache. */
export function clearAudioSources() {
  cache.clear();
  pending.clear();
  held.clear();
}

function recordSource(track: PlayerTrack, info: VideoPlaybackInfo): PlayerAudioSource {
  // A Record file reaches an HLS playlist only where the browser plays it.
  if (info.delivery === "hls" && audioHlsPlayback()) return { delivery: "hls", url: info.url };
  if (info.delivery === "direct" && info.url) return { delivery: "direct", url: info.url };
  return { delivery: "direct", url: track.streamUrl };
}

function librarySource(info: AudioPlaybackInfo): PlayerAudioSource {
  return { delivery: info.delivery, url: info.url };
}

async function fetchAudioSource(track: PlayerTrack, compatibility: boolean): Promise<PlayerAudioSource> {
  const key = audioSourceKey(track, compatibility);
  const signal = AbortSignal.timeout(RESOLVE_TIMEOUT_MS);
  try {
    const options = { capabilities: audioPlaybackCapabilities(), forceTranscode: compatibility };
    const source = track.record
      ? recordSource(track, await api.getRecordPlayback(track.record.assetId, { ...options, profile: "audio" }, signal))
      : librarySource(await api.getAudioPlaybackInfo(track.locationId, options, signal));
    if (!source.url) return fallbackAudioSource(track, compatibility);
    remember(key, source, RESOLVED_SOURCE_TTL_MS);
    return source;
  } catch {
    // The stream route decides on its own, so a track still plays, and a
    // missing or busy file reaches the player's own failure handling.
    return fallbackAudioSource(track, compatibility);
  }
}

/**
 * Resolves how a track plays: the server decides delivery from the probed
 * file and the capabilities this browser declares, and the answer names the
 * URL. A request is shared by every caller asking for the same track.
 */
export function resolveAudioSource(track: PlayerTrack, compatibility: boolean): Promise<PlayerAudioSource> {
  const known = peekAudioSource(track, compatibility);
  if (known) return Promise.resolve(known);
  const key = audioSourceKey(track, compatibility);
  let request = pending.get(key);
  if (!request) {
    request = fetchAudioSource(track, compatibility).finally(() => pending.delete(key));
    pending.set(key, request);
  }
  return request;
}
