import { describe, expect, it } from "vitest";

import type { LibrarySource } from "@/lib/libraryApi";
import type { RankingItem, RankingList, RankingOrder, RankingVariant } from "@/lib/rankingApi";

import {
  decodeRankingOrder,
  encodeRankingOrder,
  matchesRankingFilter,
  rankingAtFromSearch,
  rankingChipOrder,
  rankingChips,
  rankingChipUnseen,
  rankingCompareFromSearch,
  rankingDayAt,
  rankingDayIsDailyOnly,
  rankingIntervalOptions,
  rankingListLabel,
  rankingOrderFor,
  rankingOrderFromSearch,
  rankingOrderSearch,
  rankingsUnseen,
  rankingSettingRows,
  rankingStreakDays,
  rankingVariantFor,
  zonedDay,
  zonedDayRange,
  zonedWallTime,
} from "./rankingModel";

const t = ((key: string, options?: { year?: number }) =>
  options?.year ? `${key.split(".").pop()} ${options.year}` : (key.split(".").pop() ?? key)) as Parameters<
  typeof rankingListLabel
>[1];

const DLSITE_ORDERS: RankingOrder[] = [
  { releaseWindow: "", sort: "" },
  { releaseWindow: "30d", sort: "" },
  { releaseWindow: "", sort: "sale" },
  { releaseWindow: "30d", sort: "sale" },
];

/** The orders of a kind of list, numbered after the list, with the named orders unread. */
function variants(id: number, provider: RankingList["provider"], period: RankingList["period"], unseen: string[] = []) {
  const orders =
    provider === "remote_source"
      ? DLSITE_ORDERS.slice(0, 1)
      : period === "year" || period === "total"
        ? DLSITE_ORDERS.filter((order) => !order.releaseWindow)
        : DLSITE_ORDERS;
  return orders.map((order, index): RankingVariant => ({
    ...order,
    id: id * 10 + index,
    lastPulledAt: null,
    lastChangedAt: null,
    lastStatus: "",
    unseen: unseen.includes(encodeRankingOrder(order)),
  }));
}

