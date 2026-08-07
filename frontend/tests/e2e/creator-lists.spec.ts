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
      await route.fulfill({
        json: {
          authenticated: true,
          user: {
            id: 1,
            username: "listener",
            displayName: "Listener",
            role: "user",
            permissions: ["library:read", "favorites:write", "tags:write"],
            devMode: true,
          },
        },
      });
      return;
    }
    if (url.pathname === latestWork.coverUrl) {
      await route.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ),
      });
      return;
    }
    if (url.pathname === "/api/circles") {
      await route.fulfill({
        json: {
          circles: [
            circle,
            {
              ...circle,
              id: 2,
              externalId: "RG10000",
              displayName: "No Cover Circle",
              latestWork: { ...latestWork, primaryCode: "RJ09999003", coverUrl: "" },
            },
          ],
          page: 1,
          pageSize: 24,
          total: 30,
          catalogWorks: 75,
          availableWorks: 45,
        },
      });
      return;
    }
    if (url.pathname === "/api/voices") {
      await route.fulfill({
        json: {
          voices: [
            voice,
            {
              ...voice,
              personId: 8,
              displayName: "No Cover Voice",
              latestWork: { ...latestWork, primaryCode: "RJ09999004", coverUrl: "" },
            },
          ],
          page: 1,
          pageSize: 24,
          total: 30,
          tagOptions: ["Soft"],
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: `Not mocked: ${url.pathname}` } });
  });
}

async function mockCreatorDetails(page: Page) {
  const voiceDetail = {
    ...voice,
    aliases: [voice.displayName, "Voice alias"],
    aliasRecords: [
      { id: 1, alias: voice.displayName, source: "primary_name", createdAt: "2026-07-01T00:00:00Z" },
      { id: 2, alias: "Voice alias", source: "manual", createdAt: "2026-07-01T00:00:00Z" },
    ],
    works: [],
    remoteMatches: [],
  };
  const circleDetail = {
    ...circle,
    aliases: ["Circle alias", "Second alias"],
    works: [],
    series: [],
  };

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({
        json: {
          authenticated: true,
          user: {
            id: 1,
            username: "listener",
            displayName: "Listener",
            role: "user",
            permissions: ["library:read", "favorites:write", "tags:write", "metadata:sync"],
            devMode: true,
          },
        },
      });
      return;
    }
    if (url.pathname === "/api/voices/7") {
      await route.fulfill({ json: voiceDetail });
      return;
    }
    if (url.pathname === "/api/voices/7/works") {
      await route.fulfill({ json: { personId: 7, works: [] } });
      return;
    }
    if (url.pathname === "/api/voices/7/remote-matches") {
      await route.fulfill({
        json: {
          personId: 7,
          remoteMatches: [
            {
              sourceId: 3,
              sourceCode: "example",
              displayName: "Example Remote",
              status: "ok",
              error: "",
              elapsedMs: 12,
              total: 0,
              works: [],
            },
          ],
        },
      });
      return;
    }
    if (url.pathname === "/api/voices/7/merges") {
      await route.fulfill({ json: [] });
      return;
    }
    if (url.pathname === "/api/circles/RG09999") {
      await route.fulfill({ json: circleDetail });
      return;
    }
    if (url.pathname === "/api/circles/RG09999/auto-refresh") {
      await route.fulfill({ json: { status: "skipped", reason: "fresh", mode: "" } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: `Not mocked: ${url.pathname}` } });
  });
}

