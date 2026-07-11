import { Capacitor } from "@capacitor/core";

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
  localStorage.setItem(SERVER_URL_STORAGE_KEY, normalizeServerURL(value));
}

export function clearStoredServerURL() {
  localStorage.removeItem(SERVER_URL_STORAGE_KEY);
  clearStoredSessionToken();
}

export function getStoredSessionToken() {
  return localStorage.getItem(SESSION_TOKEN_STORAGE_KEY) ?? "";
}

export function setStoredSessionToken(value: string) {
  if (value.trim()) {
    localStorage.setItem(SESSION_TOKEN_STORAGE_KEY, value.trim());
  }
}

export function clearStoredSessionToken() {
  localStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
}
