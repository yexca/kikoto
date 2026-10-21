import { afterEach, describe, expect, it, vi } from "vitest";

import { replacesWorkspaceList } from "./workspaceNavigation";

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

function stubLocation(pathname: string, search: string) {
  vi.stubGlobal("window", {
    history: { state: {} },
    location: { pathname, search, hash: "", href: new URL(`${pathname}${search}`, "https://example.com").href },
  });
}
