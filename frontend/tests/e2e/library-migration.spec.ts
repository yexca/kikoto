import { expect, test } from "@playwright/test";

import type { LibraryMigrationStatus } from "../../src/lib/api";
import { runtimeSettingsFixture, type ApiErrorBody } from "./fixtures/api";
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

test("sign-in stays quiet while a password is typed", async ({ page }) => {
  await mockApplication(page);
  await page.route("**/api/runtime-settings", (route) =>
    route.fulfill({ json: runtimeSettingsFixture({ anonymousAccessEnabled: false }) }),
  );
  await page.clock.install();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in to Kikoto" })).toBeVisible();

  // Password managers treat a request after a password is entered as a submitted login.
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/api/")) apiRequests.push(pathname);
  });
  await page.getByLabel("Password").fill("synthetic-password");
  await page.clock.runFor(10_000);
  await page.getByLabel("Username").fill("synthetic-user");

  expect(apiRequests).toEqual([]);
});

test("a request refused for maintenance shows the maintenance notice @desktop", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, { authenticated: true });
  let maintenance = false;
  await page.route("**/api/library/migration/public", (route) => route.fulfill({ json: { maintenance } }));
  await page.route("**/api/works/1/user-state", (route) => {
    maintenance = true;
    return route.fulfill({
      status: 503,
      json: {
        error: "The site is under maintenance. Please return later.",
        code: "site_maintenance",
        retryable: true,
      } satisfies ApiErrorBody,
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Mark: Unmarked" }).click();
  await page.getByRole("button", { name: "Want", exact: true }).click();

  await expect(page.getByRole("heading", { name: /under maintenance/i })).toBeVisible();
});
