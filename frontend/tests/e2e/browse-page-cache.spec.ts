import { expect, test, type Page } from "@playwright/test";

const emptyCollection = { works: [], page: 1, pageSize: 24, total: 0 };
const cachedWork = {
  id: 1,
  primaryCode: "RJ00000000",
  title: "Example Work",
  ageRating: "",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  releaseDate: "2026-01-01",
  coverUrl: "",
  dlsiteUrl: "",
  circle: "Example Circle",
  circleExternalId: "RG012345",
  rating: null,
  sales: null,
  regularPrice: null,
  price: null,
  priceCurrency: "JPY",
  permanentlyFree: false,
  tags: [],
  userTags: [],
  voiceActors: [],
  voiceCredits: [],
  series: "",
  seriesTitleId: "",
  trackCount: 0,
  availableLocations: 0,
  availability: [],
  sourcePresence: [],
  progress: {
    mediaItemId: null,
    title: "",
    positionSeconds: 0,
    durationSeconds: null,
    lastPlayedAt: null,
    completed: false,
  },
  listeningStatus: "none",
  favorite: false,
  recommendScore: 0,
};

const cachedCircle = {
  id: 1,
  externalId: "RG012345",
  displayName: "Example Circle",
  aliases: [],
  rating: null,
  note: "",
  favorite: false,
  userTags: [],
  localWorks: 1,
  playableWorks: 1,
  remoteWorks: 0,
  missingWorks: 0,
  catalogWorks: 1,
  lastSyncedAt: "2026-01-01T00:00:00Z",
  syncState: "synced",
  syncReason: "",
  sourceSummaries: [],
  latestWork: null,
};

const cachedVoice = {
  personId: 7,
  displayName: "Example Voice",
  aliases: [],
  knownWorks: 1,
  localWorks: 1,
  remoteWorks: 0,
  cachedWorks: 0,
  playableWorks: 1,
  lastSeenAt: "2026-01-01T00:00:00Z",
  lastSyncedAt: "2026-01-01T00:00:00Z",
  syncState: "synced",
  syncReason: "",
  rating: null,
  note: "",
  favorite: false,
  userTags: [],
  sourceSummaries: [],
  latestWork: null,
};

type BrowsePageMockOptions = {
  deferAliasResolution?: boolean;
};

