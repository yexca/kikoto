import { expect, test, type Page } from "@playwright/test";
import type { LibrarySource } from "../../src/lib/api";
import { favoriteListFixture, librarySourceFixture, type ApiResponse } from "./fixtures/api";
import { mockApplication } from "./fixtures/player-library";

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

test("detail list quick creation keeps existing memberships and lets a failed creation retry", async ({
  page,
}, testInfo) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, { authenticated: true });
  const existing = favoriteListFixture({ id: 2, name: "Synthetic existing list", kind: "user" });
  const created = favoriteListFixture({ id: 3, name: "Synthetic new list", kind: "user" });
  const creations: unknown[] = [];
  const memberships: unknown[] = [];
  await page.route("**/api/favorite-lists", (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: [existing] });
    creations.push(route.request().postDataJSON());
    if (creations.length === 1) {
      return route.fulfill({ status: 500, json: { error: "Synthetic creation failure" } });
    }
    return route.fulfill({ status: 201, json: created });
  });
  await page.route("**/api/works/1/favorite-lists", (route) => {
    if (route.request().method() !== "PUT") return route.fulfill({ json: [{ ...existing, selected: true }] });
    memberships.push(route.request().postDataJSON());
    return route.fulfill({ json: { workId: 1, favorite: true, lists: [existing, created] } });
  });
  await page.goto("/RJ00000000");
  await page.getByRole("button", { name: /^(Add to list|Favorite lists)$/ }).click();
  await page.getByRole("button", { name: "Add list", exact: true }).click();
  const form = page.getByRole("form", { name: "Add list", exact: true });
  await form.getByRole("textbox", { name: "Name", exact: true }).fill("Synthetic cancelled list");
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(creations).toEqual([]);
  await page.getByRole("button", { name: "Add list", exact: true }).click();
  await form.getByRole("textbox", { name: "Name", exact: true }).fill("  Synthetic new list  ");
  await page.screenshot({ path: testInfo.outputPath("list-quick-create.png") });
  await form.getByRole("button", { name: "Add list", exact: true }).click();
  await expect(form.getByRole("alert")).toBeVisible();
  await expect(form.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("  Synthetic new list  ");
  await form.getByRole("button", { name: "Add list", exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Remove from Synthetic new list" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Remove from Synthetic existing list" })).toBeChecked();
  expect(memberships).toEqual([]);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => memberships).toEqual([{ listIds: [2, 3] }]);
  expect(creations).toEqual([{ name: "Synthetic new list" }, { name: "Synthetic new list" }]);
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
  await page.getByRole("button", { name: "Edit metadata", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit metadata", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "More metadata sources" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Refresh metadata", exact: true }).click();
  await expect.poll(() => control.postRequests).toBe(1);
  expect(bodies).toEqual([null]);
  await expect(dialog).toBeVisible();
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
  await page.getByRole("button", { name: "Edit metadata", exact: true }).click();
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
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await options.click();
  await menu.getByRole("menuitem", { name: "From Synthetic Remote B", exact: true }).click();
  await expect.poll(() => control.postRequests).toBe(1);
  expect(bodies).toEqual([{ sourceId: 2 }]);
  await expect.poll(() => control.detailRequests).toBeGreaterThan(1);
  await expect(title).toHaveValue("Synthetic title draft");
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
});

test("metadata operators can refresh without permission to change manual values", async ({ page }) => {
  await metadataActions(page, [librarySourceFixture({ metadataCapable: false })], false);
  await page.goto("/RJ00000000");
  await page.getByRole("button", { name: "Edit metadata", exact: true }).click();
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
    await page.getByRole("button", { name: "Edit metadata", exact: true }).click();
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
