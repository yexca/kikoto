import { expect, test, type Page, type Route } from "@playwright/test";

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

async function prepareRouteFailure(page: Page) {
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
      await route.fulfill({ json: { mode: "production", cacheEnabled: false, directoryRoutingRules: [] } });
      return;
    }
    if (url.pathname === "/api/works/1/media") {
      await route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } });
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

  await page.route("**/src/pages/AboutPage.tsx*", fulfillFailingAboutModule);
  await page.route(/\/assets\/AboutPage-[^/]+\.js(?:\?.*)?$/, fulfillFailingAboutModule);
}

async function fulfillFailingAboutModule(route: Route) {
  await route.fulfill({
    contentType: "application/javascript",
    body: 'throw new Error("https://source.example.invalid/private/path"); export function AboutPage() { return null; }',
  });
}

test("route render failures preserve the app shell and player", async ({ page }) => {
  await prepareRouteFailure(page);
  await page.goto("/about");

  const fallback = page.getByRole("alert");
  await expect(fallback.getByRole("heading", { name: "Page unavailable" })).toBeVisible();
  await expect(fallback).toContainText("The player and navigation are still available.");
  await expect(fallback).not.toContainText("source.example.invalid");
  await expect(fallback.getByRole("button", { name: "Retry page" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "About", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Library", exact: true })).toBeVisible();
  await expect(page.getByText("Boundary test track", { exact: true })).toBeVisible();

  await fallback.getByRole("button", { name: "Open Library" }).click();

  await expect(page).toHaveURL("/");
  await expect(fallback).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
  await expect(page.getByText("Boundary test track", { exact: true })).toBeVisible();
});
