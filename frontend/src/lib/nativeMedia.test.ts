import { beforeEach, describe, expect, it, vi } from "vitest";

const isNativeApp = vi.hoisted(() => vi.fn(() => false));
const plugin = vi.hoisted(() => ({
  update: vi.fn(),
  stop: vi.fn(),
  requestAudioFocus: vi.fn(),
  abandonAudioFocus: vi.fn(),
  addListener: vi.fn(),
}));
const registerPlugin = vi.hoisted(() => vi.fn(() => plugin));

vi.mock("@capacitor/core", () => ({ registerPlugin }));
vi.mock("@/lib/serverConfig", () => ({ isNativeApp }));

import {
  abandonNativeAudioFocus,
  addNativeMediaListeners,
  requestNativeAudioFocus,
  stopNativeMedia,
  supportsNativeMedia,
  updateNativeMedia,
} from "./nativeMedia";

const mediaState = {
  title: "Example Work",
  artist: "Example Voice",
  album: "Example Circle",
  coverUrl: "/assets/example-cover.jpg",
  playing: true,
  positionMs: 1_000,
  durationMs: 2_000,
  playbackRate: 1,
  canPrevious: false,
  canNext: true,
};

describe("native media bridge", () => {
  beforeEach(() => {
    isNativeApp.mockReset();
    isNativeApp.mockReturnValue(false);
    plugin.update.mockReset();
    plugin.stop.mockReset();
    plugin.requestAudioFocus.mockReset();
    plugin.abandonAudioFocus.mockReset();
    plugin.addListener.mockReset();
  });

  it("does not call a native plugin in the browser", async () => {
    await updateNativeMedia(mediaState);
    await stopNativeMedia();
    await abandonNativeAudioFocus();
    const dispose = await addNativeMediaListeners({ onControl: vi.fn() });
    dispose();

    expect(supportsNativeMedia()).toBe(false);
    expect(await requestNativeAudioFocus()).toBe(false);
    expect(plugin.update).not.toHaveBeenCalled();
    expect(plugin.stop).not.toHaveBeenCalled();
    expect(plugin.addListener).not.toHaveBeenCalled();
  });

  it("forwards media lifecycle calls and listener cleanup on native platforms", async () => {
    isNativeApp.mockReturnValue(true);
    plugin.update.mockResolvedValue(undefined);
    plugin.stop.mockResolvedValue(undefined);
    plugin.requestAudioFocus.mockResolvedValue({ granted: true });
    plugin.abandonAudioFocus.mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);
    plugin.addListener.mockResolvedValue({ remove });
    const onControl = vi.fn();

    await updateNativeMedia(mediaState);
    await stopNativeMedia();
    expect(await requestNativeAudioFocus()).toBe(true);
    await abandonNativeAudioFocus();
    const dispose = await addNativeMediaListeners({ onControl });
    dispose();

    expect(supportsNativeMedia()).toBe(true);
    expect(plugin.update).toHaveBeenCalledWith(mediaState);
    expect(plugin.stop).toHaveBeenCalledOnce();
    expect(plugin.abandonAudioFocus).toHaveBeenCalledOnce();
    expect(plugin.addListener).toHaveBeenCalledWith("mediaControl", onControl);
    expect(remove).toHaveBeenCalledOnce();
  });

  it("contains unavailable native-plugin failures", async () => {
    isNativeApp.mockReturnValue(true);
    plugin.update.mockRejectedValue(new Error("plugin unavailable"));
    plugin.stop.mockRejectedValue(new Error("plugin unavailable"));
    plugin.requestAudioFocus.mockRejectedValue(new Error("plugin unavailable"));
    plugin.abandonAudioFocus.mockRejectedValue(new Error("plugin unavailable"));

    await expect(updateNativeMedia(mediaState)).resolves.toBeUndefined();
    await expect(stopNativeMedia()).resolves.toBeUndefined();
    await expect(requestNativeAudioFocus()).resolves.toBe(false);
    await expect(abandonNativeAudioFocus()).resolves.toBeUndefined();
  });
});
