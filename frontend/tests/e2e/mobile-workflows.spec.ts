import { expect, test, type Page } from "@playwright/test";

const systemDefinitions = [
  {
    id: 1,
    code: "metadata_sync",
    displayName: "Sync work metadata",
    description: "Test metadata workflow.",
    definitionJson: '{"nodes":[]}',
    scope: "system",
    editable: false,
    ownerUserId: null,
    triggerCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  {
    id: 2,
    code: "media_cache",
    displayName: "Cache media",
    description: "Test cache workflow.",
    definitionJson: '{"nodes":[]}',
    scope: "system",
    editable: false,
    ownerUserId: null,
    triggerCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
];

async function mockWorkflows(page: Page) {
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
            role: "super_admin",
            permissions: ["system:admin"],
            devMode: true,
          },
        },
      });
      return;
    }
    if (url.pathname === "/api/workflow-definitions") {
      await route.fulfill({ json: systemDefinitions });
      return;
    }
    if (url.pathname === "/api/workflow-node-types" || url.pathname === "/api/workflow-triggers") {
      await route.fulfill({ json: [] });
      return;
    }
    if (url.pathname === "/api/workflow-runs") {
      await route.fulfill({ json: { runs: [], page: 1, pageSize: 10, total: 0 } });
      return;
    }
    if (url.pathname === "/api/runtime-settings") {
      await route.fulfill({ json: { cacheEnabled: false, directoryRoutingRules: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not mocked" } });
  });
}

test("workflow selection stays within its view and survives page navigation", async ({ page }) => {
  await mockWorkflows(page);
  await page.goto("/workflows");

  await expect(page.getByText("No user workflows exist yet. Create one to define a reusable pipeline.")).toHaveCount(2);
  await expect(page.getByRole("heading", { name: "Cache media", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "System", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sync work metadata", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Cache media/ }).click();
  await expect(page.getByRole("heading", { name: "Cache media", exact: true })).toBeVisible();

  await page.goto("/about");
  await page.goto("/workflows");
  await expect(page.getByRole("button", { name: "System", exact: true })).toHaveClass(/bg-primary/);
  await expect(page.getByRole("heading", { name: "Cache media", exact: true })).toBeVisible();
});

test("mobile header keeps actions in bounds and exposes theme and activity", async ({ page }) => {
  await mockWorkflows(page);
  await page.goto("/workflows");

  await expect(page.getByRole("button", { name: "Open command palette" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();
  await page.getByRole("button", { name: "Open menu" }).click();
  await expect(page.getByRole("button", { name: "Activity", exact: true })).toBeVisible();
  await expect(page.getByText("Theme", { exact: true })).toBeVisible();

  const menuBox = await page
    .getByText("Theme", { exact: true })
    .locator("..", { has: page.getByRole("button", { name: "dark" }) })
    .boundingBox();
  expect(menuBox).not.toBeNull();
  expect(menuBox!.x).toBeGreaterThanOrEqual(0);
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width);

  await page.getByRole("button", { name: "dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await expect(page).toHaveURL(/\/activity$/);
});

test("desktop header popovers render above page content", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockWorkflows(page);
  await page.goto("/workflows");

  await page.getByRole("button", { name: "Theme" }).click();
  const popover = page.getByText("Choose display mode").locator("..");
  await expect(popover).toBeVisible();
  const headerBox = await page.locator("header").boundingBox();
  const popoverBox = await popover.boundingBox();
  expect(headerBox).not.toBeNull();
  expect(popoverBox).not.toBeNull();
  expect(popoverBox!.y + popoverBox!.height).toBeGreaterThan(headerBox!.y + headerBox!.height);
  await page.getByRole("button", { name: "dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
});
