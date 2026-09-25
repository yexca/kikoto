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

const circleSeries = [
  {
    titleId: "SRI0999999999",
    name: "Example Circle Series",
    url: "https://example.invalid/series/example-circle-series",
    declaredWorks: 1,
    works: 1,
    localWorks: 1,
    remoteWorks: 0,
    missingWorks: 0,
    workCodes: ["RJ00000003"],
  },
  {
    titleId: "SRI0888888888",
    name: "Second Circle Series",
    url: "https://example.invalid/series/second-circle-series",
    declaredWorks: 1,
    works: 1,
    localWorks: 0,
    remoteWorks: 0,
    missingWorks: 1,
    workCodes: ["RJ00000004"],
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
  const legacyCreator: Record<string, unknown> = { ...creator };
  delete legacyCreator.syncState;
  delete legacyCreator.syncReason;
  return legacyCreator as Omit<T, "syncState" | "syncReason">;
}

async function mockCreatorDetails(
  page: Page,
  options: {
    circleSyncState?: string;
    voiceSyncState?: string;
    circleSeries?: typeof circleSeries;
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
    metadataMissingWorks: 1,
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
    series: options.circleSeries ?? [],
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
            permissions: ["library:read", "favorites:write", "tags:write", "metadata:sync", "workflows:run"],
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
        json: { runId: 1, status: "queued" },
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
  await expect(page.getByRole("region", { name: "Circle totals" })).toHaveCount(0);
  await expect(page.getByText("Page 1 · 30 Circles", { exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Circle pages controls" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Circle pages" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByRole("button", { name: "All circles" }).click();
  await expect(page.getByRole("menu", { name: "Circles filters" })).toBeVisible();
  await page.getByRole("menuitemradio", { name: "Missing" }).click();
  await expect(page).toHaveURL(/filter=missing/);

  await page.getByRole("button", { name: "Search circles" }).click();
  await expect(page.getByPlaceholder("Search circles")).toBeVisible();
  await page.getByPlaceholder("Search circles").fill("Example");
  await expect(page.getByRole("button", { name: "Circles search is active" })).toBeDisabled();

  await page.getByRole("button", { name: "Items per page: 24" }).click();
  await expect(page.getByRole("menu", { name: "Items per page" })).toBeVisible();
  await page.getByRole("menuitemradio", { name: "48 / page" }).click();
  await expect(page).toHaveURL(/pageSize=48/);
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
  await expect(page.getByText("Page 1 · 30 Voice actors", { exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Voice actor pages controls" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Voice actor pages" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole("button", { name: "All voices" })).toBeVisible();
  const pageSizeButton = page.getByRole("button", { name: "Items per page: 24" });
  await expect(pageSizeButton).toBeVisible();
  await pageSizeButton.click();
  await expect(page.getByRole("menu", { name: "Items per page" })).toBeVisible();
  await expect(page.getByRole("menuitemradio", { name: "24 / page" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "48 / page" }).click();
  await expect(page).toHaveURL(/pageSize=48/);
});

test("@desktop creator list toolbars keep search left and filters right on desktop", async ({ page }) => {
  await mockCreatorLists(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto("/circles");
  const circleSearch = page.getByPlaceholder("Search circles");
  const circleFilter = page.getByRole("button", { name: "All circles" });
  await expect(circleSearch).toBeVisible();
  await expect(circleFilter).toBeVisible();
  await expect(page.getByRole("button", { name: "Items per page: 24" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Search circles" })).toHaveCount(0);
  const circleSearchBox = await circleSearch.boundingBox();
  const circleFilterBox = await circleFilter.boundingBox();
  expect(circleSearchBox).not.toBeNull();
  expect(circleFilterBox).not.toBeNull();
  expect(circleSearchBox!.x + circleSearchBox!.width).toBeLessThanOrEqual(circleFilterBox!.x);

  await page.goto("/voices");
  const voiceSearch = page.getByPlaceholder("Search voices or tags");
  const voiceFilter = page.getByRole("button", { name: "All voices" });
  await expect(voiceSearch).toBeVisible();
  await expect(voiceFilter).toBeVisible();
  await expect(page.getByRole("button", { name: "Items per page: 24" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Search voice actors" })).toHaveCount(0);
  const voiceSearchBox = await voiceSearch.boundingBox();
  const voiceFilterBox = await voiceFilter.boundingBox();
  expect(voiceSearchBox).not.toBeNull();
  expect(voiceFilterBox).not.toBeNull();
  expect(voiceSearchBox!.x + voiceSearchBox!.width).toBeLessThanOrEqual(voiceFilterBox!.x);
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
  await expect(circleSummary.getByRole("button", { name: "First pull" })).toBeVisible();
  expect(legacyAutoRefreshRequests).toEqual([]);

  const circlePullRequest = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/api/circles/RG09999/refresh" && request.method() === "POST",
  );
  await circleSummary.getByRole("button", { name: "First pull" }).click();
  await circlePullRequest;
  expect(refreshRequests).toContainEqual({
    path: "/api/circles/RG09999/refresh",
    payload: { catalogRefresh: "full", metadataRefresh: "missing" },
  });
  await expect(circleSummary.getByRole("button", { name: "Refreshing" })).toBeVisible();
  await expect(circleSummary.getByRole("button", { name: "First pull" })).toHaveCount(0);

  const voiceCatalogLoaded = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/voices/7/remote-matches",
  );
  await page.goto("/voices/7");
  await voiceCatalogLoaded;
  await expect(page.getByText("Never", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "First pull" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(legacyAutoRefreshRequests).toEqual([]);

  const voicePullRequest = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/api/voices/7/catalog/refresh" && request.method() === "POST",
  );
  await page.getByRole("button", { name: "First pull" }).click();
  await voicePullRequest;
  expect(refreshRequests).toContainEqual({
    path: "/api/voices/7/catalog/refresh",
    payload: { catalogRefresh: "full", metadataRefresh: "missing" },
  });
});

// Counts React commits through the devtools hook, so a render loop that
// leaves the DOM unchanged is still observable.
async function countReactCommits(page: Page) {
  await page.addInitScript(() => {
    const renderers = new Map<number, unknown>();
    const counter = window as unknown as { __reactCommitCount: number };
    counter.__reactCommitCount = 0;
    Object.assign(window, {
      __REACT_DEVTOOLS_GLOBAL_HOOK__: {
        renderers,
        supportsFiber: true,
        inject: (renderer: unknown) => {
          const id = renderers.size + 1;
          renderers.set(id, renderer);
          return id;
        },
        checkDCE: () => {},
        onScheduleFiberRoot: () => {},
        onCommitFiberRoot: () => {
          counter.__reactCommitCount += 1;
        },
        onCommitFiberUnmount: () => {},
        onPostCommitFiberRoot: () => {},
      },
    });
  });
}

async function expectReactCommitsToSettle(page: Page) {
  const commitCount = () =>
    page.evaluate(() => (window as unknown as { __reactCommitCount: number }).__reactCommitCount);
  await expect
    .poll(async () => {
      const before = await commitCount();
      await page.waitForTimeout(250);
      return (await commitCount()) - before;
    })
    .toBe(0);
}

for (const role of ["admin", "member"] as const) {
  test(`an unknown circle ${role === "admin" ? "offers the follow workflow" : "asks a member to contact an administrator"}`, async ({
    page,
  }) => {
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
              role: role === "admin" ? "admin" : "user",
              permissions:
                role === "admin"
                  ? ["library:read", "favorites:write", "tags:write", "metadata:sync", "workflows:run"]
                  : ["library:read", "favorites:write", "tags:write"],
              devMode: true,
            },
          },
        });
        return;
      }
      if (url.pathname === "/api/circles/RG09999") {
        await route.fulfill({ status: 404, json: { error: "circle not found", code: "circle_not_in_database" } });
        return;
      }
      await route.fulfill({ status: 404, json: { error: `Not mocked: ${url.pathname}` } });
    });

    await countReactCommits(page);
    await page.goto("/circles/RG09999");
    await expect(page.getByRole("heading", { name: "Circle not in this site's database" })).toBeVisible();
    await expectReactCommitsToSettle(page);
    const fetchButton = page.getByRole("button", { name: "Try fetching" });
    if (role === "member") {
      await expect(page.getByText(/Contact an administrator to add it/)).toBeVisible();
      await expect(fetchButton).toHaveCount(0);
      return;
    }
    await expect(page.getByText(/Try fetching it from DLsite\?/)).toBeVisible();
    await fetchButton.click();
    await expect(page).toHaveURL(/\/workflows\?workflow=circle_follow&circleId=RG09999$/);
  });
}

for (const role of ["admin", "member"] as const) {
  test(`an unknown voice actor ${role === "admin" ? "explains how a metadata sync creates it" : "asks a member to contact an administrator"}`, async ({
    page,
  }) => {
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
              role: role === "admin" ? "admin" : "user",
              permissions:
                role === "admin"
                  ? ["library:read", "favorites:write", "tags:write", "metadata:sync", "workflows:run"]
                  : ["library:read", "favorites:write", "tags:write"],
              devMode: true,
            },
          },
        });
        return;
      }
      await route.fulfill({ status: 404, json: { error: "voice actor not found" } });
    });

    await countReactCommits(page);
    await page.goto("/voices/99");
    await expect(page.getByRole("heading", { name: "Voice actor not in this site's database" })).toBeVisible();
    await expectReactCommitsToSettle(page);
    await expect(
      page.getByText(
        role === "admin"
          ? "Voice actor 99 is not in this site's database. Sync the metadata of any work by this voice actor to create the page."
          : "Voice actor 99 is not in this site's database. Contact an administrator to add it.",
      ),
    ).toBeVisible();
  });
}

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

  const actions = page.getByRole("group", { name: "Voice actor actions" });
  const moreActions = actions.getByRole("button", { name: "More voice actor actions" });
  await expect(moreActions).toHaveAttribute("aria-expanded", "false");
  await expect(actions.getByRole("button", { name: "Add favorite" })).toBeVisible();
  await expect(actions.getByText("Favorite", { exact: true })).toBeHidden();
  await expect(actions.getByText("Metadata", { exact: true })).toBeVisible();
  await expect(actions.getByText("Refresh", { exact: true })).toBeVisible();
  await expect(actions.getByText("Retry metadata", { exact: true })).toBeHidden();
  await expect(actions.getByText("More", { exact: true })).toBeHidden();
  const actionMetrics = await actions.locator(":scope button[aria-label]").evaluateAll((elements) =>
    elements.map((element) => ({
      label: element.getAttribute("aria-label"),
      height: element.getBoundingClientRect().height,
      width: element.getBoundingClientRect().width,
      top: Math.round(element.getBoundingClientRect().top),
    })),
  );
  expect(actionMetrics.map((metric) => metric.label)).toEqual([
    "Add favorite",
    "Retry metadata",
    "Refresh",
    "More voice actor actions",
  ]);
  expect(actionMetrics.every((metric) => metric.height >= 44 && metric.width >= 44)).toBe(true);
  expect(
    Math.max(...actionMetrics.map((metric) => metric.top)) - Math.min(...actionMetrics.map((metric) => metric.top)),
  ).toBeLessThanOrEqual(1);

  // Secondary actions are workflow shortcuts; refresh options live in the workflow's run form.
  await moreActions.click();
  const moreMenu = page.getByRole("menu", { name: "More voice actor actions" });
  await expect(moreMenu.getByRole("menuitem")).toHaveText(["Follow this voice actor…", "Manage aliases"]);
  await page.keyboard.press("Escape");
  await expect(moreMenu).toHaveCount(0);

  const refreshRequest = page.waitForRequest((request) => {
    if (new URL(request.url()).pathname !== "/api/voices/7/catalog/refresh" || request.method() !== "POST") {
      return false;
    }
    return (request.postDataJSON() as { catalogRefresh?: string }).catalogRefresh === "incremental";
  });
  await actions.getByRole("button", { name: "Refresh", exact: true }).click();
  expect((await refreshRequest).postDataJSON()).toEqual({ catalogRefresh: "incremental", metadataRefresh: "missing" });

  const metadataRefreshRequest = page.waitForRequest((request) => {
    if (new URL(request.url()).pathname !== "/api/voices/7/catalog/refresh" || request.method() !== "POST") {
      return false;
    }
    return (request.postDataJSON() as { catalogRefresh?: string }).catalogRefresh === "stored";
  });
  await actions.getByRole("button", { name: "Retry metadata" }).click();
  expect((await metadataRefreshRequest).postDataJSON()).toEqual({
    catalogRefresh: "stored",
    metadataRefresh: "missing",
  });

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

