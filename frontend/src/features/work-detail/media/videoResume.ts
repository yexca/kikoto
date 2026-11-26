import { accountKey, type ClientStore, type StorageKey } from "@/lib/clientStorage";
import type { ClientPrincipalID } from "@/lib/clientStorageScope";

const VIDEO_RESUME_STORAGE_BASE_KEY = "kikoto:video-resume:v1";

// The most recently watched positions a device keeps per account.
const maxVideoResumeEntries = 200;
// A position this early is not worth resuming.
const minimumResumeSeconds = 10;
// Within this much of the end, or this share of the duration, the video counts as watched.
const finishedRemainingSeconds = 15;
const finishedRemainingShare = 0.05;

type VideoResumeEntry = { position: number; updatedAt: number };
type VideoResumeStore = Record<string, VideoResumeEntry>;
export function videoResumeStorageKey(principalID: ClientPrincipalID) {
  return accountKey(VIDEO_RESUME_STORAGE_BASE_KEY, principalID);
}

/**
 * The position worth resuming for a playback position, or null when the
 * video has barely started or is essentially finished.
 */
export function resumableVideoPosition(position: number, durationSeconds: number) {
  if (!Number.isFinite(position) || position < minimumResumeSeconds) return null;
  if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
    const remaining = durationSeconds - position;
    if (remaining <= Math.max(finishedRemainingSeconds, durationSeconds * finishedRemainingShare)) return null;
  }
  return position;
}

function readStore(storage: ClientStore, storageKey: StorageKey): VideoResumeStore {
  const parsed = storage.readJSON(storageKey);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const store: VideoResumeStore = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = value as Partial<VideoResumeEntry> | null;
    if (
      /^[1-9]\d*$/.test(key) &&
      typeof entry?.position === "number" &&
      Number.isFinite(entry.position) &&
      typeof entry.updatedAt === "number"
    ) {
      store[key] = { position: entry.position, updatedAt: entry.updatedAt };
    }
  }
  return store;
}

/** The stored position of a local or cached video location, if any. */
export function readVideoResumePosition(storage: ClientStore, storageKey: StorageKey, locationId: number) {
  if (locationId <= 0) return null;
  return readStore(storage, storageKey)[String(locationId)]?.position ?? null;
}

/**
 * Stores where a video location stopped, or forgets it when the position is
 * not worth resuming. Browser storage holds only location ids and positions.
 * Playback stays usable when browser storage is unavailable or full.
 */
export function writeVideoResumePosition(
  storage: ClientStore,
  storageKey: StorageKey,
  locationId: number,
  position: number,
  durationSeconds: number,
  now = Date.now(),
) {
  if (locationId <= 0) return;
  const store = readStore(storage, storageKey);
  const key = String(locationId);
  const resumable = resumableVideoPosition(position, durationSeconds);
  if (resumable === null) {
    if (!(key in store)) return;
    delete store[key];
  } else {
    store[key] = { position: Math.round(resumable * 10) / 10, updatedAt: now };
  }
  const kept = Object.entries(store)
    .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
    .slice(0, maxVideoResumeEntries);
  if (kept.length === 0) storage.remove(storageKey);
  else storage.writeJSON(storageKey, Object.fromEntries(kept));
}
