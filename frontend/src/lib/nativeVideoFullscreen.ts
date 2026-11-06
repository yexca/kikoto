import { Capacitor, registerPlugin } from "@capacitor/core";

type KikotoVideoFullscreenPlugin = {
  lockLandscape(): Promise<void>;
  unlockOrientation(): Promise<void>;
};

const pluginName = "KikotoVideoFullscreen";
let plugin: KikotoVideoFullscreenPlugin | null = null;

/**
 * Shells that show WebView fullscreen themselves register this app-local
 * plugin, because their WebView rejects the Screen Orientation lock.
 */
export function supportsNativeVideoFullscreen() {
  return Capacitor.isPluginAvailable(pluginName);
}

function videoFullscreen() {
  plugin ??= registerPlugin<KikotoVideoFullscreenPlugin>(pluginName);
  return plugin;
}

/** Turns the screen to landscape until the fullscreen view closes or the lock is released. */
export function lockNativeVideoFullscreenLandscape() {
  return videoFullscreen().lockLandscape();
}

export function unlockNativeVideoFullscreenOrientation() {
  return videoFullscreen().unlockOrientation();
}
