import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock("@capacitor/preferences", () => ({
  Preferences: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
}));

import { accountKey, accountScopeKey, clientStore, deviceKey, localStore, serverKey } from "./clientStorage";

function memoryArea(values: Record<string, string> = {}) {
  const entries = new Map(Object.entries(values));
  return {
    entries,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    removeItem: (key: string) => void entries.delete(key),
  };
}

const blocked = () => {
  throw new Error("blocked");
};

describe("client storage keys", () => {
  afterEach(() => vi.unstubAllGlobals());

  // Saved values are read back under these exact keys, so a changed format loses them.
  it("names the device, the server, or the server and principal", () => {
    vi.stubGlobal("window", { location: { origin: "https://browser.example.invalid" } });

    expect(deviceKey("kikoto:theme")).toBe("kikoto:theme");
    expect(serverKey("kikoto:seed")).toBe("kikoto:seed:https%3A%2F%2Fbrowser.example.invalid");
    expect(accountKey("kikoto:queue", 7)).toBe("kikoto:queue:https%3A%2F%2Fbrowser.example.invalid:user-7");
    expect(accountKey("kikoto:locale", null)).toBe("kikoto:locale:https%3A%2F%2Fbrowser.example.invalid:anonymous");
    expect(accountScopeKey("kikoto:tab", "server:user-1", "library")).toBe("kikoto:tab:server:user-1:library");
  });
});

describe("client stores", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips strings and JSON and ignores what it cannot parse", () => {
    const area = memoryArea({ "kikoto:broken": "{not json" });
    const store = clientStore(() => area);

    expect(store.write(deviceKey("kikoto:text"), "on")).toBe(true);
    expect(store.read(deviceKey("kikoto:text"))).toBe("on");
    store.writeJSON(deviceKey("kikoto:value"), { columns: 3 });
    expect(store.readJSON(deviceKey("kikoto:value"))).toEqual({ columns: 3 });
    expect(store.readJSON(deviceKey("kikoto:broken"))).toBeNull();
    expect(store.readJSON(deviceKey("kikoto:absent"))).toBeNull();
    store.remove(deviceKey("kikoto:text"));
    expect(store.read(deviceKey("kikoto:text"))).toBeNull();
  });

  it("reports nothing stored when storage is missing, blocked, or full", () => {
    const key = deviceKey("kikoto:value");
    for (const store of [
      clientStore(() => null),
      clientStore(blocked),
      clientStore(() => ({ getItem: blocked, setItem: blocked, removeItem: blocked })),
    ]) {
      expect(store.read(key)).toBeNull();
      expect(store.readJSON(key)).toBeNull();
      expect(store.write(key, "on")).toBe(false);
      expect(() => store.remove(key)).not.toThrow();
    }
  });

  it("finds the browser storage on window or the global scope", () => {
    const area = memoryArea({ "kikoto:theme": "dark" });
    vi.stubGlobal("localStorage", area);
    expect(localStore.read(deviceKey("kikoto:theme"))).toBe("dark");
    vi.stubGlobal("window", { localStorage: memoryArea({ "kikoto:theme": "light" }) });
    expect(localStore.read(deviceKey("kikoto:theme"))).toBe("light");
  });

  it("carries a value to its new key once, keeping a value already there", () => {
    const area = memoryArea({ "kikoto:old": "saved", "kikoto:taken-old": "older" });
    const store = clientStore(() => area);

    store.carryOver(deviceKey("kikoto:old"), deviceKey("kikoto:new"));
    expect(Object.fromEntries(area.entries)).toMatchObject({ "kikoto:new": "saved" });
    expect(area.entries.has("kikoto:old")).toBe(false);

    area.setItem("kikoto:taken", "newer");
    store.carryOver(deviceKey("kikoto:taken-old"), deviceKey("kikoto:taken"));
    expect(area.getItem("kikoto:taken")).toBe("newer");
    expect(area.entries.has("kikoto:taken-old")).toBe(false);
  });

  it("keeps the old value when the new key cannot be written", () => {
    const area = { ...memoryArea({ "kikoto:old": "saved" }), setItem: blocked };
    clientStore(() => area).carryOver(deviceKey("kikoto:old"), deviceKey("kikoto:new"));
    expect(area.getItem("kikoto:old")).toBe("saved");
  });
});
