import { expect, test, type Page } from "@playwright/test";

const nodeTypes = [
  nodeType("workflow_input", "target", "Workflow input", [], [{ id: "value", label: "Value", type: "dynamic", required: false, multiple: true }]),
  nodeType("circle_catalog", "discover", "Circle catalog", [{ id: "circle", label: "Circle", type: "circle_id", required: true, multiple: false }], [{ id: "works", label: "Works", type: "work_candidates", required: false, multiple: true }], true, ["mode", "maxWorks"]),
  nodeType("filter_works", "filter", "Filter works", [{ id: "works", label: "Works", type: "work_candidates", required: true, multiple: false }], [{ id: "accepted", label: "Accepted", type: "work_candidates", required: false, multiple: true }, { id: "rejected", label: "Rejected", type: "work_candidates", required: false, multiple: true }], false, ["limit"]),
  nodeType("check_source_availability", "match", "Check source availability", [{ id: "works", label: "Works", type: "work_candidates", required: true, multiple: false }], [{ id: "available", label: "Available", type: "work_candidates", required: false, multiple: true }, { id: "missing", label: "Missing", type: "work_candidates", required: false, multiple: true }, { id: "error", label: "Error", type: "work_candidates", required: false, multiple: true }], true, ["sourceId"]),
  nodeType("fetch_works", "execute", "Fetch works", [{ id: "works", label: "Works", type: "work_candidates", required: true, multiple: false }], [{ id: "completed", label: "Completed", type: "work_refs", required: false, multiple: true }, { id: "failed", label: "Failed", type: "work_candidates", required: false, multiple: true }], true, ["excludeExtensions", "maxWorks", "maxFiles", "maxBytes", "allowUnknownSizes", "targetRoot"]),
  nodeType("tag_works", "commit", "Tag works", [{ id: "works", label: "Works", type: "work_refs", required: true, multiple: false }, { id: "tag", label: "Tag", type: "text", required: false, multiple: false }], [{ id: "completed", label: "Completed", type: "work_refs", required: false, multiple: true }], true, ["tagName"]),
];

const workflowDocument = {
  schemaVersion: 2,
  command: { enabled: true, alias: "getCircle" },
  inputs: [{ key: "circle", label: "Circle", type: "circle_id", required: true }],
  policy: { requirePreview: true },
  nodes: [
    { id: "circle_input", type: "workflow_input", displayName: "Circle", config: { inputKey: "circle" }, position: { x: 0, y: 120 } },
    { id: "circle_catalog", type: "circle_catalog", displayName: "Circle catalog", config: { mode: "stored", maxWorks: 100 }, position: { x: 290, y: 120 } },
    { id: "filter", type: "filter_works", displayName: "Filter works", config: { limit: 25 }, position: { x: 580, y: 120 } },
    { id: "availability", type: "check_source_availability", displayName: "Check availability", config: { sourceId: 8 }, position: { x: 870, y: 120 } },
    { id: "fetch", type: "fetch_works", displayName: "Fetch without WAV", config: { excludeExtensions: ["wav"], maxWorks: 25, maxFiles: 5000, maxBytes: 2147483648, allowUnknownSizes: false }, position: { x: 1160, y: 80 } },
  ],
  edges: [
    edge("circle_input", "value", "circle_catalog", "circle"),
    edge("circle_catalog", "works", "filter", "works"),
    edge("filter", "accepted", "availability", "works"),
    edge("availability", "available", "fetch", "works"),
  ],
};

const definition = {
  id: 42,
  code: "circle_fetch_demo",
  displayName: "Circle fetch demo",
  description: "Fetch available circle works with bounded file rules.",
  definitionJson: JSON.stringify(workflowDocument),
  scope: "user",
  editable: true,
  ownerUserId: 1,
  triggerCount: 0,
  createdAt: "2026-07-16T00:00:00Z",
  updatedAt: "2026-07-16T00:00:00Z",
};

const foreignDefinition = {
  ...definition,
  id: 43,
  code: "foreign_circle_fetch",
  displayName: "Foreign circle fetch",
  ownerUserId: 2,
};

