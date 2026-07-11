import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";

const SERVER_URL_STORAGE_KEY = "kikoto:mobile-server-url";
const SESSION_TOKEN_STORAGE_KEY = "kikoto:mobile-session-token";

export function isNativeApp() {
  return Capacitor.isNativePlatform();
}

export function normalizeServerURL(value: string) {
  let next = value.trim();
  if (!next) throw new Error("Server address is required.");
  if (!/^https?:\/\//i.test(next)) {
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

export function setStoredServerURL(value: string) {
  const normalized = normalizeServerURL(value);
  localStorage.setItem(SERVER_URL_STORAGE_KEY, normalized);
  if (isNativeApp()) void Preferences.set({ key: SERVER_URL_STORAGE_KEY, value: normalized });
}

export function clearStoredServerURL() {
  localStorage.removeItem(SERVER_URL_STORAGE_KEY);
  if (isNativeApp()) void Preferences.remove({ key: SERVER_URL_STORAGE_KEY });
  clearStoredSessionToken();
}

export function getStoredSessionToken() {
  return localStorage.getItem(SESSION_TOKEN_STORAGE_KEY) ?? "";
}

export function setStoredSessionToken(value: string) {
  if (value.trim()) {
    const token = value.trim();
    localStorage.setItem(SESSION_TOKEN_STORAGE_KEY, token);
    if (isNativeApp()) void Preferences.set({ key: SESSION_TOKEN_STORAGE_KEY, value: token });
  }
}

export function clearStoredSessionToken() {
  localStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
  if (isNativeApp()) void Preferences.remove({ key: SESSION_TOKEN_STORAGE_KEY });
}

export async function hydrateNativeConfig() {
  if (!isNativeApp()) return;
  const [server, token] = await Promise.all([
    Preferences.get({ key: SERVER_URL_STORAGE_KEY }),
    Preferences.get({ key: SESSION_TOKEN_STORAGE_KEY }),
  ]);
  if (server.value) localStorage.setItem(SERVER_URL_STORAGE_KEY, server.value);
  if (token.value) localStorage.setItem(SESSION_TOKEN_STORAGE_KEY, token.value);
}
