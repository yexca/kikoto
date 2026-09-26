import { useEffect, useRef } from "react";

import { api } from "@/lib/api";

import type { PlayerTrack } from "./playerTypes";

/**
 * Asks the server to cache a streamed remote track once per session when the
 * cache is enabled, so a later play can read it locally.
 */
export function useRemoteStreamCaching(track: PlayerTrack | null, disabled: boolean) {
  const cacheRequestedRef = useRef<Set<string>>(new Set());
  const locationType = track?.locationType;
  const locationId = track?.locationId ?? 0;
  const remoteSourceId = track?.remoteSourceId;
  const remoteWorkCode = track?.remoteWorkCode;
  const remotePath = track?.remotePath;

  useEffect(() => {
    if (disabled || locationType !== "remote_stream") return;
    const cacheKey =
      remoteSourceId && remoteWorkCode && remotePath
        ? `source:${remoteSourceId}:${remoteWorkCode}:${remotePath}`
        : `location:${locationId}`;
    if (cacheRequestedRef.current.has(cacheKey)) return;
    cacheRequestedRef.current.add(cacheKey);
    api
      .getRuntimeSettings()
      .then((settings) => {
        if (!settings.cacheEnabled) return;
        if (locationId > 0) {
          void api.cacheMediaLocation(locationId).catch(() => {});
        } else if (remoteSourceId && remoteWorkCode && remotePath) {
          void api.cacheRemoteSourceWorkMedia(remoteSourceId, remoteWorkCode, remotePath).catch(() => {});
        }
      })
      .catch(() => {});
  }, [disabled, locationId, locationType, remotePath, remoteSourceId, remoteWorkCode]);
}