test("composes a typed DAG and launches a slash command through preview", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const runRequests: unknown[] = [];
  await mockComposer(page, runRequests);
  await page.goto("/workflows");

  await expect(page.getByRole("heading", { name: "Circle fetch demo" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Foreign circle fetch/ })).toBeVisible();
  await expect(page.getByLabel("Workflow DAG canvas")).toBeVisible();
  await page.getByRole("button", { name: "Edit workflow" }).click();
  const composer = page.getByRole("dialog", { name: "Edit workflow" });
  await expect(composer).toBeVisible();
  await expect(page.getByLabel("Workflow composer canvas")).toBeVisible();
  await expect(composer.locator(".react-flow__node", { hasText: "Fetch without WAV" })).toBeVisible();
  await expect(composer.locator('aside[aria-label="Node library"]')).toHaveCount(0);

  await composer.locator(".react-flow__node", { hasText: "Check availability" }).dispatchEvent("click");
  await expect(page.getByLabel("Delete selected node")).toBeVisible();
  await expect(page.getByLabel("Remote source")).toHaveValue("8");
  await expect(page.getByLabel("Remote source").getByRole("option", { name: "Local Library" })).toHaveCount(0);
  await composer.getByRole("button", { name: "Open node library" }).click();
  await page.getByRole("button", { name: /Tag works/ }).click();
  await expect(composer.locator(".react-flow__node", { hasText: "Tag works" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("workflow-composer.png"), fullPage: true });
  await page.getByRole("button", { name: "Close workflow composer" }).click();

  await page.getByRole("button", { name: "Scheduled", exact: true }).click();
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByText("New scheduled trigger", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Workflow").getByRole("option")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Close", exact: true }).click();

  await page.getByRole("button", { name: "Open command palette" }).click();
  await page.getByPlaceholder("Search, open a work code, or type /workflow").fill("/getCircle RG01234");
  await expect(page.getByRole("button", { name: /Preview Circle fetch demo/ })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /Preview Foreign circle fetch/ })).toHaveCount(0);
  await page.getByRole("button", { name: /Preview Circle fetch demo/ }).click();
  await expect(page.getByRole("dialog", { name: "Run Circle fetch demo" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Workflow preview" })).toBeVisible();
  await expect(page.getByText("Unknown", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Maximum bytes", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Queue run" }).click();

  await expect.poll(() => runRequests).toHaveLength(2);
  expect(runRequests).toEqual([
    { mode: "preview", inputs: { circle: "RG01234" } },
    { mode: "confirm", inputs: { circle: "RG01234" }, previewToken: "preview_42" },
  ]);
  await expect(page).toHaveURL(/\/activity\?view=running&run=77/);
});

test("mobile composer keeps node creation, canvas, inspector, and actions in bounds", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await mockComposer(page, []);
  await page.goto("/workflows");
  await page.getByRole("button", { name: /Circle fetch demo/ }).click();
  await page.getByRole("button", { name: "Edit workflow" }).click();

  const composer = page.getByRole("dialog", { name: "Edit workflow" });
  await expect(composer).toBeVisible();
  await expect(composer.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(composer.getByRole("button", { name: "Save" })).toBeVisible();
  await expect(composer.getByRole("button", { name: "Close workflow composer" })).toBeVisible();
  await composer.getByRole("button", { name: "Nodes", exact: true }).click();
  await expect(composer.getByRole("button", { name: "Circle input", exact: true })).toBeVisible();
  await expect(composer.getByLabel("Workflow composer canvas")).toBeVisible();

  await composer.getByRole("button", { name: "Tag works", exact: true }).click();
  const deleteButton = composer.getByLabel("Delete selected node");
  await deleteButton.scrollIntoViewIfNeeded();
  await expect(deleteButton).toBeVisible();
  await expect(composer.getByText("Works is not connected.", { exact: true })).toBeVisible();

  const bounds = await composer.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(412);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(915);
  expect(await composer.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("workflow-composer-mobile.png"), fullPage: true });
});

