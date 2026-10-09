import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

type KikotoPrivacyPlugin = {
  appSwitcherShield(): Promise<{ enabled: boolean }>;
  setAppSwitcherShield(options: { enabled: boolean }): Promise<void>;
  addListener(eventName: "audioOutputLost", listener: () => void): Promise<PluginListenerHandle>;
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

/** Called when the audio output in use disappears, such as unplugged or disconnected headphones. */
export async function addNativeAudioOutputLostListener(listener: () => void) {
  if (!supportsNativePrivacy()) return () => {};
  const handle = await nativePlugin().addListener("audioOutputLost", listener);
  return () => {
    void handle.remove();
  };
}
