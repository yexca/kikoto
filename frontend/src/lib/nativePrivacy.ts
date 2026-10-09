import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

/** Whether playback would use the device's own speaker rather than headphones or another output. */
export type NativeAudioOutput = { speaker: boolean };

type KikotoPrivacyPlugin = {
  appSwitcherShield(): Promise<{ enabled: boolean }>;
  setAppSwitcherShield(options: { enabled: boolean }): Promise<void>;
  screenCaptureShield(): Promise<{ enabled: boolean }>;
  setScreenCaptureShield(options: { enabled: boolean }): Promise<void>;
  audioOutput(): Promise<NativeAudioOutput>;
  addListener(eventName: "audioOutputLost", listener: () => void): Promise<PluginListenerHandle>;
  addListener(
    eventName: "audioOutputChange",
    listener: (output: NativeAudioOutput) => void,
  ): Promise<PluginListenerHandle>;
};

const pluginName = "KikotoPrivacy";
let plugin: KikotoPrivacyPlugin | null = null;

function nativePlugin() {
  plugin ??= registerPlugin<KikotoPrivacyPlugin>(pluginName);
  return plugin;
}

/** The iOS shell registers this app-local plugin; Android reports output loss through its media plugin. */
export function supportsNativePrivacy() {
  return Capacitor.isPluginAvailable(pluginName);
}

/** Whether the app is blurred while it is not the active app. The native default is on. */
export async function nativeAppSwitcherShield() {
  if (!supportsNativePrivacy()) return false;
  return (await nativePlugin().appSwitcherShield()).enabled;
}

export async function setNativeAppSwitcherShield(enabled: boolean) {
  if (!supportsNativePrivacy()) return;
  await nativePlugin().setAppSwitcherShield({ enabled });
}

/** Whether the app is hidden while the screen is recorded or mirrored. The native default is on. */
export async function nativeScreenCaptureShield() {
  if (!supportsNativePrivacy()) return false;
  return (await nativePlugin().screenCaptureShield()).enabled;
}

export async function setNativeScreenCaptureShield(enabled: boolean) {
  if (!supportsNativePrivacy()) return;
  await nativePlugin().setScreenCaptureShield({ enabled });
}

export async function nativeAudioOutput(): Promise<NativeAudioOutput | null> {
  if (!supportsNativePrivacy()) return null;
  return await nativePlugin().audioOutput();
}

/** Called after every audio route change with the new output. */
export async function addNativeAudioOutputListener(listener: (output: NativeAudioOutput) => void) {
  if (!supportsNativePrivacy()) return () => {};
  const handle = await nativePlugin().addListener("audioOutputChange", listener);
  return () => {
    void handle.remove();
  };
}

/** Called when the audio output in use disappears, such as unplugged or disconnected headphones. */
export async function addNativeAudioOutputLostListener(listener: () => void) {
  if (!supportsNativePrivacy()) return () => {};
  const handle = await nativePlugin().addListener("audioOutputLost", listener);
  return () => {
    void handle.remove();
  };
}
