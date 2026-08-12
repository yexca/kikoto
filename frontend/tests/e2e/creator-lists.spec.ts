import { expect, test, type Page } from "@playwright/test";

const latestWork = {
  primaryCode: "RJ00000000",
  title: "Latest known work",
  releaseDate: "2026-07-01",
  coverUrl: "/api/assets/covers/RJ00000000.png",
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
  syncState: "synced",
  syncReason: "",
  sourceSummaries: [
    { key: "local", sourceId: null, displayName: "Local", status: "available", count: 2 },
    { key: "remote", sourceId: null, displayName: "Remote", status: "available", count: 1 },
  ],
  latestWork,
};

const circleCatalogWorks = [
  {
    workId: 1,
    primaryCode: "RJ00000003",
    remoteCode: "RJ00000003",
    title: "Example Circle Work",
    releaseDate: "2026-07-02",
    updatedAt: "2026-07-02T00:00:00Z",
    coverUrl: "",
    dlsiteUrl: "",
    circle: "Example Circle",
    circleExternalId: "RG09999",
    ageRating: "R15",
    tags: [],
    userTags: [],
    voiceActors: [],
    voiceRefs: [],
    voiceCredits: [],
    rating: null,
    ratingCount: null,
    sales: null,
    hasAvailableNonOriginEdition: false,
    regularPrice: null,
    price: null,
    priceCurrency: "JPY",
    permanentlyFree: false,
    series: "",
    seriesTitleId: "",
    catalogStatus: "imported",
    dlsiteAvailable: true,
    listeningMark: "none",
    favorite: false,
    local: true,
    remote: false,
    sourceTags: [{ key: "local", sourceId: null, displayName: "Local", status: "available", count: 1 }],
  },
  {
    workId: null,
    primaryCode: "RJ00000004",
    remoteCode: "RJ00000004",
    title: "Example Catalog-only Work",
    releaseDate: "2026-07-03",
    updatedAt: "2026-07-03T00:00:00Z",
    coverUrl: "",
    dlsiteUrl: "",
    circle: "Example Circle",
    circleExternalId: "RG09999",
    ageRating: "R15",
    tags: [],
    userTags: [],
    voiceActors: [],
    voiceRefs: [],
    voiceCredits: [],
    rating: null,
    ratingCount: null,
    sales: null,
    hasAvailableNonOriginEdition: false,
    regularPrice: null,
    price: null,
    priceCurrency: "JPY",
    permanentlyFree: false,
    series: "",
    seriesTitleId: "",
    catalogStatus: "catalog_only",
    dlsiteAvailable: true,
    listeningMark: "none",
    favorite: false,
    local: false,
    remote: false,
    sourceTags: [],
  },
];

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
  lastSyncedAt: "2026-07-01T00:00:00Z",
  syncState: "synced",
  syncReason: "",
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

