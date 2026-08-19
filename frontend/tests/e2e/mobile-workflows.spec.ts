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
    definitionJson:
      '{"nodes":[{"id":"configure","type":"select_ranking","displayName":"Configure ranking"},{"id":"discover","type":"discover_provider_ranking","displayName":"Discover ranking"},{"id":"metadata","type":"sync_metadata","displayName":"Sync metadata"},{"id":"tag","type":"assign_user_tags","displayName":"Add user tag"}]}',
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
    description:
      "Discover popular works from a selected compatible source, track or fetch them, and append a user tag.",
    definitionJson:
      '{"nodes":[{"id":"configure","type":"select_remote_source","displayName":"Configure remote collection"},{"id":"discover","type":"discover_remote_collection","displayName":"Discover popular works"},{"id":"filter","type":"filter_candidates","displayName":"Filter collection candidates"},{"id":"dispatch","type":"dispatch_child_workflows","displayName":"Dispatch accepted works"},{"id":"tag","type":"assign_user_tags","displayName":"Add user tag"}]}',
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
    definitionJson:
      '{"nodes":[{"id":"select","type":"select_works","displayName":"Select works"},{"id":"sync","type":"sync_metadata","displayName":"Sync metadata"}]}',
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
    description:
      "Monitor a shared pool of work codes and dispatch configured actions when a remote source becomes available.",
    definitionJson:
      '{"nodes":[{"id":"targets","type":"select_works","displayName":"Monitoring pool"},{"id":"check","type":"check_source_availability","displayName":"Check source availability"},{"id":"ready","type":"filter_candidates","displayName":"Ready pool"},{"id":"dispatch","type":"dispatch_child_workflows","displayName":"Dispatch configured action"}]}',
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
    description: "Discover local works and synchronize local source presence.",
    definitionJson:
      '{"nodes":[{"id":"select","type":"select_local_source","displayName":"Select local source"},{"id":"discover","type":"discover_local_files","displayName":"Discover files"},{"id":"match","type":"match_works","displayName":"Match works"},{"id":"sync","type":"sync_file_locations","displayName":"Sync locations"}]}',
    scope: "system",
    editable: false,
    ownerUserId: null,
    triggerCount: 2,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
];

