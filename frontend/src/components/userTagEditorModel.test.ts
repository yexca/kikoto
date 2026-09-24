import { describe, expect, it } from "vitest";

import { buildUserTagEditorOptions, toggleUserTag } from "./userTagEditorModel";

const suggestions = [
  { name: "Sleep", usageCount: 5 },
  { name: "Sleep aid", usageCount: 2 },
  { name: "Focus", usageCount: 1 },
];

describe("toggleUserTag", () => {
  it("removes case-insensitively and appends new tags in order", () => {
    expect(toggleUserTag(["Sleep", "Focus"], " sleep ")).toEqual(["Focus"]);
    expect(toggleUserTag(["Focus"], " Night ")).toEqual(["Focus", "Night"]);
    expect(toggleUserTag(["Focus"], "   ")).toEqual(["Focus"]);
  });

  it("truncates to the backend limit by character, not UTF-16 unit", () => {
    const [tag] = toggleUserTag([], "🎧".repeat(45));
    expect(Array.from(tag)).toHaveLength(40);
  });
});

describe("buildUserTagEditorOptions", () => {
  it("keeps tags from when the editor opened first, even after they are deselected", () => {
    const options = buildUserTagEditorOptions({ query: "", selected: [], pinned: ["Focus"], suggestions });
    expect(options.map((option) => option.name)).toEqual(["Focus", "Sleep", "Sleep aid"]);
    expect(options[0]).toMatchObject({ kind: "tag", selected: false, usageCount: 1 });
  });

  it("leads with the exact match so Enter picks what was typed", () => {
    const options = buildUserTagEditorOptions({ query: "SLEEP", selected: ["Sleep"], pinned: [], suggestions });
    expect(options).toEqual([
      { kind: "tag", name: "Sleep", selected: true, usageCount: 5 },
      { kind: "tag", name: "Sleep aid", selected: false, usageCount: 2 },
    ]);
  });

  it("offers to create a tag that only partially matches existing ones", () => {
    const options = buildUserTagEditorOptions({ query: " sle ", selected: [], pinned: [], suggestions });
    expect(options.map((option) => [option.kind, option.name])).toEqual([
      ["create", "sle"],
      ["tag", "Sleep"],
      ["tag", "Sleep aid"],
    ]);
  });
});
