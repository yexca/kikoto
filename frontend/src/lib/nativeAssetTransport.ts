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

const IOS_ASSET_ORIGIN = "kikoto-asset://asset";
// The native policy enforces the same routes; this only decides which URLs to rewrite.
const IOS_ASSET_ROUTE =
  /^\/api\/(?:assets\/covers\/.+|assets\/manual\/[^/]+|media\/[1-9][0-9]*\/(?:stream|asset|text|download|hls\/(?:index\.m3u8|segment-[0-9]{6}\.ts))|remote-sources\/[1-9][0-9]*\/works\/[^/]+\/(?:media|text)|remote-sources\/[1-9][0-9]*\/images\/[^/]+)$/;

/**
 * The Android WebView attaches the session credential to media, image, and
 * remote text requests by intercepting them. WKWebView cannot intercept its
 * own http(s) requests, so the iOS shell serves configured-server assets
 * through an app-owned scheme instead. Other URLs are returned unchanged.
 */
export function nativeAssetURL(url: string, serverURL: string) {
  if (!url || !serverURL || Capacitor.getPlatform() !== "ios") return url;
  if (!url.startsWith(`${serverURL}/`)) return url;
  const route = url.slice(serverURL.length);
  const path = route.split(/[?#]/, 1)[0];
  if (!IOS_ASSET_ROUTE.test(path)) return url;
  return `${IOS_ASSET_ORIGIN}${route}`;
}
