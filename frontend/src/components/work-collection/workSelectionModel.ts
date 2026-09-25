/**
 * Drops selected keys that no longer name a visible item. The current set is
 * returned unchanged when nothing was dropped, so a selection-sync effect lets
 * React bail out instead of re-rendering on every new item array.
 */
export function retainVisibleSelection<T>(
  current: Set<string>,
  items: readonly T[],
  keyOf: (item: T) => string,
): Set<string> {
  if (current.size === 0) return current;
  const visible = new Set(items.map(keyOf));
  const next = new Set(Array.from(current).filter((key) => visible.has(key)));
  return next.size === current.size ? current : next;
}
