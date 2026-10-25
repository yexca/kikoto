import { expect, test, type Page } from "@playwright/test";

import {
  authenticatedStateFixture,
  circleCatalogWorkFixture,
  circleDetailFixture,
  circleSummaryFixture,
  creatorSubscriptionFixture,
  librarySourceFixture,
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
  RankingOrder,
  RankingOverview,
  RankingPage,
  RankingSnapshotRef,
  RankingTimeline,
  RankingVariant,
  ReleaseFeedPage,
} from "../../src/lib/api";
import { syntheticWorkCode } from "../../src/test-support/workCode";

type SubscriptionServer = {
  feed?: ReleaseFeedPage;
  lookup?: CreatorSubscriptionLookup;
  demo?: boolean;
  rankings?: RankingOverview;
  /**
   * Ranking pages by `<list>:<compare>` for the latest order and `<list>@<at>` for history,
   * where `<list>` is the list id, followed by `~<release>/<sort>` for an order other than the default.
   */
  rankingPages?: Record<string, RankingPage>;
  /** Snapshot timelines by list id. */
  timelines?: Record<string, RankingSnapshotRef[]>;
  requests: Array<{ method: string; path: string; body: unknown }>;
  feedQueries: string[];
};

const DLSITE_ORDERS: RankingOrder[] = [
  { releaseWindow: "", sort: "" },
  { releaseWindow: "30d", sort: "" },
  { releaseWindow: "", sort: "sale" },
  { releaseWindow: "30d", sort: "sale" },
];

/** A list's orders, numbered after it; `unseen` names the unread ones as `<release>/<sort>`. */
function rankingVariantsFixture(listId: number, period: RankingList["period"], unseen: string[]): RankingVariant[] {
  const orders =
    period === "year" || period === "total" ? DLSITE_ORDERS.filter((order) => !order.releaseWindow) : DLSITE_ORDERS;
  return orders.map((order, index) => ({
    ...order,
    id: listId * 10 + index,
    lastPulledAt: "2026-10-14 09:00:00",
    lastChangedAt: "2026-10-14 09:00:00",
    lastStatus: "succeeded",
    unseen: unseen.includes(`${order.releaseWindow}/${order.sort}`),
  }));
}

