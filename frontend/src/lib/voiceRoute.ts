// A voice detail URL addresses a person by route key: the canonical DLsite
// voice actor id, or local-{person id} for a person without one. The server
// sets every link's key and resolves keys to person ids.
const voiceDetailPathPattern = /^\/voices\/(\d+|local-[1-9]\d*)\/?$/;

/** The route key a voice detail path addresses, or null for any other path. */
export function voiceRouteKeyFromPath(pathname: string): string | null {
  return pathname.match(voiceDetailPathPattern)?.[1] ?? null;
}

export function isVoiceDetailPath(pathname: string) {
  return voiceRouteKeyFromPath(pathname) !== null;
}

/** The detail path of a route key the server reported, or null when it reported none. */
export function voiceDetailPath(routeKey: string | null | undefined): string | null {
  const key = routeKey?.trim() ?? "";
  return key && isVoiceDetailPath(`/voices/${key}`) ? `/voices/${key}` : null;
}
