/**
 * The availability the server reports for a local file, folder, or presence
 * that the library index holds but whose storage pool is offline now, such as
 * an unmounted disk. It is never stored: the item reads as available again once
 * the pool is back, without a scan.
 */
export const LOCAL_OFFLINE = "offline";

export type LocalFolderAvailability = "available" | typeof LOCAL_OFFLINE;

export function isLocalOffline(availability: string | null | undefined) {
  return availability === LOCAL_OFFLINE;
}
