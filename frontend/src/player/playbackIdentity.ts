export function playbackKeyForLocation(locationId: number) {
  return `location:${locationId}`;
}

export function remotePlaybackKey(sourceId: number, workCode: string, remotePath: string) {
  const code = workCode.trim().toUpperCase();
  const path = remotePath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  return `remote:${sourceId}:${encodeURIComponent(code)}:${encodeURIComponent(path)}`;
}
