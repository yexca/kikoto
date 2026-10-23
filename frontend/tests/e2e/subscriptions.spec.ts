import { expect, test, type Page } from "@playwright/test";

import {
  authenticatedStateFixture,
  circleCatalogWorkFixture,
  circleDetailFixture,
  circleSummaryFixture,
  creatorSubscriptionFixture,
  releaseFeedFamilyFixture,
  releaseFeedPageFixture,
  rolePermissions,
  runtimeSettingsFixture,
  subscriptionLookupFixture,
  subscriptionViewFixture,
  type ApiErrorBody,
} from "./fixtures/api";
import type {
  CreatorSubscriptionLookup,
  RankingItem,
  RankingList,
  RankingOverview,
  RankingPage,
  ReleaseFeedPage,
} from "../../src/lib/api";
import { syntheticWorkCode } from "../../src/test-support/workCode";

type SubscriptionServer = {
  feed?: ReleaseFeedPage;
  lookup?: CreatorSubscriptionLookup;
  demo?: boolean;
  rankings?: RankingOverview;
  /** Ranking pages by `<list id>:<compare>`; an empty compare is the last visit. */
  rankingPages?: Record<string, RankingPage>;
  requests: Array<{ method: string; path: string; body: unknown }>;
  feedQueries: string[];
};

function rankingListFixture(patch: Partial<RankingList> = {}): RankingList {
  return {
    id: 1,
    provider: "dlsite",
    sourceId: null,
    sourceName: "",
    period: "day",
    releaseWindow: "30d",
    depth: 100,
    enabled: true,
    position: 0,
    lastPulledAt: "2026-10-14 09:00:00",
    lastChangedAt: "2026-10-14 09:00:00",
    lastStatus: "succeeded",
    unseen: true,
    ...patch,
  };
}

function rankingItemFixture(ordinal: number, rank: number, change: RankingItem["change"]): RankingItem {
  const code = syntheticWorkCode("RJ", ordinal);
  return {
    rank,
    code,
    change,
    firstSeenAt: "2026-10-12 09:00:00",
    streakStartedAt: "2026-10-12 09:00:00",
    bestRank: rank,
    appearances: 2,
    work: null,
    fallback: { code, title: `Example Work ${ordinal}`, circle: "Example Circle 1", coverUrl: "", dlsiteUrl: "" },
  };
}

function rankingPageFixture(list: RankingList, baseline: RankingPage["baseline"], items: RankingItem[]): RankingPage {
  const dropped = [
    {
      code: syntheticWorkCode("RJ", 9),
      previousRank: 3,
      work: null,
      fallback: { code: syntheticWorkCode("RJ", 9), title: "Example Work 9", circle: "", coverUrl: "", dlsiteUrl: "" },
    },
  ];
  const count = (kind: string) => items.filter((item) => item.change.kind === kind).length;
  return {
    list,
    snapshot: { id: 30, pulledAt: "2026-10-14 09:00:00" },
    baseline,
    counts: {
      new: count("new"),
      reentered: count("reentered"),
      up: count("up"),
      down: count("down"),
      dropped: dropped.length,
      notInLibrary: items.length,
    },
    items,
    dropped,
    snapshots: [
      { id: 30, pulledAt: "2026-10-14 09:00:00" },
      { id: 20, pulledAt: "2026-10-13 09:00:00" },
      { id: 10, pulledAt: "2026-10-12 09:00:00" },
    ],
    demo: false,
  };
}

