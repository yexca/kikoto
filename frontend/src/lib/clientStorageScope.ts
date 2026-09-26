import { getStoredServerURL, isNativeApp } from "./serverConfig";

export type ClientPrincipalID = number | null;

export function normalizeClientServerIdentity(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed || "same-origin";
}

export function clientStorageScope(serverIdentity: string, principalID: ClientPrincipalID) {
  const principal = principalID === null ? "anonymous" : `user-${principalID}`;
  return `${encodeURIComponent(normalizeClientServerIdentity(serverIdentity))}:${principal}`;
}

export function currentClientServerIdentity() {
  if (isNativeApp()) return normalizeClientServerIdentity(getStoredServerURL() || "native-unconfigured");
  return normalizeClientServerIdentity(window.location.origin);
}

export function currentClientStorageScope(principalID: ClientPrincipalID) {
  return clientStorageScope(currentClientServerIdentity(), principalID);
}

/** True while `scope` still names the configured server, whatever its principal. */
export function isClientStorageScopeOnCurrentServer(scope: string) {
  return scope.startsWith(`${encodeURIComponent(currentClientServerIdentity())}:`);
}

export function currentScopedStorageKey(baseKey: string, principalID: ClientPrincipalID) {
  return `${baseKey}:${currentClientStorageScope(principalID)}`;
}

export function currentServerScopedStorageKey(baseKey: string) {
  return `${baseKey}:${encodeURIComponent(currentClientServerIdentity())}`;
}
