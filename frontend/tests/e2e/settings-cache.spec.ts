import { expect, test, type Page } from "@playwright/test";

async function mockCacheSettings(page: Page, onCleanup: (payload: unknown) => void) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({
        json: {
          authenticated: true,
          user: {
            id: 1,
            username: "admin",
            displayName: "Admin",
            role: "admin",
            permissions: ["library:read", "sources:write", "downloads:manage", "users:manage"],
            devMode: true,
          },
        },
      });
      return;
    }
    if (url.pathname === "/api/runtime-settings") {
      await route.fulfill({ json: { cacheEnabled: true, directoryRoutingRules: [], recommendationThreshold: 50 } });
      return;
    }
    if (url.pathname === "/api/settings") {
      await route.fulfill({
        json: {
          localScanDepth: 4,
          cacheEnabled: true,
          cacheLimitGb: 20,
          remoteSaveTemplate: "/data/<source_name>/<code_prefix>/<code_group>/<work_code>",
          remoteDelayBaseSeconds: 0.5,
          remoteDelayRandomSeconds: 1.5,
          remoteBackoffSeconds: 30,
          remoteMaxBackoffSeconds: 300,
          circleAutoRefreshDays: 30,
          dlsiteMetadataLanguage: "ja-jp",
          directoryRoutingRules: [],
          recommendationThreshold: 50,
          dataRoot: "/data",
          cacheRoot: "/cache",
          fileSources: [],
        },
      });
      return;
    }
    if (url.pathname === "/api/users") {
      await route.fulfill({ json: [{ id: 1, username: "admin", displayName: "Admin", role: "admin", enabled: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }] });
      return;
    }
    if (url.pathname === "/api/cache/overview") {
      await route.fulfill({
        json: {
          scannedAt: "2026-07-14T00:00:00Z",
          mediaFiles: 14,
          mediaBytes: 157286400,
          referencedFiles: 10,
          referencedBytes: 125829120,
          orphanFiles: 3,
          orphanBytes: 31457280,
          protectedFiles: 1,
          missingReferences: 2,
          emptyDirectories: 1,
          works: [
            {
              groupKey: "1:remote-a:RJ09990001",
              workId: 1,
              workCode: "RJ09990001",
              sourceId: 1,
              sourceCode: "remote-a",
              sourceName: "Example Remote",
              files: 8,
              bytes: 104857600,
              referencedFiles: 6,
              referencedBytes: 83886080,
              orphanFiles: 2,
              orphanBytes: 20971520,
              emptyDirectories: 1,
              tracked: false,
              local: false,
            },
          ],
        },
      });
      return;
    }
    if (url.pathname === "/api/cache/cleanup" && route.request().method() === "POST") {
      onCleanup(route.request().postDataJSON());
      await route.fulfill({ status: 202, json: { runId: 52, jobId: 53, status: "queued", queued: 4 } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: `Not mocked: ${url.pathname}` } });
  });
}

test("cache settings scan managed media and require cleanup confirmation", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const cleanupRequests: unknown[] = [];
  await mockCacheSettings(page, (payload) => { cleanupRequests.push(payload); });
  await page.goto("/maintenance?tab=cache");

  await expect(page.getByText("Managed media cache", { exact: true })).toBeVisible();
  await expect(page.getByText("150 MB", { exact: true })).toBeVisible();
  await expect(page.getByText("30 MB", { exact: true })).toBeVisible();
  await expect(page.getByText("RJ09990001", { exact: true })).toBeVisible();

  await page.getByRole("checkbox", { name: "Select cache for RJ09990001" }).click();
  await page.getByRole("button", { name: "Clean selected orphans" }).click();
  expect(cleanupRequests).toHaveLength(0);
  await expect(page.getByRole("button", { name: "Confirm cleanup (2 files)" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm cleanup (2 files)" }).click();
  await expect.poll(() => cleanupRequests).toHaveLength(1);
  expect(cleanupRequests[0]).toEqual({ mode: "orphans", groupKeys: ["1:remote-a:RJ09990001"] });
  await expect(page.getByText("Cleanup queued in workflow run #52 (4 items).", { exact: true })).toBeVisible();
});

test("cache settings can clear referenced cache for selected works", async ({ page }) => {
  const cleanupRequests: unknown[] = [];
  await mockCacheSettings(page, (payload) => { cleanupRequests.push(payload); });
  await page.goto("/maintenance?tab=cache");
  await page.getByRole("button", { name: "Work cache", exact: true }).click();
  await page.getByRole("checkbox", { name: "Select cache for RJ09990001" }).click();
  await page.getByRole("button", { name: "Clean selected works" }).click();
  await page.getByRole("button", { name: "Confirm cleanup (6 files)" }).click();
  await expect.poll(() => cleanupRequests).toHaveLength(1);
  expect(cleanupRequests[0]).toEqual({ mode: "works", workIds: [1] });
});

test("personal settings stay separate from administrator maintenance", async ({ page }) => {
  await mockCacheSettings(page, () => undefined);
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings", exact: true, level: 2 })).toBeVisible();
  await expect(page.getByText("Account", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Theme preference")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cache & Fetch", exact: true })).toHaveCount(0);

  await page.goto("/users");
  await expect(page.getByRole("heading", { name: "Maintenance", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Users", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("User directory", { exact: true })).toBeVisible();
});