async function mockSubscriptions(page: Page, server: SubscriptionServer) {
  if (server.demo) {
    await page.route("**/api/runtime-settings", (route) =>
      route.fulfill({ json: runtimeSettingsFixture({ mode: "demo", demoMode: true }) }),
    );
  }
  let unread = server.feed?.unreadCount ?? 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/subscriptions") || url.pathname.startsWith("/api/rankings")) {
      server.requests.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() });
    }
    if (url.pathname === "/api/rankings") {
      await route.fulfill({
        json: server.rankings ?? {
          lists: [],
          schedule: {
            enabled: true,
            intervalHours: 24,
            nextRunAt: null,
            lastRunAt: null,
            lastSuccessAt: null,
            lastError: "",
            latestRun: null,
          },
          demo: Boolean(server.demo),
        },
      });
      return;
    }
    const rankingPage = /^\/api\/rankings\/(\d+)$/.exec(url.pathname);
    if (rankingPage) {
      const page = server.rankingPages?.[`${rankingPage[1]}:${url.searchParams.get("compare") ?? ""}`];
      await route.fulfill(page ? { json: page } : { status: 404, json: { error: "ranking not found" } });
      return;
    }
    if (/^\/api\/rankings\/\d+\/seen$/.test(url.pathname)) {
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({
        json: server.demo
          ? authenticatedStateFixture({
              username: "__demo__",
              role: "user",
              permissions: ["library:read"],
              demoMode: true,
            })
          : authenticatedStateFixture({ role: "admin", permissions: rolePermissions.admin }),
      });
      return;
    }
    if (url.pathname === "/api/subscriptions/feed/unread") {
      await route.fulfill({ json: { count: unread } });
      return;
    }
    if (url.pathname === "/api/subscriptions/feed/seen") {
      unread = 0;
      await route.fulfill({ json: { count: 0 } });
      return;
    }
    if (url.pathname === "/api/subscriptions/feed") {
      server.feedQueries.push(url.search);
      await route.fulfill({ json: server.feed ?? releaseFeedPageFixture() });
      return;
    }
    if (url.pathname === "/api/subscriptions/lookup") {
      await route.fulfill({ json: server.lookup ?? subscriptionLookupFixture() });
      return;
    }
    if (url.pathname === "/api/subscriptions" && request.method() === "POST") {
      await route.fulfill({
        status: 201,
        json: {
          subscription: creatorSubscriptionFixture({ status: "pending", activatedAt: null }),
          removedSeries: server.lookup?.series ?? [],
          pullRun: { runId: 41, status: "queued" },
        },
      });
      return;
    }
    if (url.pathname === "/api/subscriptions") {
      await route.fulfill({ json: subscriptionViewFixture() });
      return;
    }
    if (url.pathname === "/api/circles/RG00001") {
      await route.fulfill({
        json: circleDetailFixture(
          circleSummaryFixture({ externalId: "RG00001", displayName: "Example Circle 1", syncState: "never" }),
          {
            // A full grid sits under the centered dialog, so a dialog trapped
            // in the header's stacking context would be covered by the cards.
            works: Array.from({ length: 12 }, (_, index) =>
              circleCatalogWorkFixture({
                primaryCode: syntheticWorkCode("RJ", index),
                title: `Example Work ${index + 1}`,
                circleExternalId: "RG00001",
              }),
            ),
          },
        ),
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: `Not mocked: ${url.pathname}` } satisfies ApiErrorBody });
  });
}

