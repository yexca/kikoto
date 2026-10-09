import { beforeEach, describe, expect, it, vi } from "vitest";

const pluginAvailable = vi.hoisted(() => vi.fn(() => false));
const keychainRead = vi.hoisted(() => vi.fn());
const keychainWrite = vi.hoisted(() => vi.fn());
const keychainClear = vi.hoisted(() => vi.fn());
const preferenceGet = vi.hoisted(() => vi.fn());
const preferenceSet = vi.hoisted(() => vi.fn());
const preferenceRemove = vi.hoisted(() => vi.fn());

vi.mock("@capacitor/core", () => ({
  Capacitor: { isPluginAvailable: pluginAvailable },
  registerPlugin: () => ({ read: keychainRead, write: keychainWrite, clear: keychainClear }),
}));
vi.mock("@capacitor/preferences", () => ({
  Preferences: { get: preferenceGet, set: preferenceSet, remove: preferenceRemove },
}));

import {
  clearNativeSessionCredential,
  readNativeSessionCredential,
  writeNativeSessionCredential,
} from "./nativeSessionCredential";

const preferenceKey = { key: "kikoto:mobile-session-token" };

describe("native session credential", () => {
  beforeEach(() => {
    for (const mock of [keychainRead, keychainWrite, keychainClear, preferenceGet, preferenceSet, preferenceRemove]) {
      mock.mockReset();
      mock.mockResolvedValue(undefined);
    }
    keychainRead.mockResolvedValue({ value: "" });
    preferenceGet.mockResolvedValue({ value: null });
  });

  it("uses app preferences where no Keychain plugin is registered", async () => {
    pluginAvailable.mockReturnValue(false);
    preferenceGet.mockResolvedValue({ value: " synthetic-token " });

    await expect(readNativeSessionCredential()).resolves.toBe("synthetic-token");
    await writeNativeSessionCredential("synthetic-token");
    await clearNativeSessionCredential();

    expect(preferenceSet).toHaveBeenCalledWith({ ...preferenceKey, value: "synthetic-token" });
    expect(preferenceRemove).toHaveBeenCalledWith(preferenceKey);
    expect(keychainRead).not.toHaveBeenCalled();
  });

  it("keeps the iOS session in the Keychain only", async () => {
    pluginAvailable.mockReturnValue(true);
    keychainRead.mockResolvedValue({ value: "synthetic-token" });

    await expect(readNativeSessionCredential()).resolves.toBe("synthetic-token");
    await writeNativeSessionCredential("synthetic-token");
    await clearNativeSessionCredential();

    expect(keychainWrite).toHaveBeenCalledWith({ value: "synthetic-token" });
    expect(keychainClear).toHaveBeenCalledOnce();
    expect(preferenceSet).not.toHaveBeenCalled();
    expect(preferenceRemove).not.toHaveBeenCalled();
  });

  it("moves an iOS session from app preferences into the Keychain", async () => {
    pluginAvailable.mockReturnValue(true);
    preferenceGet.mockResolvedValue({ value: "synthetic-token" });

    await expect(readNativeSessionCredential()).resolves.toBe("synthetic-token");

    expect(keychainWrite).toHaveBeenCalledWith({ value: "synthetic-token" });
    expect(preferenceRemove).toHaveBeenCalledWith(preferenceKey);
  });

  it("prefers the Keychain session and still removes the preference copy", async () => {
    pluginAvailable.mockReturnValue(true);
    keychainRead.mockResolvedValue({ value: "keychain-token" });
    preferenceGet.mockResolvedValue({ value: "stale-token" });

    await expect(readNativeSessionCredential()).resolves.toBe("keychain-token");

    expect(keychainWrite).not.toHaveBeenCalled();
    expect(preferenceRemove).toHaveBeenCalledWith(preferenceKey);
  });
});
