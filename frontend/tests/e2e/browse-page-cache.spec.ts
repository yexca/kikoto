import { expect, test, type Page } from "@playwright/test";

import type {
  CircleSummary,
  FavoriteList,
  FavoriteWorksPage,
  LibrarySource,
  RecentlyPlayedWorksResponse,
  VoiceMergeReview,
  Work,
} from "../../src/lib/api";
import { syntheticWorkCode } from "../../src/test-support/workCode";
import {
  appUpdateFixture,
  authenticatedStateFixture,
  circleCatalogWorkFixture,
  circleDetailFixture,
  circleSummaryFixture,
  circleSummaryPageFixture,
  runtimeSettingsFixture,
  voiceCatalogRefreshFixture,
  voiceDetailFixture,
  voiceKnownWorkFixture,
  voiceSummaryFixture,
  voiceSummaryPageFixture,
  workDetailFixture,
  workFixture,
  workResolveFixture,
  worksPageFixture,
  type ApiErrorBody,
  type ApiResponse,
} from "./fixtures/api";

const cachedWork = workFixture({
  primaryCode: "RJ00000000",
  title: "Example Work",
  releaseDate: "2026-01-01",
  circle: "Example Circle",
  circleExternalId: "RG012345",
  priceCurrency: "JPY",
  permanentlyFree: false,
});

const cachedCircle = circleSummaryFixture({
  externalId: "RG012345",
  displayName: "Example Circle",
  localWorks: 1,
  playableWorks: 1,
  catalogWorks: 1,
  lastSyncedAt: "2026-01-01T00:00:00Z",
});

const cachedVoice = voiceSummaryFixture({
  personId: 7,
  displayName: "Example Voice",
  knownWorks: 1,
  localWorks: 1,
  playableWorks: 1,
  lastSeenAt: "2026-01-01T00:00:00Z",
  lastSyncedAt: "2026-01-01T00:00:00Z",
});

type BrowsePageMockOptions = {
  deferAliasResolution?: boolean;
  deferWorks?: boolean;
  collectionSize?: number;
  favoriteWorks?: boolean;
};

function collectionWorks(size: number): Work[] {
  if (size <= 1) return [cachedWork];
  return Array.from({ length: size }, (_, index) => ({
    ...cachedWork,
    id: index + 1,
    primaryCode: syntheticWorkCode("RJ", index + 1),
    title: `Example Work ${index + 1}`,
  }));
}

function collectionCircles(size: number): CircleSummary[] {
  if (size <= 1) return [cachedCircle];
  return Array.from({ length: size }, (_, index) => ({
    ...cachedCircle,
    id: index + 1,
    externalId: `RG${String(index + 1).padStart(6, "0")}`,
    displayName: `Example Circle ${index + 1}`,
  }));
}