test("@desktop the feed groups families by day, pages by days, and opening it clears the new-release badge", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const server: SubscriptionServer = {
    requests: [],
    feedQueries: [],
    feed: releaseFeedPageFixture([
      releaseFeedFamilyFixture({
        unread: true,
        events: [
          {
            type: "edition",
            code: "RJ00000002",
            language: "en-us",
            at: "2026-10-14 09:00:00",
            subject: { kind: "series", circleId: "RG00001", seriesId: "SRI0000000001", seriesName: "Example Series 1" },
          },
        ],
      }),
      releaseFeedFamilyFixture({
        key: "code:RJ00000003",
        latestAt: "2026-10-12 09:00:00",
        day: "2026-10-12",
        events: [
          {
            type: "available",
            code: "RJ00000003",
            language: "",
            at: "2026-10-12 09:00:00",
            subject: { kind: "watch" },
          },
        ],
        fallback: { ...releaseFeedFamilyFixture().fallback, code: "RJ00000003", title: "Example Work 3" },
      }),
    ]),
  };
  server.feed!.totalDays = 12;
  await mockSubscriptions(page, server);
  await page.goto("/");
  const navigation = page.getByRole("button", { name: /^Subscriptions/ });
  await expect(navigation.getByLabel("1 new release")).toBeVisible();

  await navigation.click();
  const feed = page.getByRole("region", { name: "New releases", exact: true });
  const yesterday = feed.getByRole("region", { name: "New releases, Yesterday" });
  await expect(yesterday.getByRole("heading", { name: /^Yesterday/ })).toBeVisible();
  await expect(yesterday.getByText("1 work", { exact: true })).toBeVisible();
  const entry = yesterday.getByRole("listitem");
  await expect(entry).toContainText("New English edition");
  await expect(entry).toContainText("Series · Example Series 1");
  await expect(entry.getByText("New since your last visit")).toBeAttached();
  const older = feed.getByRole("region", { name: /^New releases, .*October 12/ }).getByRole("listitem");
  await expect(older).toContainText("Now available");
  await expect(older).toContainText("Availability Watch");
  await expect(feed.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: "Page 2" })).toBeVisible();

  // Days per page is a display option beside the Library card choices.
  await page.getByRole("button", { name: /^Display options/ }).click();
  await page.getByRole("radio", { name: "5 days per page", exact: true }).click();
  await expect.poll(() => server.feedQueries.at(-1)).toMatch(/days=5/);
  await page.keyboard.press("Escape");
  await expect
    .poll(() => server.requests.some((request) => request.path === "/api/subscriptions/feed/seen"))
    .toBe(true);
  await expect(navigation.getByLabel("1 new release")).toHaveCount(0);

  // Settings open in a drawer from the toolbar icon.
  await page.getByRole("button", { name: "Subscription settings" }).click();
  await expect(page).toHaveURL(/\/subscriptions\?panel=subscriptions$/);
  const settings = page.getByRole("dialog", { name: "Subscription settings" });
  await expect(settings.getByRole("tab", { name: "Subscriptions", selected: true })).toBeVisible();
  await expect(settings.getByText("Refresh schedule")).toBeVisible();
  await settings.getByRole("button", { name: "Close settings" }).click();
  await expect(settings).toHaveCount(0);
  await expect(page).toHaveURL(/\/subscriptions$/);
});

