import type { RecordProgress } from "@/lib/api";

/** Dispatched on `window` after the player saves a Record file's position. */
export const RECORD_PROGRESS_SAVED_EVENT = "kikoto:record-progress-saved";

export type RecordProgressSavedDetail = { assetId: number; progress: RecordProgress };

/** How often a playing Record file saves its position. */
export const RECORD_TRACK_SAVE_INTERVAL_MS = 10_000;
/** A save skips a position that moved less than this since the last save of the same file. */
const minimumPositionChangeSeconds = 1;

/**
 * Decides when the player writes a Record file's position: at most every ten
 * seconds while it plays, and at once when it pauses, seeks, ends, or another
 * track replaces it. A position that has not moved since the last save of the
 * same file is not written again, unless the file ended.
 */
export class RecordTrackProgressSaver {
  private last: { assetId: number; at: number; position: number } | null = null;
  private lastOrder = 0;

  constructor(
    private readonly write: (assetId: number, progress: RecordProgress) => void,
    private readonly now: () => number = Date.now,
  ) {}

  save(assetId: number, position: number, duration: number | null, completed: boolean, force: boolean) {
    const last = this.last?.assetId === assetId ? this.last : null;
    const now = this.now();
    if (last && !completed) {
      if (!force && now - last.at < RECORD_TRACK_SAVE_INTERVAL_MS) return;
      if (Math.abs(position - last.position) < minimumPositionChangeSeconds) return;
    }
    this.last = { assetId, at: now, position };
    // The server keeps the save captured last, so one that arrives late
    // never replaces a later position.
    this.lastOrder = Math.max(this.lastOrder + 1, now);
    this.write(assetId, {
      positionSeconds: Math.max(0, position),
      durationSeconds: duration ?? undefined,
      completed,
      order: this.lastOrder,
    });
  }
}
