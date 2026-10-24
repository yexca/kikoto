import { expect, test, type Page } from "@playwright/test";
import type { LibrarySource } from "../../src/lib/api";
import { favoriteListFixture, librarySourceFixture, type ApiResponse } from "./fixtures/api";
import { mockApplication } from "./fixtures/player-library";
import { openWorkMetadataEditor } from "./fixtures/work-detail";

async function metadataActions(page: Page, sources: LibrarySource[] = [], canEdit = true) {
  const control = { runId: 610, status: "queued" as const, postRequests: 0, statusRequests: 0, detailRequests: 0 };
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    permissions: ["library:read", "metadata:sync", ...(canEdit ? ["library:write"] : [])],
    librarySources: sources,
    metadataSyncControl: control,
  });
  await page.route("**/api/works/1/cover-candidates", (route) =>
    route.fulfill({ json: { candidates: [], providerCoverUrl: "" } satisfies ApiResponse<"listWorkCoverCandidates"> }),
  );
  return control;
}

test("detail list picker saves each toggle, creates a list from the search, and lets a failed creation retry", async ({
  page,
}, testInfo) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, { authenticated: true });
  const existing = favoriteListFixture({ id: 2, name: "Synthetic existing list", kind: "user" });
  const created = favoriteListFixture({ id: 3, name: "Synthetic new list", kind: "user" });
  const smart = favoriteListFixture({ id: 4, name: "Synthetic smart list", kind: "smart" });
  let lists = [existing, smart];
  let selected = [2, 4];
  const workLists = () =>
    lists.map((list) => ({ ...list, selected: selected.includes(list.id), matchedByRule: list.id === 4 }));
  const creations: unknown[] = [];
  const memberships: unknown[] = [];
  await page.route("**/api/favorite-lists", (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: lists });
    creations.push(route.request().postDataJSON());
    if (creations.length === 1) {
      return route.fulfill({ status: 500, json: { error: "Synthetic creation failure" } });
    }
    lists = [...lists, created];
    return route.fulfill({ status: 201, json: created });
  });
  await page.route("**/api/works/1/favorite-lists", (route) => {
    if (route.request().method() !== "PUT") return route.fulfill({ json: workLists() });
    const body = route.request().postDataJSON() as { listIds: number[] };
    memberships.push(body);
    selected = body.listIds;
    return route.fulfill({ json: { workId: 1, favorite: selected.length > 0, lists: workLists() } });
  });
  await page.goto("/RJ00000000");
  await page
    .getByRole("button", { name: "Lists: Synthetic existing list and Synthetic smart list", exact: true })
    .click();
  const picker = page.getByRole("dialog", { name: "Add to list", exact: true });
  await expect(picker.getByRole("option", { name: /^Synthetic existing list/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(picker.getByRole("option", { name: /^Synthetic smart list/ })).toContainText("Matched by its rule");

  const search = picker.getByRole("combobox", { name: "Search or create a list", exact: true });
  await search.fill("synthetic EXISTING list");
  await expect(picker.getByRole("option")).toHaveCount(1);
  await search.fill("  Synthetic new list  ");
  await page.screenshot({ path: testInfo.outputPath("list-picker-create.png") });
  const create = picker.getByRole("option", { name: "Create “Synthetic new list”", exact: true });
  await create.click();
  await expect(picker.getByRole("alert")).toBeVisible();
  await expect(search).toHaveValue("  Synthetic new list  ");
  await create.click();
  await expect(search).toHaveValue("");
  await expect(picker.getByRole("option", { name: /^Synthetic new list/ })).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => memberships).toEqual([{ listIds: [2, 4, 3] }]);
  expect(creations).toEqual([{ name: "Synthetic new list" }, { name: "Synthetic new list" }]);

  await picker.getByRole("option", { name: /^Synthetic existing list/ }).click();
  await expect.poll(() => memberships).toEqual([{ listIds: [2, 4, 3] }, { listIds: [4, 3] }]);
  await expect(picker.getByRole("option", { name: /^Synthetic existing list/ })).toHaveAttribute(
    "aria-selected",
    "false",
  );

  // The work's own list button follows the saved lists once the picker closes.
  await picker.getByRole("button", { name: "Close", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Lists: Synthetic smart list and Synthetic new list", exact: true }),
  ).toBeVisible();
});

test("Metadata opens the editor directly with the default refresh and no unconfigured source options", async ({
  page,
}) => {
  const control = await metadataActions(page);
  const bodies: (string | null)[] = [];
  await page.route("**/api/works/1/metadata-sync", (route) => {
    bodies.push(route.request().postData());
    return route.fallback();
  });
  await page.goto("/RJ00000000");
  await openWorkMetadataEditor(page);
  const dialog = page.getByRole("dialog", { name: "Edit metadata", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "More metadata sources" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Refresh metadata", exact: true }).click();
  await expect.poll(() => control.postRequests).toBe(1);
  expect(bodies).toEqual([null]);
  await expect(dialog).toBeVisible();
});

test("a custom work edits its metadata and age rating without provider refreshes", async ({ page }) => {
  const control = { runId: 611, status: "queued" as const, postRequests: 0, statusRequests: 0, detailRequests: 0 };
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    permissions: ["library:read", "library:write", "metadata:sync"],
    librarySources: [librarySourceFixture({ metadataCapable: true })],
    detailMetadataSync: { status: "not_synced", checkedAt: "" },
    detailCustomWork: true,
    metadataSyncControl: control,
  });
  await page.route("**/api/works/1/cover-candidates", (route) =>
    route.fulfill({ json: { candidates: [], providerCoverUrl: "" } satisfies ApiResponse<"listWorkCoverCandidates"> }),
  );
  const overrides: unknown[] = [];
  await page.route("**/api/works/1/manual-overrides", (route) => {
    overrides.push(route.request().postDataJSON());
    return route.fulfill({ json: { ageRating: "general" } });
  });
  await page.goto("/RJ00000000");
  const stats = page.getByTestId("dlsite-info");
  await expect(stats.getByText("Age rating", { exact: true })).toBeVisible();
  await expect(stats.getByText("Sales", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("metadata-sync-notice")).toHaveCount(0);

  await openWorkMetadataEditor(page);
  const dialog = page.getByRole("dialog", { name: "Edit metadata", exact: true });
  await expect(dialog.getByRole("tab", { name: /^Links/ })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Refresh metadata", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "More metadata actions", exact: true }).click();
  const more = page.getByRole("menu", { name: "More metadata actions", exact: true });
  await expect(more.getByRole("menuitem", { name: "Translate with AI", exact: true })).toBeVisible();
  await expect(more.getByRole("menuitem", { name: "Fetch for edit", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await dialog.getByRole("tab", { name: /^Age rating/ }).click();
  const rating = dialog.getByRole("radiogroup", { name: "Age rating", exact: true });
  await expect(dialog).toContainText("The provider gives no rating.");
  await rating.getByRole("radio", { name: "全年齢", exact: true }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => overrides).toEqual([{ ageRating: "general" }]);
  expect(control.postRequests).toBe(0);
});

test("remote metadata choices use declared capabilities and preserve drafts after refreshing", async ({ page }) => {
  const control = await metadataActions(page, [
    librarySourceFixture({ metadataCapable: true }),
    librarySourceFixture({ id: 2, code: "example_remote_b", displayName: "Synthetic Remote B", metadataCapable: true }),
    librarySourceFixture({ id: 3, displayName: "Synthetic Disabled Source", enabled: false }),
    librarySourceFixture({ id: 4, displayName: "Synthetic File Source", metadataCapable: false }),
  ]);
  const bodies: unknown[] = [];
  await page.route("**/api/works/1/metadata-sync", (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fallback();
  });
  await page.goto("/RJ00000000");
  await openWorkMetadataEditor(page);
  const dialog = page.getByRole("dialog", { name: "Edit metadata", exact: true });
  const title = dialog.getByRole("textbox", { name: "Japanese", exact: true });
  await title.fill("Synthetic title draft");
  const options = dialog.getByRole("button", { name: "More metadata sources", exact: true });
  await options.click();
  const menu = page.getByRole("menu", { name: "More metadata sources", exact: true });
  await expect(menu.getByRole("menuitem")).toHaveCount(2);
  await expect(menu.getByRole("menuitem", { name: "From Example Remote A", exact: true })).toBeFocused();
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem", { name: "From Synthetic Remote B", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(options).toBeFocused();
  await options.click();
  await expect(menu.getByRole("menuitem", { name: "From Example Remote A", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(menu).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "More metadata actions", exact: true })).toBeFocused();
  await options.click();
  await menu.getByRole("menuitem", { name: "From Synthetic Remote B", exact: true }).click();
  await expect.poll(() => control.postRequests).toBe(1);
  expect(bodies).toEqual([{ sourceId: 2 }]);
  await expect.poll(() => control.detailRequests).toBeGreaterThan(1);
  await expect(title).toHaveValue("Synthetic title draft");
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
});

const syntheticMetadataPreview = {
  previewId: "synthetic-preview",
  workId: 1,
  primaryCode: "RJ00000000",
  provider: "remote",
  sourceCode: "example_remote_b",
  sourceName: "Synthetic Remote B",
  baseUpdatedAt: "2026-10-11T00:00:00Z",
  current: {
    title: "Current title",
    titleLanguage: "ja-jp",
    description: "Current description",
    releaseDate: null,
    ageRating: "general",
    circle: "Current circle",
    circleExternalId: "RG00000000",
    tags: ["Current tag"],
    voiceActors: [],
    coverAvailable: false,
    family: [],
  },
  fetched: {
    title: "Fetched title",
    titleLanguage: "ja-jp",
    description: "Fetched description",
    releaseDate: "2026-10-11",
    ageRating: "general",
    circle: "Fetched circle",
    circleExternalId: "RG00000001",
    tags: ["Fetched tag"],
    voiceActors: [],
    coverAvailable: false,
    family: [],
  },
};

test("@desktop Fetch for edit opens at its own size above the editor", async ({ page }) => {
  await metadataActions(page, [librarySourceFixture()]);
  await page.route(/\/api\/works\/1\/metadata-preview$/, (route) => route.fulfill({ json: syntheticMetadataPreview }));
  await page.goto("/RJ00000000");
  await openWorkMetadataEditor(page);
  const editor = page.getByRole("dialog", { name: "Edit metadata", exact: true });
  await editor.getByRole("button", { name: "More metadata actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Fetch for edit", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "Compare fetched metadata", exact: true });
  await expect(preview.getByRole("button", { name: "Save selection", exact: true })).toBeVisible();
  // The comparison is wider than the editor, so it cannot be laid out inside the editor's panel.
  const [editorBox, previewBox] = [await editor.boundingBox(), await preview.boundingBox()];
  expect(previewBox!.width).toBeGreaterThan(editorBox!.width);
  await expect(preview.getByRole("button", { name: "Save selection", exact: true })).toBeInViewport({ ratio: 1 });
});

test("Fetch for edit compares a selected source and applies an authored value", async ({ page }) => {
  await metadataActions(page, [
    librarySourceFixture(),
    librarySourceFixture({ id: 2, code: "example_remote_b", displayName: "Synthetic Remote B", metadataCapable: true }),
  ]);
  const previews: unknown[] = [];
  let applied: unknown = null;
  await page.route(/\/api\/works\/1\/metadata-preview$/, async (route) => {
    previews.push(route.request().postDataJSON());
    await route.fulfill({ json: syntheticMetadataPreview });
  });
  await page.route("**/api/works/1/metadata-preview/apply", async (route) => {
    applied = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true, updatedAt: "2026-10-11T00:01:00Z" } });
  });
  await page.goto("/RJ00000000");
  await openWorkMetadataEditor(page);
  const editor = page.getByRole("dialog", { name: "Edit metadata", exact: true });
  await editor.getByRole("button", { name: "More metadata actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Fetch for edit", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "Compare fetched metadata", exact: true });
  await expect(preview).toBeVisible();
  await expect.poll(() => previews.length).toBe(1);
  await preview.getByLabel("Fetch source", { exact: true }).selectOption("2");
  await expect.poll(() => previews.length).toBe(2);
  expect(previews[1]).toEqual({ sourceId: 2 });
  await preview.getByRole("button", { name: /Fetched Fetched title/ }).click();
  await preview.getByRole("textbox", { name: "Expected Title", exact: true }).fill("Authored title");
  await preview.getByRole("button", { name: "Save selection", exact: true }).click();
  await expect.poll(() => applied).toEqual(expect.objectContaining({ previewId: "synthetic-preview" }));
  expect((applied as { values: { title: string } }).values.title).toBe("Authored title");
  await expect(preview).toHaveCount(0);
});

test("metadata operators can refresh without permission to change manual values", async ({ page }) => {
  await metadataActions(page, [librarySourceFixture({ metadataCapable: false })], false);
  await page.goto("/RJ00000000");
  await openWorkMetadataEditor(page);
  const dialog = page.getByRole("dialog", { name: "Edit metadata", exact: true });
  await expect(dialog.getByRole("textbox", { name: "Japanese", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Refresh metadata", exact: true })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "More metadata sources", exact: true })).toHaveCount(0);
});

for (const layout of ["phone", "desktop @desktop"]) {
  test(`metadata refresh footer and floating source choices fit ${layout}`, async ({ page }, testInfo) => {
    if (layout === "phone") await page.setViewportSize({ width: 320, height: 720 });
    await metadataActions(page, [librarySourceFixture()]);
    await page.goto("/RJ00000000");
    await openWorkMetadataEditor(page);
    const dialog = page.getByRole("dialog", { name: "Edit metadata", exact: true });
    const refresh = dialog.getByRole("button", { name: "Refresh metadata", exact: true });
    const save = dialog.getByRole("button", { name: "Save", exact: true });
    await expect(refresh).toBeVisible();
    await expect(save).toBeVisible();
    const refreshBox = (await refresh.boundingBox())!;
    const saveBox = (await save.boundingBox())!;
    expect(refreshBox.x).toBeLessThan(saveBox.x);
    expect(saveBox.x + saveBox.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await dialog.getByRole("button", { name: "More metadata sources", exact: true }).click();
    const menu = page.getByRole("menu", { name: "More metadata sources", exact: true });
    await expect(menu).toBeVisible();
    const menuBox = (await menu.boundingBox())!;
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    await page.screenshot({ path: testInfo.outputPath("metadata-refresh.png") });
  });
}
