export const APP_CLIENT_VERSION = "v0.1.2";
export const APP_CLIENT_KIND = "android";

export function versionLabel() {
  return `${APP_CLIENT_KIND} ${APP_CLIENT_VERSION}`;
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
