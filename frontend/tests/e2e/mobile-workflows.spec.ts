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
  {
    id: 3,
    code: "dlsite_popular_collection",
    displayName: "Collect DLsite popular voice works",
    description: "Discover ranking works, sync metadata, and add a user tag.",
    definitionJson: '{"nodes":[{"id":"configure","type":"select_ranking","displayName":"Configure ranking"},{"id":"discover","type":"discover_provider_ranking","displayName":"Discover ranking"},{"id":"metadata","type":"sync_metadata","displayName":"Sync metadata"},{"id":"tag","type":"assign_user_tags","displayName":"Add user tag"}]}',
    scope: "system",
    editable: false,
    ownerUserId: null,
    triggerCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  {
    id: 4,
    code: "remote_popular_collection",
    displayName: "Collect popular remote works",
    description: "Discover popular works from a selected compatible source, track or fetch them, and append a user tag.",
    definitionJson: '{"nodes":[{"id":"configure","type":"select_remote_source","displayName":"Configure remote collection"},{"id":"discover","type":"discover_remote_collection","displayName":"Discover popular works"},{"id":"filter","type":"filter_candidates","displayName":"Filter collection candidates"},{"id":"dispatch","type":"dispatch_child_workflows","displayName":"Dispatch accepted works"},{"id":"tag","type":"assign_user_tags","displayName":"Add user tag"}]}',
    scope: "system",
    editable: false,
    ownerUserId: null,
    triggerCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  {
    id: 5,
    code: "custom_draft",
    displayName: "Custom draft",
    description: "Test custom definition.",
    definitionJson: '{"nodes":[{"id":"select","type":"select_works","displayName":"Select works"}]}',
    scope: "user",
    editable: true,
    ownerUserId: 1,
    triggerCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
];

async function mockWorkflows(page: Page, onRemotePopular?: (payload: unknown) => void) {
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
    if (url.pathname === "/api/workflow-runs/dlsite-popular") {
      const payload = route.request().postDataJSON() as { period: string; releaseWindow: string; year: number; tagName: string };
      await route.fulfill({ json: { runId: 31, status: "queued", ...payload, discovered: 0, synced: 0, tagged: 0, failed: 0, failures: [] } });
      return;
    }
    if (url.pathname === "/api/library-sources") {
      await route.fulfill({
        json: [{ id: 8, code: "remote-test", displayName: "Remote Test", sourceType: "kikoeru_compatible", enabled: true, cacheEnabled: true }],
      });
      return;
    }
    if (url.pathname === "/api/workflow-runs/remote-popular") {
      const payload = route.request().postDataJSON() as { sourceId: number; action: "track" | "fetch"; limit: number; tagName: string };
      onRemotePopular?.(payload);
      await route.fulfill({ json: { runId: 41, status: "queued", collectionKind: "popular", discovered: 0, accepted: 0, skipped: 0, tracked: 0, fetched: 0, tagged: 0, failed: 0, childRuns: [], failures: [], expectedMaximum: payload.limit, returnedCount: 0, ...payload } });
      return;
    }
    if (url.pathname === "/api/runtime-settings") {
      await route.fulfill({ json: { cacheEnabled: false, directoryRoutingRules: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not mocked" } });
  });
}

test("definitions foreground runnable presets and configure DLsite popular collection", async ({ page }) => {
  await mockWorkflows(page);
  await page.goto("/workflows");

  await expect(page.getByText("Ready to run", { exact: true })).toBeVisible();
  await expect(page.getByText("Custom definitions", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "System", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Cache media/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Sync work metadata", exact: true })).toBeVisible();

  await page.getByRole("button", { name: /Collect DLsite popular voice works/ }).click();
  await expect(page.getByRole("heading", { name: "Collect DLsite popular voice works", exact: true })).toBeVisible();
  await expect(page.getByText("Ranking period", { exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Only works released within 30 days" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText(/-DL-24h-r30d-popular$/)).toBeVisible();

  await page.getByRole("button", { name: "Year", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Only works released within 30 days" })).toHaveCount(0);
  await page.getByLabel("Ranking year").selectOption("2025");
  await expect(page.getByText(/-DL-year-2025-popular$/)).toBeVisible();
  await page.getByRole("button", { name: "Run collection" }).click();
  await expect(page.getByText(/run #31 queued/)).toBeVisible();

  await page.goto("/about");
  await page.goto("/workflows");
  await expect(page.getByRole("heading", { name: "Collect DLsite popular voice works", exact: true })).toBeVisible();
});

test("remote popular collection requires an explicit source and queues configured options", async ({ page }) => {
  const payloads: unknown[] = [];
  await mockWorkflows(page, (payload) => payloads.push(payload));
  await page.goto("/workflows");
  await page.getByRole("button", { name: /Collect popular remote works/ }).click();

  await expect(page.getByLabel("Remote source")).toHaveValue("8");
  await page.getByRole("button", { name: "fetch", exact: true }).click();
  await page.getByLabel("Work limit").selectOption("50");
  await page.getByLabel("User tag").fill("weekly-remote-picks");
  await page.getByRole("button", { name: "Run collection" }).click();

  await expect.poll(() => payloads).toHaveLength(1);
  expect(payloads[0]).toEqual({ sourceId: 8, action: "fetch", limit: 50, tagName: "weekly-remote-picks" });
  await expect(page.getByText(/run #41 queued/)).toBeVisible();
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
