import type { RecordProgress } from "@/lib/api";

/** How often a playing video saves its position. */
export const RECORD_PROGRESS_SAVE_INTERVAL_MS = 10_000;
/** A saved position closer than this to the start or the end does not offer to continue. */
const resumeMarginSeconds = 5;
/** Saves skip a position that moved less than this since the last save. */
const minimumPositionChangeSeconds = 1;

function finiteDuration(duration: number | undefined) {
  return duration !== undefined && Number.isFinite(duration) && duration > 0 ? duration : undefined;
}

/**
 * Decides when a playing video writes its progress: every ten seconds while it
 * plays, when it pauses, when it ends (as completed), and when the player
 * closes. A position that has not moved since the last save, such as a video
 * closed at its resume point, is not written again.
 */
export class RecordProgressTracker {
  private lastSavedAt: number;
  private lastSavedPosition: number;

  constructor(
    private readonly save: (progress: RecordProgress) => void,
    initialPosition = 0,
    private readonly now: () => number = Date.now,
  ) {
    this.lastSavedAt = now();
    this.lastSavedPosition = initialPosition;
  }

  private write(position: number, duration: number | undefined, completed: boolean) {
    this.lastSavedAt = this.now();
    this.lastSavedPosition = position;
    this.save({ positionSeconds: Math.max(0, position), durationSeconds: finiteDuration(duration), completed });
  }

  private moved(position: number) {
    return Math.abs(position - this.lastSavedPosition) >= minimumPositionChangeSeconds;
  }

  /** A position seen while playing; saves at most once per interval. */
  timeUpdate(position: number, duration?: number) {
    if (this.now() - this.lastSavedAt < RECORD_PROGRESS_SAVE_INTERVAL_MS) return;
    if (!this.moved(position)) return;
    this.write(position, duration, false);
  }

  pause(position: number, duration?: number) {
    if (this.moved(position)) this.write(position, duration, false);
  }

  ended(duration?: number) {
    const end = finiteDuration(duration) ?? this.lastSavedPosition;
    this.write(end, duration, true);
  }

  /** The player closes or switches to another video. */
  close(position: number, duration?: number) {
    if (this.moved(position)) this.write(position, duration, false);
  }
}

/** The position a "Continue from" prompt offers, or null when the video should start over. */
export function resumePosition(progress: RecordProgress | undefined): number | null {
  if (!progress || progress.completed) return null;
  const position = progress.positionSeconds;
  if (!Number.isFinite(position) || position < resumeMarginSeconds) return null;
  const duration = finiteDuration(progress.durationSeconds);
  if (duration !== undefined && position > duration - resumeMarginSeconds) return null;
  return position;
}

/** The watched share for a tile's progress bar, 0 to 1, or null when there is nothing to show. */
export function watchedFraction(progress: RecordProgress | undefined): number | null {
  if (!progress) return null;
  if (progress.completed) return 1;
  const duration = finiteDuration(progress.durationSeconds);
  if (duration === undefined || progress.positionSeconds <= 0) return null;
  return Math.min(1, Math.max(0, progress.positionSeconds / duration));
}

/** The video a folder's Continue action resumes: the most recently played unfinished one. */
export function continueCandidate(
  videoIds: readonly number[],
  progress: ReadonlyMap<number, RecordProgress>,
): { id: number; position: number } | null {
  let best: { id: number; position: number; playedAt: string } | null = null;
  for (const id of videoIds) {
    const entry = progress.get(id);
    const position = resumePosition(entry);
    if (position === null || !entry) continue;
    const playedAt = entry.lastPlayedAt ?? "";
    if (!best || playedAt > best.playedAt) best = { id, position, playedAt };
  }
  return best ? { id: best.id, position: best.position } : null;
}

export type ProgressLoader = {
  /** Queues one video's progress read; repeated and already loaded ids are ignored. */
  request(id: number): void;
  /** Drops queued reads and aborts running ones, as when the folder changes. */
  cancel(): void;
};

/**
 * Reads saved progress for the tiles that scroll into view, a few at a time,
 * so a large folder never starts one request per tile at once.
 */
export function createProgressLoader({
  load,
  onLoaded,
  concurrency = 3,
}: {
  load: (id: number, signal: AbortSignal) => Promise<RecordProgress>;
  onLoaded: (id: number, progress: RecordProgress) => void;
  concurrency?: number;
}): ProgressLoader {
  const controller = new AbortController();
  const requested = new Set<number>();
  const queue: number[] = [];
  let active = 0;

  const pump = () => {
    while (!controller.signal.aborted && active < concurrency && queue.length > 0) {
      const id = queue.shift() as number;
      active += 1;
      load(id, controller.signal)
        .then((progress) => {
          if (!controller.signal.aborted) onLoaded(id, progress);
        })
        .catch(() => {
          // A tile without progress simply shows no bar.
        })
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };

  return {
    request(id) {
      if (controller.signal.aborted || requested.has(id)) return;
      requested.add(id);
      queue.push(id);
      pump();
    },
    cancel() {
      queue.length = 0;
      controller.abort();
    },
  };
}
