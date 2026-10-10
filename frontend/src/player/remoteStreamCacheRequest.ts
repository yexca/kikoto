import type { PlayerTrack } from "./playerTypes";

/** What this account may ask of the server's remote cache. */
export type RemoteCachePermissions = {
  /** `remote:fetch`: cache a file of a work already in the Library. */
  cacheLocation: boolean;
  /** `remote:fetch` and `remote:track`: caching a file of a work not in the Library also adds the work. */
  cacheRemoteWork: boolean;
};

type RemoteStreamTrack = Pick<
  PlayerTrack,
  "locationType" | "locationId" | "remoteSourceId" | "remoteWorkCode" | "remotePath"
>;

export type RemoteStreamCacheRequest =
  | { key: string; kind: "location"; locationId: number }
  | { key: string; kind: "remote_work"; sourceId: number; workCode: string; path: string };

/**
 * The cache request a streamed track would make, or null when it is not a
 * remote stream or the account may not ask for it.
 */
export function remoteStreamCacheRequest(
  track: Partial<RemoteStreamTrack> | null,
  permissions: RemoteCachePermissions,
): RemoteStreamCacheRequest | null {
  if (!track || track.locationType !== "remote_stream") return null;
  const locationId = track.locationId ?? 0;
  if (locationId > 0) {
    return permissions.cacheLocation ? { key: `location:${locationId}`, kind: "location", locationId } : null;
  }
  const { remoteSourceId, remoteWorkCode, remotePath } = track;
  if (!remoteSourceId || !remoteWorkCode || !remotePath || !permissions.cacheRemoteWork) return null;
  return {
    key: `source:${remoteSourceId}:${remoteWorkCode}:${remotePath}`,
    kind: "remote_work",
    sourceId: remoteSourceId,
    workCode: remoteWorkCode,
    path: remotePath,
  };
}
