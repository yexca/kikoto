export { KIKOTO_RELEASES_URL, appVersionStatus, compareVersions, githubReleaseURL } from "@/lib/versioning";

export const APP_CLIENT_VERSION = __APP_VERSION__;
export const APP_CLIENT_KIND = "android";

export function versionLabel() {
  return `${APP_CLIENT_KIND} ${APP_CLIENT_VERSION}`;
}
