import { describe, expect, it } from "vitest";

import { circleSourceBadges, sourcePresenceBadges } from "./sourceBadges";

describe("source presence badges", () => {
  it("orders local, tracked, and remote presence and distinguishes unforked tracking", () => {
    const badges = sourcePresenceBadges([
      { type: "source", availability: "available", fileSourceId: 4, fileSourceName: "Example Remote" },
      { type: "tracked", availability: "available", fileSourceId: 5, fileSourceName: "Example Tracked" },
      { type: "local", availability: "available" },
    ]);

    expect(badges.map((badge) => badge.key)).toEqual(["source:local", "source:tracked:5", "source:4"]);
    expect(badges[1]).toMatchObject({ label: "Unforked", variant: "warning" });
  });

  it("uses playable availability to label tracked sources and falls back to availability badges", () => {
    const tracked = sourcePresenceBadges(
      [{ type: "tracked", availability: "available", fileSourceId: 5, fileSourceName: "Example Tracked" }],
      ["remote"],
    );
    expect(tracked[0]).toMatchObject({ key: "source:tracked:5", label: "Tracked", variant: "outline" });

    const fallback = sourcePresenceBadges([], ["missing", "cache", "remote"]);
    expect(fallback.map((badge) => badge.key)).toEqual(["source:cache", "source:missing"]);

    const noSource = sourcePresenceBadges([], []);
    expect(noSource).toMatchObject([{ key: "source:no-source", variant: "warning" }]);
  });
});

describe("circle source badges", () => {
  it("filters non-playable source summaries, deduplicates keys, and keeps local/cache first", () => {
    const badges = circleSourceBadges({
      local: true,
      cache: true,
      sourceTags: [
        { key: "remote", sourceId: 1, displayName: "Ignored Remote", status: "available", count: 4 },
        { key: "example_remote", sourceId: 7, displayName: "Example Remote", status: "available", count: 1 },
        { key: "example_remote_duplicate", sourceId: 7, displayName: "Duplicate", status: "available", count: 2 },
        { key: "empty", sourceId: 8, displayName: "Empty", status: "unknown", count: 0 },
        { key: "degraded", sourceId: 9, displayName: "Degraded", status: "error", count: 2 },
      ],
    });

    expect(badges.map((badge) => badge.key)).toEqual([
      "source:local",
      "source:remote:9",
      "source:remote:7",
      "source:cache",
    ]);
    expect(badges[2].label).toBe("Example Remote");
  });

  it("treats a null source summary from an older API as empty", () => {
    expect(
      circleSourceBadges({
        sourceTags: null,
      }),
    ).toEqual([]);
  });
});
