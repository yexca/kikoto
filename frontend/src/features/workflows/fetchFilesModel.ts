import type { FetchFile } from "@/lib/api";

/** A file the run is working on or stopped on; it leads the list. */
export function isCurrentFetchFile(file: FetchFile) {
  return file.state !== "pending" && file.state !== "done";
}

/** Plan order, with the current file moved to the top so it stays in view. */
export function orderFetchFiles(files: FetchFile[]) {
  const current = files.filter(isCurrentFetchFile);
  if (current.length === 0) return files;
  return [...current, ...files.filter((file) => !isCurrentFetchFile(file))];
}

export function fetchFilesSummary(files: FetchFile[]) {
  return {
    done: files.filter((file) => file.state === "done").length,
    total: files.length,
    current: files.find(isCurrentFetchFile) ?? null,
  };
}

/** Percent of a file with a known size, or null when the size is unknown. */
export function fetchFilePercent(file: FetchFile) {
  if (file.sizeBytes === null || file.sizeBytes <= 0) return null;
  return Math.min(100, Math.max(0, (file.bytesCurrent / file.sizeBytes) * 100));
}