async function expectSingleStatRow(page: Page, columns: 4 | 5, marker: string) {
  const cards = page.locator(`div.grid.grid-cols-${columns}`).filter({ hasText: marker }).locator(":scope > *");
  await expect(cards).toHaveCount(columns);
  const tops = await cards.evaluateAll((elements) =>
    elements.map((element) => Math.round(element.getBoundingClientRect().top)),
  );
  expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(1);
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
  await expect(
    page
      .locator("div.inline-flex")
      .filter({ hasText: /^Soft$/ })
      .first(),
  ).toBeVisible();
  await expect(page.getByText("1-24 of 30 voice actors", { exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Voice actor pages" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("a one-circle result keeps the initial creator region height", async ({ page }) => {
  let releaseRequest = () => undefined;
  const requestGate = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  await mockCreatorLists(page);
  await page.route("**/api/circles?**", async (route) => {
    await requestGate;
    await route.fulfill({
      json: { circles: [circle], page: 1, pageSize: 24, total: 1, catalogWorks: 5, availableWorks: 3 },
    });
  });

  await page.goto("/circles?pageSize=24");
  const loading = page.getByRole("status", { name: "Loading circles" });
  await expect(loading).toBeVisible();
  const loadingBox = await loading.boundingBox();

  releaseRequest();
  const openCircle = page.getByRole("button", { name: "Open Example Circle" });
  await expect(openCircle).toBeVisible();
  const results = page.getByRole("region", { name: "Circle results" });
  const resultsBox = await results.boundingBox();

  expect(loadingBox).not.toBeNull();
  expect(resultsBox).not.toBeNull();
  expect(Math.abs(resultsBox!.height - loadingBox!.height)).toBeLessThanOrEqual(1);
});

test("voice detail renders one stable work-loading region for local and remote discovery", async ({ page }) => {
  let releaseWorks = () => undefined;
  let releaseRemote = () => undefined;
  const worksGate = new Promise<void>((resolve) => {
    releaseWorks = resolve;
  });
  const remoteGate = new Promise<void>((resolve) => {
    releaseRemote = resolve;
  });
  await mockCreatorDetails(page);
  await page.route("**/api/voices/7/works", async (route) => {
    await worksGate;
    await route.fulfill({ json: { personId: 7, works: [] } });
  });
  await page.route("**/api/voices/7/remote-matches", async (route) => {
    await remoteGate;
    await route.fulfill({ json: { personId: 7, remoteMatches: [] } });
  });

  await page.goto("/voices/7");
  await expect(page.getByRole("heading", { name: "Example Voice", exact: true })).toBeVisible();
  const loading = page.getByRole("status", { name: "Loading voice works" });
  await expect(loading).toHaveCount(1);

  releaseWorks();
  await expect(loading).toHaveCount(1);
  releaseRemote();
  await expect(page.getByText("No works match this view.", { exact: true })).toBeVisible();
  await expect(loading).toHaveCount(0);
});

test("voice detail keeps stats together and secondary panels folded on mobile", async ({ page }) => {
  await mockCreatorDetails(page);
  await page.goto("/voices/7");

  await expect(page.getByRole("heading", { name: "Example Voice", exact: true })).toBeVisible();
  await expectSingleStatRow(page, 5, "Known works");
  const aliases = page.locator("details").filter({ hasText: "Aliases" }).first();
  const remoteSources = page.locator("details").filter({ hasText: "Remote Sources" }).first();
  await expect(aliases).not.toHaveAttribute("open", "");
  await expect(remoteSources).not.toHaveAttribute("open", "");
  await expect(aliases.getByRole("heading", { name: "Aliases", exact: true })).toBeHidden();
  await expect(remoteSources.getByRole("heading", { name: "Remote Sources", exact: true })).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("circle detail keeps stats together and aliases folded on mobile", async ({ page }) => {
  await mockCreatorDetails(page);
  await page.goto("/circles/RG09999");

  await expect(page.getByRole("heading", { name: "Example Circle", exact: true })).toBeVisible();
  await expectSingleStatRow(page, 4, "Catalog works");
  const aliases = page.locator("details").filter({ hasText: "Aliases" }).first();
  await expect(aliases).not.toHaveAttribute("open", "");
  await expect(aliases.getByText("Circle alias, Second alias", { exact: true })).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
