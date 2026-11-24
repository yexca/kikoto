/** A work file or folder path with forward slashes and no leading or trailing slash. */
export function normalizeRelativePath(path: string) {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}
