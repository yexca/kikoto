import { beforeEach, describe, expect, it, vi } from "vitest";

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
  hideNativeLyricsOverlay,
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

  it("offers no native surface in a browser", () => {
    expect(supportsNativeLyricsOverlay()).toBe(false);
  });
});
