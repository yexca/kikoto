import type { MediaItem } from "@/lib/api";

const MAX_CACHED_WORKS = 20;
const MAX_CACHED_MEDIA_ITEMS = 20_000;
const IDLE_TTL_MS = 30 * 60_000;

type WorkMediaCacheEntry = {
  mediaItems: MediaItem[];
  itemCount: number;
  accessedAt: number;
};

const workMediaCache = new Map<number, WorkMediaCacheEntry>();

export function getCachedWorkMedia(workId: number) {
  pruneWorkMediaCache();
  const entry = workMediaCache.get(workId);
  if (!entry) return null;
  entry.accessedAt = Date.now();
  workMediaCache.delete(workId);
  workMediaCache.set(workId, entry);
  return entry.mediaItems;
}

export function setCachedWorkMedia(workId: number, mediaItems: MediaItem[]) {
  workMediaCache.delete(workId);
  workMediaCache.set(workId, { mediaItems, itemCount: mediaItems.length, accessedAt: Date.now() });
  pruneWorkMediaCache();
}

export function invalidateCachedWorkMedia(workId: number) {
  workMediaCache.delete(workId);
}

function pruneWorkMediaCache() {
  const now = Date.now();
  for (const [workId, entry] of workMediaCache) {
    if (now - entry.accessedAt > IDLE_TTL_MS) workMediaCache.delete(workId);
  }
  let itemCount = Array.from(workMediaCache.values()).reduce((total, entry) => total + entry.itemCount, 0);
  while (workMediaCache.size > MAX_CACHED_WORKS || itemCount > MAX_CACHED_MEDIA_ITEMS) {
    const oldest = workMediaCache.entries().next().value as [number, WorkMediaCacheEntry] | undefined;
    if (!oldest) break;
    workMediaCache.delete(oldest[0]);
    itemCount -= oldest[1].itemCount;
  }
}
