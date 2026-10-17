export type PaginationItem = number | "ellipsis-left" | "ellipsis-right";

const PAGE_BUTTON_WIDTH = 32;
const PAGE_GAP = 4;
// Two arrow buttons, the bar's horizontal padding, and its border.
const PAGE_BAR_CHROME = 2 * (PAGE_BUTTON_WIDTH + PAGE_GAP) + 16 + 2;
const MIN_SIBLINGS = 1;
const MAX_SIBLINGS = 4;

/**
 * The page numbers and gaps of a page bar: the first and last pages, the
 * current page with `siblings` pages on each side, and an ellipsis for each
 * gap. Once the pages outnumber the slots, the bar always holds the same
 * number of items, filling a gap near either end with page numbers, so the
 * arrows stay in place while the user pages through.
 */
export function paginationItems(page: number, totalPages: number, siblings = MIN_SIBLINGS): PaginationItem[] {
  const lastPage = Math.max(1, Math.floor(totalPages));
  const currentPage = Math.min(lastPage, Math.max(1, Math.floor(page)));
  const around = Math.max(MIN_SIBLINGS, Math.floor(siblings));
  const slots = 2 * around + 5;
  if (lastPage <= slots) return range(1, lastPage);

  const edgeRun = 2 * around + 3;
  if (currentPage <= around + 3) return [...range(1, edgeRun), "ellipsis-right", lastPage];
  if (currentPage >= lastPage - around - 2) return [1, "ellipsis-left", ...range(lastPage - edgeRun + 1, lastPage)];
  return [1, "ellipsis-left", ...range(currentPage - around, currentPage + around), "ellipsis-right", lastPage];
}

/** How many pages on each side of the current page fit in a page bar of the given width. */
export function paginationSiblingsForWidth(width: number) {
  const slots = Math.floor((width - PAGE_BAR_CHROME + PAGE_GAP) / (PAGE_BUTTON_WIDTH + PAGE_GAP));
  return Math.min(MAX_SIBLINGS, Math.max(MIN_SIBLINGS, Math.floor((slots - 5) / 2)));
}

/** The page a typed jump lands on, clamped to the existing pages, or null when the text names no page. */
export function pageJumpTarget(value: string, totalPages: number): number | null {
  const typed = value.trim();
  if (!/^\d+$/.test(typed)) return null;
  const lastPage = Math.max(1, Math.floor(totalPages));
  return Math.min(lastPage, Math.max(1, Number(typed)));
}

function range(first: number, last: number) {
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}