async function mockBrowsePages(page: Page, requests: Record<string, number>, options: BrowsePageMockOptions = {}) {
  let releaseAliasResolution: (() => void) | null = null;
  const aliasResolution = options.deferAliasResolution
    ? new Promise<void>((resolve) => {
        releaseAliasResolution = resolve;
      })
    : null;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const count = (key: string) => {
      requests[key] = (requests[key] ?? 0) + 1;
    };
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({
        json: {
          authenticated: true,
          user: {
            id: 1,
            username: "listener",
            displayName: "Listener",
            role: "user",
            permissions: ["library:read", "favorites:write"],
            devMode: true,
          },
        },
      });
      return;
    }
    if (url.pathname === "/api/runtime-settings") {
      await route.fulfill({ json: { mode: "development", cacheEnabled: false, directoryRoutingRules: [] } });
      return;
    }
    if (url.pathname === "/api/app-update") {
      await route.fulfill({
        json: {
          currentVersion: "v0.4.1",
          latestVersion: "v0.4.1",
          updateAvailable: false,
          releaseUrl: "",
          checkedAt: "2026-01-01T00:00:00Z",
        },
      });
      return;
    }
    if (url.pathname === "/api/library-sources") {
      count("library-sources");
      await route.fulfill({ json: [] });
      return;
    }
    if (url.pathname === "/api/recently-played-works") {
      count("recently-played");
      await route.fulfill({ json: { works: [] } });
      return;
    }
    if (url.pathname === "/api/works") {
      count("works");
      await route.fulfill({ json: { ...emptyCollection, works: [cachedWork], total: 1 } });
      return;
    }
    if (url.pathname === "/api/works/1") {
      await route.fulfill({
        json: {
          ...cachedWork,
          baseCode: "",
          metadataLanguage: "JPN",
          workType: "audio",
          titleKana: "",
          description: "",
          durationSeconds: null,
          dlsiteFetchedAt: "",
          translations: [],
          manualOverrides: {},
          mediaItems: [],
        },
      });
      return;
    }
    if (url.pathname === "/api/works/1/media") {
      count("work-media");
      await route.fulfill({ json: { workId: 1, mediaItems: [] } });
      return;
    }
    if (url.pathname === "/api/works/RJ00000001/resolve") {
      count("alias-resolve");
      await aliasResolution;
      await route.fulfill({
        json: {
          requestedCode: "RJ00000001",
          resolvedCode: "RJ00000000",
          workId: 1,
          baseCode: "",
          isTranslation: true,
          title: cachedWork.title,
          coverUrl: "",
          circle: cachedWork.circle,
          circleExternalId: cachedWork.circleExternalId,
          releaseDate: cachedWork.releaseDate,
          rating: null,
          sales: null,
          regularPrice: null,
          price: null,
          priceCurrency: "JPY",
          permanentlyFree: false,
          tags: [],
          voiceActors: [],
          voiceCredits: [],
        },
      });
      return;
    }
    if (url.pathname === "/api/circles") {
      count("circles");
      await route.fulfill({
        json: { circles: [cachedCircle], page: 1, pageSize: 24, total: 1, catalogWorks: 1, availableWorks: 1 },
      });
      return;
    }
    if (url.pathname === "/api/circles/RG012345") {
      await route.fulfill({ json: { ...cachedCircle, availableWorks: 1, works: [], series: [] } });
      return;
    }
    if (url.pathname === "/api/voices") {
      count("voices");
      await route.fulfill({ json: { voices: [cachedVoice], page: 1, pageSize: 24, total: 1, tagOptions: [] } });
      return;
    }
    if (url.pathname === "/api/voices/7") {
      await route.fulfill({ json: { ...cachedVoice, aliasRecords: [], works: [], remoteMatches: [] } });
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
            queries: [],
            sources: [],
            error: "",
          },
        },
      });
      return;
    }
    if (url.pathname === "/api/voices/7/merges") {
      await route.fulfill({ json: [] });
      return;
    }
    if (url.pathname === "/api/favorite-lists") {
      count("favorite-lists");
      await route.fulfill({ json: [] });
      return;
    }
    if (url.pathname === "/api/favorite-works") {
      count("favorite-works");
      await route.fulfill({ json: { ...emptyCollection, shelfTotal: 0, listCounts: {}, statusCounts: {} } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: `Not mocked: ${url.pathname}` } });
  });

  return {
    releaseAliasResolution: () => releaseAliasResolution?.(),
  };
}

test("keeps visited browse workspaces mounted for the current user and server", async ({ page }) => {
  const requests: Record<string, number> = {};
  await mockBrowsePages(page, requests);
  await page.goto("/");
  await expect.poll(() => (requests.works ?? 0) > 0).toBe(true);

  await page.getByRole("button", { name: "Circles", exact: true }).click();
  await expect.poll(() => (requests.circles ?? 0) > 0).toBe(true);
  await expect(page).toHaveURL(/\/circles(?:\?|$)/);
  await page.getByRole("button", { name: "Voice Actors", exact: true }).click();
  await expect.poll(() => (requests.voices ?? 0) > 0).toBe(true);
  await expect(page).toHaveURL(/\/voices(?:\?|$)/);
  await page.getByRole("button", { name: "Favorites", exact: true }).click();
  await expect.poll(() => (requests["favorite-works"] ?? 0) > 0).toBe(true);
  await expect(page).toHaveURL(/\/favorites(?:\?|$)/);

  const initialRequests = { ...requests };

  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "Circles", exact: true }).click();
  await page.getByRole("button", { name: "Voice Actors", exact: true }).click();
  await page.getByRole("button", { name: "Favorites", exact: true }).click();

  expect(requests).toMatchObject({
    works: initialRequests.works,
    circles: initialRequests.circles,
    voices: initialRequests.voices,
    "favorite-works": initialRequests["favorite-works"],
  });
});

