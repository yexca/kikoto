import { expect, test, type Locator, type Page } from "@playwright/test";

import type { RecordAsset, RecordFolder, RecordRoot, RecordTree } from "../../src/lib/api";
import { rolePermissions, runtimeSettingsFixture } from "./fixtures/api";
import { mockApplication } from "./fixtures/player-library";

// A 1×1 PNG.
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function photo(id: number, name: string): RecordAsset {
  return {
    id,
    folderId: 3,
    name,
    relativePath: `Trip/${name}`,
    kind: "image",
    mimeType: "image/png",
    availability: "available",
    streamUrl: `/api/records/assets/${id}/stream`,
  };
}

async function mockRecordPhotos(page: Page) {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    permissions: rolePermissions.admin,
  });
  await page.route("**/api/runtime-settings", (route) =>
    route.fulfill({ json: { ...runtimeSettingsFixture(), recordLibraryEnabled: true } }),
  );
  let photos = [photo(1, "Beach.png"), photo(2, "Harbor.png")];
  const trip: RecordFolder = {
    id: 3,
    name: "Trip",
    relativePath: "Trip",
    depth: 1,
    childCount: 0,
    assetCount: 2,
    artwork: {},
  };
  let folders = [trip];
  const deleted: number[] = [];
  const deletedFolders: number[] = [];
  await page.route("**/api/records**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/records") {
      const root: RecordRoot = {
        id: 1,
        displayName: "Record",
        state: "online",
        lastScannedAt: "2026-01-01T00:00:00Z",
        scanGeneration: 1,
      };
      return route.fulfill({ json: { root } });
    }
    if (path === "/api/records/tree") {
      return route.fulfill({ json: { folderId: 0, folders, assets: photos } satisfies RecordTree });
    }
    if (path === "/api/records/continue") return route.fulfill({ json: { assets: [] } });
    if (/^\/api\/records\/assets\/\d+\/stream$/.test(path))
      return route.fulfill({ contentType: "image/png", body: pixel });
    const asset = /^\/api\/records\/assets\/(\d+)$/.exec(path);
    if (asset && request.method() === "DELETE") {
      const id = Number(asset[1]);
      deleted.push(id);
      photos = photos.filter((item) => item.id !== id);
      return route.fulfill({ json: { trashPath: `.kikoto-trash/records/20260101T000000Z-${id}/Trip/Beach.png` } });
    }
    const folder = /^\/api\/records\/folders\/(\d+)$/.exec(path);
    if (folder && request.method() === "DELETE") {
      deletedFolders.push(Number(folder[1]));
      folders = [];
      return route.fulfill({
        json: { trashPath: ".kikoto-trash/records/20260101T000000Z-folder-3/Trip", assetIds: [] },
      });
    }
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });
  return { deleted, deletedFolders };
}

/** Opens a More menu and chooses Delete, which only starts the review. */
async function deleteFromMenu(page: Page, scope: Page | Locator, menu: string) {
  await scope.getByRole("button", { name: menu, exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
}

test("a Record photo moves to the trash after two confirmations and the viewer shows the next photo @desktop", async ({
  page,
}) => {
  const { deleted } = await mockRecordPhotos(page);
  await page.goto("/records");
  await page.getByRole("button", { name: "Beach" }).click();
  const viewer = page.getByRole("dialog", { name: "Photo viewer: Beach" });
  await deleteFromMenu(page, viewer, "More actions");

  // The review names the file by its path inside the record root.
  const review = page.getByRole("dialog", { name: "Review deletion" });
  await expect(review.getByText("Trip/Beach.png", { exact: true })).toBeVisible();
  // Escape closes the review, not the viewer under it.
  await page.keyboard.press("Escape");
  await expect(review).toHaveCount(0);
  await expect(viewer).toBeVisible();

  await deleteFromMenu(page, viewer, "More actions");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  expect(deleted).toEqual([]);
  await page.getByRole("button", { name: "Move to trash", exact: true }).click();

  await expect.poll(() => deleted).toEqual([1]);
  await expect(page.getByRole("dialog", { name: "Photo viewer: Harbor" })).toBeVisible();
  await expect(page.getByText("Moved Beach.png to the trash.")).toBeVisible();
});

test("a Record folder moves to the trash with everything in it after two confirmations @desktop", async ({ page }) => {
  const { deletedFolders } = await mockRecordPhotos(page);
  await page.goto("/records");
  await deleteFromMenu(page, page, "More actions for Trip");

  const review = page.getByRole("dialog", { name: "Review deletion" });
  await expect(review.getByText("Delete the folder Trip with everything in it.")).toBeVisible();
  await expect(review.getByText("Trip", { exact: true })).toBeVisible();
  await review.getByRole("button", { name: "Continue", exact: true }).click();
  expect(deletedFolders).toEqual([]);
  await page.getByRole("button", { name: "Move to trash", exact: true }).click();

  await expect.poll(() => deletedFolders).toEqual([3]);
  await expect(page.getByText("Moved Trip to the trash.")).toBeVisible();
  await expect(page.getByRole("button", { name: "More actions for Trip" })).toHaveCount(0);
});
