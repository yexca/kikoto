import { expect, test, type Page } from "@playwright/test";

import type { RecordAsset, RecordRoot, RecordTree } from "../../src/lib/api";
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
  const deleted: number[] = [];
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
      return route.fulfill({ json: { folderId: 0, folders: [], assets: photos } satisfies RecordTree });
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
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });
  return { deleted };
}

test("a Record photo moves to the trash after two confirmations and the viewer shows the next photo @desktop", async ({
  page,
}) => {
  const { deleted } = await mockRecordPhotos(page);
  await page.goto("/records");
  await page.getByRole("button", { name: "Beach" }).click();
  const viewer = page.getByRole("dialog", { name: "Photo viewer: Beach" });
  await viewer.getByRole("button", { name: "Delete", exact: true }).click();

  // The review names the file by its path inside the record root.
  const review = page.getByRole("dialog", { name: "Review deletion" });
  await expect(review.getByText("Trip/Beach.png", { exact: true })).toBeVisible();
  // Escape closes the review, not the viewer under it.
  await page.keyboard.press("Escape");
  await expect(review).toHaveCount(0);
  await expect(viewer).toBeVisible();

  await viewer.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  expect(deleted).toEqual([]);
  await page.getByRole("button", { name: "Move to trash", exact: true }).click();

  await expect.poll(() => deleted).toEqual([1]);
  await expect(page.getByRole("dialog", { name: "Photo viewer: Harbor" })).toBeVisible();
  await expect(page.getByText("Moved Beach.png to the trash.")).toBeVisible();
});
