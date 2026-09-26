import { expect, test, type Page, type Route } from "@playwright/test";
import { silentWav } from "./fixtures/player-library";

const persistedTrack = {
  queueItemId: "route-boundary-track",
  mediaItemId: 1,
  locationId: 1,
  title: "Boundary test track",
  kind: "audio",
  folderPath: "Main",
  locationType: "local",
  streamUrl: "/api/media/1/stream",
  sizeBytes: null,
  availability: "available",
  workId: 1,
  workCode: "RJ00000000",
  workTitle: "Boundary test work",
  coverUrl: "",
  circle: "Example Circle",
  progress: null,
  progressRecordable: true,
  lyricsLocationId: null,
  lyricsTitle: "",
  locations: [
    {
      locationId: 1,
      locationType: "local",
      streamUrl: "/api/media/1/stream",
      sourceId: 1,
      sourceName: "Local",
      availability: "available",
    },
  ],
};

async function prepareRouteFailure(page: Page, fulfillAboutModule = fulfillFailingAboutModule) {
  const audioBody = silentWav(60);
  await page.addInitScript((track) => {
    const key = `kikoto:player-queue:v2:${encodeURIComponent(window.location.origin)}:anonymous`;
    localStorage.setItem(
      key,
      JSON.stringify({ version: 1, queue: [track], currentIndex: 0, mode: "order", playbackRate: 1, sleepTimer: null }),
    );
  }, persistedTrack);

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({ json: { authenticated: false } });
      return;
    }
    if (url.pathname === "/api/runtime-settings") {
      await route.fulfill({
        json: {
          mode: "production",
          demoMode: false,
          anonymousAccessEnabled: true,
          cacheEnabled: false,
          directoryRoutingRules: [],
        },
      });
      return;
    }
    if (url.pathname === "/api/works/1/media") {
      await route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } });
      return;
    }
    if (url.pathname === "/api/media/1/stream") {
      // Serve byte ranges so this fixture exercises real browser seeking.
      const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? "");
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), audioBody.length - 1) : audioBody.length - 1;
      if (start > end) {
        await route.fulfill({ status: 416, headers: { "Content-Range": `bytes */${audioBody.length}` } });
        return;
      }
      await route.fulfill({
        status: range ? 206 : 200,
        contentType: "audio/wav",
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Length": String(end - start + 1),
          ...(range ? { "Content-Range": `bytes ${start}-${end}/${audioBody.length}` } : {}),
        },
        body: audioBody.subarray(start, end + 1),
      });
      return;
    }
    if (url.pathname === "/api/library-sources") {
      await route.fulfill({ json: [] });
      return;
    }
    if (url.pathname === "/api/works") {
      await route.fulfill({ json: { works: [], page: 1, pageSize: 24, total: 0 } });
      return;
    }
    if (url.pathname === "/api/recently-played-works") {
      await route.fulfill({ json: { works: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not mocked" } });
  });

  await page.route("**/src/pages/AboutPage.tsx*", fulfillAboutModule);
  await page.route(/\/assets\/AboutPage-[^/]+\.js(?:\?.*)?$/, fulfillAboutModule);
}

async function fulfillFailingAboutModule(route: Route) {
  await route.fulfill({
    contentType: "application/javascript",
    body: 'throw new Error("https://source.example.invalid/private/path"); export function AboutPage() { return null; }',
  });
}

test("route render failures preserve the app shell and player", async ({ page }) => {
  await prepareRouteFailure(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  const audio = page.locator("audio");
  await expect.poll(() => audio.evaluate((element) => element.currentTime)).toBeGreaterThan(0);
  // Seek the real media element far enough from zero that a rewind cannot
  // accidentally satisfy the subsequent playback-continuity assertions.
  await audio.evaluate((element) => {
    element.currentTime = 20;
  });
  await expect.poll(() => audio.evaluate((element) => element.currentTime)).toBeGreaterThanOrEqual(20);
  const playingElement = await audio.elementHandle();
  expect(playingElement).not.toBeNull();
  const beforeNavigation = await audio.evaluate((element) => element.currentTime);
  await page.getByRole("button", { name: "Quick actions", exact: true }).click();
  await page.getByRole("button", { name: "About /about", exact: true }).click();

  const fallback = page.getByRole("alert");
  await expect(fallback.getByRole("heading", { name: "Page unavailable" })).toBeVisible();
  await expect(fallback).toContainText("The player and navigation are still available.");
  await expect(fallback).not.toContainText("source.example.invalid");
  await expect(fallback.getByRole("button", { name: "Retry page" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "About", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Library", exact: true })).toBeVisible();
  await expect(page.getByText("Boundary test track", { exact: true })).toBeVisible();
  expect(await audio.evaluate((element, previous) => element === previous, playingElement)).toBe(true);
  await expect(audio).toHaveJSProperty("paused", false);
  await expect.poll(() => audio.evaluate((element) => element.currentTime)).toBeGreaterThan(beforeNavigation);
  const beforeRecovery = await audio.evaluate((element) => element.currentTime);

  await fallback.getByRole("button", { name: "Open Library" }).click();

  await expect(page).toHaveURL("/");
  await expect(fallback).toHaveCount(0);
  await expect(page.locator("footer").getByRole("button", { name: "Library", exact: true })).toBeVisible();
  await expect(page.getByText("Boundary test track", { exact: true })).toBeVisible();
  expect(await audio.evaluate((element, previous) => element === previous, playingElement)).toBe(true);
  await expect(audio).toHaveJSProperty("paused", false);
  await expect.poll(() => audio.evaluate((element) => element.currentTime)).toBeGreaterThan(beforeRecovery);
  await expect(audio).toHaveJSProperty("error", null);
});

test("a page chunk removed by an update offers a reload that loads the current version", async ({ page }) => {
  // Until the reload, the page's chunk is missing as after a deploy replaced it.
  let chunkMissing = true;
  await prepareRouteFailure(page, async (route) => {
    if (chunkMissing) await route.fulfill({ status: 404, body: "Not found" });
    else await route.fallback();
  });
  await page.goto("/");
  await expect(page.locator("footer").getByRole("button", { name: "Library", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Quick actions", exact: true }).click();
  await page.getByRole("button", { name: "About /about", exact: true }).click();

  const fallback = page.getByRole("alert");
  await expect(fallback.getByRole("heading", { name: "Kikoto was updated" })).toBeVisible();
  await expect(fallback.getByRole("button", { name: "Retry page" })).toHaveCount(0);

  chunkMissing = false;
  await fallback.getByRole("button", { name: "Reload Kikoto" }).click();
  await expect(page).toHaveURL(/\/about$/);
  await expect(fallback).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "About", exact: true })).toBeVisible();
});
