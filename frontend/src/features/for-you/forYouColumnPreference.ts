import { FOR_YOU_COLUMNS, type ForYouColumn } from "@/lib/forYouApi";

const storagePrefix = "kikoto:for-you-column:";

/**
 * The column last chosen on a narrow For you, a per-device convenience for a
 * server-and-user storage scope. Maybe like opens when nothing usable is kept.
 */
export function readForYouColumnPreference(storageScope: string): ForYouColumn {
  try {
    const stored = window.localStorage.getItem(`${storagePrefix}${storageScope}`);
    return FOR_YOU_COLUMNS.find((column) => column === stored) ?? "maybe_like";
  } catch {
    return "maybe_like";
  }
}

export function writeForYouColumnPreference(storageScope: string, column: ForYouColumn) {
  try {
    window.localStorage.setItem(`${storagePrefix}${storageScope}`, column);
  } catch {
    // The choice lasts for this visit when local storage is unavailable.
  }
}