async function mockCreatorLists(page: Page, options: { circleSyncState?: string; omitVoiceSyncState?: boolean } = {}) {
  const circleSummary = { ...circle, syncState: options.circleSyncState ?? circle.syncState };
  const voiceSummary = options.omitVoiceSyncState
    ? withoutCatalogSyncState(voice)
    : { ...voice, syncState: voice.syncState };

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
            circleSummary,
            {
              ...circleSummary,
              id: 2,
              externalId: "RG10000",
              displayName: "No Cover Circle",
              latestWork: { ...latestWork, primaryCode: "RJ00000001", coverUrl: "" },
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
            voiceSummary,
            {
              ...voiceSummary,
              personId: 8,
              displayName: "No Cover Voice",
              userTags: [
                { id: 3, name: "Warm", color: "" },
                { id: 4, name: "Calm", color: "" },
                { id: 5, name: "Clear", color: "" },
                { id: 6, name: "Story", color: "" },
                { id: 7, name: "Drama", color: "" },
              ],
              latestWork: { ...latestWork, primaryCode: "RJ00000002", coverUrl: "" },
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

function withoutCatalogSyncState<T extends { syncState: unknown; syncReason: unknown }>(creator: T) {
  const { syncState: _syncState, syncReason: _syncReason, ...legacyCreator } = creator;
  return legacyCreator;
}

async function mockCreatorDetails(
  page: Page,
  options: {
    circleSyncState?: string;
    voiceSyncState?: string;
    onRefresh?: (path: string, payload: unknown) => void;
  } = {},
) {
  const voiceCatalogRefresh = {
    status: "succeeded",
    reason: "",
    lastStatus: "succeeded",
    generation: 1,
    lastAttemptAt: "",
    lastSuccessAt: "",
    complete: true,
    pagesFetched: 1,
    catalogWorks: 0,
    metadataQueued: 0,
    queries: [voice.displayName, "Voice alias"],
    sources: [],
    error: "",
  };
  const voiceDetail = {
    ...voice,
    syncState: options.voiceSyncState ?? voice.syncState,
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
    syncState: options.circleSyncState ?? circle.syncState,
    aliases: ["Circle alias", "Second alias"],
    localWorks: 1,
    playableWorks: 1,
    remoteWorks: 0,
    missingWorks: 1,
    catalogWorks: circleCatalogWorks.length,
    works: circleCatalogWorks,
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
          refresh: voiceCatalogRefresh,
        },
      });
      return;
    }
    if (url.pathname === "/api/voices/7/catalog/refresh" && route.request().method() === "POST") {
      options.onRefresh?.(url.pathname, route.request().postDataJSON());
      await route.fulfill({ status: 202, json: voiceCatalogRefresh });
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
    if (url.pathname === "/api/circles") {
      await route.fulfill({
        json: {
          circles: [circle],
          page: Number(url.searchParams.get("page") ?? "1"),
          pageSize: 24,
          total: 30,
          catalogWorks: circle.catalogWorks,
          availableWorks: circle.playableWorks,
        },
      });
      return;
    }
    if (url.pathname === "/api/circles/RG09999/refresh" && route.request().method() === "POST") {
      options.onRefresh?.(url.pathname, route.request().postDataJSON());
      await route.fulfill({
        status: 202,
        json: {
          runId: 1,
          externalId: "RG09999",
          status: "succeeded",
          scope: "metadata",
          catalogWorks: 0,
          pagesFetched: 0,
          productSynced: 0,
          productSkipped: 0,
          productFailed: 0,
          productFailures: [],
          sourceSynced: 0,
          mode: "full",
          productMode: "available",
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: `Not mocked: ${url.pathname}` } });
  });
}