function rankingListFixture(patch: Partial<RankingList> & { unseen?: string[] } = {}): RankingList {
  const { unseen = ["/"], ...rest } = patch;
  const id = rest.id ?? 1;
  const period = rest.period ?? "day";
  return {
    id,
    provider: "dlsite",
    sourceId: null,
    sourceName: "",
    sourceAvailable: true,
    period,
    year: 0,
    depth: 100,
    enabled: true,
    autoRefresh: true,
    refreshIntervalMinutes: 60,
    nextPullAt: "2026-10-14 10:00:00",
    pullRequested: false,
    finalAt: null,
    followCurrentYear: true,
    lastPulledAt: "2026-10-14 09:00:00",
    lastStatus: "succeeded",
    variants: rankingVariantsFixture(id, period, unseen),
    ...rest,
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

function rankingSnapshotFixture(id: number, pulledAt: string, confirmedUntil = pulledAt): RankingSnapshotRef {
  return { id, pulledAt, confirmedUntil };
}

function rankingOverviewFixture(patch: Partial<RankingOverview> = {}): RankingOverview {
  return {
    lists: [],
    workflows: [
      { code: "dlsite_popular_collection", nextRunAt: null, latestRun: null },
      { code: "remote_popular_collection", nextRunAt: null, latestRun: null },
    ],
    retention: { fullDays: 30, dailyDays: 365 },
    currentYear: 2026,
    timeZone: "UTC",
    timeZoneFollowsDevice: false,
    demo: false,
    ...patch,
  };
}

function rankingPageFixture(
  list: RankingList,
  baseline: RankingPage["baseline"],
  items: RankingItem[],
  patch: Partial<RankingPage> = {},
): RankingPage {
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
    variant: list.variants[0],
    at: null,
    snapshot: rankingSnapshotFixture(30, "2026-10-14 09:00:00"),
    coverage: null,
    previousSnapshot: rankingSnapshotFixture(20, "2026-10-13 09:00:00", "2026-10-13 10:00:00"),
    nextSnapshot: null,
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
    history: { firstPulledAt: "2026-10-12 09:00:00", fullFrom: "2026-09-14 09:00:00" },
    demo: false,
    ...patch,
  };
}

/** Waits until the location names these query values; null means the key is absent. */
async function expectSearch(page: Page, expected: Record<string, string | null>) {
  await expect
    .poll(() => {
      const params = new URL(page.url()).searchParams;
      return Object.fromEntries(Object.keys(expected).map((key) => [key, params.get(key)]));
    })
    .toEqual(expected);
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
    if (url.pathname === "/api/rankings" && request.method() === "POST") {
      const body = request.postDataJSON() as Partial<RankingList>;
      await route.fulfill({
        status: 201,
        json: { list: rankingListFixture({ ...body, id: 90, pullRequested: true }), runId: 51 },
      });
      return;
    }
    if (url.pathname === "/api/rankings") {
      await route.fulfill({ json: server.rankings ?? rankingOverviewFixture({ demo: Boolean(server.demo) }) });
      return;
    }
    const rankingPage = /^\/api\/rankings\/(\d+)$/.exec(url.pathname);
    if (rankingPage && request.method() === "PATCH") {
      const current = server.rankings?.lists.find((list) => list.id === Number(rankingPage[1]));
      await route.fulfill({ json: { ...current, ...(request.postDataJSON() as object) } });
      return;
    }
    if (rankingPage) {
      const at = url.searchParams.get("at");
      const release = url.searchParams.get("release") ?? "";
      const sort = url.searchParams.get("sort") ?? "";
      const list = release || sort ? `${rankingPage[1]}~${release}/${sort}` : rankingPage[1];
      const key = at ? `${list}@${at}` : `${list}:${url.searchParams.get("compare") ?? ""}`;
      const page = server.rankingPages?.[key];
      await route.fulfill(page ? { json: page } : { status: 404, json: { error: "ranking not found" } });
      return;
    }
    const timeline = /^\/api\/rankings\/(\d+)\/snapshots$/.exec(url.pathname);
    if (timeline) {
      const from = url.searchParams.get("from") ?? "";
      const to = url.searchParams.get("to") ?? "";
      const snapshots = (server.timelines?.[timeline[1]] ?? []).filter((snapshot) => {
        const pulled = new Date(`${snapshot.pulledAt.replace(" ", "T")}Z`).toISOString();
        return (!from || pulled >= from) && (!to || pulled < to);
      });
      const body: RankingTimeline = {
        snapshots,
        nextAfterId: null,
        firstPulledAt: null,
        lastPulledAt: null,
        demo: false,
      };
      await route.fulfill({ json: body });
      return;
    }
    if (url.pathname === "/api/library-sources") {
      await route.fulfill({
        json: [
          librarySourceFixture({
            id: 7,
            displayName: "Example Remote",
            sourceType: "kikoeru_compatible",
            enabled: true,
          }),
        ],
      });
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

  // From 1280px the settings open beside the feed, which stays usable: the
  // toolbar icon closes them again.
  const settingsButton = page.getByRole("button", { name: "Subscription settings" });
  await settingsButton.click();
  await expect(page).toHaveURL(/\/subscriptions\?panel=subscriptions$/);
  const settings = page.getByRole("complementary", { name: "Subscription settings" });
  await expect(settings.getByRole("tab", { name: "Subscriptions", selected: true })).toBeVisible();
  await expect(settings.getByText("Refresh schedule")).toBeVisible();
  await settingsButton.click();
  await expect(settings).toHaveCount(0);
  await expect(page).toHaveURL(/\/subscriptions$/);

  // Escape closes the panel and returns focus to the toolbar icon.
  await settingsButton.click();
  await expect(settings).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await expect(settingsButton).toBeFocused();

  // Narrower desktops open the settings in a drawer over the feed.
  await page.setViewportSize({ width: 1100, height: 800 });
  await settingsButton.click();
  const drawer = page.getByRole("dialog", { name: "Subscription settings" });
  await expect(drawer.getByText("Refresh schedule")).toBeVisible();
  await drawer.getByRole("button", { name: "Close settings" }).click();
  await expect(drawer).toHaveCount(0);
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
  const week = rankingListFixture({ id: 2, period: "week", unseen: [] });
  const server: SubscriptionServer = {
    requests: [],
    feedQueries: [],
    rankings: rankingOverviewFixture({ lists: [day, week] }),
    rankingPages: {
      "1:": rankingPageFixture(day, { ...rankingSnapshotFixture(10, "2026-10-12 09:00:00"), kind: "seen" }, [
        rankingItemFixture(1, 1, { kind: "new", from: null, delta: 0 }),
        rankingItemFixture(2, 2, { kind: "up", from: 5, delta: 3 }),
        rankingItemFixture(3, 3, { kind: "same", from: 3, delta: 0 }),
      ]),
      "1:previous": rankingPageFixture(
        day,
        { ...rankingSnapshotFixture(20, "2026-10-13 09:00:00"), kind: "previous" },
        [
          rankingItemFixture(1, 1, { kind: "reentered", from: null, delta: 0 }),
          rankingItemFixture(2, 2, { kind: "down", from: 1, delta: -1 }),
          rankingItemFixture(3, 3, { kind: "same", from: 3, delta: 0 }),
        ],
      ),
    },
  };
  await mockSubscriptions(page, server);
  await page.goto("/subscriptions?view=rankings");

  await expect(page.getByRole("tab", { name: /^Rankings/, selected: true })).toBeVisible();
  const ranking = page.getByRole("region", { name: "Rankings", exact: true });
  await expect(ranking.getByRole("tab", { name: /^DLsite · 24 hours/, selected: true })).toBeVisible();
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
  const settings = page.getByRole("complementary", { name: "Subscription settings" });
  await expect(settings.getByRole("tab", { name: "Rankings", selected: true })).toBeVisible();
  await expect(
    settings
      .getByRole("region", { name: "DLsite voice rankings" })
      .getByRole("switch", { name: "Show 7 days", exact: true }),
  ).toBeChecked();
});

test("@desktop ranking history shows the order at a chosen time without marking it seen", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const day = rankingListFixture();
  const items = [rankingItemFixture(1, 1, { kind: "same", from: 1, delta: 0 })];
  const earlier = rankingSnapshotFixture(25, "2026-10-14 03:00:00", "2026-10-14 05:00:00");
  const latest = rankingSnapshotFixture(30, "2026-10-14 09:00:00");
  const server: SubscriptionServer = {
    requests: [],
    feedQueries: [],
    rankings: rankingOverviewFixture({ lists: [day] }),
    timelines: { "1": [rankingSnapshotFixture(20, "2026-10-13 09:00:00"), earlier, latest] },
    rankingPages: {
      "1:": rankingPageFixture(day, { ...earlier, kind: "seen" }, items, { previousSnapshot: earlier }),
      "1@2026-10-14T03:00:00.000Z": rankingPageFixture(
        day,
        { ...rankingSnapshotFixture(20, "2026-10-13 09:00:00"), kind: "previous" },
        items,
        {
          at: "2026-10-14 03:00:00",
          snapshot: earlier,
          coverage: { state: "confirmed", confirmedUntil: earlier.confirmedUntil },
          nextSnapshot: latest,
        },
      ),
      "1@2026-10-13T23:59:59.000Z": rankingPageFixture(day, null, items, {
        at: "2026-10-13 23:59:59",
        snapshot: rankingSnapshotFixture(20, "2026-10-13 09:00:00", "2026-10-13 10:00:00"),
        coverage: { state: "unpulled", confirmedUntil: "2026-10-13 10:00:00" },
        previousSnapshot: null,
        nextSnapshot: earlier,
      }),
    },
  };
  await mockSubscriptions(page, server);
  await page.goto("/subscriptions?view=rankings&list=1");
  const ranking = page.getByRole("region", { name: "Rankings", exact: true });
  await expect(ranking).toContainText("Updated Oct 14, 2026, 9:00 AM");
  await expect(ranking).toContainText(/days? in the ranking/);
  await expect.poll(() => server.requests.filter((request) => request.path === "/api/rankings/1/seen").length).toBe(1);

  await ranking.getByRole("button", { name: "History" }).click();
  const history = ranking.getByRole("region", { name: "Ranking history" });
  await expect(history.getByLabel("Date", { exact: true })).toHaveValue("2026-10-14");
  const updates = history.getByRole("group", { name: "Updates on this day" });
  await expect(updates.getByRole("button")).toHaveCount(2);
  await expect(updates.getByRole("button", { name: "9:00 AM" })).toHaveAttribute("aria-pressed", "true");

  await updates.getByRole("button", { name: "3:00 AM" }).click();
  await expect(page).toHaveURL(/at=2026-10-14T03%3A00%3A00\.000Z/);
  await expect(ranking).toContainText("The ranking at Oct 14, 2026, 3:00 AM");
  await expect(history).toContainText(
    "This order was pulled Oct 14, 2026, 3:00 AM and last confirmed Oct 14, 2026, 5:00 AM.",
  );
  await expect(history).toContainText("Times are in UTC.");
  // History shows ranks and movement, not the current statistics.
  await expect(ranking).not.toContainText(/days? in the ranking/);

  await history.getByLabel("Date", { exact: true }).fill("2026-10-13");
  await expect(page).toHaveURL(/at=2026-10-13T23%3A59%3A59\.000Z/);
  await expect(history).toContainText("No pull ran between Oct 13, 2026, 10:00 AM and this time.");

  await history.getByRole("button", { name: "Latest" }).click();
  await expect(page).not.toHaveURL(/at=/);
  await expect(ranking).toContainText("Updated Oct 14, 2026, 9:00 AM");
  // Looking at history never recorded it as seen.
  expect(server.requests.filter((request) => request.path === "/api/rankings/1/seen")).toHaveLength(1);
});

