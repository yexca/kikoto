import { expect, test, type Page } from "@playwright/test";

import type {
  FavoriteList,
  FavoriteWorksPage,
  LibrarySource,
  ListeningStatus,
  SourceAvailabilityResponse,
  UserTag,
  Work,
} from "../../src/lib/api";
import { syntheticWorkCode } from "../../src/test-support/workCode";
import {
  type ApiErrorBody,
  type ApiResponse,
  authenticatedStateFixture,
  circleSummaryPageFixture,
  favoriteListFixture,
  librarySourceFixture,
  runtimeSettingsFixture,
  voiceSummaryPageFixture,
  workDetailFixture,
  workFixture,
  worksPageFixture,
} from "./fixtures/api";

const baseWork = workFixture({
  title: "Favorite work 1",
  ageRating: "R18",
  releaseDate: "2026-01-01",
  circle: "Example Circle",
  circleExternalId: "RG09998001",
  rating: 4.5,
  sales: 10,
  tags: ["Example metadata tag"],
  userTags: [{ id: 1, name: "Quiet", color: "" }],
  availableLocations: 1,
  availability: ["local"],
  listeningStatus: "listening",
  favorite: true,
});

const exampleRemoteA = librarySourceFixture({ id: 11 });

async function mockFavorites(
  page: Page,
  options: {
    delayedList?: { id: number; started: () => void; gate: Promise<void> };
    sources?: LibrarySource[];
    onFavoriteWorksRequest?: (sourceIDs: number[]) => void;
    interactiveQuickMark?: boolean;
  } = {},
) {
  let savedTags: UserTag[] = baseWork.userTags;
  let quickMark: ListeningStatus = baseWork.listeningStatus;
  let favoriteLists: FavoriteList[] = [
    favoriteListFixture(),
    favoriteListFixture({ id: 2, name: "Study", sortOrder: 0, kind: "user" }),
  ];
  const works: Work[] = Array.from({ length: 24 }, (_, index) => ({
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
        json: authenticatedStateFixture({
          permissions: ["library:read", "playback:use", "favorites:write", "tags:write"],
          devMode: true,
        }),
      });
      return;
    }
    if (url.pathname === "/api/favorite-lists" && request.method() === "GET") {
      await route.fulfill({ json: favoriteLists });
      return;
    }
    if (url.pathname === "/api/favorite-lists" && request.method() === "POST") {
      const body = request.postDataJSON() as { name: string; description?: string };
      const list = favoriteListFixture({
        id: Math.max(...favoriteLists.map((item) => item.id)) + 1,
        name: body.name,
        description: body.description ?? "",
        sortOrder: favoriteLists.filter((item) => item.kind === "user").length,
        kind: "user",
      });
      favoriteLists = [...favoriteLists, list];
      await route.fulfill({ json: list });
      return;
    }
    const favoriteListMatch = url.pathname.match(/^\/api\/favorite-lists\/(\d+)$/);
    if (favoriteListMatch && request.method() === "PATCH") {
      const id = Number(favoriteListMatch[1]);
      const body = request.postDataJSON() as { name?: string; description?: string; sortOrder?: number };
      favoriteLists = favoriteLists.map((list) => (list.id === id ? { ...list, ...body } : list));
      const updated = favoriteLists.find((list) => list.id === id);
      if (!updated) {
        await route.fulfill({ status: 404, json: { error: "Favorite list not found" } satisfies ApiErrorBody });
        return;
      }
      await route.fulfill({ json: updated });
      return;
    }
    if (favoriteListMatch && request.method() === "DELETE") {
      const id = Number(favoriteListMatch[1]);
      favoriteLists = favoriteLists.filter((list) => list.id !== id);
      await route.fulfill({ json: { ok: true, deleted: id } satisfies ApiResponse<"deleteFavoriteList"> });
      return;
    }
    if (url.pathname === "/api/favorite-works") {
      options.onFavoriteWorksRequest?.(url.searchParams.getAll("sourceId").map(Number));
      const delayedList = options.delayedList;
      if (delayedList && url.searchParams.get("listId") === String(delayedList.id)) {
        delayedList.started();
        await delayedList.gate;
      }
      const emptied = options.interactiveQuickMark && quickMark === "none";
      await route.fulfill({
        json: {
          ...worksPageFixture(emptied ? [] : works.map((work) => ({ ...work, listeningStatus: quickMark })), {
            page: Number(url.searchParams.get("page") ?? 1),
            total: emptied ? 0 : 48,
          }),
          shelfTotal: emptied ? 0 : 48,
          listCounts: { "1": emptied ? 0 : 24, "2": 24 },
          statusCounts: quickMark === "none" ? {} : { [quickMark]: 48 },
        } satisfies FavoriteWorksPage,
      });
      return;
    }
    if (url.pathname === "/api/circles") {
      await route.fulfill({ json: circleSummaryPageFixture([], { pageSize: 100 }) });
      return;
    }
    if (url.pathname === "/api/voices") {
      await route.fulfill({ json: voiceSummaryPageFixture([], { pageSize: 100 }) });
      return;
    }
    if (url.pathname === "/api/library-sources") {
      await route.fulfill({ json: options.sources ?? [] });
      return;
    }
    if (url.pathname === "/api/runtime-settings") {
      await route.fulfill({ json: runtimeSettingsFixture({ anonymousAccessEnabled: false }) });
      return;
    }
    if (url.pathname === "/api/works") {
      await route.fulfill({ json: worksPageFixture(works) });
      return;
    }
    const detailMatch = url.pathname.match(/^\/api\/works\/(\d+)$/);
    if (detailMatch) {
      const id = Number(detailMatch[1]);
      const work = works.find((item) => item.id === id) ?? works[0];
      await route.fulfill({
        json: workDetailFixture(work, { userTags: id === 18 ? savedTags : work.userTags, ageRating: "" }),
      });
      return;
    }
    if (url.pathname === "/api/tags" && url.searchParams.get("scope") === "work") {
      await route.fulfill({
        json: {
          scope: "work",
          tags: [{ id: 5, name: "Focus", color: "", usageCount: 3 }],
        } satisfies ApiResponse<"listUserTags">,
      });
      return;
    }
    const tagsMatch = url.pathname.match(/^\/api\/works\/(\d+)\/tags$/);
    if (tagsMatch && request.method() === "PUT") {
      const body = request.postDataJSON() as { tags: string[] };
      savedTags = body.tags.map((name, index) => ({ id: index + 10, name, color: "" }));
      await route.fulfill({
        json: { workId: Number(tagsMatch[1]), userTags: savedTags } satisfies ApiResponse<"setWorkUserTags">,
      });
      return;
    }
    if (/^\/api\/works\/\d+\/media$/.test(url.pathname)) {
      await route.fulfill({
        json: { workId: 18, mediaWorkId: 18, mediaItems: [] } satisfies ApiResponse<"getWorkMedia">,
      });
      return;
    }
    if (/^\/api\/works\/\d+\/favorite-lists$/.test(url.pathname)) {
      await route.fulfill({
        json: [
          favoriteListFixture({ selected: true }),
          favoriteListFixture({ id: 2, name: "Study", sortOrder: 0, kind: "user", selected: true }),
        ],
      });
      return;
    }
    if (/^\/api\/works\/\d+\/user-state$/.test(url.pathname) && request.method() === "PATCH") {
      const body = request.postDataJSON() as { listeningStatus?: ListeningStatus };
      quickMark = body.listeningStatus ?? quickMark;
      await route.fulfill({
        json: { workId: 1, listeningStatus: quickMark, favorite: false } satisfies ApiResponse<"updateWorkUserState">,
      });
      return;
    }
    if (/^\/api\/works\/[^/]+\/source-availability$/.test(url.pathname)) {
      await route.fulfill({
        json: { workCode: "RJ00000017", checkedAt: "", sources: [] } satisfies SourceAvailabilityResponse,
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: `Not mocked: ${url.pathname}` } satisfies ApiErrorBody });
  });
}

