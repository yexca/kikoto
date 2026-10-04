import { describe, expect, it } from "vitest";

import { libraryTagSearchLocation } from "./libraryTagSearch";

function searchQuery(location: string | null) {
  return new URL(location ?? "", "https://kikoto.invalid").searchParams.get("q");
}

describe("library tag search location", () => {
  it("adds a personal tag to the local library view it came from", () => {
    const location = libraryTagSearchLocation("user_tag", "Sleep aid", "/tracked?q=tag%3AExample&status=listening");

    expect(location?.startsWith("/tracked?")).toBe(true);
    expect(searchQuery(location)).toBe('tag:Example mytag:"Sleep aid"');
    expect(new URL(location!, "https://kikoto.invalid").searchParams.get("status")).toBe("listening");
  });

  it("does not repeat a personal tag that is already searched", () => {
    expect(searchQuery(libraryTagSearchLocation("user_tag", "sleep", "/?q=mytag%3ASleep"))).toBe("mytag:sleep");
  });

  it("opens a personal tag from another page as a fresh local library search", () => {
    expect(libraryTagSearchLocation("user_tag", "Sleep", "/favorites?q=Example")).toBe("/?q=mytag%3ASleep");
    expect(libraryTagSearchLocation("user_tag", "Sleep", "/library/source/example_remote_a?q=tag%3AExample")).toBe(
      "/?q=mytag%3ASleep",
    );
  });

  it("keeps a provider tag on the remote source library it came from", () => {
    expect(libraryTagSearchLocation("tag", "Example", "/library/source/example_remote_a?q=circle%3AExample")).toBe(
      "/library/source/example_remote_a?q=circle%3AExample+tag%3AExample",
    );
  });

  it("ignores a blank tag", () => {
    expect(libraryTagSearchLocation("user_tag", "  ", "/")).toBeNull();
  });
});
