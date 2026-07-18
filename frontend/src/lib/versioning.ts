export const KIKOTO_RELEASES_URL = "https://github.com/yexca/kikoto/releases";

export type AppVersionStatus =
  | "compatible"
  | "client-update-available"
  | "client-update-required"
  | "server-update-available";

export function appVersionStatus(clientVersion: string, serverVersion: string, minimumClientVersion = ""): AppVersionStatus {
  if (minimumClientVersion && compareVersions(clientVersion, minimumClientVersion) < 0) {
    return "client-update-required";
  }
  if (!serverVersion) return "compatible";
  const comparison = compareVersions(clientVersion, serverVersion);
  if (comparison < 0) return "client-update-available";
  if (comparison > 0) return "server-update-available";
  return "compatible";
}

export function githubReleaseURL(version = "") {
  const normalized = version.trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+$/.test(normalized)) return `${KIKOTO_RELEASES_URL}/latest`;
  return `${KIKOTO_RELEASES_URL}/tag/v${normalized}`;
}

export function compareVersions(a: string, b: string) {
  const left = versionParts(a);
  const right = versionParts(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function versionParts(value: string) {
  return value
    .replace(/^v/i, "")
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}
