import { expect, test, type Page } from "@playwright/test";

const baseWork = {
  id: 1,
  primaryCode: "RJ09998001",
  title: "Favorite work 1",
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
};

async function mockFavorites(page: Page) {
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
      await route.fulfill({ json: { works, page: Number(url.searchParams.get("page") ?? 1), pageSize: 24, total: 48, shelfTotal: 48, listCounts: { "1": 24, "2": 24 }, statusCounts: { listening: 48 } } });
      return;
    }
    if (url.pathname === "/api/circles" || url.pathname === "/api/voices" || url.pathname === "/api/library-sources") {
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
  await page.goto("/favorites?entity=works&q=focus&status=listening&availability=local&list=2&page=2&pageSize=24");
  await expect(page.getByRole("button", { name: /Study/ })).toHaveAttribute("class", /bg-primary/);
  await expect(page.getByPlaceholder("Search title, code, circle, tag")).toHaveValue("focus");
  await page.getByRole("button", { name: "Select", exact: true }).click();
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
  await expect(page).toHaveURL(/\/favorites\?/);
  await expect(page.getByPlaceholder("Search title, code, circle, tag")).toHaveValue("focus");
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(savedScroll - 100);
  const params = new URL(page.url()).searchParams;
  expect(params.get("status")).toBe("listening");
  expect(params.get("availability")).toBe("local");
  expect(params.get("list")).toBe("2");
  expect(params.get("page")).toBe("2");
});
