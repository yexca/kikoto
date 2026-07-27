import type { MediaItem } from "@/lib/api";
import { currentClientStorageScope, type ClientPrincipalID } from "@/lib/clientStorageScope";

const MAX_CACHED_WORKS = 20;
const MAX_CACHED_MEDIA_ITEMS = 20_000;
const IDLE_TTL_MS = 30 * 60_000;

type WorkMediaCacheEntry = {
  mediaItems: MediaItem[];
  itemCount: number;
  accessedAt: number;
};

const workMediaCache = new Map<string, WorkMediaCacheEntry>();

export function getCachedWorkMedia(workId: number, principalID: ClientPrincipalID) {
  pruneWorkMediaCache();
  const key = workMediaCacheKey(workId, principalID);
  const entry = workMediaCache.get(key);
  if (!entry) return null;
  entry.accessedAt = Date.now();
  workMediaCache.delete(key);
  workMediaCache.set(key, entry);
  return entry.mediaItems;
}

export function setCachedWorkMedia(workId: number, principalID: ClientPrincipalID, mediaItems: MediaItem[]) {
  const key = workMediaCacheKey(workId, principalID);
  workMediaCache.delete(key);
  workMediaCache.set(key, { mediaItems, itemCount: mediaItems.length, accessedAt: Date.now() });
  pruneWorkMediaCache();
}

export function invalidateCachedWorkMedia(workId: number, principalID: ClientPrincipalID) {
  workMediaCache.delete(workMediaCacheKey(workId, principalID));
}

function workMediaCacheKey(workId: number, principalID: ClientPrincipalID) {
  return `${currentClientStorageScope(principalID)}:work-${workId}`;
}

function pruneWorkMediaCache() {
  const now = Date.now();
  for (const [key, entry] of workMediaCache) {
    if (now - entry.accessedAt > IDLE_TTL_MS) workMediaCache.delete(key);
  }
  let itemCount = Array.from(workMediaCache.values()).reduce((total, entry) => total + entry.itemCount, 0);
  while (workMediaCache.size > MAX_CACHED_WORKS || itemCount > MAX_CACHED_MEDIA_ITEMS) {
    const oldest = workMediaCache.entries().next().value as [string, WorkMediaCacheEntry] | undefined;
    if (!oldest) break;
    workMediaCache.delete(oldest[0]);
    itemCount -= oldest[1].itemCount;
  }
}
