import { describe, expect, it } from "vitest";

import type { RankingItem, RankingList } from "@/lib/rankingApi";

import { matchesRankingFilter, rankingCompareFromSearch, rankingListLabel, rankingStreakDays } from "./rankingModel";

const t = ((key: string) => key.split(".").pop() ?? key) as Parameters<typeof rankingListLabel>[1];

function list(patch: Partial<RankingList>): RankingList {
  return {
    id: 1,
    provider: "dlsite",
    sourceId: null,
    sourceName: "",
    period: "day",
    releaseWindow: "",
    depth: 100,
    enabled: true,
    position: 0,
    lastPulledAt: null,
    lastChangedAt: null,
    lastStatus: "",
    unseen: false,
    ...patch,
  };
}

function item(patch: Partial<RankingItem>): RankingItem {
  return {
    rank: 1,
    code: "RJ00000001",
    change: { kind: "same", from: 1, delta: 0 },
    firstSeenAt: "2026-10-01 00:00:00",
    streakStartedAt: "2026-10-01 00:00:00",
    bestRank: 1,
    appearances: 1,
    work: null,
    fallback: { code: "RJ00000001", title: "Example Work 1", circle: "", coverUrl: "", dlsiteUrl: "" },
    ...patch,
  };
}

describe("rankingModel", () => {
  it("names a DLsite list by its period and window and a remote list by its source", () => {
    expect(rankingListLabel(list({ period: "week", releaseWindow: "30d" }), t)).toBe("dlsite · week · newReleases");
    expect(rankingListLabel(list({ provider: "remote_source", period: "", sourceName: "Example Remote" }), t)).toBe(
      "Example Remote · popular",
    );
  });

  it("filters new and returning works together, and moves up or down together", () => {
    const items = [
      item({ code: "RJ00000001", change: { kind: "new", from: null, delta: 0 } }),
      item({ code: "RJ00000002", change: { kind: "reentered", from: null, delta: 0 } }),
      item({ code: "RJ00000003", change: { kind: "up", from: 5, delta: 2 } }),
      item({ code: "RJ00000004", change: { kind: "down", from: 1, delta: -3 } }),
      item({ code: "RJ00000005", work: { id: 5 } as RankingItem["work"] }),
    ];
    const codes = (filter: Parameters<typeof matchesRankingFilter>[1]) =>
      items.filter((entry) => matchesRankingFilter(entry, filter)).map((entry) => entry.code.slice(-1));
    expect(codes("new")).toEqual(["1", "2"]);
    expect(codes("moved")).toEqual(["3", "4"]);
    expect(codes("notInLibrary")).toEqual(["1", "2", "3", "4"]);
    expect(codes("all")).toHaveLength(5);
  });

  it("counts the entry day as the first day in the ranking", () => {
    const entered = item({ streakStartedAt: "2026-10-10 09:00:00" });
    expect(rankingStreakDays(entered, new Date("2026-10-10T12:00:00Z"))).toBe(1);
    expect(rankingStreakDays(entered, new Date("2026-10-12T10:00:00Z"))).toBe(3);
  });

  it("reads only a supported comparison from the location", () => {
    expect(rankingCompareFromSearch("?compare=previous")).toBe("previous");
    expect(rankingCompareFromSearch("?compare=42")).toBe("42");
    expect(rankingCompareFromSearch("?compare=seen")).toBe("");
    expect(rankingCompareFromSearch("?compare=-1")).toBe("");
  });
});
