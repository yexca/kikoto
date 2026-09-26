import type { PlayMode } from "./playerTypes";

/**
 * Moves one queue item to a target index. The original array is returned when
 * the item is missing or already at the clamped target, so callers can skip a
 * state update.
 */
export function moveQueueItemToIndex<T extends { queueItemId?: string }>(
  items: T[],
  queueItemId: string,
  targetIndex: number,
): T[] {
  const from = items.findIndex((item) => item.queueItemId === queueItemId);
  if (from < 0 || !Number.isFinite(targetIndex)) return items;
  const to = Math.max(0, Math.min(items.length - 1, Math.trunc(targetIndex)));
  if (to === from) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Returns the index a manual previous/next control selects. Loop mode wraps at
 * either end; other modes stay on the boundary item.
 */
export function stepQueueIndex(currentIndex: number, queueLength: number, mode: PlayMode, direction: -1 | 1) {
  if (direction > 0) return currentIndex < queueLength - 1 ? currentIndex + 1 : mode === "loop" ? 0 : currentIndex;
  return currentIndex > 0 ? currentIndex - 1 : mode === "loop" ? queueLength - 1 : currentIndex;
}
