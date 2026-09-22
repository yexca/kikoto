export type QueueRowLayout = { top: number; height: number };

/**
 * Resolves a dragged queue row's visual offset and drop index. The offset is
 * clamped to the list bounds and the drop index changes once the dragged row's
 * leading edge crosses a neighbor's center.
 */
export function resolveQueueDrag(layout: QueueRowLayout[], fromIndex: number, rawOffset: number) {
  const dragged = layout[fromIndex];
  if (!dragged) return { offset: 0, target: fromIndex };
  const first = layout[0];
  const last = layout[layout.length - 1];
  const minOffset = first.top - dragged.top;
  const maxOffset = last.top + last.height - (dragged.top + dragged.height);
  const offset = Math.max(minOffset, Math.min(maxOffset, rawOffset));
  const top = dragged.top + offset;
  const bottom = top + dragged.height;
  let target = fromIndex;
  for (let index = fromIndex + 1; index < layout.length; index += 1) {
    if (bottom > layout[index].top + layout[index].height / 2) target = index;
  }
  for (let index = fromIndex - 1; index >= 0; index -= 1) {
    if (top < layout[index].top + layout[index].height / 2) target = index;
  }
  return { offset, target };
}

/** Distance a non-dragged row moves to open the drop slot. */
export function queueDragShift(index: number, fromIndex: number, targetIndex: number, draggedHeight: number) {
  if (index > fromIndex && targetIndex >= index) return -draggedHeight;
  if (fromIndex > index && index >= targetIndex) return draggedHeight;
  return 0;
}
