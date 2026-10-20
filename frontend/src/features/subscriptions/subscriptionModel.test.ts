import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";

import type { CreatorSubscription, CreatorSubscriptionLookup, ReleaseFeedFamily } from "@/lib/api";

import {
  releaseFeedSources,
  subscribeButtonState,
  subscribeConfirmation,
  subscriptionSubjectPath,
  subscriptionPanelFromSearch,
  groupReleaseFeedByDay,
  releaseFeedDayCount,
  releaseFeedPageFromSearch,
} from "./subscriptionModel";

const series: CreatorSubscription = {
  id: 2,
  kind: "series",
  circleId: "RG00001",
  circleName: "Example Circle 1",
  seriesId: "SRI0000000001",
  seriesName: "Example Series 1",
  watchAvailability: false,
  status: "active",
  activatedAt: "2026-10-01 00:00:00",
  createdAt: "2026-10-01 00:00:00",
  catalogSyncedAt: null,
};

function lookup(patch: Partial<CreatorSubscriptionLookup> = {}): CreatorSubscriptionLookup {
  return {
    subscription: null,
    coveredBy: null,
    series: [],
    catalog: { syncState: "synced", lastSyncedAt: "2026-10-14T00:00:00Z" },
    available: true,
    ...patch,
  };
}

describe("subscription model", () => {
  it("opens a settings panel only when the location names one", () => {
    expect(subscriptionPanelFromSearch("")).toBeNull();
    expect(subscriptionPanelFromSearch("?panel=watch&dialog=ready")).toBe("watch");
    expect(subscriptionPanelFromSearch("?panel=unknown")).toBeNull();
  });

  it("groups a page by the day the server dated each family", () => {
    const family = (key: string, day: string) => ({ key, day }) as ReleaseFeedFamily;
    const days = groupReleaseFeedByDay(
      [family("a", "2026-10-15"), family("b", "2026-10-15"), family("c", "2026-10-14"), family("d", "2026-03-10")],
      "2026-10-15",
    );
    expect(days.map((day) => [day.day, day.offset, day.families.map((item) => item.key)])).toEqual([
      ["2026-10-15", 0, ["a", "b"]],
      ["2026-10-14", 1, ["c"]],
      ["2026-03-10", 219, ["d"]],
    ]);
    expect(days[2].date).toEqual(new Date(2026, 2, 10));
    expect(releaseFeedDayCount("15")).toBe(15);
    expect(releaseFeedDayCount(7)).toBe(10);
    expect(releaseFeedPageFromSearch("?panel=watch&page=3")).toBe(3);
    expect(releaseFeedPageFromSearch("?page=0")).toBe(1);
  });

  it("reports a series included in a circle subscription as covered", () => {
    expect(subscribeButtonState(null)).toBe("loading");
    expect(subscribeButtonState(lookup({ coveredBy: { ...series, id: 1, kind: "circle" } }))).toBe("covered");
    expect(subscribeButtonState(lookup({ subscription: { ...series, status: "pending" } }))).toBe("pending");
    expect(subscribeButtonState(lookup({ available: false }))).toBe("unavailable");
    expect(subscribeButtonState(lookup())).toBe("unsubscribed");
  });

  it("asks for a baseline pull only when the catalog is not fresh, and lists the series a circle replaces", () => {
    expect(subscribeConfirmation(lookup())).toEqual({ replacedSeries: [], needsBaseline: false });
    expect(
      subscribeConfirmation(lookup({ series: [series], catalog: { syncState: "never", lastSyncedAt: null } })),
    ).toEqual({ replacedSeries: [series], needsBaseline: true });
  });

  it("links each subscription to its page", () => {
    expect(subscriptionSubjectPath(series)).toBe("/circles/RG00001/series/SRI0000000001");
    expect(subscriptionSubjectPath({ kind: "voice", personId: 7, voiceRouteKey: "00000001" })).toBe("/voices/00000001");
    expect(subscriptionSubjectPath({ kind: "voice", personId: 8, voiceRouteKey: "local-8" })).toBe("/voices/local-8");
    expect(subscriptionSubjectPath({ kind: "voice", personId: 7 })).toBeNull();
    expect(subscriptionSubjectPath({ kind: "watch" })).toBeNull();
  });

  it("names each subscription a family arrived through once", () => {
    const t = ((key: string, values?: Record<string, string>) =>
      `${key}:${values?.name ?? ""}`) as unknown as TFunction;
    const family = {
      events: [
        {
          type: "edition",
          code: "RJ00000002",
          language: "en-us",
          at: "",
          subject: { kind: "circle", circleName: "A" },
        },
        { type: "released", code: "RJ00000001", language: "", at: "", subject: { kind: "circle", circleName: "A" } },
        { type: "available", code: "RJ00000001", language: "", at: "", subject: { kind: "watch" } },
      ],
    } as ReleaseFeedFamily;
    expect(releaseFeedSources(family, t)).toEqual(["subscriptions.feed.via.circle:A", "subscriptions.feed.via.watch:"]);
  });
});
