import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const available = vi.hoisted(() => ({ plugins: new Set<string>() }));
const pictureInPicture = vi.hoisted(() => ({
  status: vi.fn(async () => ({ supported: true, permitted: true })),
  show: vi.fn(async () => {}),
  update: vi.fn(async () => {}),
  hide: vi.fn(async () => {}),
  addListener: vi.fn(async () => ({ remove: vi.fn(async () => {}) })),
}));
const android = vi.hoisted(() => ({
  supportsNativeMedia: vi.fn(() => false),
  nativeLyricsOverlayStatus: vi.fn(async () => ({ supported: false, permitted: false })),
  requestNativeLyricsOverlayPermission: vi.fn(async () => {}),
  showNativeLyricsOverlay: vi.fn(async () => {}),
  updateNativeLyricsOverlayPlayback: vi.fn(async () => {}),
  hideNativeLyricsOverlay: vi.fn(async () => {}),
  addNativeLyricsOverlayListener: vi.fn(async () => () => {}),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isPluginAvailable: (name: string) => available.plugins.has(name) },
  registerPlugin: () => pictureInPicture,
}));
vi.mock("@/lib/nativeMedia", () => android);

import {
  addNativeLyricsOverlayPlaybackListener,
  addNativeLyricsOverlaySeekListener,
  hideNativeLyricsOverlay,
  hslTokenToHex,
  nativeLyricsOverlayStatus,
  requestNativeLyricsOverlayPermission,
  showNativeLyricsOverlay,
  supportsNativeLyricsOverlay,
  updateNativeLyricsOverlayPlayback,
} from "./nativeLyricsOverlay";

const state = {
  title: "Example Work",
  lines: [{ timeMs: 0, text: "Example line" }],
  positionMs: 0,
  playing: true,
  playbackRate: 1,
};
const playback = { positionMs: 1_000, playing: false, playbackRate: 1 };

async function exerciseContract() {
  await nativeLyricsOverlayStatus();
  await requestNativeLyricsOverlayPermission();
  await showNativeLyricsOverlay(state);
  await updateNativeLyricsOverlayPlayback(playback);
  await hideNativeLyricsOverlay();
}

describe("native lyrics overlay routing", () => {
  afterEach(() => vi.unstubAllGlobals());

  beforeEach(() => {
    vi.clearAllMocks();
    available.plugins.clear();
    android.supportsNativeMedia.mockReturnValue(false);
  });

  it("uses the Picture-in-Picture plugin where the shell registers it", async () => {
    available.plugins.add("KikotoLyricsPictureInPicture");

    expect(supportsNativeLyricsOverlay()).toBe(true);
    await exerciseContract();

    expect(pictureInPicture.status).toHaveBeenCalled();
    expect(pictureInPicture.show).toHaveBeenCalledWith(state);
    expect(pictureInPicture.update).toHaveBeenCalledWith(playback);
    expect(pictureInPicture.hide).toHaveBeenCalled();
    expect(android.requestNativeLyricsOverlayPermission).not.toHaveBeenCalled();
    expect(android.showNativeLyricsOverlay).not.toHaveBeenCalled();
  });

  it("keeps the Android overlay on the Android media bridge", async () => {
    android.supportsNativeMedia.mockReturnValue(true);
    available.plugins.add("KikotoLyricsPictureInPicture");

    expect(supportsNativeLyricsOverlay()).toBe(true);
    await exerciseContract();

    expect(android.showNativeLyricsOverlay).toHaveBeenCalledWith(state);
    expect(android.updateNativeLyricsOverlayPlayback).toHaveBeenCalledWith(playback);
    expect(android.requestNativeLyricsOverlayPermission).toHaveBeenCalled();
    expect(pictureInPicture.show).not.toHaveBeenCalled();
    expect(await addNativeLyricsOverlayPlaybackListener(vi.fn())).toBeTypeOf("function");
    expect(pictureInPicture.addListener).not.toHaveBeenCalled();
  });

  it("draws the Picture-in-Picture window in the active theme colors", async () => {
    available.plugins.add("KikotoLyricsPictureInPicture");
    const tokens: Record<string, string> = {
      "--background": "0 0% 98%",
      "--foreground": " 0 0% 12%",
      "--primary": "120 100% 25%",
    };
    vi.stubGlobal("document", { documentElement: {} });
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: (name: string) => tokens[name] ?? "" }));

    await showNativeLyricsOverlay(state);

    expect(pictureInPicture.show).toHaveBeenCalledWith({
      ...state,
      appearance: { background: "#fafafa", foreground: "#1f1f1f", accent: "#008000" },
    });
  });

  it("keeps the Android overlay payload free of Picture-in-Picture styling and progress", async () => {
    android.supportsNativeMedia.mockReturnValue(true);
    vi.stubGlobal("document", { documentElement: {} });
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "0 0% 98%" }));

    await showNativeLyricsOverlay({ ...state, durationMs: 90_000 });
    await updateNativeLyricsOverlayPlayback({ ...playback, durationMs: 90_000 });

    expect(android.showNativeLyricsOverlay).toHaveBeenCalledWith(state);
    expect(android.updateNativeLyricsOverlayPlayback).toHaveBeenCalledWith(playback);
  });

  it("sends the track length to Picture-in-Picture and reports its skip-button seeks", async () => {
    available.plugins.add("KikotoLyricsPictureInPicture");
    const onSeek = vi.fn();

    await updateNativeLyricsOverlayPlayback({ ...playback, durationMs: 90_000 });
    await addNativeLyricsOverlaySeekListener(onSeek);
    const [eventName, listener] = pictureInPicture.addListener.mock.calls[0] as unknown as [
      string,
      (event: { positionMs: number }) => void,
    ];
    listener({ positionMs: 25_000 });
    listener({ positionMs: -5 });
    listener({ positionMs: Number.NaN });

    expect(pictureInPicture.update).toHaveBeenCalledWith({ ...playback, durationMs: 90_000 });
    expect(eventName).toBe("seek");
    expect(onSeek.mock.calls).toEqual([[25_000], [0]]);
  });

  it("registers no seek listener on the Android overlay", async () => {
    android.supportsNativeMedia.mockReturnValue(true);
    available.plugins.add("KikotoLyricsPictureInPicture");

    expect(await addNativeLyricsOverlaySeekListener(vi.fn())).toBeTypeOf("function");
    expect(pictureInPicture.addListener).not.toHaveBeenCalled();
  });

  it("offers no native surface in a browser", () => {
    expect(supportsNativeLyricsOverlay()).toBe(false);
  });
});

describe("theme token conversion", () => {
  it("converts design-token HSL triplets and rejects other values", () => {
    expect(hslTokenToHex("36 38% 95%")).toBe("#f7f3ed");
    expect(hslTokenToHex("211 100% 43%")).toBe("#006adb");
    expect(hslTokenToHex("0 0% 0%")).toBe("#000000");
    expect(hslTokenToHex("")).toBe("");
    expect(hslTokenToHex("#ffffff")).toBe("");
    expect(hslTokenToHex("var(--primary)")).toBe("");
  });
});
