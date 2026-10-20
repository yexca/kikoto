import { expect, test, type Page, type Route } from "@playwright/test";

import { syntheticWorkCode } from "../../src/test-support/workCode";
import type { DatedListeningReport, PlaybackReport } from "../../src/lib/playbackReportApi";
import { authenticatedStateFixture, runtimeSettingsFixture } from "./fixtures/api";
import { playbackReportResultFixture, readPlaybackReportOutbox } from "./fixtures/playback-reports";
import { mockApplication, queuedTrackFixture, seedPlayerQueue, silentWav } from "./fixtures/player-library";

type SessionReport = DatedListeningReport;

type ListeningEvent =
  | { kind: "lookup"; generation: number }
  | { kind: "report"; report: SessionReport; accepted: boolean }
  | { kind: "clear"; generation: number };

function serveSeekableAudio(route: Route, media: Buffer) {
  const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? "");
  const start = range ? Number(range[1]) : 0;
  const end = range?.[2] ? Math.min(Number(range[2]), media.length - 1) : media.length - 1;
  return route.fulfill({
    status: range ? 206 : 200,
    contentType: "audio/wav",
    headers: {
      "Accept-Ranges": "bytes",
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${media.length}` } : {}),
    },
    body: media.subarray(start, end + 1),
  });
}

/**
 * Models the listening API: GET returns the account's history generation,
 * DELETE increments it. Merged reports acknowledge history and progress
 * separately, returning the current generation even when history is stale.
 */
async function mockListeningServer(page: Page, options: { failFirstReport?: boolean } = {}) {
  const server = { generation: 0, events: [] as ListeningEvent[] };
  let reportCount = 0;
  await page.route("**/api/listening-sessions", async (route) => {
    expect(route.request().method()).toBe("GET");
    server.events.push({ kind: "lookup", generation: server.generation });
    await route.fulfill({ headers: { "Cache-Control": "no-store" }, json: { generation: server.generation } });
  });
  await page.route("**/api/playback-reports", async (route) => {
    expect(route.request().method()).toBe("POST");
    const batch = route.request().postDataJSON() as PlaybackReport;
    if (batch.history.length) reportCount += 1;
    if (options.failFirstReport && reportCount === 1 && batch.history.length) {
      // The report fails transiently, so it is still waiting for a retry.
      for (const report of batch.history) server.events.push({ kind: "report", report, accepted: false });
      await route.fulfill({ status: 503, json: { error: "unavailable", retryable: true } });
      return;
    }
    for (const report of batch.history)
      server.events.push({ kind: "report", report, accepted: report.generation === server.generation });
    await route.fulfill({ json: playbackReportResultFixture(batch, server.generation) });
  });
  await page.route("**/api/listening-statistics*", (route) =>
    route.fulfill({ json: statisticsFixture(new URL(route.request().url()).searchParams.get("range") ?? "all") }),
  );
  // The account fixed no zone, so the report follows the zone the device names.
  await page.route("**/api/listening-calendar*", (route) => {
    const year = new URL(route.request().url()).searchParams.get("range");
    return route.fulfill({
      json: {
        // A year's calendar covers that year; any other range the weeks up to today.
        from: year ? `${year}-01-01` : "2026-02-23",
        to: year ? `${year}-12-31` : "2026-03-04",
        timeZone: new URL(route.request().url()).searchParams.get("timeZone") ?? "UTC",
        followsDevice: true,
        days: year
          ? [
              { date: `${year}-03-10`, listenedSeconds: 2400, listenCount: 2 },
              { date: `${year}-03-11`, listenedSeconds: 300, listenCount: 1 },
            ]
          : [{ date: "2026-03-03", listenedSeconds: 600, listenCount: 2 }],
      },
    });
  });
  await page.route("**/api/listening-profile*", (route) =>
    route.fulfill({
      json: {
        range: new URL(route.request().url()).searchParams.get("range") ?? "all",
        listenedSeconds: 600,
        workCount: 4,
        libraryWorkCount: 10,
        tags: ["Example Tag", "Example Tag 2", "Example Tag 3"].map((name, index) => ({
          id: index + 3,
          name,
          listenedSeconds: 600 - index * 120,
          listenCount: 2,
          workCount: 2,
          libraryWorkCount: 2,
        })),
        duration: { value: 5400, libraryValue: 3600, position: 0.8, workCount: 4 },
        marks: { works: 4, finished: 3, relisten: 1 },
      },
    }),
  );
  await page.route("**/api/listening-breakdown*", (route) => {
    const params = new URL(route.request().url()).searchParams;
    const rank = params.get("rank") ?? "time";
    // A preference ranking also reports how much of the library each entry covers.
    const library = rank === "preference" ? { libraryWorkCount: 2 } : {};
    return route.fulfill({
      json: {
        range: params.get("range") ?? "all",
        rank,
        listenedSeconds: 600,
        ...(rank === "preference" ? { libraryWorkCount: 10 } : {}),
        tags: [{ id: 3, name: "Example Tag", listenedSeconds: 600, listenCount: 2, workCount: 1, ...library }],
        voices: [
          {
            id: 7,
            routeKey: "00000001",
            name: "Example Voice",
            listenedSeconds: 600,
            listenCount: 2,
            workCount: 1,
            ...library,
          },
        ],
        circles: [
          {
            id: 5,
            name: "Example Circle",
            externalId: "RG00000000",
            listenedSeconds: 600,
            listenCount: 2,
            workCount: 1,
            ...library,
          },
          { id: 6, name: "Example Circle 2", listenedSeconds: 60, listenCount: 1, workCount: 1, ...library },
        ],
      },
    });
  });
  await page.route("**/api/listening-history*", async (route) => {
    if (route.request().method() === "DELETE") {
      server.generation += 1;
      server.events.push({ kind: "clear", generation: server.generation });
      await route.fulfill({ json: { cleared: true } });
      return;
    }
    await route.fulfill({
      json: {
        items: [
          {
            workId: 1,
            primaryCode: syntheticWorkCode("RJ", 0),
            title: "Example Work",
            listenedSeconds: 16,
            listenCount: 1,
            lastPlayedAt: "2026-01-01T00:00:00Z",
            coverUrl: "",
          },
        ],
        total: 1,
        page: 1,
        pageSize: 30,
      },
    });
  });
  const reports = () =>
    server.events.flatMap((event) => (event.kind === "report" ? [{ ...event.report, accepted: event.accepted }] : []));
  return { server, reports };
}

/** A listening report with one listened period, shaped like the server's for the requested range. */
function statisticsFixture(range: string) {
  const granularity = range === "30d" ? "day" : "month";
  const year = /^[0-9]{4}$/.test(range) ? range : null;
  const periods =
    range === "30d"
      ? Array.from({ length: 30 }, (_, index) => `2026-01-${String(index + 1).padStart(2, "0")}`)
      : year
        ? Array.from({ length: 12 }, (_, index) => `${year}-${String(index + 1).padStart(2, "0")}`)
        : ["2025-12", "2026-01"];
  // A calendar year also carries its highlights and the hours its listening was recorded with.
  const yearReport = year
    ? {
        today: `${year}-12-31`,
        hours: Array.from({ length: 24 }, (_, hour) => (hour === 22 ? 1800 : hour === 9 ? 600 : 0)),
        highlights: {
          newWorkCount: 3,
          busiestDay: { date: `${year}-03-10`, listenedSeconds: 2400 },
          topVoice: {
            id: 7,
            routeKey: "00000001",
            name: "Example Voice",
            listenedSeconds: 1800,
            listenCount: 2,
            workCount: 1,
          },
        },
      }
    : {};
  return {
    ...yearReport,
    years: ["2026", "2025"],
    range,
    listenedSeconds: 16,
    listenCount: 1,
    workCount: 1,
    activeDays: 1,
    granularity,
    series: periods.map((period, index) => ({ period, listenedSeconds: index * 16, listenCount: index })),
    topWorks: [],
  };
}

async function openPlayableQueue(page: Page) {
  await page.clock.install();
  await mockApplication(page, undefined, false, 1, 0, [], undefined, { authenticated: true });
  await seedPlayerQueue(page, [queuedTrackFixture(0, "Test track")], 1);
  const media = silentWav(180);
  await page.route(/\/api\/media\/1\/stream(?:\?.*)?$/, (route) => serveSeekableAudio(route, media));
}

async function startPlayback(page: Page) {
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect
    .poll(() => page.locator("audio").evaluate((element: HTMLAudioElement) => element.currentTime))
    .toBeGreaterThan(0.5);
}

const audioPaused = (page: Page) => page.locator("audio").evaluate((element: HTMLAudioElement) => element.paused);

test("clearing history during playback never reports pre-clear time again and keeps counting", async ({ page }) => {
  await openPlayableQueue(page);
  const { server, reports } = await mockListeningServer(page, { failFirstReport: true });
  await page.goto("/");

  // The generation is established before anything is measured or reported.
  await expect.poll(() => server.events[0]).toEqual({ kind: "lookup", generation: 0 });
  await expect.poll(async () => (await readPlaybackReportOutbox(page))?.generation).toBe(0);
  await startPlayback(page);
  await page.clock.fastForward(31_000);
  await expect.poll(() => reports().length).toBe(1);
  const preClear = reports()[0];
  expect(preClear.generation).toBe(0);

  // Navigate inside the app so the global player keeps playing.
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("dialog", { name: "Account" }).getByRole("button", { name: "Insights", exact: true }).click();
  await page.getByRole("button", { name: "Clear history" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Clear history" }).click();
  await expect(page.getByText("Listening history cleared.")).toBeVisible();
  const clearedAt = server.events.findIndex((event) => event.kind === "clear");
  expect(server.events[clearedAt]).toEqual({ kind: "clear", generation: 1 });
  expect(reports()).toHaveLength(1);
  // The player looks up the new generation after the clear.
  await expect.poll(() => server.events.slice(clearedAt).some((event) => event.kind === "lookup")).toBe(true);
  // Receiving the lookup is earlier than applying its generation to the durable queue.
  await expect.poll(async () => (await readPlaybackReportOutbox(page))?.generation).toBe(1);

  await page.clock.fastForward(31_000);
  await expect.poll(() => reports().length).toBeGreaterThan(1);
  const afterClear = reports().slice(1);
  expect(afterClear.every((report) => report.sessionId !== preClear.sessionId)).toBe(true);
  expect(afterClear.every((report) => report.generation === 1 && report.accepted)).toBe(true);
  expect(afterClear[0].workId).toBe(1);
  expect(afterClear[0].listenedSeconds).toBeLessThanOrEqual(32);
  expect(await audioPaused(page)).toBe(false);
});

test("a stale report after another device clears history restarts counting under the new generation", async ({
  page,
}) => {
  await openPlayableQueue(page);
  const { server, reports } = await mockListeningServer(page);
  await page.goto("/");

  await expect.poll(async () => (await readPlaybackReportOutbox(page))?.generation).toBe(0);
  await startPlayback(page);
  await page.clock.fastForward(31_000);
  await expect.poll(() => reports().length).toBe(1);
  const beforeClear = reports()[0];
  expect(beforeClear).toMatchObject({ generation: 0, accepted: true });

  // Another device clears history; this player learns of it only from its next report.
  server.generation = 1;
  await page.clock.fastForward(31_000);
  await expect.poll(() => reports().length).toBe(2);
  expect(reports()[1]).toMatchObject({ generation: 0, sessionId: beforeClear.sessionId, accepted: false });
  const rejectedAt = server.events.findIndex((event) => event.kind === "report" && !event.accepted);
  const lookupsAfterRejection = () => server.events.slice(rejectedAt).filter((event) => event.kind === "lookup");
  // The merged acknowledgement supplies the new generation directly.
  await expect.poll(async () => (await readPlaybackReportOutbox(page))?.generation).toBe(1);
  expect(lookupsAfterRejection()).toEqual([]);
  await page.clock.fastForward(31_000);
  await expect.poll(() => reports().length).toBeGreaterThan(2);
  expect(lookupsAfterRejection()).toEqual([]);
  const afterRejection = reports().slice(2);
  // The rejected session is never resent, and new time is counted from the refresh only.
  expect(afterRejection.every((report) => report.sessionId !== beforeClear.sessionId)).toBe(true);
  expect(afterRejection.every((report) => report.generation === 1 && report.accepted)).toBe(true);
  expect(afterRejection[0].listenedSeconds).toBeLessThanOrEqual(32);
  expect(await audioPaused(page)).toBe(false);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("an earlier account's late generation lookup never applies to the next account", async ({ page }) => {
  await openPlayableQueue(page);
  await seedPlayerQueue(page, [queuedTrackFixture(0, "Test track")], 2);
  let signedIn: 1 | 2 | null = 1;
  const account = (id: 1 | 2) =>
    authenticatedStateFixture({
      id,
      username: `synthetic-user-${id}`,
      displayName: `Listener ${id}`,
      role: "user",
      permissions: ["library:read", "playback:use", "favorites:write"],
      devMode: false,
    });
  await page.route("**/api/auth/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") {
      await route.fulfill({ json: signedIn ? account(signedIn) : { authenticated: false } });
    } else if (path === "/api/auth/logout") {
      signedIn = null;
      await route.fulfill({ json: { ok: true } });
    } else if (path === "/api/auth/login") {
      signedIn = 2;
      await route.fulfill({ json: account(2) });
    } else {
      await route.fallback();
    }
  });

  // Each account has its own generation; the first account's lookup is held until after the switch.
  const generations = { 1: 3, 2: 7 } as const;
  let releaseFirstLookup = () => {};
  const firstLookupGate = new Promise<void>((resolve) => {
    releaseFirstLookup = resolve;
  });
  const lookups: Array<{ account: 1 | 2 | null; settled: boolean }> = [];
  const reports: Array<{ account: 1 | 2 | null; report: SessionReport }> = [];
  await page.route("**/api/listening-sessions", async (route) => {
    const requestAccount = signedIn;
    expect(route.request().method()).toBe("GET");
    const lookup = { account: requestAccount, settled: false };
    lookups.push(lookup);
    if (requestAccount === 1) await firstLookupGate;
    await route.fulfill({ json: { generation: requestAccount ? generations[requestAccount] : 0 } }).catch(() => {});
    lookup.settled = true;
  });
  await page.route("**/api/playback-reports", async (route) => {
    const requestAccount = signedIn;
    const batch = route.request().postDataJSON() as PlaybackReport;
    for (const report of batch.history) reports.push({ account: requestAccount, report });
    await route.fulfill({ json: playbackReportResultFixture(batch, requestAccount ? generations[requestAccount] : 0) });
  });
  await page.goto("/");
  await expect.poll(() => lookups.some((lookup) => lookup.account === 1)).toBe(true);

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("dialog", { name: "Account" }).getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("dialog", { name: "Account" }).getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Kikoto" })).toBeVisible();
  await page.getByLabel("Username").fill("synthetic-user");
  await page.getByLabel("Password").fill("synthetic-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).last().click();
  await expect.poll(() => lookups.some((lookup) => lookup.account === 2 && lookup.settled)).toBe(true);
  await expect.poll(async () => (await readPlaybackReportOutbox(page, 2))?.generation).toBe(generations[2]);

  releaseFirstLookup();
  await expect
    .poll(() => lookups.filter((lookup) => lookup.account === 1).every((lookup) => lookup.settled))
    .toBe(true);
  await startPlayback(page);
  await page.clock.fastForward(31_000);
  await expect.poll(() => reports.length).toBeGreaterThan(0);
  expect(reports.every(({ account, report }) => account === 2 && report.generation === generations[2])).toBe(true);
  // A signed-out player has no listening scope and never looks one up.
  expect(lookups.every((lookup) => lookup.account !== null)).toBe(true);
});

test("@desktop the history page opens a listed work in work detail", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockApplication(page, undefined, false, 1, 0, [], undefined, { authenticated: true });
  await mockListeningServer(page);
  await page.goto("/insights");
  await page.evaluate(() => {
    (window as Window & { historyPageMarker?: boolean }).historyPageMarker = true;
  });

  // The full history is collapsed below the listening report until opened.
  await expect(page.getByRole("list", { name: "Listening history" })).toHaveCount(0);
  await page.getByText("Listening history", { exact: true }).click();
  await page
    .getByRole("list", { name: "Listening history" })
    .getByRole("link", { name: /Example Work/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`/${syntheticWorkCode("RJ", 0)}$`));
  await expect(page.getByRole("button", { name: `Copy work code ${syntheticWorkCode("RJ", 0)}` })).toBeVisible();
  // The app shell navigated in place rather than reloading the document.
  expect(await page.evaluate(() => (window as Window & { historyPageMarker?: boolean }).historyPageMarker)).toBe(true);
});

test("@desktop the listening report switches between its ranges", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockApplication(page, undefined, false, 1, 0, [], undefined, { authenticated: true });
  await mockListeningServer(page);
  const requestedRanges: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/listening-statistics") requestedRanges.push(url.searchParams.get("range") ?? "");
  });
  await page.goto("/insights");

  const ranges = page.getByRole("group", { name: "Report period" });
  await expect(ranges.getByRole("button", { name: "30 days" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("table", { name: "Daily listening time" })).toBeAttached();
  await ranges.getByRole("button", { name: "12 months" }).click();
  await expect(ranges.getByRole("button", { name: "12 months" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("table", { name: "Monthly listening time" })).toBeAttached();
  expect(requestedRanges.at(-1)).toBe("12m");
});

test.describe("on a device in another time zone", () => {
  test.use({ timezoneId: "Asia/Tokyo" });

  test("@desktop the listening dashboard names the time zone of its days and links to the setting", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mockApplication(page, undefined, false, 1, 0, [], undefined, { authenticated: true });
    await mockListeningServer(page);
    const reportZones: Array<string | null> = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/listening-statistics") reportZones.push(url.searchParams.get("timeZone"));
    });
    await page.goto("/insights");

    await expect(page.getByText("Days start at midnight in Asia/Tokyo, this device's time zone.")).toBeVisible();
    expect(reportZones.at(-1)).toBe("Asia/Tokyo");
    await page.getByRole("link", { name: "Change time zone", exact: true }).click();
    await expect(page).toHaveURL(/\/settings\?tab=time-zone$/);
    await expect(page.getByRole("heading", { name: "Time zone", exact: true })).toBeVisible();
  });
});

test("@desktop a calendar year opens with its highlights, its own calendar, and its hours", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockApplication(page, undefined, false, 1, 0, [], undefined, { authenticated: true });
  await mockListeningServer(page);
  const requested: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/listening-") && url.searchParams.get("range") === "2025")
      requested.push(url.pathname);
  });
  await page.goto("/insights");
  await expect(page.getByRole("heading", { name: "2025 highlights" })).toHaveCount(0);
  // The last segment of the range switcher opens the years and names the chosen one.
  const ranges = page.getByRole("group", { name: "Report period" });
  const years = ranges.getByRole("combobox", { name: "Year", exact: true });
  await expect(years).toHaveText("Year");

  await years.click();
  await page.getByRole("option", { name: "2025", exact: true }).click();
  await expect(years).toHaveText("Year: 2025");
  const highlights = page.getByRole("region", { name: "2025 highlights" });
  await expect(highlights).toBeVisible();
  // The streak comes from the year's own calendar: two listening days in a row.
  await expect(highlights.getByText("2 days", { exact: true })).toBeVisible();
  await expect(highlights.getByText("22:00–23:00", { exact: true })).toBeVisible();
  await expect(highlights.getByRole("link", { name: "Example Voice", exact: true })).toBeVisible();
  await expect(highlights.getByText("3 works", { exact: true })).toBeVisible();
  await expect(page.getByText("Most at 22:00–23:00", { exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "Monthly listening time" })).toBeAttached();
  await expect
    .poll(() => [...new Set(requested)].sort())
    .toEqual([
      "/api/listening-breakdown",
      "/api/listening-calendar",
      "/api/listening-profile",
      "/api/listening-statistics",
    ]);

  // A named range leaves the year, without highlights.
  await ranges.getByRole("button", { name: "30 days" }).click();
  await expect(highlights).toHaveCount(0);
  await expect(years).toHaveText("Year");
});

test("@desktop the taste profile says what the listening leans toward", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockApplication(page, undefined, false, 1, 0, [], undefined, { authenticated: true });
  await mockListeningServer(page);
  await page.goto("/insights");

  const profile = page.getByRole("region", { name: "Taste profile" });
  await expect(profile.getByText("You lean most toward Example Tag and Example Tag 2.")).toBeVisible();
  await expect(profile.getByText("You favor longer works.")).toBeVisible();
  await expect(
    profile.getByText("Of the 4 works you marked, 75% are finished and 25% are marked to relisten."),
  ).toBeVisible();
  await expect(profile.getByText("You 1 h 30 min · Library 1 h 0 min", { exact: true })).toBeVisible();
  // The radar's figures are also a list for assistive technology.
  await expect(profile.getByRole("listitem")).toHaveCount(3);
});

test("@desktop Demo says its listening history is simulated and offers no way to clear it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockApplication(page, undefined, false, 1, 0, [], undefined, { authenticated: true });
  await mockListeningServer(page);
  await page.goto("/insights");
  // An ordinary account sees its own history without the notice.
  await expect(page.getByRole("region", { name: "Taste profile" })).toBeVisible();
  await expect(page.getByText(/this listening history is simulated/)).toHaveCount(0);

  await page.route("**/api/runtime-settings", (route) =>
    route.fulfill({ json: runtimeSettingsFixture({ mode: "demo", demoMode: true }) }),
  );
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: authenticatedStateFixture({
        username: "__demo__",
        displayName: "Demo",
        role: "user",
        permissions: ["library:read", "playback:use"],
        demoMode: true,
      }),
    }),
  );
  await page.goto("/insights");
  await expect(page.getByRole("status").filter({ hasText: "this listening history is simulated" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Taste profile" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Clear history" })).toHaveCount(0);
});

test("@desktop the listening dashboard ranks tags, voices, and circles and links each to its page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockApplication(page, undefined, false, 1, 0, [], undefined, { authenticated: true });
  await mockListeningServer(page);
  // A former History location opens the dashboard.
  await page.goto("/settings?tab=history");
  await expect(page).toHaveURL(/\/insights$/);

  await expect(page.getByRole("region", { name: "Listening calendar" }).getByText("1 day").first()).toBeVisible();
  await expect(page.getByRole("list", { name: "Top tags" }).getByRole("link", { name: /Example Tag/ })).toHaveAttribute(
    "href",
    /^\/\?.*Example/,
  );
  // Preference is the default ranking: a share of listening time against a share of the library.
  const tags = page.getByRole("list", { name: "Top tags" });
  await expect(tags.getByText("100% of time")).toBeVisible();
  await expect(tags.getByText("20% of library")).toBeVisible();
  await page.getByRole("group", { name: "Ranking" }).getByRole("button", { name: "Listening time" }).click();
  await expect(tags.getByText("10 min")).toBeVisible();
  await expect(tags.getByText("1 work", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Your data" })).toHaveAttribute("href", "/settings?tab=data");
  const circles = page.getByRole("list", { name: "Top circles" });
  await expect(circles.getByRole("link", { name: /Example Circle/ })).toHaveAttribute("href", "/circles/RG00000000");
  // A circle without a provider id has no page to open.
  await expect(circles.getByRole("listitem").filter({ hasText: "Example Circle 2" }).getByRole("link")).toHaveCount(0);
  await page
    .getByRole("list", { name: "Top voices" })
    .getByRole("link", { name: /Example Voice/ })
    .click();
  await expect(page).toHaveURL(/\/voices\/00000001$/);
});

test("@desktop the listening report's screen reader table adds no scroll space below the page", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockApplication(page, undefined, false, 1, 0, [], undefined, { authenticated: true });
  await mockListeningServer(page);
  await page.goto("/insights");

  // Thirty daily rows are far taller than the page when the table is not clipped.
  await expect(page.getByRole("table", { name: "Daily listening time" }).getByRole("row")).toHaveCount(31);
  const overflow = await page.evaluate(() => {
    const records = document.querySelector("[aria-labelledby='listening-history-heading']")!;
    const contentBottom = records.getBoundingClientRect().bottom + window.scrollY;
    return document.documentElement.scrollHeight - contentBottom;
  });
  expect(overflow).toBeLessThan(200);
});
