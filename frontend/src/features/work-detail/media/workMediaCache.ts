import { PLAYBACK_CURSOR_UPDATED_EVENT, type PlaybackCursorUpdatedDetail } from "@/lib/appEvents";
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
  listenForProgressUpdates();
  const key = workMediaCacheKey(workId, principalID);
  workMediaCache.delete(key);
  if (mediaItems.length === 0) return;
  workMediaCache.set(key, { mediaItems, itemCount: mediaItems.length, accessedAt: Date.now() });
  pruneWorkMediaCache();
}

export function invalidateCachedWorkMedia(workId: number, principalID: ClientPrincipalID) {
  workMediaCache.delete(workMediaCacheKey(workId, principalID));
}

/**
 * Moves the work's resume cursor in the cached media of the account that saved
 * it, as the server does, so a detail reopened from the cache marks the track
 * playback actually stopped on.
 */
export function applyCachedWorkMediaProgress(update: PlaybackCursorUpdatedDetail) {
  if (update.mediaItemId <= 0) return;
  const progress = {
    positionSeconds: update.positionSeconds,
    durationSeconds: update.durationSeconds,
    completed: update.completed,
    lastPlayedAt: update.lastPlayedAt,
  };
  for (const workId of new Set([update.workId, update.mediaWorkId])) {
    const entry = workMediaCache.get(workMediaCacheKey(workId, update.principalID));
    if (!entry) continue;
    let changed = false;
    const mediaItems = entry.mediaItems.map((item) => {
      if (item.id === update.mediaItemId) {
        changed = true;
        return { ...item, progress };
      }
      if (!item.progress) return item;
      changed = true;
      return { ...item, progress: null };
    });
    if (changed) entry.mediaItems = mediaItems;
  }
}

let listeningForProgressUpdates = false;

// Playback continues while no detail is open, so the cache follows saves itself
// once it holds anything to update.
function listenForProgressUpdates() {
  if (listeningForProgressUpdates || typeof window === "undefined") return;
  listeningForProgressUpdates = true;
  window.addEventListener(PLAYBACK_CURSOR_UPDATED_EVENT, (event) => {
    const update = (event as CustomEvent<PlaybackCursorUpdatedDetail>).detail;
    if (update) applyCachedWorkMediaProgress(update);
  });
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