test("commits node positions after dragging and connects ports from either direction", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const savedDefinitions: Array<{ definitionJson: string }> = [];
  await mockComposer(page, [], { onDefinitionSaved: (payload) => savedDefinitions.push(payload) });
  await page.goto("/workflows");
  await page.getByRole("button", { name: "Edit workflow" }).click();

  const composer = page.getByRole("dialog", { name: "Edit workflow" });
  const draggedNode = composer.locator('.react-flow__node[data-id="circle_catalog"]');
  const initialBounds = await draggedNode.boundingBox();
  expect(initialBounds).not.toBeNull();
  const dragStartX = initialBounds!.x + initialBounds!.width / 2;
  const dragStartY = initialBounds!.y + Math.min(16, initialBounds!.height / 3);
  await page.mouse.move(dragStartX, dragStartY);
  await page.mouse.down();
  await page.mouse.move(dragStartX + 80, dragStartY + 48, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await draggedNode.boundingBox())?.x).toBeGreaterThan(initialBounds!.x + 50);

  await composer.getByRole("button", { name: "Open node library" }).click();
  await composer.getByRole("button", { name: /^Tag works/ }).click();
  await composer.locator(".react-flow__controls-fitview").click();
  const targetHandle = composer.locator('.react-flow__node[data-id="tag_works"] .react-flow__handle.target[data-handleid="works"]');
  const sourceHandle = composer.locator('.react-flow__node[data-id="fetch"] .react-flow__handle.source[data-handleid="completed"]');
  await expect(targetHandle).toBeInViewport();
  await expect(sourceHandle).toBeInViewport();
  const targetBounds = await targetHandle.boundingBox();
  const sourceBounds = await sourceHandle.boundingBox();
  expect(targetBounds).not.toBeNull();
  expect(sourceBounds).not.toBeNull();
  await page.mouse.move(targetBounds!.x + targetBounds!.width / 2, targetBounds!.y + targetBounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(sourceBounds!.x + sourceBounds!.width / 2, sourceBounds!.y + sourceBounds!.height / 2, { steps: 16 });
  await page.mouse.up();
  await expect(composer.getByText("5 connections", { exact: true })).toBeVisible();

  await composer.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => savedDefinitions).toHaveLength(1);
  const savedDocument = JSON.parse(savedDefinitions[0].definitionJson) as typeof workflowDocument;
  expect(savedDocument.nodes.find((node) => node.id === "circle_catalog")?.position).not.toEqual({ x: 290, y: 120 });
  expect(savedDocument.edges).toContainEqual(edge("fetch", "completed", "tag_works", "works"));
});

test("deletes an editable custom workflow after confirmation", async ({ page }) => {
  let deleteRequests = 0;
  await mockComposer(page, [], { onDefinitionDeleted: () => { deleteRequests += 1; } });
  await page.goto("/workflows");
  await page.getByRole("button", { name: "Edit workflow" }).click();

  const composer = page.getByRole("dialog", { name: "Edit workflow" });
  await composer.getByRole("button", { name: "Delete workflow" }).click();
  const confirmation = page.getByRole("dialog", { name: "Delete workflow?" });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "Delete", exact: true }).click();

  await expect.poll(() => deleteRequests).toBe(1);
  await expect(composer).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Circle fetch demo/ })).toHaveCount(0);
});

