import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

import {
  addNativeLyricsOverlayListener as addAndroidLyricsOverlayListener,
  hideNativeLyricsOverlay as hideAndroidLyricsOverlay,
  nativeLyricsOverlayStatus as androidLyricsOverlayStatus,
  requestNativeLyricsOverlayPermission as requestAndroidLyricsOverlayPermission,
  showNativeLyricsOverlay as showAndroidLyricsOverlay,
  supportsNativeMedia,
  updateNativeLyricsOverlayPlayback as updateAndroidLyricsOverlayPlayback,
} from "@/lib/nativeMedia";

export type NativeLyricsOverlayPlayback = {
  positionMs: number;
  playing: boolean;
  playbackRate: number;
  /** Track length for the Picture-in-Picture progress bar and skip buttons; 0 when unknown. */
  durationMs?: number;
};

export type NativeLyricsOverlayState = NativeLyricsOverlayPlayback & {
  title: string;
  lines: { timeMs: number; text: string }[];
};

/** Resolved theme colors as `#rrggbb`, so the native window follows the app theme. */
export type LyricsPictureInPictureAppearance = {
  background: string;
  foreground: string;
  accent: string;
};

type LyricsPictureInPicturePlugin = {
  status(): Promise<{ supported: boolean; permitted: boolean }>;
  show(state: NativeLyricsOverlayState & { appearance?: LyricsPictureInPictureAppearance }): Promise<void>;
  update(playback: NativeLyricsOverlayPlayback): Promise<void>;
  hide(): Promise<void>;
  addListener(eventName: "closed", listener: () => void): Promise<PluginListenerHandle>;
  addListener(
    eventName: "playbackControl",
    listener: (event: { playing: boolean }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(eventName: "seek", listener: (event: { positionMs: number }) => void): Promise<PluginListenerHandle>;
};

const pictureInPicturePluginName = "KikotoLyricsPictureInPicture";
let pictureInPicturePlugin: LyricsPictureInPicturePlugin | null = null;

/**
 * The app-local Picture-in-Picture lyrics plugin, when this shell registers
 * it. WKWebView exposes no usable web Picture-in-Picture, so the iOS shell
 * renders the lyric line natively instead.
 */
function lyricsPictureInPicture() {
  if (supportsNativeMedia() || !Capacitor.isPluginAvailable(pictureInPicturePluginName)) return null;
  pictureInPicturePlugin ??= registerPlugin<LyricsPictureInPicturePlugin>(pictureInPicturePluginName);
  return pictureInPicturePlugin;
}

/** Converts a design-token HSL triplet such as `36 38% 95%` to `#rrggbb`, or "" when it is not one. */
export function hslTokenToHex(token: string) {
  const match = /^(-?\d+(?:\.\d+)?)(?:deg)?\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/.exec(token.trim());
  if (!match) return "";
  const hue = (((Number(match[1]) % 360) + 360) % 360) / 360;
  const saturation = Math.min(100, Number(match[2])) / 100;
  const lightness = Math.min(100, Number(match[3])) / 100;
  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  const channel = (offset: number) => {
    let t = hue + offset;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    const value = t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(1 / 3)}${channel(0)}${channel(-1 / 3)}`;
}

/** The active theme's background, text, and primary colors, or undefined outside a themed document. */
function lyricsPictureInPictureAppearance(): LyricsPictureInPictureAppearance | undefined {
  if (typeof document === "undefined") return undefined;
  const styles = getComputedStyle(document.documentElement);
  const background = hslTokenToHex(styles.getPropertyValue("--background"));
  const foreground = hslTokenToHex(styles.getPropertyValue("--foreground"));
  const accent = hslTokenToHex(styles.getPropertyValue("--primary"));
  return background && foreground && accent ? { background, foreground, accent } : undefined;
}

/**
 * Whether a native surface can keep the current lyric line on screen: the
 * Android media overlay or the iOS Picture-in-Picture plugin. Both follow one
 * contract: status, show the timed track, update playback, hide, and a closed
 * event. The native side advances the line on its own clock, so it stays in
 * sync while the web view is in the background.
 */
export function supportsNativeLyricsOverlay() {
  return supportsNativeMedia() || lyricsPictureInPicture() !== null;
}

export async function nativeLyricsOverlayStatus() {
  const pictureInPicture = lyricsPictureInPicture();
  if (!pictureInPicture) return androidLyricsOverlayStatus();
  return await pictureInPicture.status().catch(() => ({ supported: false, permitted: false }));
}

export async function requestNativeLyricsOverlayPermission() {
  // Picture-in-Picture needs no runtime permission.
  if (!lyricsPictureInPicture()) await requestAndroidLyricsOverlayPermission();
}

/** The Android overlay has no progress bar, so its payload stays as it was. */
function withoutDuration<T extends NativeLyricsOverlayPlayback>(value: T): Omit<T, "durationMs"> {
  const { durationMs: _durationMs, ...rest } = value;
  return rest;
}

export async function showNativeLyricsOverlay(state: NativeLyricsOverlayState) {
  const pictureInPicture = lyricsPictureInPicture();
  if (!pictureInPicture) return showAndroidLyricsOverlay(withoutDuration(state));
  const appearance = lyricsPictureInPictureAppearance();
  await pictureInPicture.show(appearance ? { ...state, appearance } : state).catch(() => {});
}

export async function updateNativeLyricsOverlayPlayback(playback: NativeLyricsOverlayPlayback) {
  const pictureInPicture = lyricsPictureInPicture();
  if (!pictureInPicture) return updateAndroidLyricsOverlayPlayback(withoutDuration(playback));
  await pictureInPicture.update(playback).catch(() => {});
}

export async function hideNativeLyricsOverlay() {
  const pictureInPicture = lyricsPictureInPicture();
  if (!pictureInPicture) return hideAndroidLyricsOverlay();
  await pictureInPicture.hide().catch(() => {});
}

export async function addNativeLyricsOverlayListener(onClosed: () => void) {
  const pictureInPicture = lyricsPictureInPicture();
  if (!pictureInPicture) return addAndroidLyricsOverlayListener(onClosed);
  const handle = await pictureInPicture.addListener("closed", onClosed);
  return () => {
    void handle.remove();
  };
}

/** Play or pause requested from the Picture-in-Picture window's own controls. */
export async function addNativeLyricsOverlayPlaybackListener(onPlaying: (playing: boolean) => void) {
  const pictureInPicture = lyricsPictureInPicture();
  if (!pictureInPicture) return () => {};
  const handle = await pictureInPicture.addListener("playbackControl", (event) => onPlaying(event.playing));
  return () => {
    void handle.remove();
  };
}

/** A seek requested from the Picture-in-Picture window's skip buttons, as an absolute position. */
export async function addNativeLyricsOverlaySeekListener(onSeek: (positionMs: number) => void) {
  const pictureInPicture = lyricsPictureInPicture();
  if (!pictureInPicture) return () => {};
  const handle = await pictureInPicture.addListener("seek", (event) => {
    if (Number.isFinite(event.positionMs)) onSeek(Math.max(0, event.positionMs));
  });
  return () => {
    void handle.remove();
  };
}