test("circle list uses compact responsive cards and shared pagination", async ({ page }) => {
  await mockCreatorLists(page);
  await page.goto("/circles?pageSize=24");

  await expect(page.locator("footer").getByRole("button", { name: "Circles", exact: true })).toBeVisible();
  await expect(page.getByText("Latest RJ00000000", { exact: true })).toBeVisible();
  await expect(page.getByText("No cover", { exact: true })).toBeVisible();
  await expect(page.getByText("Synced", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Available 3/5", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Local 2", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Remote 1", { exact: true })).toHaveCount(0);
  await expect(page.getByText("2 unavailable", { exact: true })).toHaveCount(0);
  await expect(page.getByText("5 works", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Page 1 · 30 circles", { exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Circle pages controls" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Circle pages" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByRole("button", { name: "Circle list options" }).click();
  await page.getByRole("menuitem", { name: /^Filter/ }).click();
  await page.getByRole("menuitemradio", { name: "Missing" }).click();
  await expect(page).toHaveURL(/filter=missing/);
});

test("voice list keeps latest work, tags, and availability visible on mobile", async ({ page }) => {
  await mockCreatorLists(page);
  await page.goto("/voices?pageSize=24");

  await expect(page.locator("footer").getByRole("button", { name: "Voice Actors", exact: true })).toBeVisible();
  await expect(page.getByText("Latest RJ00000000", { exact: true })).toBeVisible();
  await expect(page.getByText("Local 2", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Remote 1", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Cache 1", { exact: true })).toHaveCount(0);
  await expect(page.getByText("5 works", { exact: true })).toHaveCount(0);
  await expect(page.getByText("2 unavailable", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Drama", { exact: true })).toBeVisible();
  await expect(page.getByText("Synced", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("+1", { exact: true })).toHaveCount(0);
  await expect(
    page
      .locator("div.inline-flex")
      .filter({ hasText: /^Soft$/ })
      .first(),
  ).toBeVisible();
  await expect(page.getByText("Page 1 · 30 voice actors", { exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Voice actor pages controls" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Voice actor pages" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("creator lists render a label for legacy catalog sync responses", async ({ page }) => {
  await mockCreatorLists(page, { circleSyncState: "fresh", omitVoiceSyncState: true });

  await page.goto("/circles");
  await expect(page.getByText("Synced", { exact: true }).first()).toBeVisible();

  await page.goto("/voices");
  await expect(page.getByText("Attention", { exact: true }).first()).toBeVisible();
});

test("creator detail does not auto-refresh and exposes First pull for a new catalog", async ({ page }) => {
  const legacyAutoRefreshRequests: string[] = [];
  const refreshRequests: Array<{ path: string; payload: unknown }> = [];
  await mockCreatorDetails(page, {
    circleSyncState: "never",
    voiceSyncState: "never",
    onRefresh: (path, payload) => refreshRequests.push({ path, payload }),
  });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/auto-refresh")) {
      legacyAutoRefreshRequests.push(request.url());
    }
  });

  const circleLoaded = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/circles/RG09999");
  await page.goto("/circles/RG09999");
  await circleLoaded;
  const circleSummary = page.getByRole("region", { name: "Circle summary" });
  await expect(circleSummary.getByText("Never", { exact: true })).toBeVisible();
  await expect(circleSummary.getByRole("button", { name: "First pull circle catalog" })).toBeVisible();
  expect(legacyAutoRefreshRequests).toEqual([]);

  const circlePullRequest = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/api/circles/RG09999/refresh" && request.method() === "POST",
  );
  await circleSummary.getByRole("button", { name: "First pull circle catalog" }).click();
  await circlePullRequest;
  expect(refreshRequests).toContainEqual({
    path: "/api/circles/RG09999/refresh",
    payload: { scope: "metadata", mode: "full", productMode: "available" },
  });

  const voiceCatalogLoaded = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/voices/7/remote-matches",
  );
  await page.goto("/voices/7");
  await voiceCatalogLoaded;
  await expect(page.getByText("Never", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "First pull voice catalog" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(legacyAutoRefreshRequests).toEqual([]);

  const voicePullRequest = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/api/voices/7/catalog/refresh" && request.method() === "POST",
  );
  await page.getByRole("button", { name: "First pull voice catalog" }).click();
  await voicePullRequest;
  expect(refreshRequests).toContainEqual({
    path: "/api/voices/7/catalog/refresh",
    payload: { scope: "all", mode: "full" },
  });
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
    await route.fulfill({
      json: {
        personId: 7,
        remoteMatches: [],
        refresh: {
          status: "succeeded",
          reason: "",
          lastStatus: "succeeded",
          generation: 1,
          lastAttemptAt: "",
          lastSuccessAt: "",
          complete: true,
          pagesFetched: 1,
          catalogWorks: 0,
          metadataQueued: 0,
          queries: ["Example Voice"],
          sources: [],
          error: "",
        },
      },
    });
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

test("voice detail keeps compact statistics and secondary panels closed on mobile", async ({ page }) => {
  await mockCreatorDetails(page);
  await page.goto("/voices/7");

  await expect(page.getByRole("heading", { name: "Example Voice", exact: true })).toBeVisible();
  const statistics = page.locator('[aria-label="Voice actor statistics"]');
  await expect(statistics).toBeVisible();
  await expect(statistics).toContainText("Local 2");
  await expect(statistics).toContainText("Remote 1");
  await expect(statistics).toContainText("Soft");
  await expect(statistics).not.toContainText("works: 5");
  await expect(statistics).not.toContainText("playable: 4");
  const statisticItems = statistics.locator(":scope > *");
  await expect(statisticItems).toHaveCount(3);
  const statisticTops = await statisticItems.evaluateAll((elements) =>
    elements.map((element) => Math.round(element.getBoundingClientRect().top)),
  );
  expect(Math.max(...statisticTops) - Math.min(...statisticTops)).toBeLessThanOrEqual(4);

  await expect(page.getByRole("button", { name: /^Aliases/ })).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "Open advanced refresh actions" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  const actions = page.getByRole("group", { name: "Voice actor actions" });
  await expect(actions.getByRole("button", { name: "Add favorite" })).toBeVisible();
  await expect(actions.getByText("Favorite", { exact: true })).toBeHidden();
  await expect(actions.getByRole("button", { name: /^Aliases/ })).toBeVisible();
  await expect(actions.getByText("Retry metadata", { exact: true })).toBeHidden();
  await expect(actions.getByText("Refresh remote", { exact: true })).toBeHidden();
  await expect(actions.getByText("Advanced", { exact: true })).toBeHidden();
  const actionMetrics = await actions.locator(":scope > button").evaluateAll((elements) =>
    elements.map((element) => ({
      label: element.getAttribute("aria-label"),
      height: element.getBoundingClientRect().height,
      width: element.getBoundingClientRect().width,
      top: Math.round(element.getBoundingClientRect().top),
    })),
  );
  expect(actionMetrics.map((metric) => metric.label)).toEqual([
    "Add favorite",
    null,
    "Retry voice metadata",
    "Refresh voice remote sources",
    "Open advanced refresh actions",
  ]);
  expect(actionMetrics.every((metric) => metric.height >= 44 && metric.width >= 44)).toBe(true);
  expect(
    Math.max(...actionMetrics.map((metric) => metric.top)) - Math.min(...actionMetrics.map((metric) => metric.top)),
  ).toBeLessThanOrEqual(1);
  await expect(page.getByRole("dialog", { name: "Aliases" })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Advanced refresh" })).toHaveCount(0);

  await page.getByRole("button", { name: "Open advanced refresh actions" }).click();
  const advancedDialog = page.getByRole("dialog", { name: "Advanced refresh" });
  await expect(advancedDialog).toBeVisible();
  await expect(advancedDialog.getByRole("checkbox", { name: "Refresh Example Remote" })).toBeChecked();
  const catalogRefresh = advancedDialog.getByRole("group", { name: "Catalog refresh" });
  const metadataRefresh = advancedDialog.getByRole("group", { name: "Metadata refresh" });
  await expect(catalogRefresh.getByRole("button", { name: "Incremental", exact: true })).toBeVisible();
  await expect(catalogRefresh.getByRole("button", { name: "Full", exact: true })).toBeVisible();
  await expect(metadataRefresh.getByRole("button", { name: "Incremental", exact: true })).toBeVisible();
  await expect(metadataRefresh.getByRole("button", { name: "Full", exact: true })).toBeVisible();
  const fullCatalogRequest = page.waitForRequest((request) => {
    if (new URL(request.url()).pathname !== "/api/voices/7/catalog/refresh" || request.method() !== "POST") {
      return false;
    }
    const payload = request.postDataJSON() as { scope?: string; mode?: string };
    return payload.scope === "remote" && payload.mode === "full";
  });
  await catalogRefresh.getByRole("button", { name: "Full", exact: true }).click();
  expect((await fullCatalogRequest).postDataJSON()).toEqual({ scope: "remote", mode: "full", sourceIds: [3] });
  const fullMetadataRequest = page.waitForRequest((request) => {
    if (new URL(request.url()).pathname !== "/api/voices/7/catalog/refresh" || request.method() !== "POST") {
      return false;
    }
    const payload = request.postDataJSON() as { scope?: string; mode?: string };
    return payload.scope === "metadata" && payload.mode === "full";
  });
  await metadataRefresh.getByRole("button", { name: "Full", exact: true }).click();
  expect((await fullMetadataRequest).postDataJSON()).toEqual({ scope: "metadata", mode: "full" });
  await page.getByRole("button", { name: "Close advanced refresh actions" }).click();

  const metadataRefreshRequest = page.waitForRequest((request) => {
    if (new URL(request.url()).pathname !== "/api/voices/7/catalog/refresh" || request.method() !== "POST") {
      return false;
    }
    const payload = request.postDataJSON() as { scope?: string; mode?: string };
    return payload.scope === "metadata" && payload.mode === "incremental";
  });
  await actions.getByRole("button", { name: "Retry voice metadata" }).click();
  expect((await metadataRefreshRequest).postDataJSON()).toEqual({ scope: "metadata", mode: "incremental" });

  await page.getByRole("button", { name: "Open voice work options" }).click();
  const optionsDialog = page.getByRole("dialog", { name: "Voice work options" });
  await expect(optionsDialog).toBeVisible();
  await optionsDialog.getByRole("button", { name: "Remote", exact: true }).click();
  await expect(optionsDialog.getByRole("button", { name: "Remote", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await optionsDialog.getByRole("button", { name: "2 columns" }).click();
  await expect(optionsDialog.getByRole("button", { name: "2 columns" })).toHaveAttribute("aria-pressed", "true");
  await optionsDialog.getByRole("button", { name: "Select works" }).click();
  await expect(optionsDialog).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("desktop voice detail keeps full action labels and inline work controls", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockCreatorDetails(page);
  await page.goto("/voices/7");

  const actions = page.getByRole("group", { name: "Voice actor actions" });
  await expect(actions.getByText("Favorite", { exact: true })).toBeVisible();
  await expect(actions.getByText("Retry metadata", { exact: true })).toBeVisible();
  await expect(actions.getByText("Refresh remote", { exact: true })).toBeVisible();
  await expect(actions.getByText("Advanced", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open voice work options" })).toBeHidden();
  await expect(page.getByLabel("Work filter")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Columns:/ })).toBeVisible();
});

test("circle detail keeps availability and primary actions compact on mobile", async ({ page }) => {
  await mockCreatorDetails(page);
  await page.goto("/circles/RG09999");

  await expect(page.getByRole("heading", { name: "Example Circle", exact: true })).toBeVisible();
  const summary = page.getByRole("region", { name: "Circle summary" });
  await expect(summary.getByText("Available 1", { exact: true })).toBeVisible();
  const actions = summary.getByRole("group", { name: "Circle actions" });
  await expect(actions.getByRole("button", { name: "Remove favorite" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Retry circle metadata" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Refresh circle" })).toBeVisible();
  await expect(actions.getByText("Metadata", { exact: true })).toBeVisible();
  await expect(actions.getByText("Retry metadata", { exact: true })).toBeHidden();
  await expect(actions.getByText("Circle", { exact: true })).toBeVisible();
  await expect(actions.getByText("Refresh circle", { exact: true })).toBeHidden();
  await expect(actions.getByText("Favorite", { exact: true })).toBeHidden();
  await expect(actions.getByText("Advanced", { exact: true })).toBeHidden();
  await expect(actions.getByText("DLsite", { exact: true })).toBeHidden();
  await expect(actions.getByRole("link", { name: "Open DLsite" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Open advanced refresh actions" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  const actionMetrics = await actions.locator(":scope > :is(button, a)").evaluateAll((elements) =>
    elements.map((element) => ({
      label: element.getAttribute("aria-label"),
      height: element.getBoundingClientRect().height,
      width: element.getBoundingClientRect().width,
      top: Math.round(element.getBoundingClientRect().top),
    })),
  );
  expect(actionMetrics.map((metric) => metric.label)).toEqual([
    "Remove favorite",
    "Retry circle metadata",
    "Refresh circle",
    "Open advanced refresh actions",
    "Open DLsite",
  ]);
  expect(actionMetrics.every((metric) => metric.height >= 44 && metric.width >= 44)).toBe(true);
  expect(
    Math.max(...actionMetrics.map((metric) => metric.top)) - Math.min(...actionMetrics.map((metric) => metric.top)),
  ).toBeLessThanOrEqual(1);
  await expect(page.getByRole("dialog", { name: "Advanced refresh" })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("mobile circle detail keeps the work surface visible and moves secondary controls into sheets", async ({
  page,
}) => {
  await mockCreatorDetails(page);
  await page.goto("/circles/RG09999");

  await expect(page.getByRole("heading", { name: "Example Circle", exact: true })).toBeVisible();
  await expect(page.getByTestId("work-card").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Open advanced refresh actions" })).toBeVisible();
  await expect(page.getByText("Workflow Shortcuts", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Open advanced refresh actions" }).click();
  const refreshDialog = page.getByRole("dialog", { name: "Advanced refresh" });
  await expect(refreshDialog).toBeVisible();
  await expect(refreshDialog.getByRole("button", { name: "Incremental" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Close advanced refresh actions" }).click();

  await page.getByRole("button", { name: "Open catalog options" }).click();
  const optionsDialog = page.getByRole("dialog", { name: "Catalog options" });
  await expect(optionsDialog).toBeVisible();
  await expect(optionsDialog.getByRole("button", { name: "1 column" })).toHaveText("1");
  await expect(optionsDialog.getByRole("button", { name: "2 columns" })).toHaveText("2");
  await expect(optionsDialog.getByRole("button", { name: "Automatic columns" })).toHaveText("Auto");

  await optionsDialog.getByRole("button", { name: "Unavailable" }).click();
  await expect(optionsDialog.getByRole("button", { name: "Unavailable" })).toHaveAttribute("aria-pressed", "true");
  await optionsDialog.getByRole("button", { name: "2 columns" }).click();
  await expect(optionsDialog.getByRole("button", { name: "2 columns" })).toHaveAttribute("aria-pressed", "true");
  await optionsDialog.getByRole("button", { name: "Select works" }).click();
  await expect(optionsDialog).toHaveCount(0);
  await page.getByRole("button", { name: "Open catalog options" }).click();
  await expect(
    page.getByRole("dialog", { name: "Catalog options" }).getByRole("button", { name: "Exit selection mode" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close catalog options" }).click();

  const dialogMetrics = await page
    .getByTestId("work-card")
    .first()
    .evaluate(() => ({
      width: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
  expect(dialogMetrics.width).toBeLessThanOrEqual(dialogMetrics.viewport);
});

test("desktop circle detail keeps a full-width compact summary and source-aware return", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    window.history.replaceState({ returnTo: "/", returnLabel: "Back to library" }, "", window.location.href);
  });
  await mockCreatorDetails(page);
  await page.goto("/circles/RG09999");

  await expect(page.getByRole("button", { name: "Back to library", exact: true })).toBeVisible();
  const summary = page.getByRole("region", { name: "Circle summary" });
  await expect(summary).toBeVisible();
  const summaryWidths = await summary.evaluate((element) => ({
    region: element.getBoundingClientRect().width,
    card: element.firstElementChild?.getBoundingClientRect().width ?? 0,
  }));
  expect(Math.abs(summaryWidths.region - summaryWidths.card)).toBeLessThanOrEqual(1);
  await expect(summary.getByText("Available 1", { exact: true })).toBeVisible();
  const actions = summary.getByRole("group", { name: "Circle actions" });
  await expect(actions.getByText("Favorite", { exact: true })).toBeVisible();
  await expect(actions.getByText("Retry metadata", { exact: true })).toBeVisible();
  await expect(actions.getByText("Refresh circle", { exact: true })).toBeVisible();
  await expect(actions.getByText("Advanced", { exact: true })).toBeVisible();
  await expect(actions.getByText("DLsite", { exact: true })).toBeVisible();
  const actionOrder = await actions
    .locator(":scope > :is(button, a)")
    .evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label")));
  expect(actionOrder).toEqual([
    "Remove favorite",
    "Retry circle metadata",
    "Refresh circle",
    "Open advanced refresh actions",
    "Open DLsite",
  ]);

  await page.getByLabel("Catalog availability filter").selectOption("unavailable");
  await expect(summary.getByText("Available 1", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open catalog options" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Open advanced refresh actions" })).toBeVisible();
});

test("mobile circle detail returns to the circle list entry that opened it", async ({ page }) => {
  await mockCreatorDetails(page);
  await page.goto("/circles?q=Example&page=2&pageSize=24");

  await page.getByRole("button", { name: "Open Example Circle" }).click();
  await expect(page).toHaveURL(/\/circles\/RG09999$/);
  await expect(page.getByRole("heading", { name: "Example Circle", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Back to circles", exact: true }).click();
  await expect(page).toHaveURL(/\/circles\?q=Example&page=2&pageSize=24$/);
  await expect(page.locator("footer").getByRole("button", { name: "Circles", exact: true })).toBeVisible();
});

test("mobile circle navigation does not resume a detail route after returning from Library", async ({ page }) => {
  await mockCreatorDetails(page);
  await page.goto("/circles?q=Example&page=2&pageSize=24");
  await expect(page.getByRole("button", { name: "Open Example Circle" })).toBeVisible();

  const libraryTab = page.locator("footer").getByRole("button", { name: "Library", exact: true });
  await libraryTab.click();
  await expect(page).toHaveURL(/\/$/);

  await page.evaluate(() => {
    window.history.pushState({ returnTo: "/", returnLabel: "Back to library" }, "", "/circles/RG09999");
    window.dispatchEvent(new Event("kikoto:navigation"));
  });
  await expect(page.getByRole("heading", { name: "Example Circle", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Back to circles", exact: true }).click();
  await expect(page).toHaveURL(/\/circles\?q=Example&page=2&pageSize=24$/);

  await libraryTab.click();
  await expect(page).toHaveURL(/\/$/);
  await page.locator("footer").getByRole("button", { name: "Circles", exact: true }).click();
  await expect(page).toHaveURL(/\/circles\?q=Example&page=2&pageSize=24$/);
  await expect(page.locator("footer").getByRole("button", { name: "Circles", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to circles", exact: true })).toHaveCount(0);
});

test("command palette stays within the resized mobile visual viewport", async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await mockCreatorDetails(page);
  await page.goto("/circles/RG09999");

  await page.getByRole("button", { name: "Quick actions" }).click();
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  const input = page.getByPlaceholder("Search, open a work code, or type /workflow");
  await expect(dialog).toBeVisible();
  await expect(input).toBeFocused();

  await page.setViewportSize({ width: 412, height: 430 });
  await expect
    .poll(async () => {
      const box = await dialog.boundingBox();
      return box ? box.y + box.height <= 430 : false;
    })
    .toBe(true);
  await expect(input).toBeVisible();
  await expect(page.locator("footer")).toHaveCount(0);
});
