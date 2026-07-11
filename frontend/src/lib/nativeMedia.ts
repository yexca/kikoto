import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

import { isNativeApp } from "@/lib/serverConfig";

type NativeMediaState = {
  title: string;
  artist: string;
  album: string;
  coverUrl: string;
  playing: boolean;
  positionMs: number;
  durationMs: number;
  playbackRate: number;
  canPrevious: boolean;
  canNext: boolean;
};

type NativeMediaControl = {
  command: "play" | "pause" | "previous" | "next" | "seekBackward" | "seekForward" | "seekTo";
  positionMs?: number;
};

type KikotoMediaPlugin = {
  update(state: NativeMediaState): Promise<void>;
  stop(): Promise<void>;
  requestAudioFocus(): Promise<{ granted: boolean }>;
  abandonAudioFocus(): Promise<void>;
  addListener(
    eventName: "mediaControl",
    listenerFunc: (event: NativeMediaControl) => void,
  ): Promise<PluginListenerHandle>;
};

const KikotoMedia = registerPlugin<KikotoMediaPlugin>("KikotoMedia");

export function supportsNativeMedia() {
  return isNativeApp();
}

export async function updateNativeMedia(state: NativeMediaState) {
  if (!supportsNativeMedia()) return;
  await KikotoMedia.update(state).catch(() => {});
}

export async function stopNativeMedia() {
  if (!supportsNativeMedia()) return;
  await KikotoMedia.stop().catch(() => {});
}

export async function requestNativeAudioFocus() {
  if (!supportsNativeMedia()) return false;
  const result = await KikotoMedia.requestAudioFocus().catch(() => ({ granted: false }));
  return result.granted;
}

export async function abandonNativeAudioFocus() {
  if (!supportsNativeMedia()) return;
  await KikotoMedia.abandonAudioFocus().catch(() => {});
}

export async function addNativeMediaListeners({
  onControl,
}: {
  onControl: (event: NativeMediaControl) => void;
}) {
  if (!supportsNativeMedia()) return () => {};
  const control = await KikotoMedia.addListener("mediaControl", onControl);
  return () => {
    void control.remove();
  };
}