async function mockBrowsePages(page: Page, requests: Record<string, number>, options: BrowsePageMockOptions = {}) {
  let releaseWorks: (() => void) | null = null;
  const worksGate = options.deferWorks
    ? new Promise<void>((resolve) => {
        releaseWorks = resolve;
      })
    : null;
  let releaseAliasResolution: (() => void) | null = null;
  let settleAliasResolution: (() => void) | null = null;
  const aliasResolution = options.deferAliasResolution
    ? new Promise<void>((resolve) => {
        releaseAliasResolution = resolve;
      })
    : null;
  const aliasResolutionSettled = options.deferAliasResolution
    ? new Promise<void>((resolve) => {
        settleAliasResolution = resolve;
      })
    : Promise.resolve();
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const count = (key: string) => {
      requests[key] = (requests[key] ?? 0) + 1;
    };
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({
        json: authenticatedStateFixture({ permissions: ["library:read", "favorites:write"], devMode: true }),
      });
      return;
    }
    if (url.pathname === "/api/runtime-settings") {
      await route.fulfill({ json: runtimeSettingsFixture({ anonymousAccessEnabled: false }) });
      return;
    }
    if (url.pathname === "/api/app-update") {
      await route.fulfill({ json: appUpdateFixture("v0.4.1") });
      return;
    }
    if (url.pathname === "/api/library-sources") {
      count("library-sources");
      await route.fulfill({ json: [] satisfies LibrarySource[] });
      return;
    }
    if (url.pathname === "/api/recently-played-works") {
      count("recently-played");
      await route.fulfill({ json: { works: [] } satisfies RecentlyPlayedWorksResponse });
      return;
    }
    if (url.pathname === "/api/works") {
      count("works");
      await worksGate;
      const works = collectionWorks(options.collectionSize ?? 1);
      const workPage = Number(url.searchParams.get("page")) || 1;
      const pageSize = Number(url.searchParams.get("pageSize")) || 24;
      await route.fulfill({
        json: worksPageFixture(works.slice((workPage - 1) * pageSize, workPage * pageSize), {
          page: workPage,
          pageSize,
          total: works.length,
        }),
      });
      return;
    }
    if (url.pathname === "/api/works/1") {
      await route.fulfill({ json: workDetailFixture(cachedWork) });
      return;
    }
    if (url.pathname === "/api/works/1/media") {
      count("work-media");
      await route.fulfill({
        json: { workId: 1, mediaWorkId: 1, mediaItems: [] } satisfies ApiResponse<"getWorkMedia">,
      });
      return;
    }
    if (url.pathname === "/api/works/RJ00000000/resolve") {
      await route.fulfill({ json: workResolveFixture(cachedWork) });
      return;
    }
    if (url.pathname === "/api/works/RJ00000001/resolve") {
      count("alias-resolve");
      await aliasResolution;
      try {
        await route.fulfill({
          json: workResolveFixture(cachedWork, { requestedCode: "RJ00000001", isTranslation: true }),
        });
      } finally {
        settleAliasResolution?.();
      }
      return;
    }
    if (url.pathname === "/api/circles") {
      count("circles");
      await route.fulfill({
        json: circleSummaryPageFixture(collectionCircles(options.collectionSize ?? 1), {
          catalogWorks: 1,
          availableWorks: 1,
        }),
      });
      return;
    }
    if (url.pathname === "/api/circles/RG012345") {
      await route.fulfill({
        json: circleDetailFixture(cachedCircle, {
          availableWorks: 1,
          works: [
            circleCatalogWorkFixture({
              primaryCode: cachedWork.primaryCode,
              workId: cachedWork.id,
              title: cachedWork.title,
              circle: cachedWork.circle,
              circleExternalId: cachedCircle.externalId,
              local: true,
              catalogStatus: "imported",
            }),
          ],
        }),
      });
      return;
    }
    if (url.pathname === "/api/voices") {
      count("voices");
      await route.fulfill({ json: voiceSummaryPageFixture([cachedVoice]) });
      return;
    }
    if (url.pathname === "/api/voices/7") {
      await route.fulfill({ json: voiceDetailFixture(cachedVoice) });
      return;
    }
    if (url.pathname === "/api/voices/7/works") {
      await route.fulfill({
        json: {
          personId: 7,
          works: [
            voiceKnownWorkFixture({
              primaryCode: cachedWork.primaryCode,
              workId: cachedWork.id,
              title: cachedWork.title,
              circle: cachedWork.circle,
              circleExternalId: cachedCircle.externalId,
              local: true,
            }),
          ],
        } satisfies ApiResponse<"getVoiceWorks">,
      });
      return;
    }
    if (url.pathname === "/api/voices/7/remote-matches") {
      await route.fulfill({
        json: {
          personId: 7,
          remoteMatches: [],
          refresh: voiceCatalogRefreshFixture(),
        } satisfies ApiResponse<"getVoiceRemoteMatches">,
      });
      return;
    }
    if (url.pathname === "/api/voices/7/merges") {
      await route.fulfill({ json: [] satisfies VoiceMergeReview[] });
      return;
    }
    if (url.pathname === "/api/favorite-lists") {
      count("favorite-lists");
      await route.fulfill({ json: [] satisfies FavoriteList[] });
      return;
    }
    if (url.pathname === "/api/favorite-works") {
      count("favorite-works");
      const works = options.favoriteWorks ? collectionWorks(options.collectionSize ?? 1) : [];
      const workPage = Number(url.searchParams.get("page")) || 1;
      const pageSize = Number(url.searchParams.get("pageSize")) || 24;
      await route.fulfill({
        json: {
          ...worksPageFixture(works.slice((workPage - 1) * pageSize, workPage * pageSize), {
            page: workPage,
            pageSize,
            total: works.length,
          }),
          shelfTotal: works.length,
          listCounts: {},
          statusCounts: {},
        } satisfies FavoriteWorksPage,
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: `Not mocked: ${url.pathname}` } satisfies ApiErrorBody });
  });

  return {
    releaseWorks: () => releaseWorks?.(),
    releaseAliasResolution: () => releaseAliasResolution?.(),
    waitForAliasResolution: () => aliasResolutionSettled,
  };
}

