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
  {
    id: 6,
    code: "availability_watch",
    displayName: "Availability Watch",
    description: "Monitor configured works without creating Activity entries.",
    definitionJson: '{"nodes":[]}',
    scope: "system",
    editable: false,
    ownerUserId: null,
    triggerCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  {
    id: 7,
    code: "local_library_scan",
    displayName: "Scan local library",
    description: "Discover local works and synchronize missing metadata.",
    definitionJson: '{"nodes":[{"id":"select","type":"select_local_source","displayName":"Select local source"},{"id":"discover","type":"discover_local_files","displayName":"Discover files"},{"id":"match","type":"match_works","displayName":"Match works"},{"id":"sync","type":"sync_file_locations","displayName":"Sync locations"},{"id":"metadata","type":"sync_metadata","displayName":"Sync metadata"}]}',
    scope: "system",
    editable: false,
    ownerUserId: null,
    triggerCount: 2,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
];

const workflowTriggers = [
  { id: 71, workflowDefinitionId: 7, workflowCode: "local_library_scan", displayName: "Startup local library scan", triggerType: "startup", enabled: true, scheduleJson: '{"type":"startup"}', configJson: "{}", nextRunAt: null, lastRunAt: null, lastSuccessAt: null, lastErrorMessage: "", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
  { id: 72, workflowDefinitionId: 7, workflowCode: "local_library_scan", displayName: "Watch data folders", triggerType: "filesystem_event", enabled: true, scheduleJson: '{"type":"filesystem_event"}', configJson: "{}", nextRunAt: null, lastRunAt: null, lastSuccessAt: null, lastErrorMessage: "", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
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

const sampleRunGraph = JSON.stringify({
  schemaVersion: 1,
  nodes: [
    { id: "discover", type: "discover_provider_ranking", displayName: "Discover ranking", position: { x: 0, y: 48 }, inputs: [], outputs: [{ id: "works", dataType: "work_candidates" }] },
    { id: "tag", type: "assign_user_tags", displayName: "Add user tag", position: { x: 250, y: 48 }, inputs: [{ id: "works", dataType: "work_candidates" }], outputs: [] },
  ],
  edges: [{ id: "discover_to_tag", source: "discover", sourceHandle: "works", target: "tag", targetHandle: "works", dataType: "work_candidates" }],
});

async function mockWorkflows(
  page: Page,
  onRemotePopular?: (payload: unknown) => void,
  runsPage = { runs: [sampleRun], page: 1, pageSize: 10, total: 1, viewTotals: { running: 0, review: 0, failed: 0, completed: 1 } },
  notificationPage = { notifications: [] as Array<Record<string, unknown>>, total: 0 },
  onAvailabilityWatch?: (payload: unknown) => void,
) {
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
            demoMode: false,
            passwordManagedBy: "account",
          },
        },
      });
      return;
    }
    if (url.pathname === "/api/notifications") {
      await route.fulfill({ json: notificationPage });
      return;
    }
    if (url.pathname.startsWith("/api/notifications/") && route.request().method() === "DELETE") {
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (url.pathname === "/api/workflow-definitions") {
      await route.fulfill({ json: systemDefinitions });
      return;
    }
    if (url.pathname === "/api/availability-watch") {
      const payload = route.request().method() === "PUT" ? route.request().postDataJSON() : null;
      if (payload) onAvailabilityWatch?.(payload);
      await route.fulfill({ json: {
        id: 1,
        enabled: payload ? (payload as { enabled: boolean }).enabled : true,
        intervalMinutes: payload ? (payload as { intervalMinutes: number }).intervalMinutes : 60,
        action: payload ? (payload as { action: string }).action : "monitor",
        sourceId: payload ? (payload as { sourceId: number | null }).sourceId : null,
        excludeExtensions: payload ? (payload as { excludeExtensions: string[] }).excludeExtensions : ["wav"],
        revision: 2,
        targets: [
          { id: 1, workCode: "RJ09999991", state: "monitoring", nextCheckAt: "2026-07-27T01:00:00Z", lastCheckedAt: "", lastStatus: "", lastError: "", availableSourceId: null, trackRunId: null, fetchRunId: null },
          { id: 2, workCode: "RJ09999992", state: "completed", nextCheckAt: "", lastCheckedAt: "2026-07-27T00:00:00Z", lastStatus: "available", lastError: "", availableSourceId: 8, trackRunId: null, fetchRunId: 88 },
        ],
      } });
      return;
    }
    if (url.pathname === "/api/workflow-node-types") {
      await route.fulfill({ json: [] });
      return;
    }
    if (url.pathname === "/api/workflow-triggers") {
      await route.fulfill({ json: workflowTriggers });
      return;
    }
    if (url.pathname === "/api/workflow-runs") {
      await route.fulfill({
        json: url.searchParams.get("workflowCode") === "metadata_sync"
          ? { runs: [], page: 1, pageSize: Number(url.searchParams.get("pageSize") ?? 10), total: 0, viewTotals: runsPage.viewTotals }
          : { ...runsPage, pageSize: Number(url.searchParams.get("pageSize") ?? runsPage.pageSize) },
      });
      return;
    }
    if (url.pathname === "/api/workflow-runs/51") {
      await route.fulfill({ json: { ...sampleRun, nodeRuns: sampleNodes, graphJson: sampleRunGraph } });
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
      const payload = route.request().postDataJSON() as { period: string; releaseWindow: string; year: number; tagNameTemplate: string };
      await route.fulfill({ json: { runId: 31, status: "queued", ...payload, tagName: "resolved-dlsite-popular", discovered: 0, synced: 0, tagged: 0, failed: 0, failures: [] } });
      return;
    }
    if (url.pathname === "/api/library-sources") {
      await route.fulfill({
        json: [{ id: 8, code: "remote-test", displayName: "Remote Test", sourceType: "kikoeru_compatible", enabled: true, cacheEnabled: true }],
      });
      return;
    }
    if (url.pathname === "/api/workflow-runs/remote-popular") {
      const payload = route.request().postDataJSON() as { sourceId: number; action: "track" | "fetch"; limit: number; tagNameTemplate: string };
      onRemotePopular?.(payload);
      await route.fulfill({ json: { runId: 41, status: "queued", collectionKind: "popular", tagName: "resolved-remote-popular", discovered: 0, accepted: 0, skipped: 0, tracked: 0, fetched: 0, tagged: 0, failed: 0, childRuns: [], failures: [], expectedMaximum: payload.limit, returnedCount: 0, ...payload } });
      return;
    }
    if (url.pathname === "/api/runtime-settings") {
      await route.fulfill({ json: { cacheEnabled: false, directoryRoutingRules: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not mocked" } });
  });
}

test("mobile notification center opens fetched works and dismisses individual results", async ({ page }) => {
  await mockWorkflows(page, undefined, undefined, {
    total: 2,
    notifications: [
      { id: 2, workflowRunId: 72, type: "remote_fetch", status: "failed", workId: 12, workCode: "RJ09999996", message: "Fetch failed for RJ09999996.", createdAt: "2026-07-27T02:00:00Z" },
      { id: 1, workflowRunId: 71, type: "remote_fetch", status: "succeeded", workId: 11, workCode: "RJ09999995", message: "Fetch completed for RJ09999995.", createdAt: "2026-07-27T01:00:00Z" },
    ],
  });
  await page.goto("/workflows");

  await page.getByRole("button", { name: "Notifications", exact: true }).click();
  await expect(page.getByText("Fetch completed for RJ09999995.", { exact: true })).toBeVisible();
  const dismissRequest = page.waitForRequest((request) => request.method() === "DELETE" && request.url().endsWith("/api/notifications/1"));
  await page.getByRole("button", { name: "Dismiss notification for RJ09999995" }).click();
  await dismissRequest;
  await expect(page.getByText("Fetch completed for RJ09999995.", { exact: true })).toHaveCount(0);

  await page.getByText("Fetch failed for RJ09999996.", { exact: true }).click();
  await expect(page).toHaveURL(/\/RJ09999996\?view=local$/);
});

test("definitions foreground runnable presets and configure DLsite popular collection", async ({ page }) => {
  await mockWorkflows(page);
  await page.goto("/workflows");

  await expect(page.getByRole("tab", { name: /Built-in/ })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: /Custom/ }).click();
  await expect(page.getByRole("tab", { name: /Custom/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "New workflow", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /Built-in/ }).click();
  const dlsiteDefinition = page.getByRole("button", { name: /Collect DLsite popular voice works/ });
  await expect(dlsiteDefinition.getByText("Built-in", { exact: true })).toHaveCount(0);
  await expect(dlsiteDefinition.getByText("manual", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "System", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Cache media/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Sync work metadata", exact: true })).toBeVisible();

  await page.getByRole("button", { name: /Collect DLsite popular voice works/ }).click();
  await expect(page.getByRole("heading", { name: "Collect DLsite popular voice works", exact: true })).toBeVisible();
  await expect(page.getByText("Ranking period", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  let configureDialog = page.getByRole("dialog", { name: "Configure DLsite popular collection" });
  await expect(configureDialog.getByText("Ranking period", { exact: true }).first()).toBeVisible();
  await expect(configureDialog.getByRole("switch", { name: "Only works released within 30 days" })).toHaveAttribute("aria-checked", "true");
  let dlsiteTagField = configureDialog.getByTestId("dlsite-popular-tag-template-field");
  await expect(dlsiteTagField.getByLabel("Tag template", { exact: true })).toHaveValue("{date}_DL_{period}_{release_window}_popular");
  await expect(dlsiteTagField).toContainText(/Preview.*_DL_24h_r30d_popular/);
  await expect(dlsiteTagField.getByText("{release_window}", { exact: true })).toBeVisible();
  await configureDialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByLabel("Workflow node canvas")).toBeVisible();
  await expect(page.getByText("Recent runs", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Add schedule", exact: true }).click();
  const scheduleDialog = page.getByRole("dialog", { name: "New schedule" });
  await expect(scheduleDialog).toBeVisible();
  await expect(scheduleDialog.getByLabel("Ranking period")).toHaveValue("day");
  await expect(scheduleDialog.getByLabel("Release window")).toHaveValue("");
  await expect(scheduleDialog.getByLabel("Tag template", { exact: true })).toHaveValue("{date}_DL_{period}_{release_window}_popular");
  await expect(scheduleDialog.getByTestId("dlsite-trigger-tag-template-field")).toContainText(/Preview.*_DL_24h_all_popular/);
  await scheduleDialog.getByRole("button", { name: "Close", exact: true }).click();

  await page.getByRole("button", { name: "Configure", exact: true }).click();
  configureDialog = page.getByRole("dialog", { name: "Configure DLsite popular collection" });
  dlsiteTagField = configureDialog.getByTestId("dlsite-popular-tag-template-field");
  await configureDialog.getByRole("button", { name: "Year", exact: true }).click();
  await expect(configureDialog.getByRole("switch", { name: "Only works released within 30 days" })).toHaveCount(0);
  await configureDialog.getByLabel("Ranking year").selectOption("2025");
  await expect(dlsiteTagField.getByLabel("Tag template", { exact: true })).toHaveValue("{date}_DL_year_{year}_popular");
  await expect(dlsiteTagField).toContainText(/Preview.*_DL_year_2025_popular/);
  const dlsiteRequest = page.waitForRequest((request) => request.url().endsWith("/api/workflow-runs/dlsite-popular"));
  await page.getByRole("button", { name: "Run collection" }).click();
  expect((await dlsiteRequest).postDataJSON()).toEqual({ period: "year", releaseWindow: "", year: 2025, tagNameTemplate: "{date}_DL_year_{year}_popular" });
  await expect(page.getByText(/run #31 queued/)).toBeVisible();

  await page.goto("/about");
  await page.goto("/workflows");
  await expect(page.getByRole("heading", { name: "Collect DLsite popular voice works", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /#51 day/ }).click();
  await expect(page).toHaveURL(/\/activity\?view=completed&run=51/);
});

test("local scan exposes its fixed folder watcher without edit controls", async ({ page }) => {
  await mockWorkflows(page);
  await page.goto("/workflows");

  await page.getByRole("button", { name: /Scan local library/ }).click();
  await expect(page.getByRole("switch", { name: "Pause Watch data folders", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("When local library folders change", { exact: true })).toBeVisible();
  await expect(page.getByText("Watching for folder changes", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit Watch data folders", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add filesystem trigger", exact: true })).toHaveCount(0);
});

test("legacy custom definitions remain read-only while showing their linear connections", async ({ page }) => {
  await mockWorkflows(page);
  await page.goto("/workflows");

  await page.getByRole("tab", { name: /Custom/ }).click();
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

test("availability watch keeps monitoring and ready pools outside Activity", async ({ page }) => {
  const updates: unknown[] = [];
  await mockWorkflows(page, undefined, undefined, undefined, (payload) => updates.push(payload));
  await page.goto("/workflows");

  await page.getByRole("button", { name: /Availability Watch/ }).click();
  await expect(page.getByRole("heading", { name: "Availability Watch", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Monitoring", exact: true }).locator("..")).toContainText("1");
  await expect(page.getByRole("heading", { name: "Ready", exact: true }).locator("..")).toContainText("1");
  await expect(page.getByText("dispatched", { exact: true })).toBeVisible();

  const works = page.getByRole("textbox", { name: "Works" });
  await works.fill("RJ09999991, invalid; RJ09999992");
  await expect(page.getByText("1 invalid", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save watch", exact: true })).toBeDisabled();
  await works.fill("RJ09999991, RJ09999992; RJ09999992");
  await expect(page.getByText("2 valid", { exact: true })).toBeVisible();
  await expect(page.getByText("1 duplicate", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save watch", exact: true }).click();

  await expect.poll(() => updates).toHaveLength(1);
  expect(updates[0]).toMatchObject({ targetCodes: ["RJ09999991", "RJ09999992"], excludeExtensions: ["wav"] });
  await expect(page).toHaveURL(/\/workflows$/);
});

test("activity presents overview, canvas, items, and node logs vertically", async ({ page }) => {
  await mockWorkflows(page);
  await page.goto("/activity?view=completed&run=51");

  await expect(page.getByText("Summary", { exact: true })).toBeVisible();
  await expect(page.getByText("Execution", { exact: true })).toBeVisible();
  const executionCanvas = page.getByLabel("Workflow node canvas");
  await expect(executionCanvas).toBeVisible();
  await executionCanvas.scrollIntoViewIfNeeded();
  await expect(executionCanvas.locator(".react-flow__edge")).toHaveCount(1);
  await expect(executionCanvas.locator(".workflow-data-edge--active")).toHaveCount(1);
  await expect(executionCanvas.locator(".react-flow__arrowhead")).toHaveCount(0);
  await expect(executionCanvas.locator('.react-flow__node[data-id="tag"] .workflow-run-node--running')).toBeVisible();
  await expect(executionCanvas.locator(".react-flow__edge-path")).toHaveCSS("stroke", "rgb(139, 92, 246)");
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

test("activity uses compact counted tabs and a single empty state", async ({ page }) => {
  await mockWorkflows(page, undefined, {
    runs: [],
    page: 1,
    pageSize: 10,
    total: 0,
    viewTotals: { running: 0, review: 2, failed: 0, completed: 14 },
  });
  await page.goto("/activity?view=running");

  await expect(page.getByRole("button", { name: "Running 0", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Review 2", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Completed 14", exact: true })).toBeVisible();
  await expect(page.getByText("No workflows are running.", { exact: true })).toBeVisible();
  await expect(page.getByText("Page 1 / 1", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Select a run to inspect execution by node.", { exact: true })).toHaveCount(0);

  const tabs = page.getByRole("button", { name: "Running 0", exact: true }).locator("..");
  await expect.poll(() => tabs.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("remote popular collection requires an explicit source and queues configured options", async ({ page }) => {
  const payloads: unknown[] = [];
  await mockWorkflows(page, (payload) => payloads.push(payload));
  await page.goto("/workflows");
  await page.getByRole("button", { name: /Collect popular remote works/ }).click();
  await page.getByRole("button", { name: "Configure", exact: true }).click();

  const configureDialog = page.getByRole("dialog", { name: "Configure remote popular collection" });
  await expect(configureDialog.getByLabel("Remote source")).toHaveValue("8");
  await configureDialog.getByRole("button", { name: "fetch", exact: true }).click();
  await configureDialog.getByLabel("Work limit").selectOption("50");
  const remoteTagField = configureDialog.getByTestId("remote-popular-tag-template-field");
  await expect(remoteTagField.getByRole("button", { name: /\{remote_name\}.*Remote_Test/ })).toBeVisible();
  await expect(remoteTagField.getByRole("button", { name: /\{source_code\}.*remote-test/ })).toBeVisible();
  await expect(remoteTagField.getByRole("button", { name: /\{action\}.*fetch/ })).toBeVisible();
  await remoteTagField.getByLabel("Tag template", { exact: true }).fill("weekly_{source_code}_{action}_popular");
  await expect(remoteTagField).toContainText("weekly_remote-test_fetch_popular");
  await configureDialog.getByRole("button", { name: "Run collection" }).click();

  await expect.poll(() => payloads).toHaveLength(1);
  expect(payloads[0]).toEqual({ sourceId: 8, action: "fetch", limit: 50, tagNameTemplate: "weekly_{source_code}_{action}_popular" });
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
  await page.getByRole("button", { name: "Blue accent" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme-accent", "blue");
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await expect(page).toHaveURL(/\/activity$/);
});

test("desktop header popovers render above page content", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockWorkflows(page);
  await page.goto("/workflows");

  await page.getByRole("button", { name: "Theme" }).click();
  const popover = page.getByText("Mode and accent").locator("..");
  await expect(popover).toBeVisible();
  const headerBox = await page.locator("header").boundingBox();
  const popoverBox = await popover.boundingBox();
  expect(headerBox).not.toBeNull();
  expect(popoverBox).not.toBeNull();
  expect(popoverBox!.y + popoverBox!.height).toBeGreaterThan(headerBox!.y + headerBox!.height);
  await page.getByRole("button", { name: "dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
});

test("settings persists display mode and accent color together", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockWorkflows(page);
  await page.goto("/settings");

  await page.getByRole("button", { name: "Green", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme-accent", "green");
  await expect(page.getByRole("button", { name: "Green", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme-accent", "green");
});

test("settings identifies an environment-managed root password", async ({ page }) => {
  await mockWorkflows(page);
  await page.route("**/api/auth/me", (route) => route.fulfill({
    json: {
      authenticated: true,
      user: {
        id: 1,
        username: "configured-root",
        displayName: "Configured Root",
        role: "super_admin",
        permissions: ["system:admin"],
        devMode: false,
        demoMode: false,
        passwordManagedBy: "environment",
      },
    },
  }));

  await page.goto("/settings");
  await expect(page.getByRole("status")).toContainText("KIKOTO_ROOT_PASSWORD");
  await expect(page.getByLabel("Current password")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Change password", exact: true })).toHaveCount(0);
});

test("demo settings and scheduled workflows expose read-only controls", async ({ page }) => {
  await mockWorkflows(page);
  await page.route("**/api/runtime-settings", (route) => route.fulfill({
    json: { mode: "demo", demoMode: true, cacheEnabled: false, directoryRoutingRules: [] },
  }));

  await page.goto("/settings");
  await expect(page.getByRole("status")).toHaveText("Demo mode is read-only.");
  for (const name of ["Light", "Dark", "System", "Pink", "Blue", "Green"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
  }

  await page.goto("/workflows");
  await expect(page.getByText("Demo mode is read-only. Workflow definitions, schedules, runs, and reviews cannot be changed.", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /Custom/ }).click();
  await expect(page.getByRole("button", { name: "New workflow", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New workflow", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New workflow" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview only", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Run at startup", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add schedule", exact: true })).toHaveCount(0);
});
