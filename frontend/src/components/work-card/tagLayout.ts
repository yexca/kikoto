export function visibleBadgeCountForRows(
  badgeWidths: number[],
  containerWidth: number,
  overflowWidth: number,
  rows = 2,
  gap = 6,
) {
  if (badgeWidths.length === 0 || containerWidth <= 0 || rows <= 0) return 0;
  const fits = (widths: number[]) => {
    let currentRow = 1;
    let usedWidth = 0;
    for (const rawWidth of widths) {
      const width = Math.min(containerWidth, Math.max(0, rawWidth));
      if (usedWidth > 0 && usedWidth + gap + width > containerWidth + 0.5) {
        currentRow += 1;
        usedWidth = width;
      } else {
        usedWidth += (usedWidth > 0 ? gap : 0) + width;
      }
      if (currentRow > rows) return false;
    }
    return true;
  };
  if (fits(badgeWidths)) return badgeWidths.length;
  for (let count = badgeWidths.length - 1; count >= 0; count -= 1) {
    if (fits([...badgeWidths.slice(0, count), overflowWidth])) return count;
  }
  return 0;
}
