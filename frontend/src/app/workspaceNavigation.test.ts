import { afterEach, describe, expect, it, vi } from "vitest";

import { changesWorkspace, replacesWorkspaceList } from "./workspaceNavigation";

describe("replacesWorkspaceList", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("treats a tab, filter, or page change of a browse list as the same list", () => {
    stubLocation("/", "?q=example");

    expect(replacesWorkspaceList("/?q=example&page=2", {})).toBe(true);
    expect(replacesWorkspaceList("/library/tracked", {})).toBe(true);
  });

  it("keeps a detail opened from a list as its own Back step", () => {
    stubLocation("/", "?q=example");
    expect(replacesWorkspaceList("/RJ00000000", {})).toBe(false);

    stubLocation("/circles", "");
    expect(replacesWorkspaceList("/circles/example", {})).toBe(false);
  });

  it("keeps a list opened from a detail or another page as its own Back step", () => {
    stubLocation("/circles/example", "");
    expect(replacesWorkspaceList("/circles", {})).toBe(false);

    stubLocation("/favorites", "");
    expect(replacesWorkspaceList("/?q=example", {})).toBe(false);
  });

  it("leaves pages outside the browse workspaces to ordinary pushes", () => {
    stubLocation("/workflows", "");

    expect(replacesWorkspaceList("/workflows?activity=1", {})).toBe(false);
  });
});

describe("changesWorkspace", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("names a page of another browse workspace, as a circle link from a Library work opens", () => {
    stubLocation("/RJ00000000", "");

    expect(changesWorkspace("/circles/example", {})).toBe(true);
    expect(changesWorkspace("/voices/00000001", {})).toBe(true);
  });

  it("keeps pages of the same workspace, including a work the workspace owns", () => {
    stubLocation("/circles/example", "");
    expect(changesWorkspace("/circles", {})).toBe(false);
    expect(changesWorkspace("/RJ00000000", { __kikotoWorkDetailOwner: "circles" })).toBe(false);

    stubLocation("/RJ00000000", "");
    expect(changesWorkspace("/?tag=example", {})).toBe(false);
  });

  it("leaves pages outside the browse workspaces to ordinary pushes", () => {
    stubLocation("/insights", "");
    expect(changesWorkspace("/circles/example", {})).toBe(false);

    stubLocation("/", "");
    expect(changesWorkspace("/settings", {})).toBe(false);
  });
});

function stubLocation(pathname: string, search: string) {
  vi.stubGlobal("window", {
    history: { state: {} },
    location: { pathname, search, hash: "", href: new URL(`${pathname}${search}`, "https://example.com").href },
  });
}
