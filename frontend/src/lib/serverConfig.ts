import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";

import { clearNativeAssetTransport, configureNativeAssetTransport } from "@/lib/nativeAssetTransport";

const SERVER_URL_STORAGE_KEY = "kikoto:mobile-server-url";
const SESSION_TOKEN_STORAGE_KEY = "kikoto:mobile-session-token";

export function isNativeApp() {
  return Capacitor.isNativePlatform();
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
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

export function getStoredServerURL() {
  return localStorage.getItem(SERVER_URL_STORAGE_KEY) ?? "";
}

export async function setStoredServerURL(value: string) {
  const normalized = normalizeServerURL(value);
  localStorage.setItem(SERVER_URL_STORAGE_KEY, normalized);
  if (!isNativeApp()) return;
  await Promise.all([
    Preferences.set({ key: SERVER_URL_STORAGE_KEY, value: normalized }),
    configureNativeAssetTransport(normalized, getStoredSessionToken()),
  ]);
}

export async function clearStoredServerURL() {
  localStorage.removeItem(SERVER_URL_STORAGE_KEY);
  localStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
  if (!isNativeApp()) return;
  await Promise.all([
    Preferences.remove({ key: SERVER_URL_STORAGE_KEY }),
    Preferences.remove({ key: SESSION_TOKEN_STORAGE_KEY }),
    clearNativeAssetTransport(),
  ]);
}

export function getStoredSessionToken() {
  return localStorage.getItem(SESSION_TOKEN_STORAGE_KEY) ?? "";
}

export async function setStoredSessionToken(value: string) {
  if (value.trim()) {
    const token = value.trim();
    localStorage.setItem(SESSION_TOKEN_STORAGE_KEY, token);
    if (!isNativeApp()) return;
    await Promise.all([
      Preferences.set({ key: SESSION_TOKEN_STORAGE_KEY, value: token }),
      configureNativeAssetTransport(getStoredServerURL(), token),
    ]);
  }
}

export async function clearStoredSessionToken() {
  localStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
  if (!isNativeApp()) return;
  const serverUrl = getStoredServerURL();
  await Promise.all([
    Preferences.remove({ key: SESSION_TOKEN_STORAGE_KEY }),
    serverUrl ? configureNativeAssetTransport(serverUrl, "") : clearNativeAssetTransport(),
  ]);
}

export async function hydrateNativeConfig() {
  if (!isNativeApp()) return;
  const [server, token] = await Promise.all([
    Preferences.get({ key: SERVER_URL_STORAGE_KEY }),
    Preferences.get({ key: SESSION_TOKEN_STORAGE_KEY }),
  ]);
  const serverUrl = server.value?.trim() ?? "";
  const credential = serverUrl ? (token.value?.trim() ?? "") : "";
  if (serverUrl) localStorage.setItem(SERVER_URL_STORAGE_KEY, serverUrl);
  else localStorage.removeItem(SERVER_URL_STORAGE_KEY);
  if (credential) localStorage.setItem(SESSION_TOKEN_STORAGE_KEY, credential);
  else localStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
  if (serverUrl) await configureNativeAssetTransport(serverUrl, credential);
  else await clearNativeAssetTransport();
}