test("keeps a direct Quick Action open while confirmation is in flight", async ({ page }) => {
  let releaseConfirmation = () => {};
  const confirmationGate = new Promise<void>((resolve) => { releaseConfirmation = resolve; });
  let markConfirmationStarted = () => {};
  const confirmationStarted = new Promise<void>((resolve) => { markConfirmationStarted = resolve; });
  await mockComposer(page, [], {
    directLaunch: true,
    confirmationGate,
    onConfirmationStarted: markConfirmationStarted,
  });
  await page.goto("/workflows");

  await page.getByRole("button", { name: "Open command palette" }).click();
  await page.getByPlaceholder("Search, open a work code, or type /workflow").fill("/runCircle RG01234");
  await page.getByRole("button", { name: /Run Circle fetch demo/ }).click();
  await confirmationStarted;

  const dialog = page.getByRole("dialog", { name: "Run Circle fetch demo" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/workflows$/);

  releaseConfirmation();
  await expect(page).toHaveURL(/\/activity\?view=running&run=77/);
});

type MockComposerOptions = {
  directLaunch?: boolean;
  confirmationGate?: Promise<void>;
  onConfirmationStarted?: () => void;
  onDefinitionSaved?: (payload: { definitionJson: string }) => void;
  onDefinitionDeleted?: () => void;
};

async function mockComposer(page: Page, runRequests: unknown[], options: MockComposerOptions = {}) {
  const activeDocument = options.directLaunch
    ? { ...workflowDocument, command: { enabled: true, alias: "runCircle" }, policy: { requirePreview: false } }
    : workflowDocument;
  const activeDefinition = { ...definition, definitionJson: JSON.stringify(activeDocument) };
  let definitionDeleted = false;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") return route.fulfill({ json: { authenticated: true, user: { id: 1, username: "admin", displayName: "Admin", role: "super_admin", permissions: ["system:admin"], devMode: true } } });
    if (url.pathname === "/api/workflow-definitions") return route.fulfill({ json: definitionDeleted ? [foreignDefinition] : [activeDefinition, foreignDefinition] });
    if (url.pathname === "/api/workflow-node-types") return route.fulfill({ json: nodeTypes });
    if (url.pathname === "/api/workflow-triggers") return route.fulfill({ json: [] });
    if (url.pathname === "/api/library-sources") return route.fulfill({ json: [
      { id: 1, code: "local", displayName: "Local Library", sourceType: "local", enabled: true, cacheEnabled: false },
      { id: 8, code: "remote-test", displayName: "Remote Test", sourceType: "kikoeru_compatible", enabled: true, cacheEnabled: true },
    ] });
    if (url.pathname === "/api/workflow-definitions/42" && route.request().method() === "PATCH") {
      const payload = route.request().postDataJSON() as { definitionJson: string };
      options.onDefinitionSaved?.(payload);
      return route.fulfill({ json: { ...activeDefinition, ...payload } });
    }
    if (url.pathname === "/api/workflow-definitions/42" && route.request().method() === "DELETE") {
      definitionDeleted = true;
      options.onDefinitionDeleted?.();
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname === "/api/workflow-runs") return route.fulfill({ json: { runs: [], page: 1, pageSize: Number(url.searchParams.get("pageSize") ?? 10), total: 0 } });
    if (url.pathname === "/api/workflow-definitions/42/runs") {
      const payload = route.request().postDataJSON();
      runRequests.push(payload);
      if ((payload as { mode: string }).mode === "preview") return route.fulfill({ json: { mode: "preview", definitionId: 42, workflowCode: definition.code, status: "preview", previewToken: "preview_42", requiredPermissions: ["workflows:run", "downloads:manage"], normalizedInputs: { circle: "RG01234" }, plan: { nodeCount: 5, edgeCount: 4, topologicalOrder: activeDocument.nodes.map((node) => node.id), actions: activeDocument.nodes.map((node) => ({ nodeId: node.id, nodeType: node.type, displayName: node.displayName, phase: node.type === "fetch_works" ? "execute" : "discover", requiresConfirmation: node.type === "fetch_works" })), estimates: null, limits: [{ key: "maxBytes", label: "Maximum bytes", value: 2147483648, unit: "bytes" }] }, warnings: ["Fetch remains inside the recoverable publication boundary."] } });
      options.onConfirmationStarted?.();
      await options.confirmationGate;
      return route.fulfill({ status: 202, json: { mode: "confirm", runId: 77, status: "queued" } });
    }
    if (url.pathname === "/api/workflow-runs/77" ) return route.fulfill({ json: { id: 77, workflowCode: definition.code, displayName: definition.displayName, status: "queued", triggerType: "manual", triggerReason: "custom_definition", createdAt: "2026-07-16T00:00:00Z", startedAt: "", finishedAt: "", summaryJson: "{}", nodeRunCount: 0, completedNodeRuns: 0, failedNodeRuns: 0, skippedNodeRuns: 0, jobCount: 1, completedJobs: 0, failedJobs: 0, skippedJobs: 0, candidateCount: 0, pendingCandidates: 0, acceptedCandidates: 0, rejectedCandidates: 0, reviewedAt: "", reviewedByUserId: null, definitionId: 42, triggerId: null, nodeRuns: [] } });
    if (url.pathname.startsWith("/api/workflow-runs/77/")) return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { error: `Not mocked: ${url.pathname}` } });
  });
}

function nodeType(type: string, phase: string, displayName: string, inputPorts: unknown[], outputPorts: unknown[], composite = false, configKeys: string[] = []) {
  return { type, phase, displayName, description: `${displayName} description`, userVisible: true, composite, requiredPermissions: [], configSchema: JSON.stringify({ type: "object", properties: Object.fromEntries(configKeys.map((key) => [key, { description: key }])) }), inputSchema: "{}", outputSchema: "{}", inputPorts, outputPorts };
}

function edge(source: string, sourceHandle: string, target: string, targetHandle: string) {
  return { id: `${source}:${sourceHandle}->${target}:${targetHandle}`, source, sourceHandle, target, targetHandle };
}