test("@desktop favorites keeps type and search left with work controls on the right", async ({ page }) => {
  await mockFavorites(page, {
    sources: [exampleRemoteA],
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/favorites");

  const type = page.getByRole("button", { name: "Favorite type: Works" });
  const search = page.getByPlaceholder("Search title, code, circle, tag, or creator");
  const resource = page.getByRole("button", { name: "Resource: Any available" });
  await expect(type).toBeVisible();
  await expect(search).toBeVisible();
  await expect(resource).toBeVisible();
  await expect(page.getByRole("button", { name: "Sort: Marked or added" })).toBeVisible();
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

  const listPicker = page.getByRole("button", { name: /^Favorite lists: All Favorites/ });
  await expect(listPicker).toBeVisible();
  await listPicker.click();
  await expect(page.getByRole("menuitemradio", { name: /All Favorites/ })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("menuitemradio", { name: /Marked/ })).toBeVisible();
  await expect(page.getByRole("menuitem")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Select works", exact: true }).click();
  await expect(page.getByRole("button", { name: "Exit selection", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "Exit selection", exact: true }).click();
  await page.getByRole("button", { name: "Edit lists", exact: true }).click();
  const listManager = page.getByRole("dialog", { name: "Edit lists" });
  await expect(listManager).toBeVisible();
  await expect(listManager.getByRole("button", { name: "Rename: Study" })).toBeVisible();

  await listManager.getByRole("button", { name: "Rename: Study" }).click();
  const renameForm = listManager.getByRole("form", { name: "Rename list: Study" });
  await expect(renameForm).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await renameForm.getByLabel("Name").fill("Focus");
  await renameForm.getByLabel("Description").fill("Deep listening");
  await renameForm.getByRole("button", { name: "Save", exact: true }).click();
  await expect(listManager.getByRole("button", { name: "Rename: Focus" })).toBeVisible();

  await listManager.getByRole("button", { name: "Add list", exact: true }).click();
  const addForm = listManager.getByRole("form", { name: "Add list" });
  await expect(addForm).toBeVisible();
  await expect(listManager.getByRole("listitem").last().getByRole("form", { name: "Add list" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await addForm.getByLabel("Name").fill("Example List");
  await addForm.getByLabel("Description").fill("Example description");
  await addForm.getByRole("button", { name: "Add list", exact: true }).click();
  await expect(listManager.getByRole("button", { name: "Rename: Example List" })).toBeVisible();

  const deleteListButton = listManager.getByRole("button", { name: "Delete: Example List" });
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
  await expect(listManager.getByRole("button", { name: "Rename: Example List" })).toHaveCount(0);
  await expect(listManager).toBeVisible();

  await page.getByRole("button", { name: "Close favorite list editor" }).click();
  await type.click();
  await page.getByRole("menuitemradio", { name: "Circles" }).click();
  await expect(page.getByPlaceholder("Search circles")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Resource:/ })).toHaveCount(0);
});

test("mobile favorites collapses type and search into icon controls", async ({ page }) => {
  await mockFavorites(page, {
    sources: [exampleRemoteA],
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/favorites");

  const type = page.getByRole("button", { name: "Favorite type: Works" });
  const search = page.getByRole("button", { name: "Search library" });
  await expect(type).toBeVisible();
  await expect(search).toBeVisible();
  await expect(page.getByRole("button", { name: "Resource: Any available" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Columns: Auto" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sort: Marked or added" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Items per page: 24" })).toBeVisible();
  await expect(page.getByPlaceholder("Search title, code, circle, tag, or creator")).not.toBeVisible();

  const mobileListScroller = page.getByRole("region", { name: "Favorite list tabs" });
  const mobileListTab = mobileListScroller.locator("button").first();
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
  expect(mobileListTabBox).not.toBeNull();
  expect(mobileListTabBox!.height).toBeGreaterThanOrEqual(44);

  const mobileEditLists = page.getByRole("button", { name: "Edit lists", exact: true });
  const mobileEditListsBox = await mobileEditLists.boundingBox();
  expect(mobileEditListsBox).not.toBeNull();
  expect(mobileEditListsBox!.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByRole("button", { name: "Select works", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Study/ }).click();
  await mobileEditLists.click();
  const mobileListManager = page.getByRole("dialog", { name: "Edit lists" });
  await expect(mobileListManager).toBeVisible();
  await mobileListManager.getByRole("button", { name: "Add list", exact: true }).click();
  await expect(mobileListManager.getByRole("form", { name: "Add list" })).toBeVisible();
  await expect(mobileListManager.getByRole("listitem").last().getByRole("form", { name: "Add list" })).toBeVisible();
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

  const toolbar = page.locator("[data-toast-avoid]:visible").filter({ has: type }).first();
  const toolbarBox = await toolbar.boundingBox();
  expect(toolbarBox).not.toBeNull();
  expect(toolbarBox!.y).toBeGreaterThanOrEqual(0);
  expect(toolbarBox!.y + toolbarBox!.height).toBeLessThanOrEqual(mobileViewport!.height);

  await type.click();
  await expect(page.getByRole("menuitemradio", { name: "Circles" })).toBeVisible();
  await page.getByRole("menuitemradio", { name: "Circles" }).click();
  await expect(page.getByRole("button", { name: "Favorite type: Circles" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Resource:/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Columns:/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Sort:/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Items per page:/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Search library" }).click();
  const circleSearch = page.locator('input[placeholder="Search circles"]:visible');
  await expect(circleSearch).toBeVisible();
  await circleSearch.fill("Example");
  await expect(page.getByRole("button", { name: "Search library" })).toBeVisible();
});

test("favorites detail uses Library Up navigation while the Favorites tab restores browse state", async ({ page }) => {
  await mockFavorites(page);
  await page.goto(
    "/favorites?entity=works&status=listening&availability=local&list=2&page=2&pageSize=24&sort=sales&direction=asc&seed=314159",
  );
  await expect(page.getByRole("button", { name: /Study/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Sort: Sales" }).click();
  await expect(page.getByRole("menuitemradio", { name: "Sales" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await page.getByRole("button", { name: "Select works", exact: true }).click();
  await page.locator('[aria-label="Select work"]').nth(17).click();
  const target = page.getByText("Favorite work 18", { exact: true });
  await target.scrollIntoViewIfNeeded();
  const savedScroll = await page.evaluate(() => window.scrollY);
  expect(savedScroll).toBeGreaterThan(500);
  await target.click();

  await expect(page).toHaveURL(/RJ00000017/);
  // Personal tags are edited from the hero tag row, without opening Info.
  await expect(page.getByRole("list", { name: "My tags", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit tags" }).click();
  const tagEditor = page.getByRole("dialog", { name: "Edit tags" });
  await tagEditor.getByRole("combobox", { name: "Search or create a tag" }).fill("Night");
  await tagEditor.getByRole("combobox", { name: "Search or create a tag" }).press("Enter");
  await tagEditor.getByRole("option", { name: /Focus/ }).click();
  await expect(tagEditor.getByRole("option", { name: /Night/ })).toHaveAttribute("aria-selected", "true");
  await expect(tagEditor.getByRole("option", { name: /Focus/ })).toHaveAttribute("aria-selected", "true");
  await tagEditor.getByRole("option", { name: /Night/ }).click();
  await expect(tagEditor.getByRole("option", { name: /Night/ })).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("Escape");
  await expect(tagEditor).toBeHidden();
  await expect(page.getByRole("list", { name: "My tags", exact: true }).getByRole("listitem")).toHaveText([
    "Quiet",
    "Focus",
  ]);

  await page.getByRole("main").getByRole("button", { name: "Library", exact: true }).click();
  await expect(page).toHaveURL(/^http:\/\/[^/]+\/(?:\?.*)?$/);
  await page.locator("footer").getByRole("button", { name: "Favorites", exact: true }).click();
  await expect(page).toHaveURL(/\/favorites$/);
  await expect(page.getByRole("button", { name: "Sort: Sales" })).toBeVisible();
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
  let releaseListRequest: () => void = () => undefined;
  const listRequestGate = new Promise<void>((resolve) => {
    releaseListRequest = resolve;
  });
  let markListRequestStarted: () => void = () => undefined;
  const listRequestStarted = new Promise<void>((resolve) => {
    markListRequestStarted = resolve;
  });
  await mockFavorites(page, { delayedList: { id: 2, started: markListRequestStarted, gate: listRequestGate } });
  await page.goto("/favorites");

  const listTabs = page.getByRole("region", { name: "Favorite list tabs" });
  const playlistButtons = [
    listTabs.locator("button").nth(0),
    listTabs.locator("button").nth(1),
    listTabs.locator("button").nth(2),
    page.getByRole("button", { name: "Edit lists", exact: true }),
  ];
  await expect(playlistButtons[0]).toBeVisible();
  await expect(page.getByText("Favorite work 1", { exact: true })).toBeVisible();
  await playlistButtons[3].click();
  const listManager = page.getByRole("dialog", { name: "Edit lists" });
  await expect(listManager).toBeVisible();
  await listManager.getByRole("button", { name: "Done", exact: true }).click();
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
  const listTabs = page.getByRole("region", { name: "Favorite list tabs" });
  await expect(listTabs.locator("button").nth(0)).toContainText("All Favorites");
  await expect(listTabs.locator("button").nth(0)).toContainText("0");
  await expect(listTabs.locator("button").nth(1)).toContainText("Marked");
  await expect(listTabs.locator("button").nth(1)).toContainText("0");
});

test("filters favorites by any selected file source and keeps the selection out of the canonical URL", async ({
  page,
}) => {
  const sourceRequests: number[][] = [];
  await mockFavorites(page, {
    sources: [
      exampleRemoteA,
      librarySourceFixture({ id: 12, code: "example_remote_b", displayName: "Example Remote B", enabled: false }),
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
