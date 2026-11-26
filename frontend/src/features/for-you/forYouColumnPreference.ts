import { accountScopeKey, localStore } from "@/lib/clientStorage";
import { FOR_YOU_COLUMNS, type ForYouColumn } from "@/lib/forYouApi";

const storageName = "kikoto:for-you-column";

/**
 * The column last chosen on a narrow For you, a per-device convenience for a
 * server-and-user storage scope. Maybe like opens when nothing usable is kept.
 */
export function readForYouColumnPreference(storageScope: string): ForYouColumn {
  const stored = localStore.read(accountScopeKey(storageName, storageScope));
  return FOR_YOU_COLUMNS.find((column) => column === stored) ?? "maybe_like";
}

// The choice lasts for this visit when local storage is unavailable.
export function writeForYouColumnPreference(storageScope: string, column: ForYouColumn) {
  localStore.write(accountScopeKey(storageName, storageScope), column);
}