test("@desktop keeps visited browse workspaces mounted for the current user and server", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
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

test("opening a library detail preserves its search, rendered cards, and loaded results", async ({ page }) => {
  const requests: Record<string, number> = {};
  await mockBrowsePages(page, requests);
  await page.goto("/?q=Example");
  const card = page.getByTestId("work-card").first();
  await expect(card).toBeVisible();
  await card.evaluate((element) => element.setAttribute("data-retention-probe", "library-detail"));
  const initialRequests = { ...requests };

  await card.click();
  await expect(page.getByRole("heading", { name: "Example Work", exact: true })).toBeVisible();
  await expect(page.locator('[data-retention-probe="library-detail"]')).toHaveCount(1);
  await expect(page.getByPlaceholder("Search title, code, circle, tag, or creator")).toHaveValue("Example");
  await page.goBack();

  await expect(page).toHaveURL(/\/\?q=Example$/);
  await expect(card).toBeVisible();
  expect(requests.works).toBe(initialRequests.works);
});

for (const creator of [
  { path: "/circles", name: "Example Circle", back: "Back to circles", request: "circles" },
  { path: "/voices", name: "Example Voice", back: "Back to voices", request: "voices" },
]) {
  test(`returning from ${creator.path} detail reuses the filtered list and its rendered cards`, async ({ page }) => {
    const requests: Record<string, number> = {};
    await mockBrowsePages(page, requests);
    await page.goto(`${creator.path}?q=Example&filter=favorite`);
    const open = page.getByRole("button", { name: `Open ${creator.name}`, exact: true });
    await expect(open).toBeVisible();
    await open.evaluate((element) => element.setAttribute("data-retention-probe", "creator-detail"));
    const initialRequests = requests[creator.request];
    await open.click();
    await expect(page.getByRole("heading", { name: creator.name, exact: true })).toBeVisible();
    await expect(page.locator('[data-retention-probe="creator-detail"]')).toHaveCount(1);
    await page.getByRole("button", { name: creator.back, exact: true }).click();

    await expect(page).toHaveURL(
      (url) =>
        url.pathname === creator.path &&
        url.searchParams.get("q") === "Example" &&
        url.searchParams.get("filter") === "favorite",
    );
    await expect(open).toBeVisible();
    expect(requests[creator.request]).toBe(initialRequests);
  });
}

test("mobile detail Back restores the favorites entry that opened it", async ({ page }) => {
  const requests: Record<string, number> = {};
  await mockBrowsePages(page, requests, { favoriteWorks: true });
  await page.goto("/favorites?q=Example");
  await expect(page.getByTestId("work-card").first()).toBeVisible();
  const initialRequests = requests["favorite-works"];
  await page.getByTestId("work-card").first().click();
  await expect(page.getByRole("heading", { name: "Example Work", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to favorites", exact: true }).click();
  await expect(page).toHaveURL(/\/favorites\?q=Example$/);
  await expect(page.getByTestId("work-card").first()).toBeVisible();
  expect(requests["favorite-works"]).toBe(initialRequests);
});

for (const workspace of [
  { path: "/", field: "libraryBrowseState" },
  { path: "/favorites", field: "favoritesBrowseState" },
]) {
  test(`browser history restores ${workspace.field} instead of newer session controls`, async ({ page }) => {
    const requests: Record<string, number> = {};
    await mockBrowsePages(page, requests, { collectionSize: 48, favoriteWorks: true });
    await page.goto(`${workspace.path}?q=Example`);
    await expect(page.getByTestId("work-card")).toHaveCount(24);
    const original = await page.evaluate((field) => window.history.state[field], workspace.field);
    await page.evaluate(({ path, field }) => {
      window.history.pushState(
        {
          ...window.history.state,
          [field]: {
            ...window.history.state[field],
            query: "Later",
            page: 2,
            status: "finished",
            sort: "title",
            direction: "asc",
          },
        },
        "",
        `${path}?q=Later`,
      );
      window.dispatchEvent(new Event("kikoto:navigation"));
    }, workspace);
    await expect.poll(() => page.evaluate((field) => window.history.state[field]?.page, workspace.field)).toBe(2);
    await expect(page.getByTestId("work-card").first()).toContainText("Example Work 25");
    await page.goBack();
    await expect(page).toHaveURL((url) => url.pathname === workspace.path && url.searchParams.get("q") === "Example");
    await expect
      .poll(() => page.evaluate((field) => window.history.state[field], workspace.field))
      .toEqual(
        expect.objectContaining({
          query: "Example",
          page: 1,
          status: original.status,
          sort: original.sort,
          direction: original.direction,
          randomSeed: original.randomSeed,
        }),
      );
    await expect(page.getByTestId("work-card").first()).toContainText("Example Work 1");
    await page.goForward();
    await expect
      .poll(() => page.evaluate((field) => window.history.state[field], workspace.field))
      .toEqual(
        expect.objectContaining({ query: "Later", page: 2, status: "finished", sort: "title", direction: "asc" }),
      );
    await expect(page.getByTestId("work-card").first()).toContainText("Example Work 25");
  });
}

for (const cancel of [false, true]) {
  test(`slow list restoration ${cancel ? "yields to user scrolling" : "waits for loaded content"}`, async ({
    page,
  }) => {
    const requests: Record<string, number> = {};
    await page.addInitScript(() => {
      window.history.replaceState({ __kikotoScrollY: 1800 }, "", window.location.href);
    });
    const mocks = await mockBrowsePages(page, requests, { collectionSize: 24, deferWorks: true });
    await page.goto("/");
    await expect.poll(() => requests.works ?? 0).toBeGreaterThan(0);
    // Keep the response pending beyond the former 500 ms retry window.
    await page.waitForTimeout(800);
    await expect.poll(() => page.evaluate(() => window.history.state.__kikotoScrollY)).toBe(1800);
    if (cancel) await page.mouse.wheel(0, -300);
    const userScroll = await page.evaluate(() => window.scrollY);
    mocks.releaseWorks();
    await expect(page.getByTestId("work-card")).toHaveCount(24);
    if (cancel) {
      const samples = await page.evaluate(async () => {
        const positions: number[] = [];
        for (let frame = 0; frame < 35; frame += 1) {
          await new Promise((resolve) => window.requestAnimationFrame(resolve));
          positions.push(window.scrollY);
        }
        return positions;
      });
      expect(Math.max(...samples)).toBeLessThanOrEqual(userScroll + 1);
    } else {
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(1800);
    }
  });
}

test("same-URL history entries keep independent positions when a scroll write is pending", async ({ page }) => {
  const requests: Record<string, number> = {};
  await page.addInitScript(() => {
    Reflect.deleteProperty(Object.getPrototypeOf(window.crypto), "randomUUID");
  });
  await mockBrowsePages(page, requests, { collectionSize: 24 });
  await page.goto("/");
  await expect(page.getByTestId("work-card")).toHaveCount(24);
  const initialRequests = requests.works;
  await page.evaluate(async () => {
    window.scrollTo({ top: 1800, behavior: "auto" });
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    window.history.pushState({}, "", "/");
    window.dispatchEvent(new Event("kikoto:navigation"));
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  // Let any trailing scroll write run before traversing identical locations.
  await page.waitForTimeout(200);
  await page.goBack();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(1800);
  await page.goForward();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  expect(requests.works).toBe(initialRequests);
});

test("keeps every visited browse workspace mounted on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const requests: Record<string, number> = {};
  await mockBrowsePages(page, requests);
  await page.goto("/");
  await expect.poll(() => (requests.works ?? 0) > 0).toBe(true);

  const tabs = page.locator("footer");
  await tabs.getByRole("button", { name: "Circles", exact: true }).click();
  await expect.poll(() => (requests.circles ?? 0) > 0).toBe(true);
  await tabs.getByRole("button", { name: "Voice Actors", exact: true }).click();
  await expect.poll(() => (requests.voices ?? 0) > 0).toBe(true);
  await tabs.getByRole("button", { name: "Favorites", exact: true }).click();
  await expect.poll(() => (requests["favorite-works"] ?? 0) > 0).toBe(true);
  await expect(page.locator("[data-browse-page]")).toHaveCount(4);

  const initialRequests = { ...requests };
  await tabs.getByRole("button", { name: "Library", exact: true }).click();
  await tabs.getByRole("button", { name: "Circles", exact: true }).click();
  await tabs.getByRole("button", { name: "Voice Actors", exact: true }).click();
  await tabs.getByRole("button", { name: "Circles", exact: true }).click();

  await expect(page.locator("[data-browse-page]")).toHaveCount(4);
  expect(requests).toMatchObject({
    works: initialRequests.works,
    circles: initialRequests.circles,
    voices: initialRequests.voices,
    "favorite-works": initialRequests["favorite-works"],
  });
});

async function switchMobileTabAndSampleScroll(page: Page, name: string) {
  return page.evaluate(async (label) => {
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>("footer button")).find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (!button) throw new Error(`Missing bottom navigation button: ${label}`);
    const samples: number[] = [];
    button.click();
    for (let frame = 0; frame < 45; frame += 1) {
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
      samples.push(Math.round(window.scrollY));
    }
    return samples;
  }, name);
}

test("resumes a retained mobile workspace at its scroll offset from the first frame", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const requests: Record<string, number> = {};
  await mockBrowsePages(page, requests, { collectionSize: 24 });
  await page.goto("/");
  await expect(page.getByTestId("work-card")).toHaveCount(24);
  await page.evaluate(() => window.scrollTo({ top: 1800, behavior: "auto" }));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(1800);

  await page.locator("footer").getByRole("button", { name: "Circles", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open Example Circle 24", exact: true })).toBeVisible();
  await page.evaluate(() => window.scrollTo({ top: 900, behavior: "auto" }));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(900);
  const initialRequests = { ...requests };
  // A retained workspace keeps its rendered cards rather than rebuilding them on return.
  await page.evaluate(() => {
    const card = document.querySelector('[data-browse-page="library"] [data-testid="work-card"]');
    if (card) card.setAttribute("data-retention-probe", "library");
  });

  expect(await switchMobileTabAndSampleScroll(page, "Library")).toEqual(Array(45).fill(1800));
  await expect(page.locator('[data-retention-probe="library"]')).toHaveCount(1);
  expect(await switchMobileTabAndSampleScroll(page, "Circles")).toEqual(Array(45).fill(900));
  expect(requests).toMatchObject({ works: initialRequests.works, circles: initialRequests.circles });
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

for (const creator of [
  { path: "/circles", tab: "Circles", name: "Example Circle", detail: "/circles/RG012345", back: "Back to circle" },
  { path: "/voices", tab: "Voice Actors", name: "Example Voice", detail: "/voices/7", back: "Back to voices" },
]) {
  for (const desktop of [false, true]) {
    test(`${desktop ? "@desktop " : ""}nested creator works keep Library reachable from ${creator.path}`, async ({
      page,
    }) => {
      if (desktop) await page.setViewportSize({ width: 1280, height: 800 });
      const requests: Record<string, number> = {};
      await mockBrowsePages(page, requests);
      await page.goto("/?q=Example");
      await expect(page.getByTestId("work-card").first()).toBeVisible();
      const libraryRequests = requests.works;
      const navigation = desktop ? page.getByRole("complementary") : page.locator("footer");
      await navigation.getByRole("button", { name: creator.tab, exact: true }).click();
      await page.getByRole("button", { name: `Open ${creator.name}`, exact: true }).click();
      await expect(page).toHaveURL((url) => url.pathname === creator.detail);
      await page.getByRole("heading", { name: "Example Work", exact: true }).click();
      await expect(page).toHaveURL((url) => url.pathname === "/RJ00000000" && !url.searchParams.has("q"));
      if (!desktop) {
        await navigation.getByRole("button", { name: "Library", exact: true }).click();
        await expect(page).toHaveURL((url) => url.pathname === "/" && url.searchParams.get("q") === "Example");
        await navigation.getByRole("button", { name: creator.tab, exact: true }).click();
        await expect(page).toHaveURL((url) => url.pathname === creator.detail);
        await page.getByRole("heading", { name: "Example Work", exact: true }).click();
        await expect(page).toHaveURL((url) => url.pathname === "/RJ00000000" && !url.searchParams.has("q"));
      }
      await page.getByRole("main").getByRole("button", { name: creator.back, exact: true }).click();
      await expect(page).toHaveURL((url) => url.pathname === creator.detail);

      await navigation.getByRole("button", { name: "Library", exact: true }).click();
      await expect(page).toHaveURL((url) => url.pathname === "/" && url.searchParams.get("q") === "Example");
      await expect(page.getByTestId("work-card").first()).toBeVisible();
      expect(requests.works).toBe(libraryRequests);
    });
  }

  test(`nested creator works preserve Library's own open detail from ${creator.path}`, async ({ page }) => {
    const requests: Record<string, number> = {};
    await mockBrowsePages(page, requests);
    await page.goto("/?q=Example");
    await page.getByTestId("work-card").first().click();
    await expect(page).toHaveURL((url) => url.pathname === "/RJ00000000" && url.searchParams.get("view") === "local");
    const libraryRequests = requests.works;
    const navigation = page.locator("footer");
    await navigation.getByRole("button", { name: creator.tab, exact: true }).click();
    await page.getByRole("button", { name: `Open ${creator.name}`, exact: true }).click();
    await page.getByRole("heading", { name: "Example Work", exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === "/RJ00000000" && url.searchParams.size === 0);
    await page.getByRole("main").getByRole("button", { name: creator.back, exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === creator.detail);

    await navigation.getByRole("button", { name: "Library", exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === "/RJ00000000" && url.searchParams.get("view") === "local");
    await page.getByRole("main").getByRole("button", { name: "Library", exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === "/" && url.searchParams.get("q") === "Example");
    await expect(page.getByTestId("work-card").first()).toBeVisible();
    expect(requests.works).toBe(libraryRequests);
  });
}

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
  await mocks.waitForAliasResolution();
  expect(requests["work-media"] ?? 0).toBe(0);
  await expect(page).toHaveURL(/\/circles(?:\?|$)/);
});
