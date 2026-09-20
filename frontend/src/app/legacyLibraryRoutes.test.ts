import { describe, expect, it } from "vitest";

import { legacyLibraryRedirect } from "./legacyLibraryRoutes";

describe("legacyLibraryRedirect", () => {
  it("canonicalizes Metadata links while preserving category, settings and run filters", () => {
    expect(legacyLibraryRedirect("/work-management", "?reason=metadata&metadataRun=42")).toBe(
      "/metadata?reason=metadata&metadataRun=42",
    );
    expect(legacyLibraryRedirect("/work-management/", "?tab=settings&reason=no_source")).toBe(
      "/metadata?tab=settings&reason=no_source",
    );
    expect(legacyLibraryRedirect("/metadata/", "?reason=catalog")).toBe("/metadata?reason=catalog");
    expect(legacyLibraryRedirect("/metadata", "?reason=metadata")).toBeNull();
    expect(legacyLibraryRedirect("/maintenance", "?tab=metadata&metadataRun=42")).toBe(
      "/metadata?metadataRun=42&reason=metadata",
    );
    expect(legacyLibraryRedirect("/maintenance", "?tab=metadata&reason=metadata")).toBe("/metadata?reason=metadata");
    expect(legacyLibraryRedirect("/no-source", "?metadataRun=42&page=2")).toBe("/metadata?page=2&reason=no_source");
  });
  it("opens legacy Activity links inside Workflows while preserving the selected run", () => {
    expect(legacyLibraryRedirect("/activity", "?view=failed&run=7")).toBe("/workflows?view=failed&run=7&activity=1");
    expect(legacyLibraryRedirect("/runs")).toBe("/workflows?activity=1");
  });
  it("moves no-source routes to work management", () => {
    expect(legacyLibraryRedirect("/no-source")).toBe("/metadata?reason=no_source");
    expect(legacyLibraryRedirect("/library/no-source/")).toBe("/metadata?reason=no_source");
  });

  it("moves obsolete database scopes to the normal Library", () => {
    expect(legacyLibraryRedirect("/library/all")).toBe("/");
    expect(legacyLibraryRedirect("/library/remote", "?q=voice")).toBe("/?q=voice");
  });

  it("routes removed Maintenance sections to their merged tabs", () => {
    for (const tab of ["overview", "paths", "system", "local", "remote"]) {
      expect(legacyLibraryRedirect("/maintenance", `?tab=${tab}&source=8`)).toBe("/maintenance?tab=library&source=8");
    }
    expect(legacyLibraryRedirect("/maintenance/", "?tab=security")).toBe("/maintenance?tab=users");
    expect(legacyLibraryRedirect("/maintenance", "?tab=users")).toBeNull();
  });

  it("leaves current routes unchanged", () => {
    expect(legacyLibraryRedirect("/library/source/example_remote")).toBeNull();
    expect(legacyLibraryRedirect("/maintenance", "?tab=library")).toBeNull();
  });

  it("preserves metadata run filters and maps legacy settings links", () => {
    expect(legacyLibraryRedirect("/maintenance", "?tab=works&reason=metadata&metadataRun=7")).toBe(
      "/metadata?reason=metadata&metadataRun=7",
    );
    expect(legacyLibraryRedirect("/maintenance", "?tab=works")).toBe("/metadata?reason=all");
    expect(legacyLibraryRedirect("/maintenance", "?tab=metadata")).toBe("/metadata?tab=settings");
    expect(legacyLibraryRedirect("/maintenance", "?tab=unlinked")).toBe("/metadata?reason=no_source");
  });
});
