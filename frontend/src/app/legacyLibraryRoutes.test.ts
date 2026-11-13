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
  it("sends addresses that showed Activity inside Workflows to the Activity page", () => {
    expect(legacyLibraryRedirect("/activity", "?view=failed&run=7")).toBeNull();
    expect(legacyLibraryRedirect("/runs", "?run=7")).toBe("/activity?run=7");
    expect(legacyLibraryRedirect("/workflows", "?activity=1")).toBe("/activity");
    expect(legacyLibraryRedirect("/workflows", "?activity=1&workflow=metadata_sync&view=history&run=7")).toBe(
      "/activity?view=history&run=7",
    );
    expect(legacyLibraryRedirect("/workflows", "?activity=1&runsOf=metadata_sync")).toBe(
      "/activity?workflow=metadata_sync",
    );
    expect(legacyLibraryRedirect("/workflows", "?workflow=metadata_sync&run=7")).toBe("/activity?run=7");
  });
  it("keeps an operation link on Workflows", () => {
    expect(legacyLibraryRedirect("/workflows", "?workflow=circle_catalog_sync&circleId=RG00000000")).toBeNull();
    expect(legacyLibraryRedirect("/workflows")).toBeNull();
  });
  it("moves no-source routes to work management", () => {
    expect(legacyLibraryRedirect("/no-source")).toBe("/metadata?reason=no_source");
    expect(legacyLibraryRedirect("/library/no-source/")).toBe("/metadata?reason=no_source");
  });

  it("moves obsolete database scopes to the normal Library", () => {
    expect(legacyLibraryRedirect("/library/all")).toBe("/");
    expect(legacyLibraryRedirect("/library/remote", "?q=voice")).toBe("/?q=voice");
  });

  it("routes removed Maintenance sections to their System and Settings tabs", () => {
    for (const tab of ["overview", "paths", "system", "local", "remote"]) {
      expect(legacyLibraryRedirect("/maintenance", `?tab=${tab}&source=8`)).toBe("/system?tab=library&source=8");
    }
    expect(legacyLibraryRedirect("/maintenance/", "?tab=security")).toBe("/system?tab=users");
    expect(legacyLibraryRedirect("/maintenance", "?tab=users")).toBe("/system?tab=users");
    expect(legacyLibraryRedirect("/maintenance", "?tab=routing")).toBe("/settings?tab=playback");
    expect(legacyLibraryRedirect("/maintenance", "?tab=recommendation")).toBe("/settings?tab=recommendation");
    expect(legacyLibraryRedirect("/settings", "?tab=appearance")).toBe("/settings");
  });

  it("leaves current routes unchanged", () => {
    expect(legacyLibraryRedirect("/library/source/example_remote")).toBeNull();
    expect(legacyLibraryRedirect("/system", "?tab=users")).toBeNull();
    expect(legacyLibraryRedirect("/tags/")).toBeNull();
    for (const search of ["", "?tab=playback", "?tab=recommendation", "?tab=data", "?tab=time-zone"]) {
      expect(legacyLibraryRedirect("/settings", search)).toBeNull();
    }
  });

  it("redirects bare legacy administration routes", () => {
    expect(legacyLibraryRedirect("/maintenance")).toBe("/system?tab=library");
    expect(legacyLibraryRedirect("/maintenance", "?tab=library")).toBe("/system?tab=library");
    expect(legacyLibraryRedirect("/users")).toBe("/system?tab=users");
    expect(legacyLibraryRedirect("/cleanup")).toBe("/system?tab=cleanup");
  });

  it("opens the administration tabs of Settings links on the System page", () => {
    for (const tab of ["library", "cache", "proxy", "llm", "cleanup", "users"]) {
      expect(legacyLibraryRedirect("/settings", `?tab=${tab}`)).toBe(`/system?tab=${tab}`);
    }
    expect(legacyLibraryRedirect("/settings/", "?tab=library&source=8")).toBe("/system?tab=library&source=8");
    expect(legacyLibraryRedirect("/settings", "?tab=metadata")).toBe("/system?tab=library");
    expect(legacyLibraryRedirect("/settings", "?tab=asr")).toBe("/system?tab=llm");
    expect(legacyLibraryRedirect("/settings", "?tab=services")).toBe("/system?tab=llm");
  });

  it("opens Subscriptions links as Discover with the same view", () => {
    expect(legacyLibraryRedirect("/subscriptions")).toBe("/discover");
    expect(legacyLibraryRedirect("/subscriptions/", "?view=watch&dialog=ready&run=9")).toBe(
      "/discover?view=watch&dialog=ready&run=9",
    );
    expect(legacyLibraryRedirect("/discover", "?view=rankings")).toBeNull();
  });

  it("opens former listening history locations as Insights", () => {
    expect(legacyLibraryRedirect("/history")).toBe("/insights");
    expect(legacyLibraryRedirect("/settings", "?tab=history")).toBe("/insights");
  });

  it("opens former personal locations where their content lives", () => {
    expect(legacyLibraryRedirect("/settings", "?tab=tags")).toBe("/tags");
    expect(legacyLibraryRedirect("/user-data")).toBe("/settings?tab=data");
  });

  it("preserves metadata run filters and maps legacy settings links", () => {
    expect(legacyLibraryRedirect("/maintenance", "?tab=works&reason=metadata&metadataRun=7")).toBe(
      "/metadata?reason=metadata&metadataRun=7",
    );
    expect(legacyLibraryRedirect("/maintenance", "?tab=works")).toBe("/metadata?reason=all");
    expect(legacyLibraryRedirect("/maintenance", "?tab=metadata")).toBe("/metadata?tab=settings");
    expect(legacyLibraryRedirect("/maintenance", "?tab=unlinked")).toBe("/metadata?reason=no_source");
  });

  it("sends translation coverage links to the Translation page", () => {
    expect(legacyLibraryRedirect("/metadata", "?view=translation&language=zh-cn&missing=tags")).toBe(
      "/translation?view=coverage&language=zh-cn&missing=tags",
    );
  });
});
