import { beforeEach, describe, expect, it, vi } from "vitest";

const nativePlatform = vi.hoisted(() => vi.fn(() => false));
const plugin = vi.hoisted(() => ({ configure: vi.fn(), clear: vi.fn() }));
const registerPlugin = vi.hoisted(() => vi.fn(() => plugin));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: nativePlatform },
  registerPlugin,
}));

import { clearNativeAssetTransport, configureNativeAssetTransport } from "./nativeAssetTransport";

describe("native asset transport bridge", () => {
  beforeEach(() => {
    nativePlatform.mockReset();
    nativePlatform.mockReturnValue(false);
    registerPlugin.mockClear();
    plugin.configure.mockReset();
    plugin.clear.mockReset();
  });

  it("does not initialize the plugin in a browser", async () => {
    await configureNativeAssetTransport("https://server.example.invalid/kikoto", "synthetic-token");
    await clearNativeAssetTransport();

    expect(registerPlugin).not.toHaveBeenCalled();
  });

  it("forwards native configuration and credential clearing", async () => {
    nativePlatform.mockReturnValue(true);
    plugin.configure.mockResolvedValue(undefined);
    plugin.clear.mockResolvedValue(undefined);

    await configureNativeAssetTransport("https://server.example.invalid/kikoto", "synthetic-token");
    await clearNativeAssetTransport();

    expect(registerPlugin).toHaveBeenCalledWith("KikotoAssetTransport");
    expect(plugin.configure).toHaveBeenCalledWith({
      serverUrl: "https://server.example.invalid/kikoto",
      sessionToken: "synthetic-token",
    });
    expect(plugin.clear).toHaveBeenCalledOnce();
  });
});
