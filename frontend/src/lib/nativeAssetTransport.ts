import { Capacitor, registerPlugin } from "@capacitor/core";

type KikotoAssetTransportPlugin = {
  configure(options: { serverUrl: string; sessionToken: string }): Promise<void>;
  clear(): Promise<void>;
};

let plugin: KikotoAssetTransportPlugin | null = null;

function nativePlugin() {
  plugin ??= registerPlugin<KikotoAssetTransportPlugin>("KikotoAssetTransport");
  return plugin;
}

export async function configureNativeAssetTransport(serverUrl: string, sessionToken: string) {
  if (!Capacitor.isNativePlatform()) return;
  await nativePlugin().configure({ serverUrl, sessionToken });
}

export async function clearNativeAssetTransport() {
  if (!Capacitor.isNativePlatform()) return;
  await nativePlugin().clear();
}
