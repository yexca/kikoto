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
    definitionJson: '{"nodes":[{"id":"select","type":"select_works","displayName":"Select works"},{"id":"sync","type":"sync_metadata","displayName":"Sync metadata"}]}',
    scope: "user",
    editable: true,
    ownerUserId: 1,
    triggerCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
];

const sampleRun = {
  id: 51,
  workflowCode: "dlsite_popular_collection",
  displayName: "Collect DLsite popular voice works",
  status: "succeeded",
  triggerType: "manual",
  triggerReason: "day",
  createdAt: "2026-07-14T00:00:00Z",
  startedAt: "2026-07-14T00:00:00Z",
  finishedAt: "2026-07-14T00:01:00Z",
  summaryJson: '{"synced":2,"tagged":2}',
  nodeRunCount: 2,
  completedNodeRuns: 2,
  failedNodeRuns: 0,
  skippedNodeRuns: 0,
  jobCount: 1,
  completedJobs: 1,
  failedJobs: 0,
  skippedJobs: 0,
  candidateCount: 0,
  pendingCandidates: 0,
  acceptedCandidates: 0,
  rejectedCandidates: 0,
  reviewedAt: "",
  reviewedByUserId: null,
  definitionId: 3,
  triggerId: null,
};

const sampleNodes = [
  { id: 501, nodeId: "discover", nodeType: "discover_provider_ranking", displayName: "Discover ranking", position: 1, status: "succeeded", inputJson: "{}", outputJson: '{"count":2}', errorMessage: "", startedAt: "2026-07-14T00:00:00Z", finishedAt: "2026-07-14T00:00:05Z", createdAt: "2026-07-14T00:00:00Z" },
  { id: 502, nodeId: "tag", nodeType: "assign_user_tags", displayName: "Add user tag", position: 2, status: "running", inputJson: "{}", outputJson: "{}", errorMessage: "", startedAt: "2026-07-14T00:00:05Z", finishedAt: "", createdAt: "2026-07-14T00:00:00Z" },
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
      await route.fulfill({ json: { runs: url.searchParams.get("workflowCode") === "metadata_sync" ? [] : [sampleRun], page: 1, pageSize: Number(url.searchParams.get("pageSize") ?? 10), total: url.searchParams.get("workflowCode") === "metadata_sync" ? 0 : 1 } });
      return;
    }
    if (url.pathname === "/api/workflow-runs/51") {
      await route.fulfill({ json: { ...sampleRun, nodeRuns: sampleNodes } });
      return;
    }
    if (url.pathname === "/api/workflow-runs/51/events") {
      await route.fulfill({ json: [{ id: 701, runId: 51, nodeRunId: 502, jobId: 1, level: "info", eventType: "node.progress", message: "Tagging works", detailJson: '{"current":1,"total":2}', createdAt: "2026-07-14T00:00:10Z" }] });
      return;
    }
    if (url.pathname === "/api/workflow-runs/51/candidates") {
      await route.fulfill({ json: [] });
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
  await expect(page.getByLabel("Workflow node canvas")).toBeVisible();
  await expect(page.getByText("Recent runs", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Year", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Only works released within 30 days" })).toHaveCount(0);
  await page.getByLabel("Ranking year").selectOption("2025");
  await expect(page.getByText(/-DL-year-2025-popular$/)).toBeVisible();
  await page.getByRole("button", { name: "Run collection" }).click();
  await expect(page.getByText(/run #31 queued/)).toBeVisible();

  await page.goto("/about");
  await page.goto("/workflows");
  await expect(page.getByRole("heading", { name: "Collect DLsite popular voice works", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /#51 day/ }).click();
  await expect(page).toHaveURL(/\/activity\?view=completed&run=51/);
});

test("legacy custom definitions remain read-only while showing their linear connections", async ({ page }) => {
  await mockWorkflows(page);
  await page.goto("/workflows");

  await page.getByRole("button", { name: /Custom draft/ }).click();
  await expect(page.getByRole("heading", { name: "Custom draft", exact: true })).toBeVisible();
  await expect(page.getByText("Legacy upgrade is reserved for a future release. This definition remains read-only, and its original linear connections are shown below.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Upgrade workflow", exact: true })).toBeDisabled();
  const legacyCanvas = page.getByLabel("Workflow node canvas");
  await expect(legacyCanvas).toBeVisible();
  await expect(legacyCanvas.locator(".react-flow__edge")).toHaveCount(1);
  await expect(legacyCanvas.locator(".react-flow__handle")).toHaveCount(2);
  await expect(legacyCanvas.locator(".react-flow__controls-button")).toHaveCount(4);
  await legacyCanvas.getByRole("button", { name: "Show minimap" }).click();
  await expect(legacyCanvas.getByLabel("Workflow minimap")).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit workflow", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Preview / Run", exact: true })).toHaveCount(0);
});

test("activity presents overview, canvas, items, and node logs vertically", async ({ page }) => {
  await mockWorkflows(page);
  await page.goto("/activity?view=completed&run=51");

  await expect(page.getByText("Summary", { exact: true })).toBeVisible();
  await expect(page.getByText("Execution", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Workflow node canvas")).toBeVisible();
  await expect(page.getByText("Node logs", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Add user tag.*1 events.*running/i })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("Tagging works", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Overview", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Steps", exact: true })).toHaveCount(0);
});

test("activity deep links load a run outside the visible list page", async ({ page }) => {
  await mockWorkflows(page);
  const detachedRun = { ...sampleRun, id: 99, displayName: "Detached cleanup run" };
  await page.route("**/api/workflow-runs/99**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/events") || url.pathname.endsWith("/candidates")) {
      await route.fulfill({ json: [] });
      return;
    }
    await route.fulfill({ json: { ...detachedRun, nodeRuns: [] } });
  });

  await page.goto("/activity?run=99");

  await expect(page).toHaveURL(/\/activity\?view=completed&run=99/);
  await expect(page.getByText("Detached cleanup run", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Collect DLsite popular voice works/ })).toBeVisible();
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
