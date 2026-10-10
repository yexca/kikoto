export type ListPage<Item> = { items: Item[]; total: number };

/**
 * Loads a whole paged list, one page after another. It stops once the total
 * the server reports has been read or a page comes back short, and never asks
 * for more than `maxPages` pages.
 */
export async function loadAllPages<Item>(
  loadPage: (page: number) => Promise<ListPage<Item>>,
  pageSize: number,
  maxPages = 100,
): Promise<Item[]> {
  const items: Item[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const result = await loadPage(page);
    items.push(...result.items);
    if (result.items.length < pageSize || items.length >= result.total) break;
  }
  return items;
}