test("@desktop subscribing to a circle confirms replacing its series and pulls the catalog for a baseline", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const series = creatorSubscriptionFixture({
    id: 2,
    kind: "series",
    seriesId: "SRI0000000001",
    seriesName: "Example Series 1",
  });
  const server: SubscriptionServer = {
    requests: [],
    feedQueries: [],
    lookup: subscriptionLookupFixture({ series: [series], catalog: { syncState: "never", lastSyncedAt: null } }),
  };
  await mockSubscriptions(page, server);
  await page.goto("/circles/RG00001");
  await expect(page.getByText("Example Work 1", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Subscribe", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Subscribe to Example Circle 1" });
  await expect(dialog).toContainText("replaces your subscription to this series");
  await expect(dialog.getByRole("listitem")).toHaveText(["Example Series 1"]);
  await expect(dialog).toContainText("Pull it now to set the baseline");
  await dialog.getByRole("button", { name: "Pull now and subscribe", exact: true }).click();

  await expect(page.getByText("Subscribed. The catalog pull that sets the baseline is queued.")).toBeVisible();
  const created = server.requests.find((request) => request.method === "POST" && request.path === "/api/subscriptions");
  expect(created?.body).toEqual({ kind: "circle", circleId: "RG00001", replaceSeries: true, pullNow: true });
  await expect(page.getByRole("button", { name: "Subscribed; waiting for the first catalog pull" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("@desktop rankings mark changes since the last visit and compare with the previous update", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const day = rankingListFixture();
  const week = rankingListFixture({ id: 2, period: "week", releaseWindow: "", position: 1, unseen: false });
  const server: SubscriptionServer = {
    requests: [],
    feedQueries: [],
    rankings: {
      lists: [day, week],
      schedule: {
        enabled: true,
        intervalHours: 24,
        nextRunAt: "2026-10-15 09:00:00",
        lastRunAt: "2026-10-14 09:00:00",
        lastSuccessAt: "2026-10-14 09:00:00",
        lastError: "",
        latestRun: { id: 7, status: "succeeded" },
      },
      demo: false,
    },
    rankingPages: {
      "1:": rankingPageFixture(day, { id: 10, pulledAt: "2026-10-12 09:00:00", kind: "seen" }, [
        rankingItemFixture(1, 1, { kind: "new", from: null, delta: 0 }),
        rankingItemFixture(2, 2, { kind: "up", from: 5, delta: 3 }),
        rankingItemFixture(3, 3, { kind: "same", from: 3, delta: 0 }),
      ]),
      "1:previous": rankingPageFixture(day, { id: 20, pulledAt: "2026-10-13 09:00:00", kind: "previous" }, [
        rankingItemFixture(1, 1, { kind: "reentered", from: null, delta: 0 }),
        rankingItemFixture(2, 2, { kind: "down", from: 1, delta: -1 }),
        rankingItemFixture(3, 3, { kind: "same", from: 3, delta: 0 }),
      ]),
    },
  };
  await mockSubscriptions(page, server);
  await page.goto("/subscriptions?view=rankings");

  await expect(page.getByRole("tab", { name: /^Rankings/, selected: true })).toBeVisible();
  const ranking = page.getByRole("region", { name: "Rankings", exact: true });
  await expect(ranking.getByRole("tab", { name: "DLsite · 24 hours · New releases", selected: true })).toBeVisible();
  await expect(ranking).toContainText("Compared with your last visit");
  const items = ranking.getByRole("list").first().getByRole("listitem");
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText("New");
  await expect(items.nth(0)).toContainText("Not in library");
  await expect(items.nth(1).getByText("Up 3")).toBeAttached();

  // Opening the ranking records the displayed update as seen.
  await expect
    .poll(() => server.requests.find((request) => request.path === "/api/rankings/1/seen")?.body)
    .toEqual({ snapshotId: 30 });

  await ranking.getByRole("button", { name: /^Moved/ }).click();
  await expect(items).toHaveCount(1);
  await expect(items.first()).toHaveAccessibleName("Example Work 2");
  await ranking.getByRole("button", { name: /^All/ }).click();

  await ranking.getByRole("combobox", { name: "Compare with" }).click();
  await page.getByRole("option", { name: "Previous update" }).click();
  await expect(page).toHaveURL(/compare=previous/);
  await expect(ranking).toContainText("Compared with the previous update");
  await expect(items.nth(0)).toContainText("Back");

  await ranking.getByRole("button", { name: "Dropped out (1)" }).click();
  await expect(ranking.getByRole("listitem", { name: "Example Work 9" })).toContainText("Was #3");

  // The settings icon opens the ranking settings from this view.
  await page.getByRole("button", { name: "Subscription settings" }).click();
  const settings = page.getByRole("dialog", { name: "Subscription settings" });
  await expect(settings.getByRole("tab", { name: "Rankings", selected: true })).toBeVisible();
  await expect(settings.getByText("DLsite · 7 days")).toBeVisible();
});

test("Demo shows a sample feed without actions", async ({ page }) => {
  const server: SubscriptionServer = {
    requests: [],
    feedQueries: [],
    demo: true,
    feed: releaseFeedPageFixture([releaseFeedFamilyFixture({ unread: true })], { demo: true }),
  };
  await mockSubscriptions(page, server);
  await page.goto("/subscriptions");

  const entry = page.getByRole("region", { name: "New releases", exact: true }).getByRole("listitem");
  await expect(entry).toContainText("Example Work 1");
  await expect(entry.getByRole("button", { name: "Add to Availability Watch" })).toHaveCount(0);
  expect(server.requests.some((request) => request.path === "/api/subscriptions/feed/seen")).toBe(false);
});
