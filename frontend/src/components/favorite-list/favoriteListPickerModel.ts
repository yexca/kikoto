/** Whether the works a picker edits belong to a list: all of them, some of them, or none. */
export type FavoriteListPickerState = "checked" | "mixed" | "unchecked";

function nameKey(name: string) {
  return name.trim().toLocaleLowerCase();
}

/** Lists whose name contains the query, ignoring case and surrounding spaces, in their own order. */
export function filterFavoriteListsByName<T extends { name: string }>(lists: readonly T[], query: string): T[] {
  const key = nameKey(query);
  return key ? lists.filter((list) => nameKey(list.name).includes(key)) : [...lists];
}

/**
 * The name a create row offers for the query, or null when the query is
 * blank or already names a list exactly, so a list is never offered twice.
 */
export function favoriteListCreateName(lists: readonly { name: string }[], query: string): string | null {
  const name = query.trim();
  if (!name) return null;
  const key = nameKey(name);
  return lists.some((list) => nameKey(list.name) === key) ? null : name;
}
