import { expect, test, type Page } from "@playwright/test";

import { syntheticWorkCode } from "../../src/test-support/workCode";

const baseWork = {
  id: 1,
  primaryCode: syntheticWorkCode("RJ", 0),
  title: "Favorite work 1",
  ageRating: "R18",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  releaseDate: "2026-01-01",
  coverUrl: "",
  dlsiteUrl: "",
  circle: "Example Circle",
  circleExternalId: "RG09998001",
  rating: 4.5,
  sales: 10,
  tags: ["Example metadata tag"],
  userTags: [{ id: 1, name: "Quiet", color: "" }],
  voiceActors: [],
  voiceCredits: [],
  series: "",
  seriesTitleId: "",
  trackCount: 0,
  availableLocations: 1,
  availability: ["local"],
  sourcePresence: [],
  progress: {
    mediaItemId: null,
    title: "",
    positionSeconds: 0,
    durationSeconds: null,
    lastPlayedAt: null,
    completed: false,
  },
  listeningStatus: "listening",
  favorite: true,
  recommendScore: 0,
};

async function mockFavorites(
  page: Page,
  options: {
    delayedList?: { id: number; started: () => void; gate: Promise<void> };
    sources?: Array<{
      id: number;
      code: string;
      displayName: string;
      sourceType: string;
      enabled: boolean;
      cacheEnabled: boolean;
    }>;
    onFavoriteWorksRequest?: (sourceIDs: number[]) => void;
    interactiveQuickMark?: boolean;
  } = {},
) {
  let savedTags = baseWork.userTags;
  let quickMark = baseWork.listeningStatus;
  const works = Array.from({ length: 24 }, (_, index) => ({
    ...baseWork,
    id: index + 1,
    primaryCode: syntheticWorkCode("RJ", index),
    title: `Favorite work ${index + 1}`,
    userTags: index === 17 ? savedTags : [],
  }));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({
        json: {
          authenticated: true,
          user: {
            id: 1,
            username: "listener",
            displayName: "Listener",
            role: "user",
            permissions: ["library:read", "playback:use", "favorites:write", "tags:write"],
            devMode: true,
          },
        },
      });
      return;
    }
    if (url.pathname === "/api/favorite-lists") {
      await route.fulfill({
        json: [
          { id: 1, name: "Marked", description: "", sortOrder: -1, kind: "marked" },
          { id: 2, name: "Study", description: "", sortOrder: 0, kind: "user" },
        ],
      });
      return;
    }
    if (url.pathname === "/api/favorite-works") {
      options.onFavoriteWorksRequest?.(url.searchParams.getAll("sourceId").map(Number));
      if (url.searchParams.get("listId") === String(options.delayedList?.id)) {
        options.delayedList.started();
        await options.delayedList.gate;
      }
      await route.fulfill({
        json: {
          works:
            options.interactiveQuickMark && quickMark === "none"
              ? []
              : works.map((work) => ({ ...work, listeningStatus: quickMark })),
          page: Number(url.searchParams.get("page") ?? 1),
          pageSize: 24,
          total: options.interactiveQuickMark && quickMark === "none" ? 0 : 48,
          shelfTotal: options.interactiveQuickMark && quickMark === "none" ? 0 : 48,
          listCounts: { "1": options.interactiveQuickMark && quickMark === "none" ? 0 : 24, "2": 24 },
          statusCounts: quickMark === "none" ? {} : { [quickMark]: 48 },
        },
      });
      return;
    }
    if (url.pathname === "/api/circles") {
      await route.fulfill({
        json: { circles: [], page: 1, pageSize: 100, total: 0, catalogWorks: 0, availableWorks: 0 },
      });
      return;
    }
    if (url.pathname === "/api/voices") {
      await route.fulfill({ json: { voices: [], page: 1, pageSize: 100, total: 0, tagOptions: [] } });
      return;
    }
    if (url.pathname === "/api/library-sources") {
      await route.fulfill({ json: options.sources ?? [] });
      return;
    }
    if (url.pathname === "/api/runtime-settings") {
      await route.fulfill({ json: { cacheEnabled: false, directoryRoutingRules: [] } });
      return;
    }
    if (url.pathname === "/api/works") {
      await route.fulfill({ json: { works, page: 1, pageSize: 24, total: works.length } });
      return;
    }
    const detailMatch = url.pathname.match(/^\/api\/works\/(\d+)$/);
    if (detailMatch) {
      const id = Number(detailMatch[1]);
      const work = works.find((item) => item.id === id) ?? works[0];
      await route.fulfill({
        json: {
          ...work,
          userTags: id === 18 ? savedTags : work.userTags,
          baseCode: "",
          metadataLanguage: "JPN",
          workType: "audio",
          titleKana: "",
          description: "",
          ageRating: "",
          durationSeconds: null,
          dlsiteFetchedAt: "",
          translations: [],
          manualOverrides: {},
          mediaItems: [],
        },
      });
      return;
    }
    const tagsMatch = url.pathname.match(/^\/api\/works\/(\d+)\/tags$/);
    if (tagsMatch && request.method() === "PUT") {
      const body = request.postDataJSON() as { tags: string[] };
      savedTags = body.tags.map((name, index) => ({ id: index + 10, name, color: "" }));
      await route.fulfill({ json: { workId: Number(tagsMatch[1]), userTags: savedTags } });
      return;
    }
    if (/^\/api\/works\/\d+\/media$/.test(url.pathname)) {
      await route.fulfill({ json: { workId: 18, mediaItems: [] } });
      return;
    }
    if (/^\/api\/works\/\d+\/favorite-lists$/.test(url.pathname)) {
      await route.fulfill({
        json: [
          { id: 1, name: "Marked", description: "", sortOrder: -1, kind: "marked", selected: true },
          { id: 2, name: "Study", description: "", sortOrder: 0, kind: "user", selected: true },
        ],
      });
      return;
    }
    if (/^\/api\/works\/\d+\/user-state$/.test(url.pathname) && request.method() === "PATCH") {
      const body = request.postDataJSON() as { listeningStatus?: string };
      quickMark = body.listeningStatus ?? quickMark;
      await route.fulfill({ json: { workId: 1, listeningStatus: quickMark, favorite: false } });
      return;
    }
    if (/^\/api\/works\/[^/]+\/source-availability$/.test(url.pathname)) {
      await route.fulfill({ json: { workCode: "RJ00000017", checkedAt: "", sources: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: `Not mocked: ${url.pathname}` } });
  });
}

