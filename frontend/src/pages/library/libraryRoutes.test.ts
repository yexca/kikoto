import { describe, expect, it } from "vitest";

import type { LibrarySource } from "@/lib/api";
import { syntheticWorkCode } from "@/test-support/workCode";

import {
  knownLibraryRoute,
  libraryBrowseKey,
  localScopeFromPath,
  pathForActiveLibrary,
  tabFromPath,
} from "./libraryRoutes";

const remoteSource: LibrarySource = {
  id: 7,
  code: "example_remote_a",
  displayName: "Example Remote A",
  sourceType: "remote",
  enabled: true,
};
const workCode = syntheticWorkCode("RJ", 0);

describe("knownLibraryRoute", () => {
  it("accepts the local list routes and their compatibility paths", () => {
    for (const path of ["/", "/tracked", "/library", "/library/tracked/", "/library/no-source", "/library/all"]) {
      expect(knownLibraryRoute(path, "", [])).toBe(true);
    }
  });

  it("accepts a work code before the configured sources are known", () => {
    expect(knownLibraryRoute(`/${workCode}`, "", [])).toBe(true);
  });

  it("accepts a source list route only for a configured source", () => {
    expect(knownLibraryRoute("/example_remote_a", "", [remoteSource])).toBe(true);
    expect(knownLibraryRoute("/library/source/EXAMPLE_REMOTE_A", "", [remoteSource])).toBe(true);
    expect(knownLibraryRoute("/Example%20Remote%20A", "", [remoteSource])).toBe(true);
    expect(knownLibraryRoute("/example_remote_b", "", [remoteSource])).toBe(false);
    expect(knownLibraryRoute("/example_remote_a", "", [])).toBe(false);
  });

  it("accepts a source-local work code only for a configured source", () => {
    expect(knownLibraryRoute("/REMOTE-SAMPLE", "?source=7", [remoteSource])).toBe(true);
    expect(knownLibraryRoute("/REMOTE-SAMPLE", "?source=8", [remoteSource])).toBe(false);
  });
});

describe("tabFromPath", () => {
  const sourceTab = { kind: "source", source: remoteSource } as const;

  it("selects the source named by the route", () => {
    expect(tabFromPath("/example_remote_a", [remoteSource])).toEqual(sourceTab);
    expect(tabFromPath("/library/source/example_remote_a/", [remoteSource])).toEqual(sourceTab);
  });

  it("selects the local list for its routes, whatever tab was active", () => {
    expect(tabFromPath("/", [remoteSource], sourceTab)).toEqual({ kind: "all" });
    expect(tabFromPath("/tracked", [remoteSource], sourceTab)).toEqual({ kind: "all" });
  });

  it("keeps the active tab under a work detail or an unresolved source", () => {
    expect(tabFromPath(`/${workCode}`, [remoteSource], sourceTab)).toBe(sourceTab);
    expect(tabFromPath("/example_remote_a", [], sourceTab)).toBe(sourceTab);
  });
});

describe("Library list locations", () => {
  it("separates the local and tracked scopes and each source", () => {
    expect(localScopeFromPath("/tracked")).toBe("tracked");
    expect(localScopeFromPath("/")).toBe("local");
    expect(pathForActiveLibrary({ kind: "all" }, "tracked")).toBe("/tracked");
    expect(pathForActiveLibrary({ kind: "source", source: remoteSource }, "tracked")).toBe("/example_remote_a");
    expect(libraryBrowseKey({ kind: "all" }, "tracked", "scope")).toBe("scope:scope:tracked");
    expect(libraryBrowseKey({ kind: "source", source: remoteSource }, "local", "scope")).toBe("scope:source:7");
  });
});
