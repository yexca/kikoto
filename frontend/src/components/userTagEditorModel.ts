/** Matches the backend's per-tag rune limit. */
export const maxUserTagNameLength = 40;

export type UserTagEditorOption =
  { kind: "create"; name: string } | { kind: "tag"; name: string; selected: boolean; usageCount?: number };

export function userTagKey(name: string) {
  return name.trim().toLowerCase();
}

export function normalizeUserTagName(name: string) {
  return Array.from(name.trim()).slice(0, maxUserTagNameLength).join("");
}

/** Adds or removes one tag, matching case-insensitively and keeping the existing order. */
export function toggleUserTag(selected: string[], name: string) {
  const normalized = normalizeUserTagName(name);
  const key = userTagKey(normalized);
  if (!key) return selected;
  if (selected.some((tag) => userTagKey(tag) === key)) {
    return selected.filter((tag) => userTagKey(tag) !== key);
  }
  return [...selected, normalized];
}

/**
 * Builds the picker rows. `pinned` (the tags the entity had when the editor
 * opened, then tags created in this session) stays first so rows do not jump
 * while the user toggles them. An exact match for the query moves to the top;
 * otherwise a create row leads so Enter always means "exactly what I typed".
 */
export function buildUserTagEditorOptions({
  query,
  selected,
  pinned,
  suggestions,
}: {
  query: string;
  selected: string[];
  pinned: string[];
  suggestions: { name: string; usageCount: number }[];
}): UserTagEditorOption[] {
  const selectedKeys = new Set(selected.map(userTagKey));
  const usage = new Map(suggestions.map((tag) => [userTagKey(tag.name), tag.usageCount]));
  const seen = new Set<string>();
  const rows: Extract<UserTagEditorOption, { kind: "tag" }>[] = [];
  for (const name of [...pinned, ...selected, ...suggestions.map((tag) => tag.name)]) {
    const key = userTagKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push({ kind: "tag", name, selected: selectedKeys.has(key), usageCount: usage.get(key) });
  }

  const typed = normalizeUserTagName(query);
  const needle = userTagKey(typed);
  if (!needle) return rows;
  const exact = rows.find((row) => userTagKey(row.name) === needle);
  const partial = rows.filter((row) => row !== exact && userTagKey(row.name).includes(needle));
  return exact ? [exact, ...partial] : [{ kind: "create", name: typed }, ...partial];
}
