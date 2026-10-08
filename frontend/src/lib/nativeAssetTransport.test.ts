import { beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => vi.fn(() => "web"));
const plugin = vi.hoisted(() => ({ configure: vi.fn(), clear: vi.fn() }));
const registerPlugin = vi.hoisted(() => vi.fn(() => plugin));

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: platform, isNativePlatform: () => platform() !== "web" },
  registerPlugin,
}));

import { clearNativeAssetTransport, configureNativeAssetTransport, nativeAssetURL } from "./nativeAssetTransport";

const SERVER = "https://server.example.invalid/kikoto";

describe("native asset transport bridge", () => {
  beforeEach(() => {
    platform.mockReset();
    platform.mockReturnValue("web");
    plugin.configure.mockReset();
    plugin.clear.mockReset();
  });

  it("does not initialize the plugin in a browser", async () => {
    await configureNativeAssetTransport(SERVER, "synthetic-token");
    await clearNativeAssetTransport();

    expect(registerPlugin).not.toHaveBeenCalled();
  });

  it("forwards Android configuration and credential clearing", async () => {
    platform.mockReturnValue("android");
    plugin.configure.mockResolvedValue(undefined);
    plugin.clear.mockResolvedValue(undefined);

    await configureNativeAssetTransport(SERVER, "synthetic-token");
    await clearNativeAssetTransport();

    expect(registerPlugin).toHaveBeenCalledWith("KikotoAssetTransport");
    expect(plugin.configure).toHaveBeenCalledWith({ serverUrl: SERVER, sessionToken: "synthetic-token" });
    expect(plugin.clear).toHaveBeenCalledOnce();
  });

  it("forwards iOS configuration to the asset scheme handler", async () => {
    platform.mockReturnValue("ios");
    plugin.configure.mockResolvedValue(undefined);

    await configureNativeAssetTransport(SERVER, "synthetic-token");

    expect(plugin.configure).toHaveBeenCalledWith({ serverUrl: SERVER, sessionToken: "synthetic-token" });
  });
});

describe("native asset URLs", () => {
  beforeEach(() => {
    platform.mockReset();
    platform.mockReturnValue("ios");
  });

  it("routes configured-server media and images through the iOS asset scheme", () => {
    expect(nativeAssetURL(`${SERVER}/api/media/7/stream?profile=audio&forceDirect=1`, SERVER)).toBe(
      "kikoto-asset://asset/api/media/7/stream?profile=audio&forceDirect=1",
    );
    expect(nativeAssetURL(`${SERVER}/api/assets/covers/RJ00000001/main.jpg`, SERVER)).toBe(
      "kikoto-asset://asset/api/assets/covers/RJ00000001/main.jpg",
    );
    expect(nativeAssetURL(`${SERVER}/api/media/7/hls/index.m3u8`, SERVER)).toBe(
      "kikoto-asset://asset/api/media/7/hls/index.m3u8",
    );
  });

  it("leaves other routes, origins, and look-alike base paths on the network", () => {
    expect(nativeAssetURL(`${SERVER}/api/works/1`, SERVER)).toBe(`${SERVER}/api/works/1`);
    expect(nativeAssetURL(`${SERVER}/api/assets/manual/a/b.jpg`, SERVER)).toBe(`${SERVER}/api/assets/manual/a/b.jpg`);
    expect(nativeAssetURL("https://other.example.invalid/kikoto/api/media/7/stream", SERVER)).toBe(
      "https://other.example.invalid/kikoto/api/media/7/stream",
    );
    expect(nativeAssetURL(`${SERVER}-other/api/media/7/stream`, SERVER)).toBe(`${SERVER}-other/api/media/7/stream`);
  });

  it("does not rewrite outside the iOS shell", () => {
    platform.mockReturnValue("android");

    expect(nativeAssetURL(`${SERVER}/api/media/7/stream`, SERVER)).toBe(`${SERVER}/api/media/7/stream`);
  });
});