test("restores cached mobile detail workspaces through bottom navigation history", async ({ page }) => {
  const requests: Record<string, number> = {};
  await mockBrowsePages(page, requests);
  await page.goto("/");

  const libraryTab = page.locator("footer").getByRole("button", { name: "Library", exact: true });
  const circlesTab = page.locator("footer").getByRole("button", { name: "Circles", exact: true });
  const voicesTab = page.locator("footer").getByRole("button", { name: "Voice Actors", exact: true });

  await page.getByTestId("work-card").first().click();
  await expect(page).toHaveURL(/\/RJ00000000(?:\?view=local)?$/);
  await expect(page.getByRole("heading", { name: "Example Work", exact: true })).toBeVisible();

  const historyBeforeCircle = await page.evaluate(() => window.history.length);
  await circlesTab.click();
  await expect(page).toHaveURL(/\/circles(?:\?|$)/);
  await expect.poll(() => page.evaluate((before) => window.history.length > before, historyBeforeCircle)).toBe(true);

  await page.getByRole("button", { name: "Open Example Circle", exact: true }).click();
  await expect(page).toHaveURL(/\/circles\/RG012345$/);
  await expect(page.getByRole("heading", { name: "Example Circle", exact: true })).toBeVisible();

  await voicesTab.click();
  await expect(page).toHaveURL(/\/voices(?:\?|$)/);
  await page.getByRole("button", { name: "Open Example Voice", exact: true }).click();
  await expect(page).toHaveURL(/\/voices\/7$/);
  await expect(page.getByRole("heading", { name: "Example Voice", exact: true })).toBeVisible();

  await libraryTab.click();
  await expect(page).toHaveURL(/\/RJ00000000(?:\?view=local)?$/);
  await expect(page.getByRole("heading", { name: "Example Work", exact: true })).toBeVisible();

  await circlesTab.click();
  await expect(page).toHaveURL(/\/circles\/RG012345$/);
  await expect(page.getByRole("heading", { name: "Example Circle", exact: true })).toBeVisible();

  await voicesTab.click();
  await expect(page).toHaveURL(/\/voices\/7$/);
  await expect(page.getByRole("heading", { name: "Example Voice", exact: true })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/circles\/RG012345$/);
  await expect(page.getByRole("heading", { name: "Example Circle", exact: true })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/RJ00000000(?:\?view=local)?$/);
  await expect(page.getByRole("heading", { name: "Example Work", exact: true })).toBeVisible();
});

test("active mobile tabs return entity details to their browse lists", async ({ page }) => {
  const requests: Record<string, number> = {};
  await mockBrowsePages(page, requests);

  await page.goto("/?q=Example");
  await page.getByTestId("work-card").first().click();
  await expect(page).toHaveURL(/\/RJ00000000(?:\?view=local)?$/);
  await page.locator("footer").getByRole("button", { name: "Library", exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/" && url.searchParams.get("q") === "Example");
  await expect(page.getByRole("button", { name: "Back to library", exact: true })).toHaveCount(0);

  await page.goto("/circles?q=Example");
  await page.getByRole("button", { name: "Open Example Circle", exact: true }).click();
  await expect(page).toHaveURL(/\/circles\/RG012345$/);
  await page.locator("footer").getByRole("button", { name: "Circles", exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/circles" && url.searchParams.get("q") === "Example");
  await expect(page.getByRole("button", { name: "Back to circles", exact: true })).toHaveCount(0);

  await page.goto("/voices?q=Example");
  await page.getByRole("button", { name: "Open Example Voice", exact: true }).click();
  await expect(page).toHaveURL(/\/voices\/7$/);
  await page.locator("footer").getByRole("button", { name: "Voice Actors", exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/voices" && url.searchParams.get("q") === "Example");
  await expect(page.getByRole("button", { name: "Back to voices", exact: true })).toHaveCount(0);
});

test("does not let an inactive Library detail redirect replace another mobile workspace route", async ({ page }) => {
  const requests: Record<string, number> = {};
  const mocks = await mockBrowsePages(page, requests, { deferAliasResolution: true });
  await page.goto("/");
  await expect(page.getByTestId("work-card").first()).toBeVisible();

  await page.evaluate(() => {
    window.history.pushState({}, "", "/RJ00000001");
    window.dispatchEvent(new Event("kikoto:navigation"));
  });
  await expect.poll(() => (requests["alias-resolve"] ?? 0) > 0).toBe(true);

  await page.locator("footer").getByRole("button", { name: "Circles", exact: true }).click();
  await expect(page).toHaveURL(/\/circles(?:\?|$)/);

  mocks.releaseAliasResolution();
  await expect.poll(() => (requests["work-media"] ?? 0) > 0).toBe(true);
  await expect(page).toHaveURL(/\/circles(?:\?|$)/);
});