test("@desktop a ranking's orders keep their own place in the location and their own unread state", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  // The all-time chip was last left on its sales order, which has an unread update.
  await page.addInitScript(() => {
    window.localStorage.setItem(
      `kikoto:ranking-orders:${encodeURIComponent(window.location.origin)}`,
      JSON.stringify({ "list:5": "/sale" }),
    );
  });
  const day = rankingListFixture({ unseen: ["/sale"] });
  const total = rankingListFixture({ id: 5, period: "total", unseen: ["/sale"] });
  const order = (list: RankingList, releaseWindow: "" | "30d", sort: "" | "sale") =>
    list.variants.find((variant) => variant.releaseWindow === releaseWindow && variant.sort === sort)!;
  const pageFor = (list: RankingList, variant: RankingVariant, ordinal: number, snapshotId: number) =>
    rankingPageFixture(list, null, [rankingItemFixture(ordinal, 1, { kind: "same", from: 1, delta: 0 })], {
      variant,
      snapshot: rankingSnapshotFixture(snapshotId, "2026-10-14 09:00:00"),
    });
  const server: SubscriptionServer = {
    requests: [],
    feedQueries: [],
    rankings: rankingOverviewFixture({ lists: [total, day] }),
    rankingPages: {
      "1:": pageFor(day, order(day, "", ""), 1, 30),
      "1~/sale:": pageFor(day, order(day, "", "sale"), 2, 31),
      "1~30d/sale:": pageFor(day, order(day, "30d", "sale"), 3, 32),
      "5~/sale:": pageFor(total, order(total, "", "sale"), 4, 52),
    },
  };
  await mockSubscriptions(page, server);
  await page.goto("/subscriptions?view=rankings");
  const ranking = page.getByRole("region", { name: "Rankings", exact: true });
  const items = ranking.getByRole("list").first().getByRole("listitem");
  const sortOrder = ranking.getByRole("radiogroup", { name: "Ranking order" });
  const newReleases = ranking.getByRole("switch", { name: "Released within 30 days" });

  // The chips follow the fixed order, and each dot reflects the order its chip shows.
  await expect(ranking.getByRole("tab")).toHaveCount(2);
  await expect(ranking.getByRole("tab").first()).toHaveAccessibleName("DLsite · 24 hours");
  await expect(ranking.getByRole("tab").nth(1)).toHaveAccessibleName(
    /^DLsite · All time.*Updated since your last visit$/,
  );
  await expect(page.getByRole("tab", { name: /^Rankings.*Rankings updated since your last visit$/ })).toBeVisible();
  await expect(sortOrder.getByRole("radio", { name: "Popularity" })).toBeChecked();
  await expect(newReleases).not.toBeChecked();
  await expect(items.first()).toHaveAccessibleName("Example Work 1");

  await sortOrder.getByRole("radio", { name: "Sales" }).click();
  await expectSearch(page, { release: null, sort: "sale" });
  await expect(items.first()).toHaveAccessibleName("Example Work 2");
  // Seeing the sales order records its own update.
  await expect
    .poll(() =>
      server.requests.filter((request) => request.path === "/api/rankings/1/seen").map((request) => request.body),
    )
    .toEqual([{ snapshotId: 31 }]);

  await newReleases.click();
  await expectSearch(page, { release: "30d", sort: "sale" });
  await expect(items.first()).toHaveAccessibleName("Example Work 3");

  // Back returns to the previous order.
  await page.goBack();
  await expectSearch(page, { release: null, sort: "sale" });
  await expect(newReleases).not.toBeChecked();
  await expect(sortOrder.getByRole("radio", { name: "Sales" })).toBeChecked();
  await expect(items.first()).toHaveAccessibleName("Example Work 2");

  // A chip opens in the order last chosen on it; All time offers no 30-day window.
  await ranking.getByRole("tab").nth(1).click();
  await expectSearch(page, { list: "5", release: null, sort: "sale" });
  await expect(items.first()).toHaveAccessibleName("Example Work 4");
  await expect(newReleases).toHaveCount(0);
  await expect
    .poll(() => server.requests.find((request) => request.path === "/api/rankings/5/seen")?.body)
    .toEqual({ snapshotId: 52 });
  await expect(ranking.getByRole("tab").nth(1)).toHaveAccessibleName("DLsite · All time");
  await expect(page.getByRole("tab", { name: "Rankings", exact: true })).toBeVisible();

  await ranking.getByRole("tab").first().click();
  await expectSearch(page, { list: "1", release: "30d", sort: "sale" });
  await expect(newReleases).toBeChecked();
});

