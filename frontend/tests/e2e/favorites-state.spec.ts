import { expect, test, type Page } from "@playwright/test";

const baseWork = {
  id: 1,
  primaryCode: "RJ09998001",
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
  progress: { mediaItemId: null, title: "", positionSeconds: 0, durationSeconds: null, lastPlayedAt: null, completed: false },
  listeningStatus: "listening",
  favorite: true,
  recommendScore: 0,
};

async function mockFavorites(
  page: Page,
  delayedList?: { id: number; started: () => void; gate: Promise<void> },
) {
  let savedTags = baseWork.userTags;
  const works = Array.from({ length: 24 }, (_, index) => ({
    ...baseWork,
    id: index + 1,
    primaryCode: `RJ${String(9998001 + index).padStart(8, "0")}`,
    title: `Favorite work ${index + 1}`,
    userTags: index === 17 ? savedTags : [],
  }));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({ json: { authenticated: true, user: { id: 1, username: "listener", displayName: "Listener", role: "user", permissions: ["library:read", "playback:use", "favorites:write", "tags:write"], devMode: true } } });
      return;
    }
    if (url.pathname === "/api/favorite-lists") {
      await route.fulfill({ json: [{ id: 1, name: "Favorites", description: "", sortOrder: 0 }, { id: 2, name: "Study", description: "", sortOrder: 1 }] });
      return;
    }
    if (url.pathname === "/api/favorite-works") {
      if (url.searchParams.get("listId") === String(delayedList?.id)) {
        delayedList.started();
        await delayedList.gate;
      }
      await route.fulfill({ json: { works, page: Number(url.searchParams.get("page") ?? 1), pageSize: 24, total: 48, shelfTotal: 48, listCounts: { "1": 24, "2": 24 }, statusCounts: { listening: 48 } } });
      return;
    }
    if (url.pathname === "/api/circles") {
      await route.fulfill({ json: { circles: [], page: 1, pageSize: 100, total: 0, catalogWorks: 0, availableWorks: 0 } });
      return;
    }
    if (url.pathname === "/api/voices") {
      await route.fulfill({ json: { voices: [], page: 1, pageSize: 100, total: 0, tagOptions: [] } });
      return;
    }
    if (url.pathname === "/api/library-sources") {
      await route.fulfill({ json: [] });
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
      await route.fulfill({ json: { ...work, userTags: id === 18 ? savedTags : work.userTags, baseCode: "", metadataLanguage: "JPN", workType: "audio", titleKana: "", description: "", ageRating: "", durationSeconds: null, dlsiteFetchedAt: "", translations: [], manualOverrides: {}, mediaItems: [] } });
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
      await route.fulfill({ json: [{ id: 1, name: "Favorites", description: "", sortOrder: 0, selected: true }, { id: 2, name: "Study", description: "", sortOrder: 1, selected: true }] });
      return;
    }
    if (/^\/api\/works\/[^/]+\/source-availability$/.test(url.pathname)) {
      await route.fulfill({ json: { workCode: "RJ09998018", checkedAt: "", sources: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: `Not mocked: ${url.pathname}` } });
  });
}

test("favorites detail return restores browse state, selection, anchor, and work tags", async ({ page }) => {
  await mockFavorites(page);
  await page.goto("/favorites?entity=works&status=listening&availability=local&list=2&page=2&pageSize=24&sort=sales&direction=asc&seed=314159");
  await expect(page.getByRole("button", { name: /Study/ })).toHaveAttribute("class", /bg-primary/);
  await page.getByRole("button", { name: "More shelf options" }).click();
  await expect(page.getByRole("menuitem", { name: "Sort Sales" })).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Selection mode Off" }).click();
  await page.locator('[aria-label="Select work"]').nth(17).click();
  const target = page.getByText("Favorite work 18", { exact: true });
  await target.scrollIntoViewIfNeeded();
  const savedScroll = await page.evaluate(() => window.scrollY);
  expect(savedScroll).toBeGreaterThan(500);
  await target.click();

  await expect(page).toHaveURL(/RJ09998018/);
  await page.getByRole("button", { name: "Info", exact: true }).click();
  await expect(page.getByText("My tags", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add tag" }).click();
  await page.getByPlaceholder("tag1, tag2").fill("Night, Focus");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Night", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Back to favorites" }).click();
  await expect(page).toHaveURL(/\/favorites$/);
  await expect(page.getByRole("button", { name: "More shelf options" })).toHaveAttribute("data-shelf-sort", "sales");
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(savedScroll - 100);
  const params = new URL(page.url()).searchParams;
  expect(params.size).toBe(0);
  const restoredState = await page.evaluate(() => window.history.state?.favoritesBrowseState);
  expect(restoredState).toEqual(expect.objectContaining({
    entity: "works",
    status: "listening",
    availability: "local",
    list: 2,
    page: 2,
    pageSize: 24,
    sort: "sales",
    direction: "asc",
    randomSeed: 314159,
  }));
});

test("switching favorite lists keeps the entire playlist row stable while works load", async ({ page }) => {
  let releaseListRequest = () => undefined;
  const listRequestGate = new Promise<void>((resolve) => { releaseListRequest = resolve; });
  let markListRequestStarted = () => undefined;
  const listRequestStarted = new Promise<void>((resolve) => { markListRequestStarted = resolve; });
  await mockFavorites(page, { id: 2, started: markListRequestStarted, gate: listRequestGate });
  await page.goto("/favorites");

  const playlistButtons = [
    page.getByRole("button", { name: /All Shelf/ }),
    page.getByRole("button", { name: /Favorites 24/ }),
    page.getByRole("button", { name: /Study 24/ }),
    page.getByRole("button", { name: "New list", exact: true }),
    page.getByRole("button", { name: "List actions", exact: true }),
  ];
  await expect(playlistButtons[0]).toBeVisible();
  const positionsBefore = await Promise.all(playlistButtons.map((button) => button.boundingBox()));

  await playlistButtons[2].click();
  await listRequestStarted;
  await expect(playlistButtons[2]).toHaveClass(/bg-primary/);
  for (const button of playlistButtons) await expect(button).toBeVisible();
  const positionsWhileLoading = await Promise.all(playlistButtons.map((button) => button.boundingBox()));
  expect(positionsWhileLoading).toEqual(positionsBefore);

  releaseListRequest();
  await expect(page.getByText("Favorite work 1", { exact: true })).toBeVisible();
});
