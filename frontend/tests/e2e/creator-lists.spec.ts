import { expect, test, type Page } from "@playwright/test";

const latestWork = {
  primaryCode: "RJ09999002",
  title: "Latest known work",
  releaseDate: "2026-07-01",
  coverUrl: "/api/assets/covers/RJ09999002.png",
};

const circle = {
  id: 1,
  externalId: "RG09999",
  displayName: "Example Circle",
  aliases: ["Circle alias"],
  rating: null,
  note: "",
  favorite: true,
  userTags: [{ id: 1, name: "Relax", color: "" }],
  localWorks: 2,
  playableWorks: 3,
  remoteWorks: 1,
  missingWorks: 2,
  catalogWorks: 5,
  lastSyncedAt: "2026-07-01T00:00:00Z",
  syncState: "fresh",
  autoRefresh: { status: "skipped", reason: "not evaluated", mode: "" },
  sourceSummaries: [
    { key: "local", sourceId: null, displayName: "Local", status: "available", count: 2 },
    { key: "remote", sourceId: null, displayName: "Remote", status: "available", count: 1 },
  ],
  latestWork,
};

const voice = {
  personId: 7,
  displayName: "Example Voice",
  aliases: ["Voice alias"],
  knownWorks: 5,
  localWorks: 2,
  remoteWorks: 1,
  cachedWorks: 1,
  playableWorks: 4,
  lastSeenAt: "2026-07-01T00:00:00Z",
  rating: null,
  note: "",
  favorite: false,
  userTags: [{ id: 2, name: "Soft", color: "" }],
  sourceSummaries: [
    { key: "local", sourceId: null, displayName: "Local", status: "available", count: 2 },
    { key: "cache", sourceId: null, displayName: "Cache", status: "available", count: 1 },
    { key: "remote", sourceId: null, displayName: "Remote", status: "available", count: 1 },
  ],
  latestWork,
};

async function mockCreatorLists(page: Page) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({ json: { authenticated: true, user: { id: 1, username: "listener", displayName: "Listener", role: "user", permissions: ["library:read", "favorites:write", "tags:write"], devMode: true } } });
      return;
    }
    if (url.pathname === latestWork.coverUrl) {
      await route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64") });
      return;
    }
    if (url.pathname === "/api/circles") {
      await route.fulfill({ json: { circles: [circle, { ...circle, id: 2, externalId: "RG10000", displayName: "No Cover Circle", latestWork: { ...latestWork, primaryCode: "RJ09999003", coverUrl: "" } }], page: 1, pageSize: 24, total: 30, catalogWorks: 75, availableWorks: 45 } });
      return;
    }
    if (url.pathname === "/api/voices") {
      await route.fulfill({ json: { voices: [voice, { ...voice, personId: 8, displayName: "No Cover Voice", latestWork: { ...latestWork, primaryCode: "RJ09999004", coverUrl: "" } }], page: 1, pageSize: 24, total: 30, tagOptions: ["Soft"] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: `Not mocked: ${url.pathname}` } });
  });
}

test("circle list uses compact responsive cards and shared pagination", async ({ page }) => {
  await mockCreatorLists(page);
  await page.goto("/circles?pageSize=24");

  await expect(page.getByRole("heading", { name: "Circles" })).toBeVisible();
  await expect(page.getByText("Latest RJ09999002", { exact: true })).toBeVisible();
  await expect(page.getByText("No cover", { exact: true })).toBeVisible();
  await expect(page.getByText("1-24 of 30 circles", { exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Circle pages" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByLabel("Circle filter").selectOption("missing");
  await expect(page).toHaveURL(/filter=missing/);
});

test("voice list keeps latest work, tags, and availability visible on mobile", async ({ page }) => {
  await mockCreatorLists(page);
  await page.goto("/voices?pageSize=24");

  await expect(page.getByRole("heading", { name: "Voice Actors" })).toBeVisible();
  await expect(page.getByText("Latest RJ09999002", { exact: true })).toBeVisible();
  await expect(page.getByText("Cache 1", { exact: true }).first()).toBeVisible();
  await expect(page.locator("div.inline-flex").filter({ hasText: /^Soft$/ }).first()).toBeVisible();
  await expect(page.getByText("1-24 of 30 voice actors", { exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Voice actor pages" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
