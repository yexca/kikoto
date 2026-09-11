import type { PlayerTrack } from "./playerTypes";

export function playbackKeyForLocation(locationId: number) {
  return `location:${locationId}`;
}

export function remotePlaybackKey(sourceId: number, workCode: string, remotePath: string) {
  const code = workCode.trim().toUpperCase();
  const path = remotePath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  return `remote:${sourceId}:${encodeURIComponent(code)}:${encodeURIComponent(path)}`;
}

export function withQueueIdentity(track: PlayerTrack): PlayerTrack {
  if (track.queueItemId) return track;
  const randomID =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return { ...track, queueItemId: randomID };
}
