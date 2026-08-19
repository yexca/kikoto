import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativePlatform = vi.hoisted(() => vi.fn(() => false));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: nativePlatform } }));
vi.mock("@capacitor/preferences", () => ({
  Preferences: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
}));

import {
  clientStorageScope,
  currentClientServerIdentity,
  currentClientStorageScope,
  currentScopedStorageKey,
  currentServerScopedStorageKey,
  normalizeClientServerIdentity,
} from "./clientStorageScope";

function storageWith(values: Record<string, string> = {}): Storage {
  const entries = new Map(Object.entries(values));
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: (key) => entries.delete(key),
    clear: () => entries.clear(),
    key: (index) => [...entries.keys()][index] ?? null,
    get length() {
      return entries.size;
    },
  };
}

describe("client storage scope", () => {
  beforeEach(() => nativePlatform.mockReturnValue(false));
  afterEach(() => vi.unstubAllGlobals());

  it("normalizes trailing slashes without changing a server path", () => {
    expect(normalizeClientServerIdentity(" https://example.test/kikoto/// ")).toBe("https://example.test/kikoto");
    expect(normalizeClientServerIdentity("  ")).toBe("same-origin");
  });

  it("isolates anonymous and authenticated principals on each server", () => {
    expect(clientStorageScope("https://one.invalid", null)).toBe("https%3A%2F%2Fone.invalid:anonymous");
    expect(clientStorageScope("https://one.invalid", 7)).toBe("https%3A%2F%2Fone.invalid:user-7");
    expect(clientStorageScope("https://two.invalid", 7)).not.toBe(clientStorageScope("https://one.invalid", 7));
  });

  it("scopes browser state to the current origin and principal", () => {
    vi.stubGlobal("window", { location: { origin: "https://browser.example.invalid" } });

    expect(currentClientServerIdentity()).toBe("https://browser.example.invalid");
    expect(currentClientStorageScope(null)).toBe("https%3A%2F%2Fbrowser.example.invalid:anonymous");
    expect(currentScopedStorageKey("kikoto:queue", 7)).toBe(
      "kikoto:queue:https%3A%2F%2Fbrowser.example.invalid:user-7",
    );
    expect(currentServerScopedStorageKey("kikoto:seed")).toBe("kikoto:seed:https%3A%2F%2Fbrowser.example.invalid");
  });

  it("uses the configured native server and has an explicit unconfigured scope", () => {
    nativePlatform.mockReturnValue(true);
    vi.stubGlobal("localStorage", storageWith({ "kikoto:mobile-server-url": " https://native.example.invalid/// " }));
    expect(currentClientServerIdentity()).toBe("https://native.example.invalid");

    vi.stubGlobal("localStorage", storageWith());
    expect(currentClientServerIdentity()).toBe("native-unconfigured");
  });
});
