import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativePlatform = vi.hoisted(() => vi.fn(() => false));
const preferenceGet = vi.hoisted(() => vi.fn());
const preferenceSet = vi.hoisted(() => vi.fn());
const preferenceRemove = vi.hoisted(() => vi.fn());

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: nativePlatform },
}));
vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: preferenceGet,
    set: preferenceSet,
    remove: preferenceRemove,
  },
}));

import {
  clearStoredServerURL,
  clearStoredSessionToken,
  getStoredServerURL,
  getStoredSessionToken,
  hydrateNativeConfig,
  isNativeApp,
  normalizeServerURL,
  setStoredServerURL,
  setStoredSessionToken,
} from "./serverConfig";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

describe("mobile server configuration", () => {
  beforeEach(() => {
    nativePlatform.mockReturnValue(false);
    preferenceGet.mockReset();
    preferenceSet.mockReset();
    preferenceRemove.mockReset();
    vi.stubGlobal("localStorage", memoryStorage());
  });

  afterEach(() => vi.unstubAllGlobals());

  it("normalizes HTTP(S) addresses and rejects other explicit protocols", () => {
    expect(normalizeServerURL(" HTTPS://source.example.invalid/kikoto///?synthetic=1#section ")).toBe(
      "https://source.example.invalid/kikoto",
    );
    expect(normalizeServerURL("source.example.invalid:7655")).toBe("http://source.example.invalid:7655");
    expect(() => normalizeServerURL(" ")).toThrow("Server address is required.");
    expect(() => normalizeServerURL("ftp://source.example.invalid")).toThrow("http or https");
  });

  it("keeps browser storage normalized and clears the session with the server", () => {
    expect(isNativeApp()).toBe(false);
    setStoredServerURL(" source.example.invalid///?ignored=1 ");
    setStoredSessionToken(" synthetic-token ");
    setStoredSessionToken("   ");

    expect(getStoredServerURL()).toBe("http://source.example.invalid");
    expect(getStoredSessionToken()).toBe("synthetic-token");
    expect(preferenceSet).not.toHaveBeenCalled();

    clearStoredServerURL();
    expect(getStoredServerURL()).toBe("");
    expect(getStoredSessionToken()).toBe("");
    clearStoredSessionToken();
  });

  it("synchronizes native preferences during writes, clears, and hydration", async () => {
    nativePlatform.mockReturnValue(true);
    preferenceGet.mockImplementation(async ({ key }: { key: string }) => ({
      value: key.endsWith("url") ? "https://native.example.invalid" : "native-token",
    }));

    setStoredServerURL("https://source.example.invalid");
    setStoredSessionToken("synthetic-token");
    expect(preferenceSet).toHaveBeenCalledWith({
      key: "kikoto:mobile-server-url",
      value: "https://source.example.invalid",
    });
    expect(preferenceSet).toHaveBeenCalledWith({ key: "kikoto:mobile-session-token", value: "synthetic-token" });

    clearStoredServerURL();
    expect(preferenceRemove).toHaveBeenCalledWith({ key: "kikoto:mobile-server-url" });
    expect(preferenceRemove).toHaveBeenCalledWith({ key: "kikoto:mobile-session-token" });

    await hydrateNativeConfig();
    expect(getStoredServerURL()).toBe("https://native.example.invalid");
    expect(getStoredSessionToken()).toBe("native-token");
    expect(preferenceGet).toHaveBeenCalledTimes(2);
  });
});
