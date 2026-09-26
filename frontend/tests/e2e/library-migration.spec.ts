import { expect, test } from "@playwright/test";

import type { LibraryMigrationStatus } from "../../src/lib/api";
import { mockApplication } from "./fixtures/player-library";

test("administrator sees storage migration progress and can retry a failed move @desktop", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    permissions: ["library:read", "sources:write"],
  });
  await page.route("**/api/library/migration/public", (route) => route.fulfill({ json: { maintenance: true } }));
  let status: LibraryMigrationStatus = {
    status: "failed",
    phase: "copy",
    progressCurrent: 1,
    progressTotal: 2,
    progressBytesCurrent: 1073741824,
    progressBytesTotal: 2147483648,
  };
  await page.route("**/api/library/migration", (route) => route.fulfill({ json: status }));
  await page.route("**/api/library/migration/retry", (route) => {
    status = { ...status, status: "running" };
    return route.fulfill({ json: status });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: /under maintenance/i })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("1 / 2 folders, 1.00 / 2.00 GiB");
  await page.getByRole("button", { name: "Retry migration" }).click();
  await expect(page.getByRole("button", { name: "Retry migration" })).toHaveCount(0);
});

test("ordinary user sees only the maintenance notice @desktop", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    permissions: ["library:read"],
  });
  await page.route("**/api/library/migration/public", (route) => route.fulfill({ json: { maintenance: true } }));
  let privilegedRequests = 0;
  await page.route("**/api/library/migration", (route) => {
    privilegedRequests++;
    return route.fulfill({ status: 403 });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: /under maintenance/i })).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);
  expect(privilegedRequests).toBe(0);
});