function list(patch: Partial<RankingList> & { unseen?: string[] }): RankingList {
  const { unseen, ...rest } = patch;
  const id = rest.id ?? 1;
  const provider = rest.provider ?? "dlsite";
  const period = rest.period ?? "day";
  return {
    id,
    provider,
    sourceId: null,
    sourceName: "",
    sourceAvailable: true,
    period,
    year: 0,
    depth: 100,
    enabled: true,
    autoRefresh: true,
    refreshIntervalMinutes: 60,
    nextPullAt: null,
    pullRequested: false,
    finalAt: null,
    followCurrentYear: true,
    lastPulledAt: null,
    lastStatus: "",
    variants: variants(id, provider, period, unseen),
    ...rest,
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

function source(patch: Partial<LibrarySource>): LibrarySource {
  return {
    id: 7,
    displayName: "Example Remote",
    sourceType: "kikoeru_compatible",
    enabled: true,
    ...patch,
  } as LibrarySource;
}

describe("rankingModel", () => {
  it("names a DLsite list by its period and year, and a remote list by its source", () => {
    expect(rankingListLabel(list({ period: "total" }), t)).toBe("dlsite · total");
    expect(rankingListLabel(list({ period: "year", year: 2025 }), t)).toBe("dlsite · year · 2025");
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

  it("reads only a supported comparison and history time from the location", () => {
    expect(rankingCompareFromSearch("?compare=previous")).toBe("previous");
    expect(rankingCompareFromSearch("?compare=42")).toBe("42");
    expect(rankingCompareFromSearch("?compare=2026-10-20T03:00:00Z")).toBe("2026-10-20T03:00:00.000Z");
    expect(rankingCompareFromSearch("?compare=seen")).toBe("");
    expect(rankingCompareFromSearch("?compare=-1")).toBe("");
    expect(rankingAtFromSearch("?at=2026-10-20T03:00:00Z")).toBe("2026-10-20T03:00:00.000Z");
    expect(rankingAtFromSearch("?at=soon")).toBeNull();
    expect(rankingAtFromSearch("?view=rankings")).toBeNull();
  });

  it("shows the chips in their fixed order with the annual lists as one chip", () => {
    const chips = rankingChips([
      list({ id: 8, provider: "remote_source", period: "", sourceId: 2, sourceName: "Example Remote B" }),
      list({ id: 5, period: "total" }),
      list({ id: 2, period: "year", year: 2024, finalAt: "2025-01-03 00:00:00" }),
      list({ id: 3, period: "month" }),
      list({ id: 7, provider: "remote_source", period: "", sourceId: 1, sourceName: "Example Remote A" }),
      list({ id: 4, period: "year", year: 2026 }),
      list({ id: 1, period: "week" }),
      list({ id: 6, period: "day" }),
    ]);
    // Remote lists keep the order they arrive in: the sources' configured order.
    expect(chips.map((chip) => chip.key)).toEqual([
      "list:6",
      "list:1",
      "list:3",
      "annual",
      "list:5",
      "list:8",
      "list:7",
    ]);
    expect(chips[3].lists.map((entry) => entry.year)).toEqual([2026, 2024]);
  });

  it("shows each list in the closest order it is pulled in", () => {
    const day = list({ period: "day" });
    const annual = list({ id: 2, period: "year", year: 2025 });
    const remote = list({ id: 3, provider: "remote_source", period: "" });
    const newBySales: RankingOrder = { releaseWindow: "30d", sort: "sale" };
    expect(rankingOrderFor(day, newBySales)).toEqual(newBySales);
    expect(rankingOrderFor(annual, newBySales)).toEqual({ releaseWindow: "", sort: "sale" });
    expect(rankingOrderFor(remote, newBySales)).toEqual({ releaseWindow: "", sort: "" });
    expect(rankingVariantFor(day, newBySales)?.id).toBe(13);
    expect(rankingVariantFor(annual, newBySales)?.id).toBe(21);
  });

  it("reads and writes the order in the location and in storage", () => {
    expect(rankingOrderFromSearch("?view=rankings&list=1")).toBeNull();
    expect(rankingOrderFromSearch("?release=30d&sort=sale")).toEqual({ releaseWindow: "30d", sort: "sale" });
    expect(rankingOrderFromSearch("?sort=price")).toEqual({ releaseWindow: "", sort: "" });
    expect(rankingOrderSearch({ releaseWindow: "", sort: "sale" })).toEqual({ release: null, sort: "sale" });
    expect(decodeRankingOrder(encodeRankingOrder({ releaseWindow: "30d", sort: "" }))).toEqual({
      releaseWindow: "30d",
      sort: "",
    });
    expect(decodeRankingOrder("7d/price")).toBeNull();
  });

  it("marks a chip unread by the order it shows", () => {
    const day = list({ id: 1, period: "day", unseen: ["30d/"] });
    const annual = list({ id: 2, period: "year", year: 2026, unseen: ["/sale"] });
    const chips = rankingChips([day, annual]);
    const newReleases: RankingOrder = { releaseWindow: "30d", sort: "" };
    expect(rankingChipUnseen(chips[0], { releaseWindow: "", sort: "" })).toBe(false);
    expect(rankingChipUnseen(chips[0], newReleases)).toBe(true);
    // The location names the shown chip's order; other chips show their last choice.
    const shown = { chipKey: "list:1", order: newReleases };
    expect(rankingChipOrder(chips[0], shown, {})).toEqual(newReleases);
    expect(rankingChipOrder(chips[1], shown, { annual: { releaseWindow: "", sort: "sale" } })).toEqual({
      releaseWindow: "",
      sort: "sale",
    });
    expect(rankingsUnseen([day, annual], 2, null, {})).toBe(false);
    expect(rankingsUnseen([day, annual], 2, null, { "list:1": newReleases })).toBe(true);
    expect(rankingsUnseen([day, annual], 2, { releaseWindow: "", sort: "sale" }, {})).toBe(true);
    expect(rankingsUnseen([{ ...day, enabled: false }], null, newReleases, {})).toBe(false);
  });

  it("offers a fixed row for every ranking, with or without a list", () => {
    const rows = rankingSettingRows(
      [
        list({ id: 1, period: "week" }),
        list({ id: 4, period: "total" }),
        list({ id: 2, period: "year", year: 2024 }),
        list({ id: 3, provider: "remote_source", period: "", sourceId: 9, sourceName: "Example Gone" }),
      ],
      [source({ id: 7 }), source({ id: 8, enabled: false }), source({ id: 10, sourceType: "local_folder" })],
      2026,
      t,
    );
    expect(rows.dlsite.map((row) => row.list?.id ?? null)).toEqual([null, 1, null]);
    expect(rows.dlsite[0].kind).toBe("day");
    expect(rows.total.list?.id).toBe(4);
    expect(rows.total.kind).toBe("total");
    expect(rows.currentYear.request).toEqual({ provider: "dlsite", period: "year", year: 2026 });
    expect(rows.currentYear.list).toBeNull();
    expect(rows.pastYears.map((row) => row.list?.id)).toEqual([2]);
    expect(rows.addableYears[0]).toBe(2025);
    expect(rows.addableYears).not.toContain(2024);
    expect(rows.addableYears[rows.addableYears.length - 1]).toBe(2000);
    // An enabled compatible source, then the list of a source that is no longer offered.
    expect(rows.remote.map((row) => [row.request.sourceId, row.list?.id ?? null])).toEqual([
      [7, null],
      [9, 3],
    ]);
  });

  it("offers each kind's intervals and keeps an unusual current one", () => {
    expect(rankingIntervalOptions("day", 60)).toEqual([20, 30, 60, 120, 180, 360, 720, 1440]);
    expect(rankingIntervalOptions("year", 1440)[0]).toBe(1440);
    expect(rankingIntervalOptions("total", 10080)).toEqual([1440, 2880, 4320, 10080, 20160, 43200]);
    expect(rankingIntervalOptions("week", 90)).toContain(90);
  });

  it("reads calendar days and wall-clock times in the account's time zone", () => {
    // 20:00 UTC on 24 October is already 25 October in Japan.
    const instant = Date.parse("2026-10-24T20:00:00Z");
    expect(zonedDay(instant, "Asia/Tokyo")).toBe("2026-10-25");
    expect(zonedDay(instant, "UTC")).toBe("2026-10-24");
    const day = zonedDayRange("2026-10-25", "Asia/Tokyo");
    expect(new Date(day.start).toISOString()).toBe("2026-10-24T15:00:00.000Z");
    expect(new Date(day.end).toISOString()).toBe("2026-10-25T15:00:00.000Z");
    expect(zonedWallTime("2026-10-25T09:30", "Asia/Tokyo")).toBe("2026-10-25T00:30:00.000Z");
    expect(zonedWallTime("not a time", "Asia/Tokyo")).toBeNull();
  });

  it("shows a past day at its end and today at the current time", () => {
    const now = Date.parse("2026-10-25T03:00:00Z");
    expect(rankingDayAt("2026-10-20", "UTC", now)).toBe("2026-10-20T23:59:59.000Z");
    expect(rankingDayAt("2026-10-25", "UTC", now)).toBe("2026-10-25T03:00:00.000Z");
    expect(rankingDayIsDailyOnly("2026-09-01", "UTC", "2026-09-25 03:00:00")).toBe(true);
    expect(rankingDayIsDailyOnly("2026-09-25", "UTC", "2026-09-25 03:00:00")).toBe(false);
  });
});
