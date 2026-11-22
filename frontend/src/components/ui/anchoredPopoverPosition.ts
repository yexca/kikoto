export type PopoverAlign = "start" | "end";

/**
 * The left edge of a popover beside its anchor. The popover lines up with the
 * anchor's `align` edge, switches to the other edge when the preferred one
 * would run past the viewport while the other fits, and is then kept inside
 * the viewport.
 */
export function popoverLeft({
  align,
  anchorLeft,
  anchorRight,
  contentWidth,
  viewportLeft,
  viewportWidth,
  collisionPadding,
}: {
  align: PopoverAlign;
  anchorLeft: number;
  anchorRight: number;
  contentWidth: number;
  viewportLeft: number;
  viewportWidth: number;
  collisionPadding: number;
}) {
  const minLeft = viewportLeft + collisionPadding;
  const maxLeft = Math.max(minLeft, viewportLeft + viewportWidth - contentWidth - collisionPadding);
  const startLeft = anchorLeft;
  const endLeft = anchorRight - contentWidth;
  const fits = (left: number) => left >= minLeft && left <= maxLeft;
  const preferred = align === "start" ? startLeft : endLeft;
  const other = align === "start" ? endLeft : startLeft;
  const desired = !fits(preferred) && fits(other) ? other : preferred;
  return Math.max(minLeft, Math.min(maxLeft, desired));
}
