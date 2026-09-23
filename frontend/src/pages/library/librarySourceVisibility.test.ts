import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LibrarySource } from "@/lib/api";

import {
  autoLibrarySourceVisible,
  librarySourceVisible,
  readLibrarySourceVisibility,
  withLibrarySourceVisibilityMode,
  writeLibrarySourceVisibility,
} from "./librarySourceVisibility";

const remoteSource = (enabled: boolean): LibrarySource => ({
  id: 1,
  code: "example-remote",
  displayName: "Example Remote",
  sourceType: "kikoeru_compatible",
  enabled,
});

describe("library source visibility", () => {
  beforeEach(() => {
    const entries = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => entries.set(key, value),
        removeItem: (key: string) => entries.delete(key),
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows Local, Tracked with works, and enabled remote sources automatically", () => {
    expect(autoLibrarySourceVisible("local", { hasTrackedWorks: false })).toBe(true);
    expect(autoLibrarySourceVisible("tracked", { hasTrackedWorks: true })).toBe(true);
    expect(autoLibrarySourceVisible("tracked", { hasTrackedWorks: false })).toBe(false);
    expect(autoLibrarySourceVisible("remote:1", { hasTrackedWorks: null, source: remoteSource(true) })).toBe(true);
    expect(autoLibrarySourceVisible("remote:1", { hasTrackedWorks: null, source: remoteSource(false) })).toBe(false);
  });

  it("lets explicit modes override automatic visibility", () => {
    expect(librarySourceVisible("always", false)).toBe(true);
    expect(librarySourceVisible("never", true)).toBe(false);
    expect(librarySourceVisible("auto", false)).toBe(false);
  });

  it("persists only explicit modes and drops unknown stored entries", () => {
    const preferences = withLibrarySourceVisibilityMode(
      withLibrarySourceVisibilityMode({}, "local", "never"),
      "remote:1",
      "always",
    );
    writeLibrarySourceVisibility("viewer", withLibrarySourceVisibilityMode(preferences, "local", "auto"));
    expect(readLibrarySourceVisibility("viewer")).toEqual({ "remote:1": "always" });

    window.localStorage.setItem(
      "kikoto:library-source-visibility:viewer",
      JSON.stringify({ tracked: "never", "remote:x": "never", local: "sometimes" }),
    );
    expect(readLibrarySourceVisibility("viewer")).toEqual({ tracked: "never" });
  });
});