test("@desktop voice detail keeps full action labels and inline work controls", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockCreatorDetails(page);
  await page.goto("/voices/7");

  const actions = page.getByRole("group", { name: "Voice actor actions" });
  await expect(actions.getByText("Favorite", { exact: true })).toBeVisible();
  await expect(actions.getByText("Retry metadata", { exact: true })).toBeVisible();
  await expect(actions.getByText("Refresh", { exact: true })).toBeVisible();
  await expect(actions.getByText("Metadata", { exact: true })).toBeHidden();
  await expect(actions.getByText("More", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open voice work options" })).toBeHidden();
  await expect(page.getByLabel("Voice work availability")).toBeVisible();
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
  await expect(actions.getByRole("button", { name: "Retry metadata" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Refresh circle" })).toBeVisible();
  await expect(actions.getByText("Metadata", { exact: true })).toBeVisible();
  await expect(actions.getByText("Retry metadata", { exact: true })).toBeHidden();
  await expect(actions.getByRole("button", { name: "Refresh circle", exact: true })).toBeVisible();
  await expect(actions.getByText("Favorite", { exact: true })).toBeHidden();
  await expect(actions.getByText("More", { exact: true })).toBeHidden();
  const dlsiteLink = summary.getByRole("link", { name: "Open DLsite for RG09999" });
  await expect(dlsiteLink).toBeVisible();
  await expect(dlsiteLink).toContainText("RG09999");
  await expect(dlsiteLink).toHaveAttribute(
    "href",
    "https://www.dlsite.com/maniax/circle/profile/=/maker_id/RG09999.html",
  );
  await expect(dlsiteLink).toHaveAttribute("target", "_blank");
  await expect(dlsiteLink).toHaveAttribute("rel", "noreferrer");
  const codeAndTitle = await Promise.all([
    dlsiteLink.boundingBox(),
    summary.getByRole("heading", { name: "Example Circle", exact: true }).boundingBox(),
  ]);
  expect(codeAndTitle[0]).not.toBeNull();
  expect(codeAndTitle[1]).not.toBeNull();
  expect(codeAndTitle[0]!.y).toBeLessThan(codeAndTitle[1]!.y);
  await expect(actions.getByRole("button", { name: "More circle actions" })).toHaveAttribute("aria-expanded", "false");
  const actionMetrics = await actions.locator(":scope button[aria-label], :scope > a").evaluateAll((elements) =>
    elements
      .map((element) => ({
        label: element.getAttribute("aria-label"),
        height: element.getBoundingClientRect().height,
        width: element.getBoundingClientRect().width,
        top: Math.round(element.getBoundingClientRect().top),
      }))
      .filter((metric) => metric.width > 0 && metric.height > 0),
  );
  expect(actionMetrics.map((metric) => metric.label)).toEqual([
    "Remove favorite",
    "Retry metadata",
    "Refresh circle",
    "More circle actions",
  ]);
  expect(actionMetrics.every((metric) => metric.height >= 44 && metric.width >= 44)).toBe(true);
  expect(
    Math.max(...actionMetrics.map((metric) => metric.top)) - Math.min(...actionMetrics.map((metric) => metric.top)),
  ).toBeLessThanOrEqual(1);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // The Follow shortcut opens the circle follow workflow with this circle prefilled.
  await actions.getByRole("button", { name: "More circle actions" }).click();
  const moreMenu = page.getByRole("menu", { name: "More circle actions" });
  await expect(moreMenu.getByRole("menuitem")).toHaveText(["Follow this circle…"]);
  await moreMenu.getByRole("menuitem", { name: "Follow this circle…" }).click();
  await expect(page).toHaveURL(/\/workflows\?workflow=circle_follow&circleId=RG09999$/);
});

test("mobile circle detail keeps the work surface visible and moves secondary controls into sheets", async ({
  page,
}) => {
  await mockCreatorDetails(page);
  await page.goto("/circles/RG09999");

  await expect(page.getByRole("heading", { name: "Example Circle", exact: true })).toBeVisible();
  await expect(page.getByTestId("work-card").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "More circle actions" })).toBeVisible();

  await page.getByRole("button", { name: "Catalog options" }).click();
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
  await page.getByRole("button", { name: "Catalog options" }).click();
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

test("mobile circle series combines its selected row, DLsite link, and sheet control", async ({ page }) => {
  await mockCreatorDetails(page, { circleSeries });
  await page.goto("/circles/RG09999/series/SRI0999999999");

  const chooseSeries = page.getByRole("button", { name: "Series", exact: true }).first();
  await expect(chooseSeries).toContainText("Example Circle Series");
  await expect(
    page.locator('a[aria-label="Open DLsite"][href="https://example.invalid/series/example-circle-series"]'),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Series", exact: true })).toHaveCount(2);
  await expect(page.getByText("Second Circle Series", { exact: true }).filter({ visible: true })).toHaveCount(0);

  await chooseSeries.click();
  const seriesDialog = page.getByRole("dialog", { name: "Series" });
  await expect(seriesDialog).toBeVisible();
  await expect(seriesDialog.getByText("All series", { exact: true })).toBeVisible();
  await expect(seriesDialog.getByText("Example Circle Series", { exact: true })).toBeVisible();
  await expect(seriesDialog.getByText("Second Circle Series", { exact: true })).toBeVisible();

  await seriesDialog.getByText("Second Circle Series", { exact: true }).click();
  await expect(seriesDialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/circles\/RG09999\/series\/SRI0888888888$/);
  await expect(page.getByRole("button", { name: "Series", exact: true }).first()).toContainText("Second Circle Series");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("@desktop circle detail keeps a full-width compact summary and source-aware return", async ({ page }) => {
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
  await expect(actions.getByRole("button", { name: "Refresh circle", exact: true })).toBeVisible();
  await expect(actions.getByText("More", { exact: true })).toBeVisible();
  await expect(actions.getByText("DLsite", { exact: true })).toHaveCount(0);
  const dlsiteLink = summary.getByRole("link", { name: "Open DLsite for RG09999" });
  await expect(dlsiteLink).toBeVisible();
  await expect(dlsiteLink).toContainText("RG09999");
  const actionOrder = await actions
    .locator(":scope button[aria-label], :scope > a")
    .evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label")));
  expect(actionOrder).toEqual(["Remove favorite", "Retry metadata", "Refresh circle", "More circle actions"]);

  await page.getByRole("button", { name: "Catalog availability filter" }).click();
  await page.getByRole("menuitemradio", { name: "Unavailable", exact: true }).click();
  await expect(summary.getByText("Available 1", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Catalog options" })).toBeHidden();
  await expect(page.getByRole("button", { name: "More circle actions" })).toBeVisible();
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

test("mobile command palette uses a sheet, stays in the visual viewport, and closes on a downward swipe", async ({
  page,
}) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await mockCreatorDetails(page);
  await page.goto("/circles/RG09999");

  await page.getByRole("button", { name: "Quick actions" }).click();
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  const input = page.getByPlaceholder("Search or open a work code");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("data-mobile-sheet");
  await expect(dialog).toHaveAttribute("data-state", "open");
  await expect(dialog.getByRole("button", { name: "Close command palette" })).toHaveCount(0);
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

  const handleBox = await dialog.locator("[data-mobile-sheet-handle]").boundingBox();
  expect(handleBox).not.toBeNull();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2 + 140, {
    steps: 4,
  });
  await page.mouse.up();
  await expect(dialog).toHaveCount(0);
});
