import { describe, expect, it } from "vitest";

import type { FavoriteList, SmartListRuleView } from "@/lib/api";

import {
  addSmartRuleTag,
  editableFavoriteLists,
  emptySmartRuleDraft,
  removeSmartRuleTag,
  smartRuleCanSave,
  smartRuleFromDraft,
  smartRuleMatchKey,
  smartRuleSummary,
  smartRuleTagLimit,
  type SmartRuleDraftTag,
} from "./smartListModel";

const tagA: SmartRuleDraftTag = { kind: "metadata", id: 101, name: "Example Tag A", state: "active" };
const tagB: SmartRuleDraftTag = { kind: "user", id: 7, name: "Sleep", state: "active" };

describe("smart rule drafts", () => {
  it("keeps a tag in one group, moving it when it is added to another", () => {
    const required = addSmartRuleTag(emptySmartRuleDraft, "require", tagA);
    const anyOf = addSmartRuleTag(required, "any", tagA);
    expect(anyOf).toEqual({ require: [], any: [tagA], exclude: [] });
    const excluded = addSmartRuleTag(anyOf, "exclude", tagA);
    expect(excluded).toEqual({ require: [], any: [], exclude: [tagA] });
    expect(addSmartRuleTag(excluded, "exclude", tagA)).toBe(excluded);
  });

  it("needs a required or any tag before saving and drops editor-only fields from the saved rule", () => {
    const excludedOnly = addSmartRuleTag(emptySmartRuleDraft, "exclude", tagB);
    expect(smartRuleCanSave(excludedOnly)).toBe(false);
    expect(smartRuleCanSave(addSmartRuleTag(excludedOnly, "any", tagA))).toBe(true);
    const draft = addSmartRuleTag(excludedOnly, "require", tagA);
    expect(smartRuleCanSave(draft)).toBe(true);
    expect(smartRuleFromDraft(draft)).toEqual({
      require: [{ kind: "metadata", id: 101 }],
      any: [],
      exclude: [{ kind: "user", id: 7 }],
    });
    expect(removeSmartRuleTag(draft, "require", tagA).require).toEqual([]);
  });

  it("stops at the server's limit for each group", () => {
    let draft = emptySmartRuleDraft;
    for (let id = 1; id <= smartRuleTagLimit + 2; id += 1) {
      draft = addSmartRuleTag(draft, "any", { kind: "metadata", id, name: `Tag ${id}`, state: "active" });
    }
    expect(draft.any).toHaveLength(smartRuleTagLimit);
    expect(addSmartRuleTag(draft, "require", tagB).require).toEqual([tagB]);
  });

  it("keys a preview by what the rule matches, not by tag order", () => {
    const forward = addSmartRuleTag(addSmartRuleTag(emptySmartRuleDraft, "require", tagA), "require", tagB);
    const reverse = addSmartRuleTag(addSmartRuleTag(emptySmartRuleDraft, "require", tagB), "require", tagA);
    expect(smartRuleMatchKey(forward)).toBe(smartRuleMatchKey(reverse));
    const anyOf = addSmartRuleTag(addSmartRuleTag(emptySmartRuleDraft, "any", tagA), "any", tagB);
    expect(smartRuleMatchKey(anyOf)).not.toBe(smartRuleMatchKey(forward));
  });
});

describe("smartRuleSummary", () => {
  it("names required tags before any tags and counts the rest", () => {
    const view = (id: number) => ({ kind: "metadata" as const, id, name: `Tag ${id}`, state: "active" as const });
    const rule: SmartListRuleView = { require: [view(1), view(2), view(3)], any: [view(4), view(5)], exclude: [] };
    const summary = smartRuleSummary(rule);
    expect(summary.require.map((tag) => tag.id)).toEqual([1, 2, 3]);
    expect(summary.any.map((tag) => tag.id)).toEqual([4]);
    expect(summary.hidden).toBe(1);
  });
});

describe("editableFavoriteLists", () => {
  it("offers user and smart lists but never the marked list", () => {
    const list = (id: number, kind: FavoriteList["kind"]): FavoriteList => ({
      id,
      kind,
      name: `List ${id}`,
      description: "",
      sortOrder: id,
    });
    expect(
      editableFavoriteLists([list(1, "marked"), list(2, "user"), list(3, "smart")]).map((item) => item.id),
    ).toEqual([2, 3]);
  });
});
