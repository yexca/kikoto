import { Capacitor } from "@capacitor/core";

export { KIKOTO_RELEASES_URL, appVersionStatus, compareVersions, githubReleaseURL } from "@/lib/versioning";

export const APP_CLIENT_VERSION = __APP_VERSION__;

const CLIENT_PLATFORM_NAMES: Record<string, string> = { android: "Android", ios: "iOS", web: "Web" };

/** The shell actually running this bundle ("android", "ios", or "web"); one bundle ships in every shell. */
export function appClientKind() {
  return Capacitor.getPlatform();
}

/** Human-readable name of the running shell for status messages and diagnostics. */
export function appClientPlatformName() {
  const kind = appClientKind();
  return CLIENT_PLATFORM_NAMES[kind] ?? kind;
}

export function versionLabel() {
  return `${appClientKind()} ${APP_CLIENT_VERSION}`;
}
