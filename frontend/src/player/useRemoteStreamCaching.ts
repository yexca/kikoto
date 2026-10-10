import { useEffect, useRef } from "react";

import { api } from "@/lib/api";

import type { PlayerTrack } from "./playerTypes";
import { remoteStreamCacheRequest, type RemoteCachePermissions } from "./remoteStreamCacheRequest";

/**
 * Asks the server to cache a streamed remote track once per session when the
 * cache is enabled, so a later play can read it locally. A request the account
 * may not make is never sent: caching is a background convenience and must not
 * surface a permission error during playback.
 */
export function useRemoteStreamCaching(
  track: PlayerTrack | null,
  disabled: boolean,
  permissions: RemoteCachePermissions,
) {
  const cacheRequestedRef = useRef<Set<string>>(new Set());
  const locationType = track?.locationType;
  const locationId = track?.locationId ?? 0;
  const remoteSourceId = track?.remoteSourceId;
  const remoteWorkCode = track?.remoteWorkCode;
  const remotePath = track?.remotePath;
  const { cacheLocation, cacheRemoteWork } = permissions;

  useEffect(() => {
    if (disabled) return;
    const request = remoteStreamCacheRequest(
      { locationType, locationId, remoteSourceId, remoteWorkCode, remotePath },
      { cacheLocation, cacheRemoteWork },
    );
    if (!request || cacheRequestedRef.current.has(request.key)) return;
    cacheRequestedRef.current.add(request.key);
    api
      .getRuntimeSettings()
      .then((settings) => {
        if (!settings.cacheEnabled) return;
        if (request.kind === "location") {
          void api.cacheMediaLocation(request.locationId).catch(() => {});
        } else {
          void api.cacheRemoteSourceWorkMedia(request.sourceId, request.workCode, request.path).catch(() => {});
        }
      })
      .catch(() => {});
  }, [cacheLocation, cacheRemoteWork, disabled, locationId, locationType, remotePath, remoteSourceId, remoteWorkCode]);
}
