import { expect, test, type Page } from "@playwright/test";

async function mockCacheSettings(page: Page, onCleanup: () => void) {
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
            permissions: ["library:read", "sources:write", "downloads:manage"],
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
            { workCode: "RJ09990001", sourceId: 1, sourceName: "Example Remote", files: 8, bytes: 104857600, orphanFiles: 2, orphanBytes: 20971520, tracked: false, local: false },
          ],
        },
      });
      return;
    }
    if (url.pathname === "/api/cache/cleanup" && route.request().method() === "POST") {
      onCleanup();
      await route.fulfill({ status: 202, json: { runId: 52, jobId: 53, status: "queued", queued: 4 } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: `Not mocked: ${url.pathname}` } });
  });
}

test("cache settings scan managed media and require cleanup confirmation", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  let cleanupRequests = 0;
  await mockCacheSettings(page, () => { cleanupRequests += 1; });
  await page.goto("/settings");
  await page.getByRole("button", { name: "Cache & Fetch", exact: true }).click();

  await expect(page.getByText("Managed media cache", { exact: true })).toBeVisible();
  await expect(page.getByText("150 MB", { exact: true })).toBeVisible();
  await expect(page.getByText("30 MB", { exact: true })).toBeVisible();
  await expect(page.getByText("RJ09990001", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Clean orphan cache" }).click();
  expect(cleanupRequests).toBe(0);
  await expect(page.getByRole("button", { name: "Confirm cleanup (3 files)" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm cleanup (3 files)" }).click();
  await expect.poll(() => cleanupRequests).toBe(1);
  await expect(page.getByText("Cleanup queued in workflow run #52 (4 items).", { exact: true })).toBeVisible();
});
