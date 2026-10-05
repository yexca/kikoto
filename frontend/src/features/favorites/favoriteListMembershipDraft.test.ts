import { describe, expect, it } from "vitest";

import { membershipChanges, membershipStatesFromSummary, nextMembershipState } from "./favoriteListMembershipDraft";

describe("favorite list membership draft", () => {
  it("derives all, some, and none from the selected works", () => {
    const states = membershipStatesFromSummary({
      total: 3,
      lists: [
        { listId: 11, count: 3 },
        { listId: 12, count: 1 },
        { listId: 13, count: 0 },
      ],
    });
    expect(Object.fromEntries(states)).toEqual({ 11: "all", 12: "some", 13: "none" });
  });

  it("lets a mixed list return to unchanged but not a uniform one", () => {
    expect(nextMembershipState("some", "some")).toBe("all");
    expect(nextMembershipState("some", "all")).toBe("none");
    expect(nextMembershipState("some", "none")).toBe("some");
    expect(nextMembershipState("none", "none")).toBe("all");
    expect(nextMembershipState("all", "none")).toBe("all");
  });

  it("sends only lists whose state changed", () => {
    const initial = new Map([
      [11, "all"],
      [12, "some"],
      [13, "none"],
      [14, "some"],
    ] as const);
    const current = new Map([
      [11, "all"],
      [12, "none"],
      [13, "all"],
      [14, "some"],
    ] as const);
    expect(membershipChanges(initial, current)).toEqual({ addListIds: [13], removeListIds: [12] });
  });
});
