import type { FavoriteList, SmartListRule, SmartListRuleView, SmartRuleTag, SmartRuleTagState } from "@/lib/api";

/** Server bound of one condition group. */
export const smartRuleTagLimit = 16;

/** Condition groups of a rule, in the order the editor shows them. */
export const smartRuleModes = ["require", "any", "exclude"] as const;

export type SmartRuleMode = (typeof smartRuleModes)[number];

export type SmartRuleDraftTag = SmartRuleTag & { name: string; state: SmartRuleTagState };

export type SmartRuleDraft = Record<SmartRuleMode, SmartRuleDraftTag[]>;

export const emptySmartRuleDraft: SmartRuleDraft = { require: [], any: [], exclude: [] };

export function smartTagKey(tag: SmartRuleTag) {
  return `${tag.kind}:${tag.id}`;
}

export function smartRuleDraftFromView(view: SmartListRuleView | undefined): SmartRuleDraft {
  if (!view) return emptySmartRuleDraft;
  const toDraft = (tag: SmartListRuleView["require"][number]): SmartRuleDraftTag => ({
    kind: tag.kind,
    id: tag.id,
    name: tag.name,
    state: tag.state,
  });
  return { require: view.require.map(toDraft), any: view.any.map(toDraft), exclude: view.exclude.map(toDraft) };
}

export function smartRuleFromDraft(draft: SmartRuleDraft): SmartListRule {
  const strip = ({ kind, id }: SmartRuleDraftTag): SmartRuleTag => ({ kind, id });
  return { require: draft.require.map(strip), any: draft.any.map(strip), exclude: draft.exclude.map(strip) };
}

/** Adds a tag to one group of the rule; a tag in another group moves over, since it belongs to one group only. */
export function addSmartRuleTag(draft: SmartRuleDraft, mode: SmartRuleMode, tag: SmartRuleDraftTag): SmartRuleDraft {
  const key = smartTagKey(tag);
  if (draft[mode].some((item) => smartTagKey(item) === key)) return draft;
  if (draft[mode].length >= smartRuleTagLimit) return draft;
  const next = { ...draft };
  for (const other of smartRuleModes) {
    next[other] = other === mode ? [...draft[mode], tag] : draft[other].filter((item) => smartTagKey(item) !== key);
  }
  return next;
}

export function removeSmartRuleTag(draft: SmartRuleDraft, mode: SmartRuleMode, tag: SmartRuleTag): SmartRuleDraft {
  const key = smartTagKey(tag);
  return { ...draft, [mode]: draft[mode].filter((item) => smartTagKey(item) !== key) };
}

/** A rule needs a required or any tag; excluded tags alone would match the whole library. */
export function smartRuleCanSave(draft: SmartRuleDraft) {
  return draft.require.length + draft.any.length > 0;
}

/** A stable key of what the rule matches, so a preview reloads only when the rule changes. */
export function smartRuleMatchKey(draft: SmartRuleDraft) {
  const keys = (tags: SmartRuleDraftTag[]) => tags.map(smartTagKey).sort().join(",");
  return smartRuleModes.map((mode) => keys(draft[mode])).join("|");
}

/** Lists a user can add works to and remove works from. */
export function editableFavoriteLists(lists: FavoriteList[]) {
  return lists.filter((list) => list.kind === "user" || list.kind === "smart");
}

/** The required and any tags a shelf header names, required first, and how many more there are. */
export function smartRuleSummary(view: SmartListRuleView, limit = 4) {
  const require = view.require.slice(0, limit);
  const any = view.any.slice(0, limit - require.length);
  return { require, any, hidden: view.require.length + view.any.length - require.length - any.length };
}
