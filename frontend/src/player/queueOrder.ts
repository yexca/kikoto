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
 * Removes several queue items, one after another, and returns the index that
 * keeps playback on the same item, as removing each in turn would. Returns
 * null when none of the items is in the queue.
 */
export function removeQueueItemsById<T extends { queueItemId?: string }>(
  items: T[],
  currentIndex: number,
  queueItemIds: Iterable<string>,
): { items: T[]; currentIndex: number; removedCurrent: boolean; stop: boolean } | null {
  let state: { items: T[]; currentIndex: number } = { items, currentIndex };
  let removed = false;
  let removedCurrent = false;
  let stop = false;
  for (const queueItemId of queueItemIds) {
    const current = state.items[state.currentIndex]?.queueItemId === queueItemId;
    const next = removeQueueItemById(state.items, state.currentIndex, queueItemId);
    if (!next) continue;
    removed = true;
    removedCurrent ||= current;
    stop ||= next.stop;
    state = { items: next.items, currentIndex: next.currentIndex };
  }
  return removed ? { ...state, removedCurrent, stop } : null;
}

/**
 * Removes one queue item and returns the index that keeps playback on the same
 * item. Removing the current item selects the item that takes its place. When
 * the current one was last, nothing takes its place: the new last item
 * becomes current and `stop` is set, so playback stops while the player keeps
 * showing the items that remain. Returns null when the item is missing.
 */
export function removeQueueItemById<T extends { queueItemId?: string }>(
  items: T[],
  currentIndex: number,
  queueItemId: string,
): { items: T[]; currentIndex: number; stop: boolean } | null {
  const removedIndex = items.findIndex((item) => item.queueItemId === queueItemId);
  if (removedIndex < 0) return null;
  const nextItems = items.filter((_, index) => index !== removedIndex);
  if (removedIndex < currentIndex) return { items: nextItems, currentIndex: currentIndex - 1, stop: false };
  if (removedIndex === currentIndex && removedIndex >= nextItems.length) {
    return { items: nextItems, currentIndex: Math.max(0, nextItems.length - 1), stop: true };
  }
  return { items: nextItems, currentIndex, stop: false };
}

/**
 * Returns the index a manual previous/next control selects. Loop mode wraps at
 * either end; other modes stay on the boundary item.
 */
export function stepQueueIndex(currentIndex: number, queueLength: number, mode: PlayMode, direction: -1 | 1) {
  if (direction > 0) return currentIndex < queueLength - 1 ? currentIndex + 1 : mode === "loop" ? 0 : currentIndex;
  return currentIndex > 0 ? currentIndex - 1 : mode === "loop" ? queueLength - 1 : currentIndex;
}