test("desktop favorites keeps type and search left with work controls on the right", async ({ page }) => {
  await mockFavorites(page, {
    sources: [
      {
        id: 11,
        code: "example_remote_a",
        displayName: "Example Remote A",
        sourceType: "kikoeru_compatible",
        enabled: true,
        cacheEnabled: true,
      },
    ],
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/favorites");

  const type = page.getByRole("button", { name: "Favorite type: Works" });
  const search = page.getByPlaceholder("Search title, code, circle, tag, or creator");
  const resource = page.getByRole("button", { name: "Resource: Any available" });
  await expect(type).toBeVisible();
  await expect(search).toBeVisible();
  await expect(resource).toBeVisible();
  await expect(page.getByRole("button", { name: "Sort favorite works: Marked or added" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Columns: Auto" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Items per page: 24" })).toBeVisible();
  const searchBox = await search.boundingBox();
  const resourceBox = await resource.boundingBox();
  expect(searchBox).not.toBeNull();
  expect(resourceBox).not.toBeNull();
  expect(searchBox!.x + searchBox!.width).toBeLessThanOrEqual(resourceBox!.x);

  await resource.click();
  await page.getByRole("menuitemradio", { name: "Example Remote A" }).click();
  await expect.poll(() => page.evaluate(() => window.history.state?.favoritesBrowseState?.availability)).toBe("remote");
  await expect.poll(() => page.evaluate(() => window.history.state?.favoritesBrowseState?.sourceIDs)).toEqual([11]);

  await page.getByRole("button", { name: "Favorite list options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit lists", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Edit favorite lists" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Rename Study" })).toBeVisible();

  await page.getByRole("button", { name: "Close favorite list editor" }).click();
  await type.click();
  await page.getByRole("menuitemradio", { name: "Circles" }).click();
  await expect(page.getByPlaceholder("Search circles")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Resource:/ })).toHaveCount(0);
});

test("favorites detail uses Library Up navigation while the Favorites tab restores browse state", async ({ page }) => {
  await mockFavorites(page);
  await page.goto(
    "/favorites?entity=works&status=listening&availability=local&list=2&page=2&pageSize=24&sort=sales&direction=asc&seed=314159",
  );
  await expect(page.getByRole("button", { name: /Study/ })).toHaveAttribute("class", /bg-primary/);
  await page.getByRole("button", { name: "More favorite options" }).click();
  await expect(page.getByRole("menuitem", { name: "Sort Sales" })).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Selection mode Off" }).click();
  await page.locator('[aria-label="Select work"]').nth(17).click();
  const target = page.getByText("Favorite work 18", { exact: true });
  await target.scrollIntoViewIfNeeded();
  const savedScroll = await page.evaluate(() => window.scrollY);
  expect(savedScroll).toBeGreaterThan(500);
  await target.click();

  await expect(page).toHaveURL(/RJ00000017/);
  await page.getByRole("button", { name: "Info", exact: true }).click();
  await expect(page.getByText("My tags", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add tag" }).click();
  await page.getByPlaceholder("tag1, tag2").fill("Night, Focus");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Night", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Back to library" }).click();
  await expect(page).toHaveURL(/^http:\/\/[^/]+\/(?:\?.*)?$/);
  await page.locator("footer").getByRole("button", { name: "Favorites", exact: true }).click();
  await expect(page).toHaveURL(/\/favorites$/);
  await expect(page.getByRole("button", { name: "More favorite options" })).toHaveAttribute(
    "data-favorite-sort",
    "sales",
  );
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(savedScroll - 100);
  const params = new URL(page.url()).searchParams;
  expect(params.size).toBe(0);
  const restoredState = await page.evaluate(() => window.history.state?.favoritesBrowseState);
  expect(restoredState).toEqual(
    expect.objectContaining({
      entity: "works",
      status: "listening",
      availability: "local",
      list: 2,
      page: 2,
      pageSize: 24,
      sort: "sales",
      direction: "asc",
      randomSeed: 314159,
    }),
  );
});

