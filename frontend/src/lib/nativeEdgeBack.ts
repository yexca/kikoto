import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

/** Where the swipe started, in viewport CSS pixels. */
export type NativeEdgeBackSwipe = { x: number; y: number };

type KikotoEdgeBackPlugin = {
  addListener(eventName: "edgeBack", listener: (swipe: NativeEdgeBackSwipe) => void): Promise<PluginListenerHandle>;
};

const pluginName = "KikotoEdgeBack";
let plugin: KikotoEdgeBackPlugin | null = null;

/** Shells whose system back is a screen-edge swipe register this app-local plugin. */
export function supportsNativeEdgeBack() {
  return Capacitor.isPluginAvailable(pluginName);
}

export async function addNativeEdgeBackListener(listener: (swipe: NativeEdgeBackSwipe) => void) {
  if (!supportsNativeEdgeBack()) return () => {};
  plugin ??= registerPlugin<KikotoEdgeBackPlugin>(pluginName);
  const handle = await plugin.addListener("edgeBack", listener);
  return () => {
    void handle.remove();
  };
}
