import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";

import { clearNativeAssetTransport, configureNativeAssetTransport } from "@/lib/nativeAssetTransport";
import { changeApiSession } from "@/lib/apiSession";
import { deviceKey, localStore, type StorageKey } from "@/lib/clientStorage";
import {
  clearNativeSessionCredential,
  readNativeSessionCredential,
  writeNativeSessionCredential,
} from "@/lib/nativeSessionCredential";

// Both pick the server, so they are kept for the device rather than for one server.
const SERVER_URL_STORAGE_KEY = deviceKey("kikoto:mobile-server-url");
const SESSION_TOKEN_STORAGE_KEY = deviceKey("kikoto:mobile-session-token");

// Native shells hold the session in memory and in their native credential
// store, never in WebView storage, which device backups include.
let nativeSession = "";

export function isNativeApp() {
  return Capacitor.isNativePlatform();
}

/** The Android shell is the only native build with media, overlay, and asset transport plugins. */
export function isAndroidApp() {
  return Capacitor.getPlatform() === "android";
}

export function isIOSApp() {
  return Capacitor.getPlatform() === "ios";
}

export function normalizeServerURL(value: string) {
  let next = value.trim();
  if (!next) throw new Error("Server address is required.");

  const explicitProtocol = /^([a-z][a-z\d+.-]*):\/\//i.exec(next)?.[1].toLowerCase();
  if (explicitProtocol && explicitProtocol !== "http" && explicitProtocol !== "https") {
    throw new Error("Server address must use http or https.");
  }
  if (!explicitProtocol) {
    next = `http://${next}`;
  }
  const parsed = new URL(next);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Server address must use http or https.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Server address must not contain credentials.");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

// A server address or session that cannot be kept fails the sign-in step instead of vanishing.
function storeOrThrow(key: StorageKey, value: string) {
  if (!localStore.write(key, value)) throw new Error("Browser storage is unavailable.");
}

export function getStoredServerURL() {
  return localStore.read(SERVER_URL_STORAGE_KEY) ?? "";
}

export async function setStoredServerURL(value: string) {
  const normalized = normalizeServerURL(value);
  // Clear the old credential durably before publishing a different server.
  // The base path is part of the identity: one origin may host multiple instances.
  if (normalized !== getStoredServerURL()) {
    await clearStoredSessionToken();
    // Requests may have started against the old server while native credential
    // removal was pending. Fence those too, at the point the new URL is published.
    changeApiSession();
  }
  storeOrThrow(SERVER_URL_STORAGE_KEY, normalized);
  if (!isNativeApp()) return;
  await Promise.all([
    Preferences.set({ key: SERVER_URL_STORAGE_KEY, value: normalized }),
    configureNativeAssetTransport(normalized, getStoredSessionToken()),
  ]);
}

export async function clearStoredServerURL() {
  changeApiSession();
  localStore.remove(SERVER_URL_STORAGE_KEY);
  localStore.remove(SESSION_TOKEN_STORAGE_KEY);
  nativeSession = "";
  if (!isNativeApp()) return;
  await Promise.all([
    Preferences.remove({ key: SERVER_URL_STORAGE_KEY }),
    clearNativeSessionCredential(),
    clearNativeAssetTransport(),
  ]);
}

export function getStoredSessionToken() {
  if (isNativeApp()) return nativeSession;
  return localStore.read(SESSION_TOKEN_STORAGE_KEY) ?? "";
}

export async function setStoredSessionToken(value: string) {
  if (value.trim()) {
    const token = value.trim();
    if (token !== getStoredSessionToken()) changeApiSession();
    if (!isNativeApp()) {
      storeOrThrow(SESSION_TOKEN_STORAGE_KEY, token);
      return;
    }
    nativeSession = token;
    await Promise.all([
      writeNativeSessionCredential(token),
      configureNativeAssetTransport(getStoredServerURL(), token),
    ]);
  }
}

export async function clearStoredSessionToken() {
  changeApiSession();
  localStore.remove(SESSION_TOKEN_STORAGE_KEY);
  nativeSession = "";
  if (!isNativeApp()) return;
  const serverUrl = getStoredServerURL();
  await Promise.all([
    clearNativeSessionCredential(),
    serverUrl ? configureNativeAssetTransport(serverUrl, "") : clearNativeAssetTransport(),
  ]);
}

export async function hydrateNativeConfig() {
  if (!isNativeApp()) return;
  const [server, token] = await Promise.all([
    Preferences.get({ key: SERVER_URL_STORAGE_KEY }),
    readNativeSessionCredential(),
  ]);
  const serverUrl = server.value?.trim() ?? "";
  const credential = serverUrl ? token : "";
  if (serverUrl !== getStoredServerURL() || credential !== getStoredSessionToken()) changeApiSession();
  if (serverUrl) localStore.write(SERVER_URL_STORAGE_KEY, serverUrl);
  else localStore.remove(SERVER_URL_STORAGE_KEY);
  localStore.remove(SESSION_TOKEN_STORAGE_KEY);
  nativeSession = credential;
  // A Keychain item outlives an app removal that cleared the server address.
  if (!serverUrl && token) await clearNativeSessionCredential();
  if (serverUrl) await configureNativeAssetTransport(serverUrl, credential);
  else await clearNativeAssetTransport();
}