test("switching favorite lists keeps the entire playlist row stable while works load", async ({ page }) => {
  let releaseListRequest = () => undefined;
  const listRequestGate = new Promise<void>((resolve) => {
    releaseListRequest = resolve;
  });
  let markListRequestStarted = () => undefined;
  const listRequestStarted = new Promise<void>((resolve) => {
    markListRequestStarted = resolve;
  });
  await mockFavorites(page, { delayedList: { id: 2, started: markListRequestStarted, gate: listRequestGate } });
  await page.goto("/favorites");

  const playlistButtons = [
    page.getByRole("button", { name: /All Favorites/ }),
    page.getByRole("button", { name: /Marked 24/ }),
    page.getByRole("button", { name: /Study 24/ }),
    page.getByRole("button", { name: "Favorite list options", exact: true }),
  ];
  await expect(playlistButtons[0]).toBeVisible();
  await expect(page.getByText("Favorite work 1", { exact: true })).toBeVisible();
  await playlistButtons[3].click();
  await expect(page.getByRole("menuitem", { name: "New list", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  // Normalize horizontal scroll before measuring; click() may reveal a partially clipped tab.
  await playlistButtons[2].scrollIntoViewIfNeeded();
  const positionsBefore = await Promise.all(playlistButtons.map((button) => button.boundingBox()));
  const worksRegionBefore = await page.locator('[data-favorite-work-id="1"]').boundingBox();

  await playlistButtons[2].click();
  await listRequestStarted;
  await expect(playlistButtons[2]).toHaveClass(/bg-primary/);
  await expect(page.getByText("Favorite work 1", { exact: true })).toBeVisible();
  await expect(page.getByRole("status", { name: "Loading favorite works" })).toHaveCount(0);
  for (const button of playlistButtons) await expect(button).toBeVisible();
  const positionsWhileLoading = await Promise.all(playlistButtons.map((button) => button.boundingBox()));
  const worksRegionWhileLoading = await page.locator('[data-favorite-work-id="1"]').boundingBox();
  expect(positionsWhileLoading).toEqual(positionsBefore);
  expect(worksRegionWhileLoading).toEqual(worksRegionBefore);

  releaseListRequest();
  await expect(page.getByText("Favorite work 1", { exact: true })).toBeVisible();
});

test("unmarking a work refreshes All Favorites and removes it immediately", async ({ page }) => {
  await mockFavorites(page, { interactiveQuickMark: true });
  await page.goto("/favorites");

  await expect(page.getByText("Favorite work 1", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Mark: Listening" }).first().click();
  await page.getByRole("button", { name: "Unmarked" }).click();

  await expect(page.getByText("Favorite work 1", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "No favorite works yet" })).toBeVisible();
  await expect(page.getByRole("button", { name: /All Favorites 0/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Marked 0/ })).toBeVisible();
});

test("filters favorites by any selected file source and keeps the selection out of the canonical URL", async ({
  page,
}) => {
  const sourceRequests: number[][] = [];
  await mockFavorites(page, {
    sources: [
      {
        id: 11,
        code: "example_remote_a",
        displayName: "Example Remote A",
        sourceType: "kikoeru_compatible",
        enabled: true,
        cacheEnabled: true,
      },
      {
        id: 12,
        code: "example_remote_b",
        displayName: "Example Remote B",
        sourceType: "kikoeru_compatible",
        enabled: false,
        cacheEnabled: false,
      },
    ],
    onFavoriteWorksRequest: (sourceIDs) => sourceRequests.push(sourceIDs),
  });
  await page.goto("/favorites");

  await page.getByRole("button", { name: "More favorite options" }).click();
  await page.getByRole("menuitem", { name: /Sources All sources/ }).click();
  await page.getByRole("menuitemcheckbox", { name: /Example Remote A/ }).click();
  await expect.poll(() => sourceRequests.at(-1)).toEqual([11]);
  await page.getByRole("menuitemcheckbox", { name: /Example Remote B/ }).click();
  await expect.poll(() => sourceRequests.at(-1)).toEqual([11, 12]);

  expect(new URL(page.url()).searchParams.size).toBe(0);
  await expect.poll(() => page.evaluate(() => window.history.state?.favoritesBrowseState?.sourceIDs)).toEqual([11, 12]);

  await page.getByRole("button", { name: "Back to more options" }).click();
  await expect(page.getByRole("menuitem", { name: /Sources 2 sources/ })).toBeVisible();
  await page.getByRole("menuitem", { name: "Clear filters", exact: true }).click();
  await expect.poll(() => sourceRequests.at(-1)).toEqual([]);
});