const workflowTriggers = [
  {
    id: 71,
    workflowDefinitionId: 7,
    workflowCode: "local_library_scan",
    displayName: "Startup local library scan",
    triggerType: "startup",
    enabled: true,
    scheduleJson: '{"type":"startup"}',
    configJson: '{"followUpRun":false}',
    nextRunAt: null,
    lastRunAt: null,
    lastSuccessAt: null,
    lastErrorMessage: "",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  {
    id: 72,
    workflowDefinitionId: 7,
    workflowCode: "local_library_scan",
    displayName: "Watch data folders",
    triggerType: "filesystem_event",
    enabled: true,
    scheduleJson: '{"type":"filesystem_event"}',
    configJson: '{"followUpRun":false,"scanMode":"incremental"}',
    nextRunAt: null,
    lastRunAt: null,
    lastSuccessAt: null,
    lastErrorMessage: "",
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
  progressBytesCurrent: 0,
  progressBytesTotal: 0,
  progressBytesUnknownItems: 0,
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
  {
    id: 501,
    nodeId: "discover",
    nodeType: "discover_provider_ranking",
    displayName: "Discover ranking",
    position: 1,
    status: "succeeded",
    inputJson: "{}",
    outputJson: '{"count":2}',
    errorMessage: "",
    startedAt: "2026-07-14T00:00:00Z",
    finishedAt: "2026-07-14T00:00:05Z",
    createdAt: "2026-07-14T00:00:00Z",
  },
  {
    id: 502,
    nodeId: "tag",
    nodeType: "assign_user_tags",
    displayName: "Add user tag",
    position: 2,
    status: "running",
    inputJson: "{}",
    outputJson: "{}",
    errorMessage: "",
    startedAt: "2026-07-14T00:00:05Z",
    finishedAt: "",
    createdAt: "2026-07-14T00:00:00Z",
  },
];

const sampleRunGraph = JSON.stringify({
  schemaVersion: 1,
  nodes: [
    {
      id: "discover",
      type: "discover_provider_ranking",
      displayName: "Discover ranking",
      position: { x: 0, y: 48 },
      inputs: [],
      outputs: [{ id: "works", dataType: "work_candidates" }],
    },
    {
      id: "tag",
      type: "assign_user_tags",
      displayName: "Add user tag",
      position: { x: 250, y: 48 },
      inputs: [{ id: "works", dataType: "work_candidates" }],
      outputs: [],
    },
  ],
  edges: [
    {
      id: "discover_to_tag",
      source: "discover",
      sourceHandle: "works",
      target: "tag",
      targetHandle: "works",
      dataType: "work_candidates",
    },
  ],
});

async function mockWorkflows(
  page: Page,
  onRemotePopular?: (payload: unknown) => void,
  runsPage = {
    runs: [sampleRun],
    page: 1,
    pageSize: 10,
    total: 1,
    viewTotals: { running: 0, review: 0, failed: 0, completed: 1 },
  },
  notificationPage:
    | {
        notifications: Array<Record<string, unknown>>;
        page?: number;
        pageSize?: number;
        total: number;
        totalPages?: number;
        clearableTotal?: number;
      }
    | ((
        page: number,
        pageSize: number,
      ) => {
        notifications: Array<Record<string, unknown>>;
        page?: number;
        pageSize?: number;
        total: number;
        totalPages?: number;
        clearableTotal?: number;
      }) = { notifications: [] as Array<Record<string, unknown>>, total: 0 },
  onAvailabilityWatch?: (payload: unknown) => void,
  onClearSucceeded?: () => void,
) {
  let availabilityWatch = {
    id: 1,
    action: "monitor",
    sourceId: null as number | null,
    excludeExtensions: ["wav"],
    revision: 2,
    targets: [
      {
        id: 1,
        workCode: "RJ00000000",
        state: "monitoring",
        nextCheckAt: "2026-07-27T01:00:00Z",
        lastCheckedAt: "",
        lastStatus: "",
        lastError: "",
        availableSourceId: null as number | null,
        trackRunId: null as number | null,
        fetchRunId: null as number | null,
      },
      {
        id: 2,
        workCode: "RJ00000001",
        state: "completed",
        nextCheckAt: "",
        lastCheckedAt: "2026-07-27T00:00:00Z",
        lastStatus: "available",
        lastError: "",
        availableSourceId: 8 as number | null,
        trackRunId: null as number | null,
        fetchRunId: 88 as number | null,
      },
    ],
  };
  let activeTriggers = [...workflowTriggers];
  let nextTriggerID = 73;

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
      const requestedPage = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
      const requestedPageSize = Math.max(1, Number(url.searchParams.get("pageSize") ?? "50"));
      const response =
        typeof notificationPage === "function" ? notificationPage(requestedPage, requestedPageSize) : notificationPage;
      const clearableTotal = response.notifications.filter(
        (notification) =>
          notification.status === "succeeded" &&
          (notification.type === "remote_fetch" ||
            notification.type === "remote_track" ||
            notification.type === "availability_watch_ready"),
      ).length;
      await route.fulfill({
        json: {
          page: requestedPage,
          pageSize: requestedPageSize,
          totalPages: 1,
          clearableTotal,
          ...response,
        },
      });
      return;
    }
    if (url.pathname === "/api/notifications/clear-succeeded" && route.request().method() === "POST") {
      onClearSucceeded?.();
      await route.fulfill({ json: { ok: true, dismissed: 1 } });
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
      if (route.request().method() === "PUT") {
        const payload = route.request().postDataJSON() as {
          action: string;
          sourceId: number | null;
          excludeExtensions: string[];
        };
        onAvailabilityWatch?.(payload);
        availabilityWatch = {
          ...availabilityWatch,
          action: payload.action,
          sourceId: payload.sourceId,
          excludeExtensions: payload.excludeExtensions,
          revision: availabilityWatch.revision + 1,
        };
      }
      await route.fulfill({ json: availabilityWatch });
      return;
    }
    if (url.pathname === "/api/availability-watch/targets" && route.request().method() === "PUT") {
      const payload = route.request().postDataJSON() as { targetCodes: string[] };
      onAvailabilityWatch?.(payload);
      const currentByCode = new Map(availabilityWatch.targets.map((target) => [target.workCode, target]));
      availabilityWatch = {
        ...availabilityWatch,
        revision: availabilityWatch.revision + 1,
        targets: payload.targetCodes.map((workCode, index) => {
          const current = currentByCode.get(workCode);
          return (
            current ?? {
              id: 100 + index,
              workCode,
              state: "monitoring",
              nextCheckAt: "2026-07-27T01:00:00Z",
              lastCheckedAt: "",
              lastStatus: "",
              lastError: "",
              availableSourceId: null,
              trackRunId: null,
              fetchRunId: null,
            }
          );
        }),
      };
      await route.fulfill({ json: availabilityWatch });
      return;
    }
    if (url.pathname.startsWith("/api/availability-watch/targets/") && route.request().method() === "DELETE") {
      const targetID = Number(url.pathname.split("/").at(-1));
      onAvailabilityWatch?.({ deleteTargetId: targetID });
      availabilityWatch = {
        ...availabilityWatch,
        revision: availabilityWatch.revision + 1,
        targets: availabilityWatch.targets.filter((target) => target.id !== targetID),
      };
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (url.pathname.startsWith("/api/availability-watch/targets/") && route.request().method() === "POST") {
      const targetID = Number(url.pathname.split("/").at(-2));
      onAvailabilityWatch?.({ trackTargetId: targetID });
      availabilityWatch = {
        ...availabilityWatch,
        targets: availabilityWatch.targets.map((target) =>
          target.id === targetID ? { ...target, state: "completed", trackRunId: 89 } : target,
        ),
      };
      await route.fulfill({ json: { runId: 89, status: "queued" } });
      return;
    }
    if (url.pathname === "/api/availability-watch/run" && route.request().method() === "POST") {
      onAvailabilityWatch?.({ run: true });
      await route.fulfill({
        status: 202,
        json: {
          runId: 91,
          jobId: 92,
          status: "queued",
          targetCount: availabilityWatch.targets.length,
          checked: 0,
          ready: 0,
          dispatched: 0,
          newlyAvailableCodes: [],
          readyCodes: [],
          failures: [],
        },
      });
      return;
    }
    if (url.pathname === "/api/workflow-node-types") {
      await route.fulfill({ json: [] });
      return;
    }
    if (url.pathname === "/api/workflow-triggers") {
      if (route.request().method() === "POST") {
        const payload = route.request().postDataJSON() as {
          workflowDefinitionId: number;
          displayName: string;
          triggerType: string;
          enabled: boolean;
          scheduleJson: string;
          configJson: string;
        };
        const definition = systemDefinitions.find((item) => item.id === payload.workflowDefinitionId);
        const saved = {
          id: nextTriggerID++,
          workflowCode: definition?.code ?? "",
          nextRunAt: payload.enabled ? "2026-07-27T03:00:00Z" : null,
          lastRunAt: null,
          lastSuccessAt: null,
          lastErrorMessage: "",
          createdAt: "2026-07-27T00:00:00Z",
          updatedAt: "2026-07-27T00:00:00Z",
          ...payload,
        };
        activeTriggers = [...activeTriggers, saved];
        await route.fulfill({ json: saved });
        return;
      }
      await route.fulfill({ json: activeTriggers });
      return;
    }
    if (url.pathname === "/api/workflow-runs") {
      await route.fulfill({
        json:
          url.searchParams.get("workflowCode") === "metadata_sync"
            ? {
                runs: [],
                page: 1,
                pageSize: Number(url.searchParams.get("pageSize") ?? 10),
                total: 0,
                viewTotals: runsPage.viewTotals,
              }
            : { ...runsPage, pageSize: Number(url.searchParams.get("pageSize") ?? runsPage.pageSize) },
      });
      return;
    }
    if (url.pathname === "/api/workflow-runs/51") {
      await route.fulfill({ json: { ...sampleRun, nodeRuns: sampleNodes, graphJson: sampleRunGraph } });
      return;
    }
    if (url.pathname === "/api/workflow-runs/51/events") {
      await route.fulfill({
        json: [
          {
            id: 701,
            runId: 51,
            nodeRunId: 502,
            jobId: 1,
            level: "info",
            eventType: "node.progress",
            message: "Tagging works",
            detailJson: '{"current":1,"total":2}',
            createdAt: "2026-07-14T00:00:10Z",
          },
        ],
      });
      return;
    }
    if (url.pathname === "/api/workflow-runs/51/candidates") {
      await route.fulfill({ json: [] });
      return;
    }
    if (url.pathname === "/api/workflow-runs/dlsite-popular") {
      const payload = route.request().postDataJSON() as {
        period: string;
        releaseWindow: string;
        year: number;
        tagNameTemplate: string;
      };
      await route.fulfill({
        json: {
          runId: 31,
          status: "queued",
          ...payload,
          tagName: "resolved-dlsite-popular",
          discovered: 0,
          synced: 0,
          tagged: 0,
          failed: 0,
          failures: [],
        },
      });
      return;
    }
    if (url.pathname === "/api/library-sources") {
      await route.fulfill({
        json: [
          {
            id: 8,
            code: "remote-test",
            displayName: "Remote Test",
            sourceType: "kikoeru_compatible",
            enabled: true,
            cacheEnabled: true,
          },
        ],
      });
      return;
    }
    if (url.pathname === "/api/workflow-runs/remote-popular") {
      const payload = route.request().postDataJSON() as {
        sourceId: number;
        action: "track" | "fetch";
        limit: number;
        tagNameTemplate: string;
      };
      onRemotePopular?.(payload);
      await route.fulfill({
        json: {
          runId: 41,
          status: "queued",
          collectionKind: "popular",
          tagName: "resolved-remote-popular",
          discovered: 0,
          accepted: 0,
          skipped: 0,
          tracked: 0,
          fetched: 0,
          tagged: 0,
          failed: 0,
          childRuns: [],
          failures: [],
          expectedMaximum: payload.limit,
          returnedCount: 0,
          ...payload,
        },
      });
      return;
    }
    if (url.pathname === "/api/runtime-settings") {
      await route.fulfill({
        json: {
          mode: "development",
          demoMode: false,
          anonymousAccessEnabled: false,
          cacheEnabled: false,
          directoryRoutingRules: [],
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not mocked" } });
  });
}

test("mobile notification center opens fetched works and dismisses individual results", async ({ page }) => {
  await mockWorkflows(page, undefined, undefined, {
    total: 2,
    notifications: [
      {
        id: 2,
        workflowRunId: 72,
        type: "remote_fetch",
        status: "failed",
        workId: 12,
        workCode: "RJ00000003",
        message: "Fetch failed for RJ00000003.",
        createdAt: "2026-07-27T02:00:00Z",
      },
      {
        id: 1,
        workflowRunId: 71,
        type: "remote_fetch",
        status: "succeeded",
        workId: 11,
        workCode: "RJ00000002",
        message: "Fetch completed for RJ00000002.",
        createdAt: "2026-07-27T01:00:00Z",
      },
    ],
  });
  await page.goto("/workflows");

  await page.getByRole("button", { name: "Notifications", exact: true }).click();
  await expect(page.getByText("Fetch completed for RJ00000002.", { exact: true })).toBeVisible();
  const dismissRequest = page.waitForRequest(
    (request) => request.method() === "DELETE" && request.url().endsWith("/api/notifications/1"),
  );
  await page.getByRole("button", { name: "Dismiss notification for RJ00000002" }).click();
  await dismissRequest;
  await expect(page.getByText("Fetch completed for RJ00000002.", { exact: true })).toHaveCount(0);

  await page.getByText("Fetch failed for RJ00000003.", { exact: true }).click();
  await expect(page).toHaveURL(/\/RJ00000003\?view=local$/);
});

test("notification center paginates and clears only succeeded remote notifications", async ({ page }) => {
  let cleared = false;
  const futureActionNotification = {
    id: 3,
    workflowRunId: 73,
    type: "future_review_action",
    status: "succeeded",
    workId: 13,
    workCode: "RJ00000004",
    message: "Review action remains available.",
    createdAt: "2026-07-27T03:00:00Z",
  };
  await mockWorkflows(
    page,
    undefined,
    undefined,
    (requestedPage) => {
      if (cleared) {
        return { notifications: [futureActionNotification], page: 1, total: 1, totalPages: 1, clearableTotal: 0 };
      }
      if (requestedPage === 2) {
        return {
          notifications: [futureActionNotification],
          page: 2,
          total: 51,
          totalPages: 2,
          clearableTotal: 1,
        };
      }
      return {
        notifications: [
          {
            id: 2,
            workflowRunId: 72,
            type: "remote_track",
            status: "failed",
            workId: 12,
            workCode: "RJ00000003",
            message: "Track failed for RJ00000003.",
            createdAt: "2026-07-27T02:00:00Z",
          },
          {
            id: 1,
            workflowRunId: 71,
            type: "remote_fetch",
            status: "succeeded",
            workId: 11,
            workCode: "RJ00000002",
            message: "Fetch completed for RJ00000002.",
            createdAt: "2026-07-27T01:00:00Z",
          },
        ],
        page: 1,
        total: 51,
        totalPages: 2,
        clearableTotal: 1,
      };
    },
    undefined,
    () => {
      cleared = true;
    },
  );
  await page.goto("/workflows");

  const notificationButton = page.getByRole("button", { name: "Notifications", exact: true });
  await notificationButton.click();
  const dialog = page.getByRole("dialog", { name: "Notifications" });
  await expect(dialog.getByText("Fetch completed for RJ00000002.", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Page 1 of 2", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Clear succeeded", exact: true })).toBeEnabled();

  await dialog.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(dialog.getByText("Page 2 of 2", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Review action remains available.", { exact: true })).toBeVisible();

  const clearRequest = page.waitForRequest(
    (request) => request.method() === "POST" && request.url().endsWith("/api/notifications/clear-succeeded"),
  );
  await dialog.getByRole("button", { name: "Clear succeeded", exact: true }).click();
  await clearRequest;
  await expect(dialog.getByText("Review action remains available.", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Fetch completed for RJ00000002.", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Clear succeeded", exact: true })).toBeDisabled();
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
  await expect(configureDialog.getByRole("switch", { name: "Only works released within 30 days" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  let dlsiteTagField = configureDialog.getByTestId("dlsite-popular-tag-template-field");
  await expect(dlsiteTagField.getByLabel("Tag template", { exact: true })).toHaveValue(
    "{date}_DL_{period}_{release_window}_popular",
  );
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
  await expect(scheduleDialog.getByLabel("Tag template", { exact: true })).toHaveValue(
    "{date}_DL_{period}_{release_window}_popular",
  );
  await expect(scheduleDialog.getByTestId("dlsite-trigger-tag-template-field")).toContainText(
    /Preview.*_DL_24h_all_popular/,
  );
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
  expect((await dlsiteRequest).postDataJSON()).toEqual({
    period: "year",
    releaseWindow: "",
    year: 2025,
    tagNameTemplate: "{date}_DL_year_{year}_popular",
  });
  await expect(page.getByText(/run #31 queued/)).toBeVisible();

  await page.goto("/about");
  await page.goto("/workflows");
  await expect(page.getByRole("heading", { name: "Collect DLsite popular voice works", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /#51 day/ }).click();
  await expect(page).toHaveURL(/\/activity\?view=completed&run=51/);
});

test("local scan folder watcher exposes incremental and full scan modes", async ({ page }) => {
  const triggerPayloads: Array<Record<string, unknown>> = [];
  await mockWorkflows(page);
  await page.route("**/api/workflow-triggers/72", async (route) => {
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    triggerPayloads.push(payload);
    await route.fulfill({ json: { ...workflowTriggers[1], configJson: payload.configJson } });
  });
  await page.goto("/workflows");

  await page.getByRole("button", { name: /Scan local library/ }).click();
  await expect(page.getByRole("switch", { name: "Pause Watch data folders", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByText("When local library folders change", { exact: true })).toBeVisible();
  await expect(page.getByText("Watching for folder changes", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit Watch data folders", exact: true }).click();
  const triggerDialog = page.getByRole("dialog", { name: "Edit trigger" });
  await expect(triggerDialog.getByRole("radio", { name: "Incremental", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await triggerDialog.getByRole("radio", { name: "Full", exact: true }).click();
  await expect(triggerDialog.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
  await triggerDialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => triggerPayloads).toHaveLength(1);
  expect(JSON.parse(String(triggerPayloads[0].configJson))).toEqual({ followUpRun: false, scanMode: "full" });
  await expect(page.getByRole("button", { name: "Add filesystem trigger", exact: true })).toHaveCount(0);
});

test("local scan follow-up is explicit and defaults off for manual and automatic runs", async ({ page }) => {
  const manualPayloads: unknown[] = [];
  const triggerPayloads: Array<Record<string, unknown>> = [];
  await mockWorkflows(page);
  await page.route("**/api/workflow-runs/local-scan", async (route) => {
    manualPayloads.push(route.request().postDataJSON());
    await route.fulfill({
      status: 202,
      json: {
        runId: 61,
        jobId: 71,
        fileSourceId: 0,
        status: "queued",
        detectedWorks: 0,
        scannedFiles: 0,
        updatedLocations: 0,
        skippedLocations: 0,
        followUpRun: (manualPayloads.at(-1) as { followUpRun: boolean }).followUpRun,
        newWorkCodes: [],
        failures: [],
      },
    });
  });
  await page.route("**/api/workflow-triggers/71", async (route) => {
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    triggerPayloads.push(payload);
    await route.fulfill({
      json: {
        ...workflowTriggers[0],
        configJson: payload.configJson,
      },
    });
  });

  await page.goto("/workflows");
  await page.getByRole("button", { name: /Scan local library/ }).click();
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  const runDialog = page.getByRole("dialog", { name: "Configure local library scan" });
  const manualFollowUp = runDialog.getByRole("switch", { name: "Follow-up run" });
  await expect(manualFollowUp).toHaveAttribute("aria-checked", "false");
  await manualFollowUp.click();
  await runDialog.getByRole("button", { name: "Run scan" }).click();
  await expect.poll(() => manualPayloads).toEqual([{ followUpRun: true }]);
  await runDialog.getByRole("button", { name: "Close", exact: true }).click();

  await page.getByRole("button", { name: "Edit Startup local library scan" }).click();
  const triggerDialog = page.getByRole("dialog", { name: "Edit trigger" });
  const triggerFollowUp = triggerDialog.getByRole("switch", { name: "Follow-up run" });
  await expect(triggerFollowUp).toHaveAttribute("aria-checked", "false");
  await triggerFollowUp.click();
  await triggerDialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => triggerPayloads).toHaveLength(1);
  expect(JSON.parse(String(triggerPayloads[0].configJson))).toEqual({ followUpRun: true });
});

test("legacy custom definitions remain read-only while showing their linear connections", async ({ page }) => {
  await mockWorkflows(page);
  await page.goto("/workflows");

  await page.getByRole("tab", { name: /Custom/ }).click();
  await page.getByRole("button", { name: /Custom draft/ }).click();
  await expect(page.getByRole("heading", { name: "Custom draft", exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "Legacy upgrade is reserved for a future release. This definition remains read-only, and its original linear connections are shown below.",
      { exact: true },
    ),
  ).toBeVisible();
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

test("availability watch shares pools, schedules checks, and handles ready works on mobile", async ({ page }) => {
  const updates: unknown[] = [];
  await mockWorkflows(page, undefined, undefined, undefined, (payload) => updates.push(payload));
  await page.goto("/workflows");

  await page.getByRole("button", { name: /Availability Watch/ }).click();
  await expect(page.getByRole("heading", { name: "Availability Watch", exact: true })).toBeVisible();
  const pools = page.getByLabel("Availability pools");
  await expect(pools).toContainText("Monitoring");
  await expect(pools).toContainText("Ready");
  await expect(pools).toContainText("1");
  await expect(page.getByLabel("Workflow node canvas")).toBeVisible();
  await expect(page.getByText("Recent runs", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Add schedule", exact: true }).click();
  const scheduleDialog = page.getByRole("dialog", { name: "New schedule" });
  await scheduleDialog.getByLabel("Name", { exact: true }).fill("Availability interval");
  await scheduleDialog.getByLabel("Interval (minutes)", { exact: true }).fill("120");
  await scheduleDialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit Availability interval", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Configure", exact: true }).click();
  const configureDialog = page.getByRole("dialog", { name: "Configure Availability Watch" });
  await configureDialog.getByRole("combobox", { name: "Remote source", exact: true }).selectOption({
    label: "Remote Test",
  });
  await configureDialog.getByRole("combobox", { name: "When available", exact: true }).selectOption({ label: "Track" });
  await configureDialog.getByLabel("Exclude extensions", { exact: true }).fill("wav, flac");
  await configureDialog.getByRole("button", { name: "Run now", exact: true }).click();
  await expect(page.getByText("Availability Watch run #91 queued.", { exact: true })).toBeVisible();
  await expect.poll(() => updates).toHaveLength(2);
  expect(updates).toContainEqual({ action: "track", sourceId: 8, excludeExtensions: ["wav", "flac"] });
  expect(updates).toContainEqual({ run: true });

  await pools.getByRole("button", { name: "Edit", exact: true }).click();
  const monitoringDialog = page.getByRole("dialog", { name: "Edit monitoring pool" });
  const works = monitoringDialog.getByRole("textbox", { name: "Works" });
  await works.fill("RJ00000000\nRJ00000001\nRJ00000002");
  await expect(monitoringDialog.getByText("3 valid", { exact: true })).toBeVisible();
  await monitoringDialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => updates).toHaveLength(3);
  expect(updates).toContainEqual({ targetCodes: ["RJ00000000", "RJ00000001", "RJ00000002"] });

  await pools.getByRole("button", { name: "View", exact: true }).click();
  const readyDialog = page.getByRole("dialog", { name: "Ready works (1)" });
  await expect(readyDialog.getByText("RJ00000001", { exact: true })).toBeVisible();
  const bounds = await readyDialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(412);
  expect(await readyDialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await readyDialog.getByRole("button", { name: "Track", exact: true }).click();
  await expect(page.getByText("Track run #89 queued.", { exact: true })).toBeVisible();
  await expect.poll(() => updates).toHaveLength(4);
  expect(updates).toContainEqual({ trackTargetId: 2 });
  await readyDialog.getByRole("button", { name: "Remove RJ00000001 from watch", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Ready works (0)" }).getByText("No available works.", { exact: true }),
  ).toBeVisible();
  expect(updates).toContainEqual({ deleteTargetId: 2 });
});

test("availability notifications open the shared ready pool", async ({ page }) => {
  await mockWorkflows(page, undefined, undefined, {
    total: 1,
    notifications: [
      {
        id: 9,
        workflowRunId: 91,
        type: "availability_watch_ready",
        status: "succeeded",
        workId: null,
        workCode: "RJ00000001",
        message: "RJ00000001 is now available.",
        createdAt: "2026-07-27T02:00:00Z",
      },
    ],
  });
  await page.goto("/workflows");

  await page.getByRole("button", { name: "Notifications", exact: true }).click();
  await page.getByText("RJ00000001 is now available.", { exact: true }).click();
  await expect(page).toHaveURL(/\/workflows\?workflow=availability_watch&dialog=ready&run=91$/);
  await expect(page.getByRole("heading", { name: "Availability Watch", exact: true })).toBeVisible();
  const readyDialog = page.getByRole("dialog", { name: "Ready works (1)" });
  await expect(readyDialog.getByText("RJ00000001", { exact: true })).toBeVisible();
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
  await expect(page.getByRole("button", { name: /Add user tag.*1 events.*running/i })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(page.getByText("Tagging works", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Overview", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Steps", exact: true })).toHaveCount(0);
});

test("activity reports Fetch byte progress without guessing unknown totals", async ({ page }) => {
  const knownTotal = 128 * 1024 * 1024;
  const current = 64 * 1024 * 1024;
  const unknownRun = {
    ...sampleRun,
    id: 52,
    workflowCode: "remote_work_fetch",
    displayName: "Fetch remote work",
    status: "running",
    finishedAt: "",
    completedJobs: 0,
    progressBytesCurrent: current,
    progressBytesTotal: knownTotal,
    progressBytesUnknownItems: 1,
  };
  const knownRun = { ...unknownRun, id: 53, progressBytesUnknownItems: 0 };
  await mockWorkflows(page, undefined, {
    runs: [unknownRun, knownRun],
    page: 1,
    pageSize: 10,
    total: 2,
    viewTotals: { running: 2, review: 0, failed: 0, completed: 0 },
  });
  await page.route(/\/api\/workflow-runs\/(52|53)(?:\/.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/events") || url.pathname.endsWith("/candidates")) {
      await route.fulfill({ json: [] });
      return;
    }
    await route.fulfill({
      json: { ...(url.pathname.endsWith("/52") ? unknownRun : knownRun), nodeRuns: [], graphJson: "{}" },
    });
  });

  await page.goto("/activity?view=running&run=52");
  const unknownProgress = page.getByRole("status", { name: "Fetch transfer progress" });
  await expect(unknownProgress).toContainText("64.0 MB transferred · 128.0 MB known total · 1 unknown-size file");
  await expect(unknownProgress.getByRole("progressbar")).toHaveCount(0);

  await page.goto("/activity?view=running&run=53");
  const progressbar = page.getByRole("progressbar", { name: "Fetch byte progress" });
  await expect(progressbar).toHaveAttribute("aria-valuenow", String(current));
  await expect(progressbar).toHaveAttribute("aria-valuemax", String(knownTotal));
  await expect(progressbar).toHaveAttribute("aria-valuetext", "64.0 MB of 128.0 MB");
});

test("blocked Fetch origins stay in Review with source recovery actions and bounded layout", async ({ page }) => {
  const blockedOrigin = "https://media.example.invalid:443";
  const longLegacyURL = `https://media.example.invalid/${"nested-path/".repeat(120)}track.mp3?token=synthetic`;
  const reviewRun = {
    ...sampleRun,
    workflowCode: "remote_work_fetch",
    displayName: "Fetch remote work",
    status: "partial",
    summaryJson: JSON.stringify({ review_required: true, blocked_origin: blockedOrigin, legacy_detail: longLegacyURL }),
    completedNodeRuns: 0,
    failedNodeRuns: 0,
    completedJobs: 0,
    failedJobs: 1,
    candidateCount: 1,
    pendingCandidates: 1,
  };
  const runsPage = {
    runs: [reviewRun],
    page: 1,
    pageSize: 10,
    total: 1,
    viewTotals: { running: 0, review: 1, failed: 0, completed: 0 },
  };
  await mockWorkflows(page, undefined, runsPage);
  let retries = 0;
  await page.route("**/api/workflow-runs/51", async (route) => {
    await route.fulfill({
      json: {
        ...reviewRun,
        nodeRuns: [
          {
            ...sampleNodes[0],
            nodeId: "cache",
            nodeType: "materialize_cache",
            displayName: "Cache selected files",
            status: "partial",
            outputJson: JSON.stringify({ legacy_detail: longLegacyURL }),
            errorMessage: `Remote download origin is not allowed by the source policy: ${blockedOrigin}`,
          },
        ],
        graphJson: "{}",
      },
    });
  });
  await page.route("**/api/workflow-runs/51/events", async (route) => {
    await route.fulfill({ json: [] });
  });
  await page.route("**/api/workflow-runs/51/candidates", async (route) => {
    await route.fulfill({
      json: [
        {
          id: 801,
          runId: 51,
          nodeRunId: 501,
          type: "remote_origin_blocked",
          externalKey: blockedOrigin,
          status: "pending",
          payloadJson: JSON.stringify({ origin: blockedOrigin, source_id: 8, reason: "origin_not_allowed" }),
          decisionJson: "{}",
          createdAt: "2026-07-14T00:00:00Z",
          updatedAt: "2026-07-14T00:00:00Z",
        },
      ],
    });
  });
  await page.route("**/api/workflow-runs/51/retry", async (route) => {
    retries += 1;
    await route.fulfill({ status: 202, json: { runId: 51, status: "retried", message: "retry started" } });
  });

  await page.setViewportSize({ width: 1265, height: 850 });
  await page.goto("/activity?view=review&run=51");
  await expect(page.getByText("Outbound origin blocked", { exact: true })).toBeVisible();
  await expect(page.getByText(blockedOrigin, { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Mark resolved" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ignore" })).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
    .toBe(true);

  await page.getByRole("button", { name: "Retry Fetch", exact: true }).click();
  await expect.poll(() => retries).toBe(1);
  await page.getByRole("button", { name: "Configure source", exact: true }).click();
  await expect(page).toHaveURL(/\/maintenance\?tab=library&source=8$/);
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
  await page.addInitScript(() => {
    const trackedWindow = window as typeof window & { __activityLoadingSeen?: boolean };
    trackedWindow.__activityLoadingSeen = false;
    const observer = new MutationObserver(() => {
      if (document.querySelector('[aria-label="Loading runs"]')) trackedWindow.__activityLoadingSeen = true;
    });
    observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-label"] });
  });
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
  await expect
    .poll(() =>
      page.evaluate(() => (window as typeof window & { __activityLoadingSeen?: boolean }).__activityLoadingSeen),
    )
    .toBe(false);

  const tabs = page.getByRole("button", { name: "Running 0", exact: true }).locator("..");
  await expect.poll(() => tabs.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("activity only animates loading when the run request is perceptibly slow", async ({ page }) => {
  let releaseRuns = () => undefined;
  const runsGate = new Promise<void>((resolve) => {
    releaseRuns = resolve;
  });
  await mockWorkflows(page, undefined, {
    runs: [],
    page: 1,
    pageSize: 10,
    total: 0,
    viewTotals: { running: 0, review: 0, failed: 0, completed: 0 },
  });
  await page.route("**/api/workflow-runs?**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("view") !== "running" || url.searchParams.has("workflowCode")) {
      await route.fallback();
      return;
    }
    await runsGate;
    await route.fulfill({
      json: {
        runs: [],
        page: 1,
        pageSize: 10,
        total: 0,
        viewTotals: { running: 0, review: 0, failed: 0, completed: 0 },
      },
    });
  });

  await page.goto("/activity?view=running");
  await expect(page.getByRole("status", { name: "Loading runs" })).toBeVisible();
  releaseRuns();
  await expect(page.getByText("No workflows are running.", { exact: true })).toBeVisible();
  await expect(page.getByRole("status", { name: "Loading runs" })).toHaveCount(0);
});

test("workflow metadata loads as one snapshot without an interim empty panel", async ({ page }) => {
  let releaseDefinitions = () => undefined;
  const definitionsGate = new Promise<void>((resolve) => {
    releaseDefinitions = resolve;
  });
  await mockWorkflows(page);
  await page.route("**/api/workflow-definitions", async (route) => {
    await definitionsGate;
    await route.fulfill({ json: [systemDefinitions[0]] });
  });

  await page.goto("/workflows");
  await expect(page.getByRole("status", { name: "Loading workflow data" })).toBeVisible();
  await expect(page.getByText("No runnable or custom workflow definitions exist yet.", { exact: true })).toHaveCount(0);

  releaseDefinitions();
  await expect(page.getByRole("heading", { name: "Sync work metadata", exact: true })).toBeVisible();
  await expect(page.getByRole("status", { name: "Loading workflow data" })).toHaveCount(0);
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
  expect(payloads[0]).toEqual({
    sourceId: 8,
    action: "fetch",
    limit: 50,
    tagNameTemplate: "weekly_{source_code}_{action}_popular",
  });
  await expect(page.getByText(/run #41 queued/)).toBeVisible();
});

test("mobile header orders actions and separates popovers from the quick-action sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockWorkflows(page);
  await page.goto("/workflows");

  await expect(page.getByRole("button", { name: "Quick actions" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Notifications", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open appearance settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open menu" })).toHaveCount(0);

  const headerActions = page.getByRole("button", {
    name: /^(Quick actions|Notifications|Open appearance settings|Account menu)$/,
  });
  const actionMetrics = await headerActions.evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { label: element.getAttribute("aria-label"), height: rect.height, right: rect.right, left: rect.left };
    }),
  );
  expect(actionMetrics.every((metric) => metric.height >= 44 && metric.right <= page.viewportSize()!.width)).toBe(true);
  expect(
    actionMetrics
      .slice()
      .sort((left, right) => left.left - right.left)
      .map((metric) => metric.label),
  ).toEqual(["Quick actions", "Notifications", "Open appearance settings", "Account menu"]);

  await page.getByRole("button", { name: "Account menu" }).click();
  const accountPopover = page.getByRole("dialog", { name: "Account" });
  await expect(accountPopover).toBeVisible();
  expect(await accountPopover.evaluate((element) => getComputedStyle(element).zIndex)).toBe("50");
  await expect(accountPopover.getByRole("button", { name: "Activity", exact: true })).toBeVisible();
  await expect(accountPopover.getByText("Appearance", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(accountPopover).toHaveCount(0);

  await page.getByRole("button", { name: "Open appearance settings" }).click();
  const appearancePopover = page.getByRole("dialog", { name: "Appearance" });
  await expect(appearancePopover).toBeVisible();
  await expect(appearancePopover.getByText("UI language, mode, style, and color", { exact: true })).toBeVisible();
  await expect(appearancePopover.getByRole("button", { name: "Activity", exact: true })).toHaveCount(0);

  const modeGroup = appearancePopover.getByRole("group", { name: "Mode" });
  const modeBox = await modeGroup.boundingBox();
  expect(modeBox).not.toBeNull();
  expect(modeBox!.x).toBeGreaterThanOrEqual(0);
  expect(modeBox!.x + modeBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width);

  await modeGroup.getByRole("combobox").selectOption("dark");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await appearancePopover.getByRole("button", { name: "Apple", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme-preset", "apple");
  await appearancePopover.getByRole("button", { name: "Cobalt", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme-palette", "cobalt");
  const colorGroupBox = await appearancePopover.getByRole("group", { name: "Color" }).boundingBox();
  expect(colorGroupBox).not.toBeNull();
  expect(colorGroupBox!.x).toBeGreaterThanOrEqual(0);
  expect(colorGroupBox!.x + colorGroupBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(colorGroupBox!.y + colorGroupBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("dialog", { name: "Account" }).getByRole("button", { name: "Activity", exact: true }).click();
  await expect(page).toHaveURL(/\/activity$/);
});

test("desktop header popovers render above page content", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockWorkflows(page);
  await page.goto("/workflows");

  await page.getByRole("button", { name: "Open appearance settings" }).click();
  await expect(page.getByText("UI language, mode, style, and color", { exact: true })).toBeVisible();
  const modeGroup = page.getByRole("group", { name: "Mode" });
  await expect(modeGroup).toBeVisible();
  const headerBox = await page.locator("header").boundingBox();
  const popoverBox = await modeGroup.boundingBox();
  expect(headerBox).not.toBeNull();
  expect(popoverBox).not.toBeNull();
  expect(popoverBox!.y + popoverBox!.height).toBeGreaterThan(headerBox!.y + headerBox!.height);
  await page.getByRole("group", { name: "Mode" }).getByRole("combobox").selectOption("dark");
  await expect(page.locator("html")).toHaveClass(/dark/);
});

test("settings theme styles and colors change independently and persist", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockWorkflows(page);
  await page.goto("/settings");

  await expect(page.locator("html")).toHaveAttribute("data-theme-preset", "anthropic");
  await expect(page.locator("html")).toHaveAttribute("data-theme-palette", "original");
  const anthropicTokens = await themeVisualTokens(page);
  await page.getByRole("button", { name: "Apple", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme-preset", "apple");
  await expect(page.getByRole("button", { name: "Apple", exact: true })).toHaveAttribute("aria-pressed", "true");
  const appleOriginalTokens = await themeVisualTokens(page);
  expect(appleOriginalTokens.radius).not.toBe(anthropicTokens.radius);
  expect(appleOriginalTokens.controlHeight).not.toBe(anthropicTokens.controlHeight);
  expect(appleOriginalTokens.motionScale).not.toBe(anthropicTokens.motionScale);
  expect(appleOriginalTokens.fontHeading).not.toBe(anthropicTokens.fontHeading);
  await page.getByRole("button", { name: "Cobalt", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme-palette", "cobalt");
  const appleCobaltTokens = await themeVisualTokens(page);
  expect(appleCobaltTokens.primary).not.toBe(appleOriginalTokens.primary);
  expect(appleCobaltTokens.radius).toBe(appleOriginalTokens.radius);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme-preset", "apple");
  await expect(page.locator("html")).toHaveAttribute("data-theme-palette", "cobalt");
});

async function themeVisualTokens(page: Page) {
  return page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      radius: style.getPropertyValue("--radius").trim(),
      controlHeight: style.getPropertyValue("--control-height").trim(),
      motionScale: style.getPropertyValue("--motion-scale").trim(),
      fontHeading: style.getPropertyValue("--font-heading").trim(),
      primary: style.getPropertyValue("--primary").trim(),
    };
  });
}

test("settings identifies an environment-managed root password", async ({ page }) => {
  await mockWorkflows(page);
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
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
    }),
  );

  await page.goto("/settings");
  await expect(page.getByRole("status")).toContainText("KIKOTO_ROOT_PASSWORD");
  await expect(page.getByLabel("Current password")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Change password", exact: true })).toHaveCount(0);
});

test("demo settings keeps account and workflows read-only while allowing appearance changes", async ({ page }) => {
  await mockWorkflows(page);
  await page.route("**/api/runtime-settings", (route) =>
    route.fulfill({
      json: {
        mode: "demo",
        demoMode: true,
        anonymousAccessEnabled: false,
        cacheEnabled: false,
        directoryRoutingRules: [],
      },
    }),
  );

  await page.goto("/settings");
  await expect(page.getByRole("status")).toHaveText("Demo mode keeps account settings read-only.");
  for (const name of [
    "Light",
    "Dark",
    "System",
    "Anthropic",
    "OpenAI",
    "Apple",
    "Google MD",
    "Original",
    "Graphite",
    "Cobalt",
    "Iris",
  ]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeEnabled();
  }
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await page.getByRole("button", { name: "Apple", exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator("html")).toHaveAttribute("data-theme-preset", "apple");
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator("html")).toHaveAttribute("data-theme-preset", "apple");

  await page.goto("/workflows");
  await expect(
    page.getByText("Demo mode is read-only. Workflow definitions, schedules, runs, and reviews cannot be changed.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("tab", { name: /Custom/ }).click();
  await expect(page.getByRole("button", { name: "New workflow", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New workflow", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New workflow" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview only", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Run at startup", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add schedule", exact: true })).toHaveCount(0);
});
