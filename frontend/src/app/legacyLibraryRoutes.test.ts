import { describe, expect, it } from "vitest";

import { legacyLibraryRedirect } from "./legacyLibraryRoutes";

describe("legacyLibraryRedirect", () => {
  it("opens legacy Activity links inside Workflows while preserving the selected run", () => {
    expect(legacyLibraryRedirect("/activity", "?view=failed&run=7")).toBe("/workflows?view=failed&run=7&activity=1");
    expect(legacyLibraryRedirect("/runs")).toBe("/workflows?activity=1");
  });
  it("moves no-source routes to work management", () => {
    expect(legacyLibraryRedirect("/no-source")).toBe("/work-management?reason=no_source");
    expect(legacyLibraryRedirect("/library/no-source/")).toBe("/work-management?reason=no_source");
  });

  it("moves obsolete database scopes to the normal Library", () => {
    expect(legacyLibraryRedirect("/library/all")).toBe("/");
    expect(legacyLibraryRedirect("/library/remote", "?q=voice")).toBe("/?q=voice");
  });

  it("leaves current routes unchanged", () => {
    expect(legacyLibraryRedirect("/library/source/example_remote")).toBeNull();
    expect(legacyLibraryRedirect("/maintenance", "?tab=library")).toBeNull();
  });

  it("preserves metadata run filters and maps legacy settings links", () => {
    expect(legacyLibraryRedirect("/maintenance", "?tab=works&reason=metadata&metadataRun=7")).toBe(
      "/work-management?reason=metadata&metadataRun=7",
    );
    expect(legacyLibraryRedirect("/maintenance", "?tab=metadata")).toBe("/work-management?tab=settings");
    expect(legacyLibraryRedirect("/maintenance", "?tab=unlinked")).toBe("/work-management?reason=no_source");
  });
});