test("@desktop annual rankings share one chip and finished years read as an archive", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const current = rankingListFixture({ id: 3, period: "year", year: 2026, unseen: [] });
  const finished = rankingListFixture({
    id: 4,
    period: "year",
    year: 2025,
    unseen: [],
    autoRefresh: false,
    finalAt: "2026-01-03 00:00:00",
  });
  const items = [rankingItemFixture(1, 1, { kind: "new", from: null, delta: 0 })];
  const server: SubscriptionServer = {
    requests: [],
    feedQueries: [],
    rankings: rankingOverviewFixture({ lists: [current, finished] }),
    rankingPages: {
      "3:": rankingPageFixture(current, null, items),
      "4:": rankingPageFixture(finished, null, items, { previousSnapshot: null }),
    },
  };
  await mockSubscriptions(page, server);
  await page.goto("/subscriptions?view=rankings");
  const ranking = page.getByRole("region", { name: "Rankings", exact: true });
  await expect(ranking.getByRole("tab")).toHaveCount(1);
  await expect(ranking.getByRole("tab", { name: "DLsite · Annual", selected: true })).toBeVisible();
  // An annual ranking is ordered by popularity or sales, without the 30-day window.
  await expect(ranking.getByRole("radio", { name: "Sales" })).toBeVisible();
  await expect(ranking.getByRole("switch", { name: "Released within 30 days" })).toHaveCount(0);

  await ranking.getByRole("combobox", { name: "Year" }).click();
  await page.getByRole("option", { name: "2025" }).click();
  await expect(page).toHaveURL(/list=4/);
  await expect(ranking).toContainText("Final order of 2025, recorded Jan 3, 2026, 12:00 AM");
  await expect(ranking.getByRole("button", { name: /^Moved/ })).toHaveCount(0);
  await expect(ranking.getByRole("button", { name: /^Not in library/ })).toBeVisible();
  await expect(ranking.getByRole("combobox", { name: "Compare with" })).toHaveCount(0);
  await expect(ranking.getByRole("list").first().getByRole("listitem").first()).not.toContainText("New");
});

