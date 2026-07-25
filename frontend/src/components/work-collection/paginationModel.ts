export type PaginationItem = number | "ellipsis-left" | "ellipsis-right";

export function paginationItems(page: number, totalPages: number): PaginationItem[] {
  const lastPage = Math.max(1, Math.floor(totalPages));
  const currentPage = Math.min(lastPage, Math.max(1, Math.floor(page)));
  const pages = Array.from(new Set([1, currentPage - 1, currentPage, currentPage + 1, lastPage]))
    .filter((value) => value >= 1 && value <= lastPage)
    .sort((left, right) => left - right);
  const items: PaginationItem[] = [];

  pages.forEach((value, index) => {
    const previous = pages[index - 1];
    if (previous !== undefined && value - previous > 1) {
      items.push(index === 1 ? "ellipsis-left" : "ellipsis-right");
    }
    items.push(value);
  });
  return items;
}
