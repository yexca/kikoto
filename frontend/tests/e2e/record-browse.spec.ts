import { expect, test } from "@playwright/test";

import type { RecordAsset, RecordRoot } from "../../src/lib/api";
import { rolePermissions, runtimeSettingsFixture } from "./fixtures/api";
import { mockApplication } from "./fixtures/player-library";
import { recordTreeResponse } from "./fixtures/records";

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

test("a Record section reads its later pages as the end of the section comes into view @desktop", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    permissions: rolePermissions.user,
  });
  await page.route("**/api/runtime-settings", (route) =>
    route.fulfill({ json: { ...runtimeSettingsFixture(), recordLibraryEnabled: true } }),
  );
  const photos = [photo(1, "Beach.png"), photo(2, "Harbor.png"), photo(3, "Lighthouse.png")];
  // The cursor of each section page read after the first.
  const cursors: string[] = [];
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
      const section = url.searchParams.get("section");
      if (section) cursors.push(`${section} ${url.searchParams.get("after")}`);
      // Two children to a page.
      return route.fulfill({ json: recordTreeResponse(url, [], photos, 2) });
    }
    if (url.pathname === "/api/records/continue") return route.fulfill({ json: { assets: [] } });
    if (/^\/api\/records\/assets\/\d+\/stream$/.test(url.pathname)) {
      return route.fulfill({ contentType: "image/png", body: pixel });
    }
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });

  await page.goto("/records");
  // The photo on the section's second page is listed with the others.
  for (const name of ["Beach", "Harbor", "Lighthouse"]) {
    await expect(page.getByRole("button", { name })).toBeVisible();
  }
  expect(cursors).toEqual(["photos 2"]);
});
