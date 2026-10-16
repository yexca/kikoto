import { describe, expect, it } from "vitest";

import type { FavoriteList } from "@/lib/api";

import {
  addSmartRuleTag,
  editableFavoriteLists,
  emptySmartRuleDraft,
  removeSmartRuleTag,
  smartRuleCanSave,
  smartRuleFromDraft,
  smartRuleMatchKey,
  smartRuleTagLimit,
  type SmartRuleDraftTag,
} from "./smartListModel";

const tagA: SmartRuleDraftTag = { kind: "metadata", id: 101, name: "Example Tag A", state: "active" };
const tagB: SmartRuleDraftTag = { kind: "user", id: 7, name: "Sleep", state: "active" };

describe("smart rule drafts", () => {
  it("moves a tag between include and exclude instead of keeping it on both sides", () => {
    const included = addSmartRuleTag(emptySmartRuleDraft, "include", tagA);
    const moved = addSmartRuleTag(included, "exclude", tagA);
    expect(moved.include).toEqual([]);
    expect(moved.exclude).toEqual([tagA]);
    expect(addSmartRuleTag(moved, "exclude", tagA)).toBe(moved);
  });

  it("needs an included tag before saving and drops editor-only fields from the saved rule", () => {
    const excludedOnly = addSmartRuleTag(emptySmartRuleDraft, "exclude", tagB);
    expect(smartRuleCanSave(excludedOnly)).toBe(false);
    const draft = addSmartRuleTag(excludedOnly, "include", tagA);
    expect(smartRuleCanSave(draft)).toBe(true);
    expect(smartRuleFromDraft(draft)).toEqual({
      includeMatch: "all",
      include: [{ kind: "metadata", id: 101 }],
      exclude: [{ kind: "user", id: 7 }],
    });
    expect(removeSmartRuleTag(draft, "include", tagA).include).toEqual([]);
  });

  it("stops at the server's tag limit", () => {
    let draft = emptySmartRuleDraft;
    for (let id = 1; id <= smartRuleTagLimit + 2; id += 1) {
      draft = addSmartRuleTag(draft, "include", { kind: "metadata", id, name: `Tag ${id}`, state: "active" });
    }
    expect(draft.include).toHaveLength(smartRuleTagLimit);
  });

  it("keys a preview by what the rule matches, not by tag order", () => {
    const forward = addSmartRuleTag(addSmartRuleTag(emptySmartRuleDraft, "include", tagA), "include", tagB);
    const reverse = addSmartRuleTag(addSmartRuleTag(emptySmartRuleDraft, "include", tagB), "include", tagA);
    expect(smartRuleMatchKey(forward)).toBe(smartRuleMatchKey(reverse));
    expect(smartRuleMatchKey({ ...forward, includeMatch: "any" })).not.toBe(smartRuleMatchKey(forward));
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