test("@desktop ranking settings show fixed rows and start a ranking when it is first shown", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const day = rankingListFixture();
  const server: SubscriptionServer = {
    requests: [],
    feedQueries: [],
    rankings: rankingOverviewFixture({ lists: [day] }),
    rankingPages: { "1:": rankingPageFixture(day, null, []) },
  };
  await mockSubscriptions(page, server);
  await page.goto("/subscriptions?view=rankings&panel=rankings");
  const settings = page.getByRole("complementary", { name: "Subscription settings" });
  const dlsite = settings.getByRole("region", { name: "DLsite voice rankings" });
  // The rows follow the fixed order of the chips.
  await expect
    .poll(() =>
      dlsite
        .getByRole("switch", { name: /^Show / })
        .evaluateAll((switches) => switches.map((element) => element.getAttribute("aria-label"))),
    )
    .toEqual(["Show 24 hours", "Show 7 days", "Show 30 days", "Show 2026, in progress", "Show All time"]);
  await expect(dlsite.getByRole("switch", { name: "Show 24 hours" })).toBeChecked();
  await expect(settings.getByRole("region", { name: "Remote source popular lists" })).toContainText("Example Remote");
  await expect(settings.getByRole("button", { name: /^Move / })).toHaveCount(0);

  await dlsite.getByRole("combobox", { name: "Pull interval · 24 hours" }).click();
  await page.getByRole("option", { name: "20 minutes" }).click();
  await expect
    .poll(
      () => server.requests.find((request) => request.method === "PATCH" && request.path === "/api/rankings/1")?.body,
    )
    .toEqual({ refreshIntervalMinutes: 20 });

  await dlsite.getByRole("switch", { name: "Show 30 days", exact: true }).click();
  await expect
    .poll(() => server.requests.find((request) => request.method === "POST" && request.path === "/api/rankings")?.body)
    .toEqual({ provider: "dlsite", period: "month" });
  await dlsite.getByRole("switch", { name: "Show All time", exact: true }).click();
  await expect
    .poll(() =>
      server.requests
        .filter((request) => request.method === "POST" && request.path === "/api/rankings")
        .map((request) => request.body),
    )
    .toContainEqual({ provider: "dlsite", period: "total" });

  const annual = dlsite.getByRole("listitem", { name: "DLsite annual ranking" });
  await annual.getByRole("button", { name: "Add years" }).click();
  const years = page.getByRole("dialog", { name: "Add years" });
  await years.getByRole("checkbox", { name: "2024" }).check();
  await years.getByRole("checkbox", { name: "2023" }).check();
  await years.getByRole("button", { name: "Add 2 years" }).click();
  await expect
    .poll(() =>
      server.requests
        .filter((request) => request.method === "POST" && request.path === "/api/rankings")
        .map((request) => (request.body as { year?: number }).year)
        .filter(Boolean),
    )
    .toEqual([2024, 2023]);
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
