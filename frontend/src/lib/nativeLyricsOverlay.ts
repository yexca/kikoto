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
};

export type NativeLyricsOverlayState = NativeLyricsOverlayPlayback & {
  title: string;
  lines: { timeMs: number; text: string }[];
};

type LyricsPictureInPicturePlugin = {
  status(): Promise<{ supported: boolean; permitted: boolean }>;
  show(state: NativeLyricsOverlayState): Promise<void>;
  update(playback: NativeLyricsOverlayPlayback): Promise<void>;
  hide(): Promise<void>;
  addListener(eventName: "closed", listener: () => void): Promise<PluginListenerHandle>;
  addListener(
    eventName: "playbackControl",
    listener: (event: { playing: boolean }) => void,
  ): Promise<PluginListenerHandle>;
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

export async function showNativeLyricsOverlay(state: NativeLyricsOverlayState) {
  const pictureInPicture = lyricsPictureInPicture();
  if (!pictureInPicture) return showAndroidLyricsOverlay(state);
  await pictureInPicture.show(state).catch(() => {});
}

export async function updateNativeLyricsOverlayPlayback(playback: NativeLyricsOverlayPlayback) {
  const pictureInPicture = lyricsPictureInPicture();
  if (!pictureInPicture) return updateAndroidLyricsOverlayPlayback(playback);
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
