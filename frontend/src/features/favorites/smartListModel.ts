import type { FavoriteList, SmartListRule, SmartListRuleView, SmartRuleTag, SmartRuleTagState } from "@/lib/api";

/** Server bounds of one rule. */
export const smartRuleTagLimit = 16;

export type SmartRuleMode = "include" | "exclude";

export type SmartRuleDraftTag = SmartRuleTag & { name: string; state: SmartRuleTagState };

export type SmartRuleDraft = {
  includeMatch: "all" | "any";
  include: SmartRuleDraftTag[];
  exclude: SmartRuleDraftTag[];
};

export const emptySmartRuleDraft: SmartRuleDraft = { includeMatch: "all", include: [], exclude: [] };

export function smartTagKey(tag: SmartRuleTag) {
  return `${tag.kind}:${tag.id}`;
}

export function smartRuleDraftFromView(view: SmartListRuleView | undefined): SmartRuleDraft {
  if (!view) return emptySmartRuleDraft;
  const toDraft = (tag: SmartListRuleView["include"][number]): SmartRuleDraftTag => ({
    kind: tag.kind,
    id: tag.id,
    name: tag.name,
    state: tag.state,
  });
  return { includeMatch: view.includeMatch, include: view.include.map(toDraft), exclude: view.exclude.map(toDraft) };
}

export function smartRuleFromDraft(draft: SmartRuleDraft): SmartListRule {
  const strip = ({ kind, id }: SmartRuleDraftTag): SmartRuleTag => ({ kind, id });
  return { includeMatch: draft.includeMatch, include: draft.include.map(strip), exclude: draft.exclude.map(strip) };
}

/** Adds a tag to one side of the rule; a tag on the other side moves over, since it cannot be on both. */
export function addSmartRuleTag(draft: SmartRuleDraft, mode: SmartRuleMode, tag: SmartRuleDraftTag): SmartRuleDraft {
  const key = smartTagKey(tag);
  const other: SmartRuleMode = mode === "include" ? "exclude" : "include";
  if (draft[mode].some((item) => smartTagKey(item) === key)) return draft;
  if (draft[mode].length >= smartRuleTagLimit) return draft;
  return {
    ...draft,
    [mode]: [...draft[mode], tag],
    [other]: draft[other].filter((item) => smartTagKey(item) !== key),
  };
}

export function removeSmartRuleTag(draft: SmartRuleDraft, mode: SmartRuleMode, tag: SmartRuleTag): SmartRuleDraft {
  const key = smartTagKey(tag);
  return { ...draft, [mode]: draft[mode].filter((item) => smartTagKey(item) !== key) };
}

export function smartRuleCanSave(draft: SmartRuleDraft) {
  return draft.include.length > 0;
}

/** A stable key of what the rule matches, so a preview reloads only when the rule changes. */
export function smartRuleMatchKey(draft: SmartRuleDraft) {
  const keys = (tags: SmartRuleDraftTag[]) => tags.map(smartTagKey).sort().join(",");
  return `${draft.includeMatch}|${keys(draft.include)}|${keys(draft.exclude)}`;
}

/** Lists a user can add works to and remove works from. */
export function editableFavoriteLists(lists: FavoriteList[]) {
  return lists.filter((list) => list.kind === "user" || list.kind === "smart");
}

/** The included tags a shelf header names, and how many more there are. */
export function smartRuleSummary(view: SmartListRuleView, limit = 3) {
  return { shown: view.include.slice(0, limit), hidden: Math.max(0, view.include.length - limit) };
}
