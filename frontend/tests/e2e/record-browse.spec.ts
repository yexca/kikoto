import { expect, test } from "@playwright/test";

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
    folderId: 0,
    name,
    relativePath: name,
    kind: "image",
    mimeType: "image/png",
    availability: "available",
    streamUrl: `/api/records/assets/${id}/stream`,
  };
}

test("a Record folder lists every child when its listing spans several pages @desktop", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    permissions: rolePermissions.user,
  });
  await page.route("**/api/runtime-settings", (route) =>
    route.fulfill({ json: { ...runtimeSettingsFixture(), recordLibraryEnabled: true } }),
  );
  const photos = [photo(1, "Beach.png"), photo(2, "Harbor.png"), photo(3, "Lighthouse.png")];
  const offsets: string[] = [];
  await page.route("**/api/records**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/records") {
      const root: RecordRoot = {
        id: 1,
        displayName: "Record",
        state: "online",
        lastScannedAt: "2026-01-01T00:00:00Z",
        scanGeneration: 1,
      };
      return route.fulfill({ json: { root } });
    }
    if (url.pathname === "/api/records/tree") {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      offsets.push(String(offset));
      // Two children to a page.
      const tree: RecordTree = { folderId: 0, folders: [], assets: photos.slice(offset, offset + 2), total: 3 };
      if (offset + 2 < photos.length) tree.nextOffset = offset + 2;
      return route.fulfill({ json: tree });
    }
    if (url.pathname === "/api/records/continue") return route.fulfill({ json: { assets: [] } });
    if (/^\/api\/records\/assets\/\d+\/stream$/.test(url.pathname)) {
      return route.fulfill({ contentType: "image/png", body: pixel });
    }
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });

  await page.goto("/records");
  // The child on the second page is listed with the others.
  for (const name of ["Beach", "Harbor", "Lighthouse"]) {
    await expect(page.getByRole("button", { name })).toBeVisible();
  }
  expect(new Set(offsets)).toEqual(new Set(["0", "2"]));
});
