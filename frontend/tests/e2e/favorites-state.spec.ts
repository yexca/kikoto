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
    }>;
    onFavoriteWorksRequest?: (sourceIDs: number[]) => void;
    interactiveQuickMark?: boolean;
  } = {},
) {
  let savedTags = baseWork.userTags;
  let quickMark = baseWork.listeningStatus;
  let favoriteLists = [
    { id: 1, name: "Marked", description: "", sortOrder: -1, kind: "marked" as const },
    { id: 2, name: "Study", description: "", sortOrder: 0, kind: "user" as const },
  ];
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
    if (url.pathname === "/api/favorite-lists" && request.method() === "GET") {
      await route.fulfill({ json: favoriteLists });
      return;
    }
    if (url.pathname === "/api/favorite-lists" && request.method() === "POST") {
      const body = request.postDataJSON() as { name: string; description?: string };
      const list = {
        id: Math.max(...favoriteLists.map((item) => item.id)) + 1,
        name: body.name,
        description: body.description ?? "",
        sortOrder: favoriteLists.filter((item) => item.kind === "user").length,
        kind: "user" as const,
      };
      favoriteLists = [...favoriteLists, list];
      await route.fulfill({ json: list });
      return;
    }
    const favoriteListMatch = url.pathname.match(/^\/api\/favorite-lists\/(\d+)$/);
    if (favoriteListMatch && request.method() === "PATCH") {
      const id = Number(favoriteListMatch[1]);
      const body = request.postDataJSON() as { name?: string; description?: string; sortOrder?: number };
      favoriteLists = favoriteLists.map((list) => (list.id === id ? { ...list, ...body } : list));
      await route.fulfill({ json: favoriteLists.find((list) => list.id === id) });
      return;
    }
    if (favoriteListMatch && request.method() === "DELETE") {
      const id = Number(favoriteListMatch[1]);
      favoriteLists = favoriteLists.filter((list) => list.id !== id);
      await route.fulfill({ json: { ok: true, deleted: id } });
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
      await route.fulfill({
        json: {
          mode: "development",
          demoMode: false,
          anonymousAccessEnabled: false,
          cacheEnabled: false,
          directoryRoutingRules: [],
        },
      });
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
  const desktopListTab = page.getByRole("button", { name: /All Favorites/ });
  const desktopListTabBox = await desktopListTab.boundingBox();
  expect(desktopListTabBox).not.toBeNull();
  expect(desktopListTabBox!.height).toBe(32);
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
  const listManager = page.getByRole("dialog", { name: "Edit favorite lists" });
  await expect(listManager).toBeVisible();
  await expect(listManager.getByRole("button", { name: "Rename Study" })).toBeVisible();

  await listManager.getByRole("button", { name: "Rename Study" }).click();
  const renameForm = listManager.getByRole("form", { name: "Rename Study" });
  await expect(renameForm).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await renameForm.getByLabel("Name").fill("Focus");
  await renameForm.getByLabel("Description").fill("Deep listening");
  await renameForm.getByRole("button", { name: "Save", exact: true }).click();
  await expect(listManager.getByRole("button", { name: "Rename Focus" })).toBeVisible();

  await listManager.getByRole("button", { name: "Add list", exact: true }).click();
  const addForm = listManager.getByRole("form", { name: "Add favorite list" });
  await expect(addForm).toBeVisible();
  await expect(listManager.getByRole("listitem").last().getByRole("form", { name: "Add favorite list" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await addForm.getByLabel("Name").fill("Example List");
  await addForm.getByLabel("Description").fill("Example description");
  await addForm.getByRole("button", { name: "Add list", exact: true }).click();
  await expect(listManager.getByRole("button", { name: "Rename Example List" })).toBeVisible();

  const deleteListButton = listManager.getByRole("button", { name: "Delete Example List" });
  await deleteListButton.click();
  const deleteConfirmation = page.getByRole("alertdialog", { name: "Delete list?" });
  await expect(deleteConfirmation).toBeVisible();
  await expect(listManager).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await deleteConfirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(deleteConfirmation).toHaveCount(0);
  await expect(deleteListButton).toBeFocused();

  await deleteListButton.click();
  await page
    .getByRole("alertdialog", { name: "Delete list?" })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(page.getByRole("alertdialog", { name: "Delete list?" })).toHaveCount(0);
  await expect(listManager.getByRole("button", { name: "Rename Example List" })).toHaveCount(0);
  await expect(listManager).toBeVisible();

  await page.getByRole("button", { name: "Close favorite list editor" }).click();
  await type.click();
  await page.getByRole("menuitemradio", { name: "Circles" }).click();
  await expect(page.getByPlaceholder("Search circles")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Resource:/ })).toHaveCount(0);
});

test("mobile favorites collapses type and search into icon controls", async ({ page }) => {
  await mockFavorites(page, {
    sources: [
      {
        id: 11,
        code: "example_remote_a",
        displayName: "Example Remote A",
        sourceType: "kikoeru_compatible",
        enabled: true,
      },
    ],
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/favorites");

  const type = page.getByRole("button", { name: "Favorite type: Works" });
  const search = page.getByRole("button", { name: "Search favorites" });
  await expect(type).toBeVisible();
  await expect(search).toBeVisible();
  await expect(page.getByRole("button", { name: "Resource: Any available" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Columns: Auto" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sort favorite works: Marked or added" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Items per page: 24" })).toBeVisible();
  await expect(page.getByPlaceholder("Search title, code, circle, tag, or creator")).not.toBeVisible();

  const mobileListTab = page.getByRole("button", { name: /All Favorites/ });
  const mobileListScroller = page.getByRole("region", { name: "Favorite list tabs" });
  await expect(mobileListScroller).toBeVisible();
  await expect
    .poll(() =>
      mobileListScroller.evaluate((element) => {
        const style = getComputedStyle(element);
        return { overflowX: style.overflowX, overflowY: style.overflowY };
      }),
    )
    .toEqual({ overflowX: "auto", overflowY: "hidden" });
  const mobileListTabBox = await mobileListTab.boundingBox();
  const mobileListTabSurfaceBox = await mobileListTab.locator(":scope > span").boundingBox();
  expect(mobileListTabBox).not.toBeNull();
  expect(mobileListTabSurfaceBox).not.toBeNull();
  expect(mobileListTabBox!.height).toBe(44);
  expect(mobileListTabSurfaceBox!.height).toBe(36);

  const mobileListOptions = page.getByRole("button", { name: "Favorite list options", exact: true });
  const mobileListOptionsBox = await mobileListOptions.boundingBox();
  const mobileListOptionsSurfaceBox = await mobileListOptions.locator(":scope > span").boundingBox();
  expect(mobileListOptionsBox).not.toBeNull();
  expect(mobileListOptionsSurfaceBox).not.toBeNull();
  expect(mobileListOptionsBox!.height).toBe(44);
  expect(mobileListOptionsSurfaceBox!.height).toBe(36);
  await page.getByRole("button", { name: /Study/ }).click();
  await mobileListOptions.click();
  await expect(page.getByRole("menuitem", { name: "Edit lists", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem")).toHaveCount(2);
  await expect(page.getByRole("menuitem", { name: "New list", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Rename list", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Move list left", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Move list right", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Delete list", exact: true })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Edit lists", exact: true }).click();
  const mobileListManager = page.getByRole("dialog", { name: "Edit favorite lists" });
  await expect(mobileListManager).toBeVisible();
  await mobileListManager.getByRole("button", { name: "Add list", exact: true }).click();
  await expect(mobileListManager.getByRole("form", { name: "Add favorite list" })).toBeVisible();
  await expect(
    mobileListManager.getByRole("listitem").last().getByRole("form", { name: "Add favorite list" }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  const mobileListManagerBox = await mobileListManager.boundingBox();
  const mobileViewport = page.viewportSize();
  expect(mobileListManagerBox).not.toBeNull();
  expect(mobileViewport).not.toBeNull();
  expect(mobileListManagerBox!.y).toBeGreaterThanOrEqual(0);
  expect(mobileListManagerBox!.y + mobileListManagerBox!.height).toBeLessThanOrEqual(mobileViewport!.height);
  await mobileListManager.getByRole("button", { name: "Cancel", exact: true }).click();
  await mobileListManager.getByRole("button", { name: "Done", exact: true }).click();

  const topPreviousPage = page.getByRole("button", { name: "Previous page" }).first();
  await expect(topPreviousPage).toBeVisible();
  const topPreviousPageBox = await topPreviousPage.boundingBox();
  expect(topPreviousPageBox).not.toBeNull();
  expect(topPreviousPageBox!.height).toBe(32);

  const toolbar = page.locator("[data-toast-avoid]:visible").filter({ has: type }).first();
  const toolbarBox = await toolbar.boundingBox();
  expect(toolbarBox).not.toBeNull();
  expect(toolbarBox!.y).toBe(77);
  expect(toolbarBox!.height).toBe(32);

  await type.click();
  await expect(page.getByRole("menuitemradio", { name: "Circles" })).toBeVisible();
  await page.getByRole("menuitemradio", { name: "Circles" }).click();
  await expect(page.getByRole("button", { name: "Favorite type: Circles" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Resource:/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Columns:/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Sort favorite works:/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Items per page:/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Search favorites" }).click();
  const circleSearch = page.locator('input[placeholder="Search circles"]:visible');
  await expect(circleSearch).toBeVisible();
  await circleSearch.fill("Example");
  await expect(page.getByRole("button", { name: "Edit favorite search" })).toBeVisible();
});

test("favorites detail uses Library Up navigation while the Favorites tab restores browse state", async ({ page }) => {
  await mockFavorites(page);
  await page.goto(
    "/favorites?entity=works&status=listening&availability=local&list=2&page=2&pageSize=24&sort=sales&direction=asc&seed=314159",
  );
  await expect(page.getByRole("button", { name: /Study/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Sort favorite works: Sales" }).click();
  await expect(page.getByRole("menuitemradio", { name: "Sales" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await page.getByRole("button", { name: "Favorite list options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Select works", exact: true }).click();
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
  await expect(page.getByRole("button", { name: "Sort favorite works: Sales" })).toBeVisible();
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
  await expect(page.getByRole("menuitem", { name: "Edit lists", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  // Normalize horizontal scroll before measuring; click() may reveal a partially clipped tab.
  await playlistButtons[2].scrollIntoViewIfNeeded();
  const positionsBefore = await Promise.all(playlistButtons.map((button) => button.boundingBox()));
  const worksRegionBefore = await page.locator('[data-favorite-work-id="1"]').boundingBox();

  await playlistButtons[2].click();
  await listRequestStarted;
  await expect(playlistButtons[2]).toHaveAttribute("aria-pressed", "true");
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
      },
      {
        id: 12,
        code: "example_remote_b",
        displayName: "Example Remote B",
        sourceType: "kikoeru_compatible",
        enabled: false,
      },
    ],
    onFavoriteWorksRequest: (sourceIDs) => sourceRequests.push(sourceIDs),
  });
  await page.goto("/favorites");

  await page.getByRole("button", { name: "Resource: Any available" }).click();
  await page.getByRole("menuitemradio", { name: "Example Remote A" }).click();
  await expect.poll(() => sourceRequests.at(-1)).toEqual([11]);

  expect(new URL(page.url()).searchParams.size).toBe(0);
  await expect.poll(() => page.evaluate(() => window.history.state?.favoritesBrowseState?.sourceIDs)).toEqual([11]);
  await page.getByRole("button", { name: "Resource: Example Remote A" }).click();
  await page.getByRole("menuitemradio", { name: "Any available" }).click();
  await expect.poll(() => sourceRequests.at(-1)).toEqual([]);
});
