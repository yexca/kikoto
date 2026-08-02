import { describe, expect, it } from "vitest";

import { legacyLibraryRedirect } from "./legacyLibraryRoutes";

describe("legacyLibraryRedirect", () => {
  it("moves no-source routes to Maintenance", () => {
    expect(legacyLibraryRedirect("/no-source")).toBe("/maintenance?tab=unlinked");
    expect(legacyLibraryRedirect("/library/no-source/")).toBe("/maintenance?tab=unlinked");
  });

  it("moves obsolete database scopes to the normal Library", () => {
    expect(legacyLibraryRedirect("/library/all")).toBe("/");
    expect(legacyLibraryRedirect("/library/remote", "?q=voice")).toBe("/?q=voice");
  });

  it("leaves current routes unchanged", () => {
    expect(legacyLibraryRedirect("/library/source/example_remote")).toBeNull();
    expect(legacyLibraryRedirect("/maintenance", "?tab=unlinked")).toBeNull();
  });
});
