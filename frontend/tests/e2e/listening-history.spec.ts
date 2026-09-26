import { expect, test, type Page, type Route } from "@playwright/test";

import { syntheticWorkCode } from "../../src/test-support/workCode";
import { mockApplication, queuedTrackFixture, seedPlayerQueue, silentWav } from "./fixtures/player-library";

type SessionReport = { generation: number; sessionId: string; workId: number; listenedSeconds: number };

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
 * DELETE clears history and increments it, and a report for any other
 * generation is rejected like the server's HTTP 409.
 */
async function mockListeningServer(page: Page, options: { failFirstReport?: boolean } = {}) {
  const server = { generation: 0, events: [] as ListeningEvent[] };
  let reportCount = 0;
  await page.route("**/api/listening-sessions", async (route) => {
    if (route.request().method() === "GET") {
      server.events.push({ kind: "lookup", generation: server.generation });
      await route.fulfill({ headers: { "Cache-Control": "no-store" }, json: { generation: server.generation } });
      return;
    }
    const report = route.request().postDataJSON() as SessionReport;
    reportCount += 1;
    if (report.generation !== server.generation) {
      server.events.push({ kind: "report", report, accepted: false });
      await route.fulfill({
        status: 409,
        json: {
          error: "Listening history was cleared. Start a new listening session.",
          code: "listening_history_cleared",
          retryable: false,
        },
      });
      return;
    }
    if (options.failFirstReport && reportCount === 1) {
      // The report fails transiently, so it is still waiting for a retry.
      server.events.push({ kind: "report", report, accepted: false });
      await route.fulfill({ status: 503, json: { error: "unavailable", retryable: true } });
      return;
    }
    server.events.push({ kind: "report", report, accepted: true });
    await route.fulfill({ json: { recorded: true } });
  });
  await page.route("**/api/listening-statistics", (route) =>
    route.fulfill({
      json: { listenedSeconds: 16, listenCount: 1, workCount: 1, activeDays: 1, daily: [], topWorks: [] },
    }),
  );
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

async function openPlayableQueue(page: Page) {
  await page.clock.install();
  await mockApplication(page, undefined, false, 1, 0, [], undefined, { authenticated: true });
  await seedPlayerQueue(page, [queuedTrackFixture(0, "Test track")], 1);
  const media = silentWav(180);
  await page.route(/\/api\/media\/1\/stream(?:\?.*)?$/, (route) => serveSeekableAudio(route, media));
  await page.route(/\/api\/media-items\/\d+\/progress$/, (route) => route.fulfill({ status: 204, body: "" }));
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

  await startPlayback(page);
  // The generation is established before anything is measured or reported.
  await expect.poll(() => server.events[0]).toEqual({ kind: "lookup", generation: 0 });
  await page.clock.fastForward(16_000);
  await expect.poll(() => reports().length).toBe(1);
  const preClear = reports()[0];
  expect(preClear.generation).toBe(0);

  // Navigate inside the app so the global player keeps playing.
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("dialog", { name: "Account" }).getByRole("button", { name: "History", exact: true }).click();
  await page.getByRole("button", { name: "Clear history" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Clear history" }).click();
  await expect(page.getByText("Listening history cleared.")).toBeVisible();
  const clearedAt = server.events.findIndex((event) => event.kind === "clear");
  expect(server.events[clearedAt]).toEqual({ kind: "clear", generation: 1 });
  expect(reports()).toHaveLength(1);
  // The player looks up the new generation after the clear.
  await expect.poll(() => server.events.slice(clearedAt).some((event) => event.kind === "lookup")).toBe(true);

  await page.clock.fastForward(16_000);
  await expect.poll(() => reports().length).toBeGreaterThan(1);
  const afterClear = reports().slice(1);
  expect(afterClear.every((report) => report.sessionId !== preClear.sessionId)).toBe(true);
  expect(afterClear.every((report) => report.generation === 1 && report.accepted)).toBe(true);
  expect(afterClear[0].workId).toBe(1);
  expect(afterClear[0].listenedSeconds).toBeLessThanOrEqual(17);
  expect(await audioPaused(page)).toBe(false);
});

test("a stale report after another device clears history restarts counting under the new generation", async ({
  page,
}) => {
  await openPlayableQueue(page);
  const { server, reports } = await mockListeningServer(page);
  await page.goto("/");

  await startPlayback(page);
  await page.clock.fastForward(16_000);
  await expect.poll(() => reports().length).toBe(1);
  const beforeClear = reports()[0];
  expect(beforeClear).toMatchObject({ generation: 0, accepted: true });

  // Another device clears history; this player learns of it only from its next report.
  server.generation = 1;
  await page.clock.fastForward(16_000);
  await expect.poll(() => reports().length).toBe(2);
  expect(reports()[1]).toMatchObject({ generation: 0, sessionId: beforeClear.sessionId, accepted: false });
  const rejectedAt = server.events.findIndex((event) => event.kind === "report" && !event.accepted);
  const lookupsAfterRejection = () => server.events.slice(rejectedAt).filter((event) => event.kind === "lookup");
  await expect.poll(lookupsAfterRejection).toEqual([{ kind: "lookup", generation: 1 }]);

  await page.clock.fastForward(16_000);
  await expect.poll(() => reports().length).toBeGreaterThan(2);
  // One rejected report refreshes the generation once.
  expect(lookupsAfterRejection()).toHaveLength(1);
  const afterRejection = reports().slice(2);
  // The rejected session is never resent, and new time is counted from the refresh only.
  expect(afterRejection.every((report) => report.sessionId !== beforeClear.sessionId)).toBe(true);
  expect(afterRejection.every((report) => report.generation === 1 && report.accepted)).toBe(true);
  expect(afterRejection[0].listenedSeconds).toBeLessThanOrEqual(17);
  expect(await audioPaused(page)).toBe(false);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("an earlier account's late generation lookup never applies to the next account", async ({ page }) => {
  await openPlayableQueue(page);
  await seedPlayerQueue(page, [queuedTrackFixture(0, "Test track")], 2);
  let signedIn: 1 | 2 | null = 1;
  const account = (id: 1 | 2) => ({
    authenticated: true,
    user: {
      id,
      username: `synthetic-user-${id}`,
      displayName: `Listener ${id}`,
      role: "user",
      permissions: ["library:read", "playback:use", "favorites:write"],
      devMode: false,
    },
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
    if (route.request().method() === "GET") {
      const lookup = { account: requestAccount, settled: false };
      lookups.push(lookup);
      if (requestAccount === 1) await firstLookupGate;
      await route.fulfill({ json: { generation: requestAccount ? generations[requestAccount] : 0 } }).catch(() => {});
      lookup.settled = true;
      return;
    }
    const report = route.request().postDataJSON() as SessionReport;
    reports.push({ account: requestAccount, report });
    await route.fulfill({ json: { recorded: true } });
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

  releaseFirstLookup();
  await expect
    .poll(() => lookups.filter((lookup) => lookup.account === 1).every((lookup) => lookup.settled))
    .toBe(true);
  await startPlayback(page);
  await page.clock.fastForward(16_000);
  await expect.poll(() => reports.length).toBeGreaterThan(0);
  expect(reports.every(({ account, report }) => account === 2 && report.generation === generations[2])).toBe(true);
  // A signed-out player has no listening scope and never looks one up.
  expect(lookups.every((lookup) => lookup.account !== null)).toBe(true);
});

test("@desktop the history page opens a listed work in work detail", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockApplication(page, undefined, false, 1, 0, [], undefined, { authenticated: true });
  await mockListeningServer(page);
  await page.goto("/history");
  await page.evaluate(() => {
    (window as Window & { historyPageMarker?: boolean }).historyPageMarker = true;
  });

  await page
    .getByRole("list", { name: "Listening history" })
    .getByRole("link", { name: /Example Work/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`/${syntheticWorkCode("RJ", 0)}$`));
  await expect(page.getByRole("button", { name: `Copy work code ${syntheticWorkCode("RJ", 0)}` })).toBeVisible();
  // The app shell navigated in place rather than reloading the document.
  expect(await page.evaluate(() => (window as Window & { historyPageMarker?: boolean }).historyPageMarker)).toBe(true);
});
