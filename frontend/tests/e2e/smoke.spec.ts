import { expect, test, type Page } from "@playwright/test";

async function mockAppShell(page: Page) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({ json: { authenticated: false } });
      return;
    }
    if (url.pathname === "/api/runtime-settings") {
      await route.fulfill({ json: { mode: "production", cacheEnabled: false, directoryRoutingRules: [] } });
      return;
    }
    if (url.pathname === "/api/app-update") {
      await route.fulfill({
        json: {
          currentVersion: "v0.4.1",
          latestVersion: "v0.4.1",
          updateAvailable: false,
          releaseUrl: "",
          checkedAt: "2026-01-01T00:00:00Z",
        },
      });
      return;
    }
    if (url.pathname === "/api/works") {
      await route.fulfill({ json: { works: [], page: 1, pageSize: 24, total: 0 } });
      return;
    }
    if (url.pathname === "/api/library-sources") {
      await route.fulfill({ json: [] });
      return;
    }
    if (url.pathname === "/api/recently-played-works") {
      await route.fulfill({ json: { works: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not mocked" } });
  });
}

test("@smoke renders the anonymous library shell", async ({ page }) => {
  await mockAppShell(page);
  await page.goto("/");

  await expect(page.locator("footer").getByRole("button", { name: "Library", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open appearance settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Account menu" })).toHaveCount(0);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const accountSheet = page.getByRole("dialog", { name: "Account" });
  await expect(accountSheet).toBeVisible();
  await expect(accountSheet.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
});

test("@smoke opens About without an update icon when current", async ({ page }) => {
  await mockAppShell(page);
  await page.goto("/about");

  await expect(page.getByRole("heading", { name: "About", exact: true })).toBeVisible();
  await expect(page.getByText(/About Kikoto.*v0\.4\.1/)).toBeVisible();
  await expect(page.getByLabel(/Update available/)).toHaveCount(0);
});
