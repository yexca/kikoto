import { expect, test, type Locator, type Page } from "@playwright/test";
import type {
  AuthState,
  AvailabilityWatch,
  AvailabilityWatchActionResult,
  AvailabilityWatchRunResult,
  LocalMediaIndexResult,
  LocalScanResult,
  MaintenanceWorkPage,
  WorkflowCandidate,
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowNodeRun,
  WorkflowNotification,
  WorkflowNotificationsPage,
  WorkflowPreset,
  WorkflowRun,
  WorkflowRunActionResult,
  WorkflowRunGraph,
  WorkflowRunsPage,
  WorkflowTrigger,
} from "../../src/lib/api";
import {
  authenticatedStateFixture,
  currentUserFixture,
  fixtureTimestamp,
  librarySourceFixture,
  notificationSummaryFixture,
  runtimeSettingsFixture,
  workflowRunDetailFixture,
  workflowRunFixture,
  workflowRunsPageFixture,
  workflowStatusFixture,
  type ApiErrorBody,
  type ApiResponse,
} from "./fixtures/api";

function workflowDefinitionFixture(
  overrides: Pick<WorkflowDefinition, "id" | "code" | "displayName" | "description"> & Partial<WorkflowDefinition>,
): WorkflowDefinition {
  return {
    definitionJson: '{"nodes":[]}',
    scope: "system",
    editable: false,
    ownerUserId: null,
    triggerCount: 0,
    createdAt: fixtureTimestamp,
    updatedAt: fixtureTimestamp,
    ...overrides,
  };
}

function workflowTriggerFixture(
  overrides: Pick<WorkflowTrigger, "id" | "workflowDefinitionId" | "workflowCode" | "displayName" | "triggerType"> &
    Partial<WorkflowTrigger>,
): WorkflowTrigger {
  return {
    enabled: true,
    scheduleJson: "{}",
    configJson: "{}",
    nextRunAt: null,
    lastRunAt: null,
    lastSuccessAt: null,
    lastErrorMessage: "",
    createdAt: fixtureTimestamp,
    updatedAt: fixtureTimestamp,
    ...overrides,
  };
}

function notificationFixture(
  overrides: Pick<WorkflowNotification, "id" | "workflowRunId" | "type" | "status" | "workCode"> &
    Partial<WorkflowNotification>,
): WorkflowNotification {
  return { workId: null, fileSourceId: null, message: "", createdAt: fixtureTimestamp, ...overrides };
}

/** A notifications page; omitted paging fields are filled from the request by `mockWorkflows`. */
type NotificationPageMock = Pick<WorkflowNotificationsPage, "notifications" | "total"> &
  Partial<WorkflowNotificationsPage>;

const systemDefinitions: WorkflowDefinition[] = [
  workflowDefinitionFixture({
    id: 1,
    code: "metadata_sync",
    displayName: "Sync work metadata",
    description: "Test metadata workflow.",
  }),
  workflowDefinitionFixture({
    id: 2,
    code: "media_cache",
    displayName: "Cache media",
    description: "Test cache workflow.",
  }),
  workflowDefinitionFixture({
    id: 3,
    code: "dlsite_popular_collection",
    displayName: "Pull DLsite rankings",
    description: "Pull the due DLsite voice rankings in each of their orders and record how they changed.",
    definitionJson:
      '{"nodes":[{"id":"pull","type":"pull_rankings","displayName":"Pull rankings"},{"id":"record","type":"record_rankings","displayName":"Record changes"}]}',
  }),
  workflowDefinitionFixture({
    id: 4,
    code: "remote_popular_collection",
    displayName: "Pull remote source rankings",
    description: "Pull the due popular list of a compatible remote source and record how it changed.",
    definitionJson:
      '{"nodes":[{"id":"pull","type":"pull_rankings","displayName":"Pull rankings"},{"id":"record","type":"record_rankings","displayName":"Record changes"}]}',
  }),
  workflowDefinitionFixture({
    id: 6,
    code: "availability_watch",
    displayName: "Availability Watch",
    description:
      "Monitor a shared pool of work codes and dispatch configured actions when a remote source becomes available.",
    definitionJson:
      '{"nodes":[{"id":"targets","type":"select_works","displayName":"Monitoring pool"},{"id":"check","type":"check_source_availability","displayName":"Check source availability"},{"id":"ready","type":"filter_candidates","displayName":"Ready pool"},{"id":"dispatch","type":"dispatch_child_workflows","displayName":"Dispatch configured action"}]}',
  }),
  workflowDefinitionFixture({
    id: 7,
    code: "local_library_scan",
    displayName: "Scan local library",
    description: "Discover local works and synchronize local source presence.",
    definitionJson:
      '{"nodes":[{"id":"select","type":"select_local_source","displayName":"Select local source"},{"id":"discover","type":"discover_local_files","displayName":"Discover files"},{"id":"match","type":"match_works","displayName":"Match works"},{"id":"sync","type":"sync_file_locations","displayName":"Sync locations"}]}',
    triggerCount: 2,
  }),
  workflowDefinitionFixture({
    id: 8,
    code: "local_media_index",
    displayName: "Refresh local work files",
    description: "Index the media files inside discovered local work folders.",
    definitionJson:
      '{"nodes":[{"id":"select","type":"select_local_works","displayName":"Select local works"},{"id":"index","type":"index_local_media","displayName":"Index work files"}]}',
  }),
  workflowDefinitionFixture({
    id: 9,
    code: "record_library_scan",
    displayName: "Scan record library",
    description: "Index the independent local video and image library without changing audio works.",
    definitionJson: '{"nodes":[{"id":"scan","type":"record_library_scan","displayName":"Scan record library"}]}',
  }),
  workflowDefinitionFixture({
    id: 10,
    code: "record_media_probe",
    displayName: "Read record media details",
    description: "Read the length of record videos and audio files.",
    definitionJson:
      '{"nodes":[{"id":"select","type":"select_record_media","displayName":"Select pending files"},{"id":"probe","type":"probe_record_media","displayName":"Read media details"}]}',
  }),
];

const workflowTriggers: WorkflowTrigger[] = [
  workflowTriggerFixture({
    id: 71,
    workflowDefinitionId: 7,
    workflowCode: "local_library_scan",
    displayName: "Startup local library scan",
    triggerType: "startup",
    scheduleJson: '{"type":"startup"}',
    configJson: '{"followUpRun":false}',
  }),
  workflowTriggerFixture({
    id: 72,
    workflowDefinitionId: 7,
    workflowCode: "local_library_scan",
    displayName: "Watch data folders",
    triggerType: "filesystem_event",
    scheduleJson: '{"type":"filesystem_event"}',
    configJson: '{"followUpRun":false,"scanMode":"incremental"}',
  }),
];

const sampleRun = workflowRunFixture({
  id: 51,
  workflowCode: "dlsite_popular_collection",
  displayName: "Pull DLsite rankings",
  status: "succeeded",
  triggerType: "manual",
  triggerReason: "day",
  createdAt: "2026-07-14T00:00:00Z",
  startedAt: "2026-07-14T00:00:00Z",
  finishedAt: "2026-07-14T00:01:00Z",
  summaryJson: '{"synced":2,"tagged":2}',
  nodeRunCount: 2,
  completedNodeRuns: 2,
  jobCount: 1,
  completedJobs: 1,
  definitionId: 3,
});

const sampleNodes: WorkflowNodeRun[] = [
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
} satisfies WorkflowRunGraph);

/** Whether the backend lists a run under a view: active runs, runs that wait for a decision, or the others. */
function runInView(run: WorkflowRun, view: string) {
  const active = run.status === "queued" || run.status === "running";
  const attention =
    !active &&
    !run.reviewedAt &&
    (run.pendingCandidates > 0 ||
      (run.pendingFailedMetadata ?? 0) > 0 ||
      (run.pendingMetadata ?? 0) > 0 ||
      run.status === "failed" ||
      run.status === "partial");
  if (view === "running") return active;
  if (view === "attention") return attention;
  if (view === "history") return !active && !attention;
  if (view === "failed") return run.status === "failed";
  return true;
}

async function mockWorkflows(
  page: Page,
  runsPage: WorkflowRunsPage = workflowRunsPageFixture([sampleRun], {
    viewTotals: { running: 0, review: 0, failed: 0, completed: 1 },
  }),
  notificationPage: NotificationPageMock | ((page: number, pageSize: number) => NotificationPageMock) = {
    notifications: [],
    total: 0,
  },
  onAvailabilityWatch?: (payload: unknown) => void,
  onClearSucceeded?: () => void,
) {
  let availabilityWatch: AvailabilityWatch = {
    id: 1,
    sourceId: null,
    revision: 2,
    targets: [
      {
        id: 1,
        workCode: "RJ00000000",
        title: "",
        coverUrl: "",
        state: "monitoring",
        nextCheckAt: "2026-07-27T01:00:00Z",
        lastCheckedAt: "",
        lastStatus: "",
        lastError: "",
        availableSourceId: null,
        availableCode: "",
        trackRunId: null,
        fetchRunId: null,
        trackRunStatus: "",
        fetchRunStatus: "",
        inLibrary: false,
        addedAt: "2026-07-26 00:00:00",
        releaseDate: "",
        family: [],
      },
      {
        id: 2,
        workCode: "RJ00000001",
        title: "Synthetic watched work",
        coverUrl: "",
        state: "ready",
        nextCheckAt: "",
        lastCheckedAt: "2026-07-27T00:00:00Z",
        lastStatus: "available",
        lastError: "",
        availableSourceId: 8,
        availableCode: "RJ00000003",
        trackRunId: null,
        fetchRunId: null,
        trackRunStatus: "",
        fetchRunStatus: "",
        inLibrary: false,
        addedAt: "2026-07-26 00:00:00",
        releaseDate: "",
        family: [
          { code: "RJ00000001", title: "Synthetic watched work", language: "ja-jp", canonical: true },
          { code: "RJ00000003", title: "Synthetic translated work", language: "en-us", canonical: false },
        ],
      },
    ],
  };
  let activeTriggers = [...workflowTriggers];
  let nextTriggerID = 73;

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({
        json: authenticatedStateFixture({
          username: "admin",
          displayName: "Admin",
          role: "super_admin",
          permissions: ["system:admin"],
          devMode: true,
        }),
      });
      return;
    }
    if (url.pathname === "/api/notifications" || url.pathname === "/api/notifications/summary") {
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
      const notifications = {
        page: requestedPage,
        pageSize: requestedPageSize,
        totalPages: 1,
        clearableTotal,
        ...response,
      } satisfies WorkflowNotificationsPage;
      const attentionRuns = runsPage.runs.filter((run) => runInView(run, "attention"));
      await route.fulfill({
        json: notificationSummaryFixture(notifications, {
          total: attentionRuns.length,
          runs: attentionRuns.slice(0, 5),
          running: runsPage.viewTotals.running,
          runningRun: runsPage.runs.find((run) => runInView(run, "running")) ?? null,
        }),
      });
      return;
    }
    if (url.pathname === "/api/workflow-status") {
      const codes = url.searchParams.getAll("code");
      await route.fulfill({
        json: {
          workflows: systemDefinitions
            .filter((definition) => codes.length === 0 || codes.includes(definition.code))
            .map((definition) =>
              workflowStatusFixture(
                definition,
                // The mock's run history stands for every operation's, but only a run of the operation itself
                // is active on it, and Metadata has only ever run what is active.
                runsPage.runs
                  .filter((run) =>
                    runInView(run, "running")
                      ? run.workflowCode === definition.code
                      : definition.code !== "metadata_sync",
                  )
                  .map((run) => ({ ...run, workflowCode: definition.code })),
                activeTriggers,
              ),
            ),
        },
      });
      return;
    }
    if (url.pathname === "/api/notifications/clear-succeeded" && route.request().method() === "POST") {
      onClearSucceeded?.();
      await route.fulfill({ json: { ok: true, dismissed: 1 } satisfies ApiResponse<"clearSucceededNotifications"> });
      return;
    }
    if (url.pathname.startsWith("/api/notifications/") && route.request().method() === "DELETE") {
      await route.fulfill({ json: { ok: true } satisfies ApiResponse<"dismissNotification"> });
      return;
    }
    if (url.pathname === "/api/workflow-definitions") {
      await route.fulfill({ json: systemDefinitions });
      return;
    }
    if (url.pathname === "/api/workflow-presets") {
      await route.fulfill({ json: [] satisfies WorkflowPreset[] });
      return;
    }
    if (url.pathname === "/api/availability-watch") {
      if (route.request().method() === "PUT") {
        const payload = route.request().postDataJSON() as Pick<AvailabilityWatch, "sourceId">;
        onAvailabilityWatch?.(payload);
        availabilityWatch = {
          ...availabilityWatch,
          sourceId: payload.sourceId,
          revision: availabilityWatch.revision + 1,
        };
      }
      await route.fulfill({ json: availabilityWatch });
      return;
    }
    if (url.pathname === "/api/availability-watch/targets" && route.request().method() === "POST") {
      const payload = route.request().postDataJSON() as { targetCodes: string[] };
      onAvailabilityWatch?.(payload);
      availabilityWatch = {
        ...availabilityWatch,
        revision: availabilityWatch.revision + 1,
        targets: [
          ...availabilityWatch.targets,
          ...payload.targetCodes.map((workCode, index) => ({
            id: 100 + index,
            workCode,
            title: "",
            coverUrl: "",
            state: "monitoring" as const,
            nextCheckAt: "2026-07-27T01:00:00Z",
            lastCheckedAt: "",
            lastStatus: "",
            lastError: "",
            availableSourceId: null,
            availableCode: "",
            trackRunId: null,
            fetchRunId: null,
            trackRunStatus: "",
            fetchRunStatus: "",
            inLibrary: false,
            addedAt: "2026-07-27 03:00:00",
            releaseDate: "",
            family: [],
          })),
        ],
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
      await route.fulfill({ json: { ok: true } satisfies ApiResponse<"removeAvailabilityWatchTarget"> });
      return;
    }
    if (
      (url.pathname === "/api/availability-watch/targets/remove" ||
        url.pathname === "/api/availability-watch/targets/clean-up") &&
      route.request().method() === "POST"
    ) {
      const { targetIds } = route.request().postDataJSON() as { targetIds: number[] };
      const cleanUp = url.pathname.endsWith("clean-up");
      onAvailabilityWatch?.(cleanUp ? { cleanUpTargetIds: targetIds } : { removeTargetIds: targetIds });
      availabilityWatch = {
        ...availabilityWatch,
        revision: availabilityWatch.revision + 1,
        targets: availabilityWatch.targets.filter(
          (target) => !(targetIds.includes(target.id) && (!cleanUp || target.inLibrary)),
        ),
      };
      await route.fulfill({ json: availabilityWatch });
      return;
    }
    if (url.pathname === "/api/availability-watch/fetch" && route.request().method() === "POST") {
      const { targetIds, excludeExtensions } = route.request().postDataJSON() as {
        targetIds: number[];
        excludeExtensions: string[];
      };
      onAvailabilityWatch?.({ fetchTargetIds: targetIds, excludeExtensions });
      // The Fetch finishes at once here, so the work is in the library.
      availabilityWatch = {
        ...availabilityWatch,
        targets: availabilityWatch.targets.map((target) =>
          targetIds.includes(target.id)
            ? { ...target, fetchRunId: 88, fetchRunStatus: "succeeded", inLibrary: true }
            : target,
        ),
      };
      await route.fulfill({
        status: 202,
        json: {
          runs: [{ runId: 87, sourceId: 8, codes: ["RJ00000003"] }],
          queued: targetIds,
          skipped: 0,
        } satisfies AvailabilityWatchActionResult,
      });
      return;
    }
    if (url.pathname === "/api/availability-watch/run" && route.request().method() === "POST") {
      const { targetIds } = route.request().postDataJSON() as { targetIds: number[] };
      onAvailabilityWatch?.({ checkTargetIds: targetIds });
      await route.fulfill({
        status: 202,
        json: {
          runId: 91,
          jobId: 92,
          status: "queued",
          targetCount: availabilityWatch.targets.length,
          checked: 0,
          ready: 0,
          newlyAvailableCodes: [],
          readyCodes: [],
          failures: [],
        } satisfies AvailabilityWatchRunResult,
      });
      return;
    }
    if (url.pathname === "/api/workflow-triggers") {
      if (route.request().method() === "POST") {
        const payload = route.request().postDataJSON() as Pick<
          WorkflowTrigger,
          "workflowDefinitionId" | "displayName" | "triggerType" | "enabled" | "scheduleJson" | "configJson"
        >;
        const definition = systemDefinitions.find((item) => item.id === payload.workflowDefinitionId);
        const saved: WorkflowTrigger = {
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
      const view = url.searchParams.get("view") ?? "";
      const runs = runsPage.runs.filter((run) => runInView(run, view));
      await route.fulfill({
        json:
          url.searchParams.get("workflowCode") === "metadata_sync"
            ? workflowRunsPageFixture([], {
                pageSize: Number(url.searchParams.get("pageSize") ?? 10),
                viewTotals: runsPage.viewTotals,
              })
            : ({
                ...runsPage,
                runs,
                total: runs.length,
                pageSize: Number(url.searchParams.get("pageSize") ?? runsPage.pageSize),
              } satisfies WorkflowRunsPage),
      });
      return;
    }
    if (url.pathname === "/api/workflow-runs/51") {
      await route.fulfill({
        json: workflowRunDetailFixture(sampleRun, { nodeRuns: sampleNodes, graphJson: sampleRunGraph }),
      });
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
        ] satisfies WorkflowEvent[],
      });
      return;
    }
    if (url.pathname === "/api/workflow-runs/51/candidates") {
      await route.fulfill({ json: [] satisfies WorkflowCandidate[] });
      return;
    }
    if (url.pathname === "/api/library-sources") {
      await route.fulfill({
        json: [librarySourceFixture({ id: 8, code: "remote-test", displayName: "Remote Test" })],
      });
      return;
    }
    if (url.pathname === "/api/runtime-settings") {
      await route.fulfill({
        json: runtimeSettingsFixture({ anonymousAccessEnabled: false, recordLibraryEnabled: true }),
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not mocked" } satisfies ApiErrorBody });
  });
}

test("mobile notification center opens fetched works and dismisses individual results", async ({ page }) => {
  await mockWorkflows(page, undefined, {
    total: 2,
    notifications: [
      notificationFixture({
        id: 2,
        workflowRunId: 72,
        type: "remote_fetch",
        status: "failed",
        workId: 12,
        workCode: "RJ00000003",
        message: "Fetch failed for RJ00000003.",
        createdAt: "2026-07-27T02:00:00Z",
      }),
      notificationFixture({
        id: 1,
        workflowRunId: 71,
        type: "remote_fetch",
        status: "succeeded",
        workId: 11,
        workCode: "RJ00000002",
        message: "Fetch completed for RJ00000002.",
        createdAt: "2026-07-27T01:00:00Z",
      }),
    ],
  });
  await page.goto("/workflows");

  await page.getByRole("button", { name: "Notifications", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Workflow update for RJ00000002. Workflow #71 · succeeded", exact: true }),
  ).toBeVisible();
  const dismissRequest = page.waitForRequest(
    (request) => request.method() === "DELETE" && request.url().endsWith("/api/notifications/1"),
  );
  await page.getByRole("button", { name: "Dismiss notification for RJ00000002" }).click();
  await dismissRequest;
  await expect(
    page.getByRole("button", { name: "Workflow update for RJ00000002. Workflow #71 · succeeded", exact: true }),
  ).toHaveCount(0);

  await page
    .getByRole("button", { name: "Workflow update for RJ00000003. Workflow #72 · failed", exact: true })
    .click();
  await expect(page).toHaveURL(/\/RJ00000003\?view=local$/);
});

test("notification center keeps what it shows when a refresh fails", async ({ page }) => {
  await mockWorkflows(page, undefined, {
    total: 1,
    notifications: [
      notificationFixture({
        id: 1,
        workflowRunId: 71,
        type: "remote_fetch",
        status: "succeeded",
        workId: 11,
        workCode: "RJ00000002",
        message: "Fetch completed for RJ00000002.",
        createdAt: "2026-07-27T01:00:00Z",
      }),
    ],
  });
  await page.goto("/workflows");

  const notificationButton = page.getByRole("button", { name: "Notifications", exact: true });
  await notificationButton.click();
  const dialog = page.getByRole("dialog", { name: "Notifications" });
  const row = dialog.getByRole("button", {
    name: "Workflow update for RJ00000002. Workflow #71 · succeeded",
    exact: true,
  });
  await expect(row).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await page.route("**/api/notifications/summary**", (route) =>
    route.fulfill({ status: 500, json: { error: "Unavailable" } satisfies ApiErrorBody }),
  );
  const failedRefresh = page.waitForResponse(
    (response) => response.url().includes("/api/notifications/summary") && response.status() === 500,
  );
  // Opening the panel refreshes it.
  await notificationButton.click();
  await failedRefresh;
  await expect(dialog.getByText("1 item", { exact: true })).toBeVisible();
  await expect(row).toBeVisible();
});

test("notification center paginates and clears only succeeded remote notifications", async ({ page }) => {
  let cleared = false;
  const futureActionNotification = notificationFixture({
    id: 3,
    workflowRunId: 73,
    type: "future_review_action",
    status: "succeeded",
    workId: 13,
    workCode: "RJ00000004",
    message: "Review action remains available.",
    createdAt: "2026-07-27T03:00:00Z",
  });
  await mockWorkflows(
    page,
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
          notificationFixture({
            id: 2,
            workflowRunId: 72,
            type: "remote_track",
            status: "failed",
            workId: 12,
            workCode: "RJ00000003",
            message: "Track failed for RJ00000003.",
            createdAt: "2026-07-27T02:00:00Z",
          }),
          notificationFixture({
            id: 1,
            workflowRunId: 71,
            type: "remote_fetch",
            status: "succeeded",
            workId: 11,
            workCode: "RJ00000002",
            message: "Fetch completed for RJ00000002.",
            createdAt: "2026-07-27T01:00:00Z",
          }),
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
  await expect(
    dialog.getByRole("button", { name: "Workflow update for RJ00000002. Workflow #71 · succeeded", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("Page 1 of 2", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Clear succeeded", exact: true })).toBeEnabled();

  await dialog.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(dialog.getByText("Page 2 of 2", { exact: true })).toBeVisible();
  await expect(
    dialog.getByRole("button", {
      name: "Workflow update for RJ00000004. Workflow #73 · succeeded",
      exact: true,
    }),
  ).toBeVisible();

  const clearRequest = page.waitForRequest(
    (request) => request.method() === "POST" && request.url().endsWith("/api/notifications/clear-succeeded"),
  );
  await dialog.getByRole("button", { name: "Clear succeeded", exact: true }).click();
  await clearRequest;
  await expect(
    dialog.getByRole("button", {
      name: "Workflow update for RJ00000004. Workflow #73 · succeeded",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Workflow update for RJ00000002. Workflow #71 · succeeded", exact: true }),
  ).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Clear succeeded", exact: true })).toBeDisabled();
});

/** An operation's card on the Workflows page. */
function operation(page: Page, name: string) {
  return page.getByRole("group", { name, exact: true });
}

/** The part of Operations that lists what runs on its own next. */
function nextTriggers(page: Page) {
  return page.getByRole("region", { name: "Next", exact: true });
}

/** Answers each operation's workflow status from the runs a test holds for it. */
async function mockWorkflowStatuses(page: Page, runsOf: (code: string) => WorkflowRun[]) {
  await page.route("**/api/workflow-status*", async (route) => {
    const codes = new URL(route.request().url()).searchParams.getAll("code");
    await route.fulfill({
      json: {
        workflows: systemDefinitions
          .filter((definition) => codes.length === 0 || codes.includes(definition.code))
          .map((definition) => workflowStatusFixture(definition, runsOf(definition.code), workflowTriggers)),
      },
    });
  });
}

async function mockMetadataRun(page: Page) {
  const submissions: Record<string, unknown>[] = [];
  await page.route("**/api/workflow-runs/dlsite-sync", async (route) => {
    submissions.push(route.request().postDataJSON());
    await route.fulfill({
      status: 202,
      json: {
        runId: 91,
        jobId: 92,
        status: "queued",
        targetWorks: 0,
        syncedWorks: 0,
        skippedWorks: 0,
        failedWorks: 0,
        unavailableWorks: 0,
        reviewCandidates: [],
        failures: [],
      },
    });
  });
  return submissions;
}

test("Operations holds the Library and Record cards above what runs next", async ({ page }) => {
  await mockWorkflows(page);
  await page.route("**/api/workflow-triggers", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      json: [
        ...workflowTriggers,
        // A ranking pull's dispatcher is always on; the ranking lists plan its next run.
        workflowTriggerFixture({
          id: 31,
          workflowDefinitionId: 3,
          workflowCode: "dlsite_popular_collection",
          displayName: "Example ranking",
          triggerType: "schedule",
          scheduleJson: "{}",
          nextRunAt: "2099-01-01T00:00:00Z",
        }),
        workflowTriggerFixture({
          id: 32,
          workflowDefinitionId: 4,
          workflowCode: "remote_popular_collection",
          displayName: "Example remote ranking",
          triggerType: "schedule",
          scheduleJson: "{}",
          nextRunAt: null,
        }),
      ],
    });
  });
  const probes: string[] = [];
  await page.route("**/api/records/probes", async (route) => {
    probes.push(route.request().method());
    await route.fulfill({ status: 202, json: { runId: 95, jobId: 96, status: "queued", existing: false } });
  });
  await page.goto("/workflows");

  // Operations is the default tab; nothing runs, so nothing shows above the tabs.
  const runs = page.getByRole("region", { name: "Runs", exact: true });
  await expect(runs.getByRole("tab")).toHaveText(["Operations", "Needs attention", "History"]);
  await expect(runs.getByRole("tab", { name: "Operations", selected: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Running", exact: true })).toHaveCount(0);
  const group = (name: string) => runs.getByRole("region", { name, exact: true });
  await expect(group("Library").getByRole("list").getByRole("heading", { level: 3 })).toHaveText([
    "Scan",
    "Metadata",
    "Index",
  ]);
  await expect(group("Record").getByRole("list").getByRole("heading", { level: 3 })).toHaveText([
    "Record scan",
    "Media details",
  ]);
  await expect(operation(page, "Scan")).toContainText("At startup·Watching folders");
  // A Record scan runs by hand; Media details runs by hand or from a trigger.
  await expect(operation(page, "Record scan").getByRole("button", { name: /triggers$/ })).toHaveCount(0);
  await expect(operation(page, "Record scan").getByRole("img", { name: /triggers$/ })).toHaveCount(0);
  await expect(operation(page, "Media details").getByRole("button", { name: /triggers$/ })).toBeVisible();
  await expect(operation(page, "Media details").getByRole("switch", { name: "Full", exact: true })).toHaveCount(0);
  await operation(page, "Media details").getByRole("button", { name: "Run", exact: true }).click();
  await expect.poll(() => probes).toEqual(["POST"]);
  await expect(operation(page, "Scan").getByRole("switch", { name: "Full", exact: true })).toHaveCount(0);
  await expect(operation(page, "Metadata")).toContainText("Never run");
  await expect(operation(page, "Metadata").getByRole("switch", { name: "Full", exact: true })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(page.getByText("Fetch runs from a work", { exact: false })).toHaveCount(0);

  // A dispatcher shows when its lists plan a pull, and a dispatcher with nothing planned runs nothing.
  const next = nextTriggers(page);
  await expect(next.getByRole("listitem")).toHaveText([
    /^Pull DLsite rankings · Example ranking\s*Next/,
    /^Scan.*At startup/,
    /^Scan.*When local library folders change/,
  ]);
  // Another workflow's trigger leads to where it is set up.
  await next.getByRole("button", { name: "Open where this is set up Pull DLsite rankings · Example ranking" }).click();
  await expect(page).toHaveURL(/\/discover\?view=rankings&panel=rankings$/);
  await page.goBack();

  // An operation's state opens its latest run in place of the tabs on a phone, and Back returns to them.
  await operation(page, "Scan").getByRole("button", { name: "Open run #51 (Succeeded)", exact: true }).click();
  await expect(page).toHaveURL(/\/workflows\?run=51$/);
  await expect(operation(page, "Scan")).toHaveCount(0);
  await page.goBack();
  await expect(operation(page, "Scan")).toBeVisible();

  // History narrowed to a workflow Discover runs says where it is configured.
  await page.goto("/workflows?tab=history&workflow=dlsite_popular_collection");
  await expect(page.getByRole("tab", { name: "History", selected: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Workflow", exact: true })).toHaveValue("dlsite_popular_collection");
  await expect(page.getByText("Each ranking is pulled on its own schedule", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Open Discover", exact: true }).click();
  await expect(page).toHaveURL(/\/discover\?view=rankings&panel=rankings$/);

  // History narrowed to a Record operation names it and needs no pointer elsewhere.
  await page.goto("/workflows?tab=history&workflow=record_library_scan");
  const workflowFilter = page.getByRole("combobox", { name: "Workflow", exact: true });
  await expect(workflowFilter).toHaveValue("record_library_scan");
  await expect(workflowFilter.getByRole("option", { name: "Scan Record", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Open Record", exact: true })).toHaveCount(0);
});

test("Full applies to the next Metadata or Index run, and Scan always scans every folder", async ({ page }) => {
  await mockWorkflows(page);
  const metadataRuns = await mockMetadataRun(page);
  const indexRuns: unknown[] = [];
  const scanRuns: unknown[] = [];
  await page.route("**/api/workflow-runs/local-media-index", async (route) => {
    indexRuns.push(route.request().postDataJSON());
    await route.fulfill({
      status: 202,
      json: { runId: 62, jobId: 72, status: "queued", mode: "full", existing: false } satisfies LocalMediaIndexResult,
    });
  });
  await page.route("**/api/workflow-runs/local-scan", async (route) => {
    scanRuns.push(route.request().postDataJSON());
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
        followUpRun: false,
        newWorkCodes: [],
        failures: [],
      } satisfies LocalScanResult,
    });
  });
  await page.goto("/workflows");

  const metadata = operation(page, "Metadata");
  await metadata.getByRole("switch", { name: "Full", exact: true }).click();
  await expect(metadata).toContainText("Refreshes the metadata of every work");
  await metadata.getByRole("button", { name: "Run", exact: true }).click();
  await expect
    .poll(() => metadataRuns)
    .toEqual([
      {
        scope: "all",
        mode: "full",
        remoteMetadataFallback: { enabled: false, sourceIds: [] },
        purchaseBonusAutoLink: true,
      },
    ]);
  // Full is for the run it was chosen for.
  await expect(metadata.getByRole("switch", { name: "Full", exact: true })).toHaveAttribute("aria-checked", "false");

  const index = operation(page, "Index");
  await index.getByRole("button", { name: "Run", exact: true }).click();
  await expect.poll(() => indexRuns).toEqual([{ mode: "incremental" }]);
  // A requested run holds an operation that runs once at a time.
  await expect(index.getByRole("button", { name: "Starting", exact: true })).toBeDisabled();

  const scan = operation(page, "Scan");
  await expect(scan.getByRole("switch")).toHaveCount(0);
  await scan.getByRole("button", { name: "Run", exact: true }).click();
  await expect.poll(() => scanRuns).toEqual([{ followUpRun: false }]);
});

test("Metadata options set the remote fallback and bonus linking for its runs and new triggers", async ({ page }) => {
  await mockWorkflows(page);
  await page.route("**/api/library-sources", (route) =>
    route.fulfill({
      json: [
        librarySourceFixture({ id: 1, displayName: "Example Remote A" }),
        librarySourceFixture({ id: 2, displayName: "Example Remote B" }),
        librarySourceFixture({ id: 3, metadataCapable: false, displayName: "Example No Metadata" }),
      ],
    }),
  );
  const runs = await mockMetadataRun(page);
  await page.goto("/workflows");

  const metadata = operation(page, "Metadata");
  await metadata.getByRole("button", { name: "Metadata options", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Metadata options", exact: true });
  await dialog.getByRole("switch", { name: "Look up works DLsite does not have", exact: true }).click();
  // A fallback needs a source before it can be saved.
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  const order = dialog.getByRole("list", { name: "Fallback source order", exact: true });
  await expect(order.getByRole("listitem")).toHaveText(["Example Remote A", "Example Remote B"]);
  await dialog.getByRole("checkbox", { name: "Use Example Remote A", exact: true }).click();
  await dialog.getByRole("checkbox", { name: "Use Example Remote B", exact: true }).click();
  await dialog.getByRole("button", { name: "Move Example Remote B earlier", exact: true }).click();
  await dialog.getByRole("switch", { name: "Link purchase bonuses to their work", exact: true }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(metadata).toContainText(
    "Remote fallback: Example Remote B → Example Remote A · Purchase bonus linking off",
  );

  await metadata.getByRole("button", { name: "Run", exact: true }).click();
  await expect
    .poll(() => runs)
    .toEqual([
      {
        scope: "all",
        mode: "missing",
        remoteMetadataFallback: { enabled: true, sourceIds: [2, 1] },
        purchaseBonusAutoLink: false,
      },
    ]);

  // A new Metadata trigger starts from the same options; without a trigger, the card opens straight to adding one.
  await metadata.getByRole("button", { name: "Metadata triggers", exact: true }).click();
  const add = page.getByRole("dialog", { name: "Add trigger", exact: true });
  await expect(add.getByRole("group", { name: "When", exact: true })).toHaveCount(0);
  await expect(add).toContainText("On a schedule");
  const created = page.waitForRequest(
    (request) => request.method() === "POST" && request.url().endsWith("/api/workflow-triggers"),
  );
  await add.getByRole("button", { name: "Add", exact: true }).click();
  expect(JSON.parse((await created).postDataJSON().configJson)).toEqual({
    scope: "all",
    mode: "missing",
    remoteMetadataFallback: { enabled: true, sourceIds: [2, 1] },
    purchaseBonusAutoLink: false,
  });

  // The options stay in this browser.
  await page.reload();
  await expect(operation(page, "Metadata")).toContainText("Remote fallback: Example Remote B → Example Remote A");
});

test("a card lists and adds its triggers, and Next edits them", async ({ page }) => {
  await mockWorkflows(page);
  const updates: Array<Record<string, unknown>> = [];
  await page.route(/\/api\/workflow-triggers\/\d+$/, async (route) => {
    const payload = route.request().postDataJSON() as Omit<WorkflowTrigger, "id">;
    const id = Number(new URL(route.request().url()).pathname.split("/").at(-1));
    updates.push({ ...payload, id });
    await route.fulfill({ json: { ...workflowTriggers[1], ...payload, id } satisfies WorkflowTrigger });
  });
  await page.goto("/workflows");

  // A card with triggers lists them, and the scan already runs at startup.
  await operation(page, "Scan").getByRole("button", { name: "Scan triggers", exact: true }).click();
  const list = page.getByRole("dialog", { name: "Scan triggers", exact: true });
  await expect(list.getByRole("listitem")).toHaveText([/^At startup/, /^When local library folders change/]);
  await list.getByRole("button", { name: "Add trigger", exact: true }).click();
  const addScan = page.getByRole("dialog", { name: "Add trigger", exact: true });
  const scanWhen = addScan.getByRole("group", { name: "When", exact: true });
  await expect(scanWhen.getByRole("button", { name: "At startup", exact: true })).toBeDisabled();
  await expect(addScan).toContainText("This already runs at startup.");
  // Cancel returns to the list it was opened from.
  await addScan.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await list.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(list).toHaveCount(0);

  // A card without triggers opens straight to adding one.
  await operation(page, "Index").getByRole("button", { name: "Index triggers", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add trigger", exact: true });
  await expect(dialog).toContainText("Index");
  await dialog
    .getByRole("group", { name: "When", exact: true })
    .getByRole("button", { name: "On a schedule", exact: true })
    .click();
  await dialog.getByRole("combobox", { name: "Interval", exact: true }).selectOption({ label: "Every 6 hours" });
  await dialog.getByRole("switch", { name: "Full", exact: true }).click();
  const created = page.waitForRequest(
    (request) => request.method() === "POST" && request.url().endsWith("/api/workflow-triggers"),
  );
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  const payload = (await created).postDataJSON();
  expect(payload).toMatchObject({
    workflowDefinitionId: 8,
    triggerType: "schedule",
    scheduleJson: '{"intervalMinutes":360}',
    enabled: true,
  });
  expect(JSON.parse(payload.configJson)).toEqual({ mode: "full" });
  await expect(dialog).toHaveCount(0);
  await expect(operation(page, "Index")).toContainText("Every 6 hours");
  await expect(nextTriggers(page).getByRole("listitem").first()).toContainText("Every 6 hours·Full");

  // The folder trigger is fixed: it changes only Full and cannot be deleted.
  await nextTriggers(page).getByRole("button", { name: "Edit trigger Scan", exact: true }).nth(1).click();
  const edit = page.getByRole("dialog", { name: "Edit trigger", exact: true });
  await expect(edit).toContainText("When local library folders change");
  await expect(edit.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
  await edit.getByRole("switch", { name: "Full", exact: true }).click();
  await edit.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => updates).toHaveLength(1);
  expect(updates[0]).toMatchObject({ id: 72, triggerType: "filesystem_event", displayName: "Watch data folders" });
  expect(JSON.parse(String(updates[0].configJson))).toEqual({ followUpRun: false, scanMode: "full" });

  // Pausing a trigger saves at once, and Next leaves out what no longer runs.
  await nextTriggers(page).getByRole("switch", { name: "Pause Scan" }).first().click();
  await expect.poll(() => updates).toHaveLength(2);
  expect(updates[1]).toMatchObject({ id: 71, enabled: false });
  await expect(nextTriggers(page).getByRole("listitem")).toHaveText([
    /^Index.*Every 6 hours/,
    /^Scan.*When local library folders change/,
  ]);

  // Its card's list keeps it, and pausing one there saves at once too.
  await operation(page, "Scan").getByRole("button", { name: "Scan triggers", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Scan triggers", exact: true }).getByRole("switch", { name: "Enable At startup" }),
  ).toBeVisible();
  await page
    .getByRole("dialog", { name: "Scan triggers", exact: true })
    .getByRole("switch", { name: "Pause When local library folders change", exact: true })
    .click();
  await expect.poll(() => updates).toHaveLength(3);
  expect(updates[2]).toMatchObject({ id: 72, enabled: false });
});

test("availability watch keeps only its source in settings and acts on works from the Watch view on mobile", async ({
  page,
}) => {
  const updates: unknown[] = [];
  await mockWorkflows(page, undefined, undefined, (payload) => updates.push(payload));
  await page.goto("/workflows?tab=history&workflow=availability_watch");

  // Workflows keeps the run history and links to the Discover page,
  // whose Watch view holds the pool and whose settings hold the source.
  await page.getByRole("button", { name: "Open Discover", exact: true }).click();
  await expect(page).toHaveURL(/\/discover\?view=watch&panel=watch$/);
  const settings = page.getByRole("dialog", { name: "Subscription settings", exact: true });
  await expect(settings.getByRole("tab")).toHaveText(["Subscriptions", "Rankings", "Availability Watch"]);
  await expect(settings.getByRole("tab", { name: "Availability Watch", selected: true })).toBeVisible();

  // The watch only monitors: the settings choose the source, with no action, exclusion, or Run.
  const save = settings.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeDisabled();
  await expect(settings.getByRole("button", { name: "Run", exact: true })).toHaveCount(0);
  await expect(settings.getByRole("group", { name: "When available", exact: true })).toHaveCount(0);
  const sourceTabs = settings.getByRole("group", { name: "Remote source", exact: true });
  await sourceTabs.getByRole("button", { name: "Remote Test", exact: true }).click();
  await save.click();
  await expect.poll(() => updates).toContainEqual({ sourceId: 8 });
  await expect(save).toBeDisabled();

  // Behind the settings, the Watch view groups the works: available above waiting.
  await settings.getByRole("button", { name: "Close settings", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Watch", selected: true })).toBeVisible();
  const pool = page.getByRole("region", { name: "Watch pool", exact: true });
  const available = pool.getByRole("region", { name: /^Available/ });
  const waiting = pool.getByRole("region", { name: /^Waiting/ });
  await expect(pool.getByRole("region").nth(0)).toHaveAccessibleName("Available");
  await expect(pool.getByRole("region").nth(1)).toHaveAccessibleName("Waiting");
  await expect(waiting.getByRole("button", { name: /^RJ00000000/ })).toBeVisible();

  // Add codes reads links and mixed text and previews what it adds.
  await pool
    .getByRole("textbox", { name: "Add work codes to the watch pool", exact: true })
    .fill("RJ00000003, https://www.dlsite.example/maniax/work/=/product_id/RJ00000002.html hello");
  await expect(pool.getByText("1 new:", { exact: true })).toBeVisible();
  await expect(pool.getByText("1 code is already watched.", { exact: true })).toBeVisible();
  await expect(pool.getByText("1 not a code:", { exact: true })).toBeVisible();
  await pool.getByRole("button", { name: "Add 1", exact: true }).click();
  await expect.poll(() => updates).toContainEqual({ targetCodes: ["RJ00000002"] });
  await expect(waiting.getByRole("button", { name: /^RJ00000002/ })).toBeVisible();

  // Removing a work takes a second, confirming press.
  const removed = updates.length;
  // A simple card shows its actions with its details, opened by its toggle.
  const details = (group: Locator, code: string) =>
    group
      .getByRole("listitem")
      .filter({ has: page.getByRole("button", { name: new RegExp(`^${code}`) }) })
      .getByRole("button", { name: "Show details", exact: true });
  await details(waiting, "RJ00000002").click();
  await waiting.getByRole("button", { name: "Remove RJ00000002 from watch", exact: true }).click();
  expect(updates).toHaveLength(removed);
  await waiting.getByRole("button", { name: "Confirm removing RJ00000002 from watch", exact: true }).click();
  await expect.poll(() => updates).toContainEqual({ removeTargetIds: [100] });

  // Fetch of a work available as another edition names that edition and confirms first.
  await available.getByRole("button", { name: "Show details", exact: true }).click();
  await available.getByRole("button", { name: "Fetch RJ00000003", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Fetch 1 work?" });
  await expect(confirm.getByText("RJ00000003", { exact: true })).toBeVisible();
  await confirm.getByRole("switch").click();
  await confirm.getByRole("textbox", { name: "Extensions to exclude", exact: true }).fill("wav ");
  await confirm.getByRole("button", { name: "Fetch 1 work", exact: true }).click();
  await expect.poll(() => updates).toContainEqual({ fetchTargetIds: [2], excludeExtensions: ["wav"] });

  // The fetched work is in the library; Clean up removes it after a confirmation with both counts.
  const inLibrary = pool.getByRole("region", { name: /^Already in library/ });
  await expect(inLibrary.getByRole("button", { name: /^RJ00000001/ })).toBeVisible();
  await page.getByRole("button", { name: "Watch actions", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Clean up \(1\)/ }).click();
  const cleanUp = page.getByRole("alertdialog", { name: "Remove 1 work from the watch?" });
  await cleanUp.getByRole("button", { name: "Remove 1 work", exact: true }).click();
  await expect.poll(() => updates).toContainEqual({ cleanUpTargetIds: [2] });
  await expect(inLibrary).toHaveCount(0);

  // Selection checks only the works an action applies to.
  await pool.getByRole("button", { name: "Select", exact: true }).click();
  const selection = page.getByRole("toolbar", { name: "Selection actions", exact: true });
  await selection.getByRole("checkbox", { name: "Select all on this page", exact: true }).click();
  await selection.getByRole("button", { name: "Check now (1)", exact: true }).click();
  await expect.poll(() => updates).toContainEqual({ checkTargetIds: [1] });
  await selection.getByRole("button", { name: "Exit selection mode", exact: true }).click();

  // The family dialog removes a work too.
  await waiting.getByRole("button", { name: /^RJ00000000/ }).click();
  const family = page.getByRole("dialog", { name: "RJ00000000 work family" });
  const bounds = await family.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(412);
  await family.getByRole("button", { name: "Remove from watch", exact: true }).click();
  await family.getByRole("button", { name: "Confirm removal", exact: true }).click();
  await expect(family).toHaveCount(0);
  await expect.poll(() => updates).toContainEqual({ removeTargetIds: [1] });
});

test("availability notifications and earlier watch links open the Watch view", async ({ page }) => {
  await mockWorkflows(page, undefined, {
    total: 1,
    notifications: [
      notificationFixture({
        id: 9,
        workflowRunId: 91,
        type: "availability_watch_ready",
        status: "succeeded",
        workId: null,
        workCode: "RJ00000001",
        message: "RJ00000001 is now available.",
        createdAt: "2026-07-27T02:00:00Z",
      }),
    ],
  });
  // Registered after the mock, so it answers first: the run that found RJ00000001.
  await page.route("**/api/workflow-runs/91", async (route) => {
    await route.fulfill({
      json: workflowRunDetailFixture(
        {
          ...sampleRun,
          id: 91,
          workflowCode: "availability_watch",
          summaryJson: '{"newlyAvailableCodes":["RJ00000001"]}',
        },
        { nodeRuns: [], graphJson: sampleRunGraph },
      ),
    });
  });
  await page.goto("/workflows");

  await page.getByRole("button", { name: "Notifications", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Availability watch is ready for RJ00000001. Workflow #91 · succeeded",
      exact: true,
    })
    .click();
  await expect(page.getByRole("tab", { name: "Watch", selected: true })).toBeVisible();
  // The run's newly available works are selected, ready for Fetch in the selection bar.
  const selection = page.getByRole("toolbar", { name: "Selection actions", exact: true });
  await expect(selection).toBeInViewport();
  await expect(selection.getByText("1 selected", { exact: true })).toBeVisible();
  await expect(selection.getByRole("button", { name: "Fetch (1)", exact: true })).toBeEnabled();
  await expect(page).toHaveURL(/\/discover\?view=watch$/);

  // A Subscriptions bookmark of the pool in the settings opens Discover's Watch view and the target's family.
  await page.goto("/subscriptions?panel=watch&target=2");
  await expect(page.getByRole("dialog", { name: "RJ00000001 work family" })).toBeVisible();
  await expect(page).toHaveURL(/\/discover\?view=watch$/);
});

test("activity links metadata failures to a run-filtered Maintenance list", async ({ page }) => {
  await mockWorkflows(page);
  await page.route("**/api/workflow-runs/51", async (route) => {
    await route.fulfill({
      json: workflowRunDetailFixture(sampleRun, {
        nodeRuns: sampleNodes,
        graphJson: sampleRunGraph,
        metadataIssues: { encountered: 1, pending: 1 },
      }),
    });
  });
  const runFilters: string[] = [];
  await page.route("**/api/maintenance/works?*", async (route) => {
    runFilters.push(new URL(route.request().url()).searchParams.get("runId") ?? "");
    await route.fulfill({ json: { works: [], page: 1, pageSize: 25, total: 0 } satisfies MaintenanceWorkPage });
  });
  await page.goto("/workflows?tab=history&run=51");
  await page.getByRole("button", { name: "Open metadata issues", exact: true }).click();
  await expect(page).toHaveURL(/\/metadata\?reason=metadata&metadataRun=51/);
  await expect(page.getByText("Failures from run #51", { exact: true })).toBeVisible();
  await expect.poll(() => runFilters.includes("51")).toBe(true);
  await page.getByRole("button", { name: "Show all pending works", exact: true }).click();
  await expect.poll(() => runFilters.includes("")).toBe(true);
});

test("activity presents a compact run summary without the execution canvas", async ({ page }) => {
  await mockWorkflows(page);
  await page.goto("/workflows?tab=history&run=51");

  const activity = page.getByRole("region", { name: "Runs", exact: true });
  await expect(activity.getByText("Nodes", { exact: true })).toBeVisible();
  await expect(activity.getByText("jobs", { exact: true })).toBeVisible();
  await expect(activity.getByText("Run signals", { exact: true })).toHaveCount(0);
  await expect(activity.getByRole("region", { name: "Latest run" })).toHaveCount(0);
  await expect(activity.getByText("Node logs", { exact: true })).toHaveCount(0);
  await expect(activity.getByRole("button", { name: "Overview", exact: true })).toHaveCount(0);
  await expect(activity.getByRole("button", { name: "Steps", exact: true })).toHaveCount(0);
  await expect(activity.getByText("Started", { exact: true })).toBeVisible();
  await expect(activity.getByText("Duration", { exact: true })).toBeVisible();
  await expect(activity.getByText("1m", { exact: true })).toBeVisible();

  // Raw events stay behind the collapsed diagnostic log until requested.
  await expect(activity.getByText("Tagging works", { exact: true })).toBeHidden();
  await activity.getByText("Diagnostic log", { exact: true }).click();
  await expect(activity.getByText("Tagging works", { exact: true })).toBeVisible();
});

test("workflow Activity forgets a previous account's private run after sign-in", async ({ page }) => {
  await mockWorkflows(page);
  let accountId: number | null = 1;
  let denied = 0;
  const account = (id: number) =>
    authenticatedStateFixture({
      id,
      username: `synthetic-user-${id}`,
      displayName: `Example User ${id}`,
      devMode: false,
      permissions: ["library:read", "playback:use", "workflows:run"],
    });
  await page.route("**/api/auth/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/logout")) {
      accountId = null;
      await route.fulfill({ json: { ok: true } });
    } else if (path.endsWith("/login")) {
      accountId = 2;
      await route.fulfill({ json: account(2) });
    } else if (path.endsWith("/me")) {
      await route.fulfill({ json: accountId === null ? { authenticated: false } : account(accountId) });
    } else await route.fallback();
  });
  await page.route("**/api/workflow-runs/51**", async (route) => {
    if (accountId !== 1) {
      denied += 1;
      await route.fulfill({ status: 403, json: { error: "Example access failure" } });
    } else await route.fallback();
  });
  await page.goto("/workflows?activity=1&run=51");
  const activity = page.getByRole("region", { name: "Runs", exact: true });
  await activity.getByText("Diagnostic log", { exact: true }).click();
  await expect(activity.getByText("Tagging works", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("dialog", { name: "Account" }).getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Kikoto" })).toBeVisible();
  await page.getByLabel("Username").fill("synthetic-user-2");
  await page.getByLabel("Password").fill("synthetic-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
  // Follow a same-document deep link so the preceding account's module cache remains in memory.
  await page.evaluate(() => {
    window.history.pushState(window.history.state, "", "/workflows?activity=1&run=51");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect.poll(() => denied).toBeGreaterThan(0);
  await expect(activity.getByRole("alert")).toContainText("The run could not be loaded.");
  await expect(activity.getByText("Tagging works", { exact: true })).toHaveCount(0);
  await expect(activity.getByText("Diagnostic log", { exact: true })).toHaveCount(0);
});

test("activity reports Fetch byte progress without guessing unknown totals", async ({ page }) => {
  const knownTotal = 128 * 1024 * 1024;
  const current = 64 * 1024 * 1024;
  const unknownRun: WorkflowRun = {
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
  const knownRun: WorkflowRun = { ...unknownRun, id: 53, progressBytesUnknownItems: 0 };
  await mockWorkflows(
    page,
    workflowRunsPageFixture([unknownRun, knownRun], {
      viewTotals: { running: 2, review: 0, failed: 0, completed: 0 },
    }),
  );
  await page.route(/\/api\/workflow-runs\/(52|53)(?:\/.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/events") || url.pathname.endsWith("/candidates")) {
      await route.fulfill({ json: [] satisfies WorkflowEvent[] | WorkflowCandidate[] });
      return;
    }
    if (url.pathname.endsWith("/fetch-files")) {
      await route.fulfill({
        json: {
          runId: Number(url.pathname.split("/")[3]),
          files: [],
        } satisfies ApiResponse<"listWorkflowRunFetchFiles">,
      });
      return;
    }
    await route.fulfill({ json: workflowRunDetailFixture(url.pathname.endsWith("/52") ? unknownRun : knownRun) });
  });

  await page.goto("/workflows?run=52");
  const unknownProgress = page.getByRole("status", { name: "Fetch transfer progress" });
  await expect(unknownProgress).toContainText("64.0 MB transferred · 128.0 MB known total · 1 unknown-size file");
  await expect(unknownProgress.getByRole("progressbar")).toHaveCount(0);

  await page.goto("/workflows?run=53");
  const progressbar = page.getByRole("progressbar", { name: "Fetch byte progress" });
  await expect(progressbar).toHaveAttribute("aria-valuenow", String(current));
  await expect(progressbar).toHaveAttribute("aria-valuemax", String(knownTotal));
  await expect(progressbar).toHaveAttribute("aria-valuetext", "64.0 MB of 128.0 MB");
});

test("@desktop blocked Fetch origins stay in Review with source recovery actions and bounded layout", async ({
  page,
}) => {
  const blockedOrigin = "https://media.example.invalid:443";
  const longLegacyURL = `https://media.example.invalid/${"nested-path/".repeat(120)}track.mp3?token=synthetic`;
  const reviewRun: WorkflowRun = {
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
  const runsPage = workflowRunsPageFixture([reviewRun], {
    viewTotals: { running: 0, review: 1, failed: 0, completed: 0 },
  });
  await mockWorkflows(page, runsPage);
  let retries = 0;
  await page.route("**/api/workflow-runs/51", async (route) => {
    await route.fulfill({
      json: workflowRunDetailFixture(reviewRun, {
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
      }),
    });
  });
  await page.route("**/api/workflow-runs/51/events", async (route) => {
    await route.fulfill({ json: [] satisfies WorkflowEvent[] });
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
      ] satisfies WorkflowCandidate[],
    });
  });
  await page.route("**/api/workflow-runs/51/retry", async (route) => {
    retries += 1;
    await route.fulfill({
      status: 202,
      json: { runId: 51, status: "retried", message: "retry started" } satisfies WorkflowRunActionResult,
    });
  });

  await page.setViewportSize({ width: 1265, height: 850 });
  await page.goto("/workflows?run=51");
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
  await expect(page).toHaveURL(/\/system\?tab=library&source=8$/);
});

test("run retry shows progress while pending and reports a failure", async ({ page }) => {
  await mockWorkflows(page);
  const failedRun: WorkflowRun = {
    ...sampleRun,
    id: 99,
    workflowCode: "local_library_scan",
    displayName: "Failed library scan",
    status: "failed",
  };
  // The retry request stays pending until the test has seen the busy state.
  let answerRetry = () => {};
  const retryResponse = new Promise<void>((resolve) => {
    answerRetry = resolve;
  });
  await page.route("**/api/workflow-runs/99**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/events") || url.pathname.endsWith("/candidates")) {
      await route.fulfill({ json: [] satisfies WorkflowEvent[] | WorkflowCandidate[] });
      return;
    }
    if (url.pathname.endsWith("/retry")) {
      await retryResponse;
      await route.fulfill({ status: 500, json: { error: "internal error" } satisfies ApiErrorBody });
      return;
    }
    await route.fulfill({ json: workflowRunDetailFixture(failedRun) });
  });

  await page.goto("/workflows?run=99");
  const activity = page.getByRole("region", { name: "Runs", exact: true });
  await expect(activity.getByRole("heading", { name: "Scan local library", exact: true })).toBeVisible();
  const retry = activity.getByRole("button", { name: "Retry", exact: true });
  await retry.click();
  await expect(retry).toBeDisabled();

  answerRetry();
  await expect(page.getByText("Workflow run could not be retried. Please try again.")).toBeVisible();
  await expect(retry).toBeEnabled();
});

// A clock advance fires the page's timers at once, but the requests they start still cross the network to the
// route handlers. A later request resolves only after the earlier ones reached their handlers, which count them.
async function settleIssuedRequests(page: Page) {
  await page.evaluate(() => fetch("/api/runtime-settings").then((response) => response.text()));
}

test("a hidden tab pauses operation status polling and refreshes when shown again", async ({ page }) => {
  await mockWorkflows(page);
  const running: WorkflowRun = {
    ...sampleRun,
    id: 63,
    workflowCode: "local_library_scan",
    status: "running",
    finishedAt: "",
  };
  let queueRequests = 0;
  await mockWorkflowStatuses(page, (code) => (code === "local_library_scan" ? [running] : []));
  await page.route("**/api/workflow-runs?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    // The Workflows page reads the whole active queue; the notification panel reads a shorter one.
    const queue = params.get("view") === "running" && params.get("pageSize") === "50";
    if (queue) queueRequests += 1;
    await route.fulfill({
      json: workflowRunsPageFixture(params.get("view") === "running" ? [running] : [], {
        pageSize: Number(params.get("pageSize")),
        viewTotals: { running: 1, attention: 0, history: 0, review: 0, failed: 0, completed: 0 },
      }),
    });
  });
  const setHidden = (hidden: boolean) =>
    page.evaluate((value) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => (value ? "hidden" : "visible"),
      });
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);

  await page.clock.install();
  await page.goto("/workflows");
  // A run started somewhere else shows on its operation, which cannot start again meanwhile.
  await expect(operation(page, "Scan").getByRole("button", { name: "Running", exact: true })).toBeDisabled();
  // Polling runs while the tab is visible.
  await expect.poll(() => queueRequests, { timeout: 8_000 }).toBeGreaterThanOrEqual(2);

  await setHidden(true);
  const hiddenCount = queueRequests;
  // Several polling periods pass on the page clock while the tab stays hidden.
  await page.clock.runFor(30_000);
  await settleIssuedRequests(page);
  expect(queueRequests).toBe(hiddenCount);

  await setHidden(false);
  await expect.poll(() => queueRequests, { timeout: 1_000 }).toBeGreaterThan(hiddenCount);
});

test("demo running activity stays untimed while real running work keeps its elapsed time", async ({ page }) => {
  await mockWorkflows(page);
  await page.route("**/api/runtime-settings", (route) =>
    route.fulfill({ json: runtimeSettingsFixture({ mode: "demo", demoMode: true }) }),
  );
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: authenticatedStateFixture({
        username: "__demo__",
        displayName: "Demo",
        role: "user",
        permissions: ["library:read", "playback:use"],
        demoMode: true,
      }),
    }),
  );
  const startedAt = new Date(Date.now() - 70_000).toISOString();
  const demoRun = workflowRunFixture({
    id: 64,
    workflowCode: "local_library_scan",
    displayName: "Example: Index local media",
    status: "running",
    triggerReason: "Demo example",
    startedAt,
    finishedAt: "",
    jobCount: 1,
  });
  const realRun = workflowRunFixture({
    id: 65,
    displayName: "Index local media",
    status: "running",
    startedAt,
    finishedAt: "",
    jobCount: 1,
  });
  let runningListRequests = 0;
  let eventStreams = 0;
  await page.route("**/api/workflow-runs/64**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/events/stream")) eventStreams += 1;
    if (path.endsWith("/events")) return route.fulfill({ json: [] satisfies WorkflowEvent[] });
    return route.fulfill({ json: workflowRunDetailFixture(demoRun) });
  });
  await page.route("**/api/workflow-runs?*", (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("view") === "running") runningListRequests += 1;
    return route.fulfill({
      json: workflowRunsPageFixture(params.get("view") === "running" ? [demoRun, realRun] : [], {
        viewTotals: { running: 2, attention: 0, history: 0, review: 0, failed: 0, completed: 0 },
      }),
    });
  });

  await page.clock.install();
  await page.goto("/workflows");
  const activity = page.getByRole("region", { name: "Runs", exact: true });
  const demoItem = activity.getByRole("listitem").filter({ hasText: "#64" });
  const realItem = activity.getByRole("listitem").filter({ hasText: "#65" });
  await expect(demoItem).toBeVisible();
  await expect(realItem).toContainText(/1m \d+s/);
  await expect(demoItem).not.toContainText(/1m \d+s/);
  await demoItem.getByRole("button").click();
  await expect(activity.getByRole("heading", { name: "Scan local library", exact: true })).toBeVisible();
  const initialRequests = runningListRequests;
  // Several polling periods pass on the page clock without another request.
  await page.clock.runFor(30_000);
  await settleIssuedRequests(page);
  expect(runningListRequests).toBe(initialRequests);
  expect(eventStreams).toBe(0);
});

test("activity deep links load a run outside the visible list page", async ({ page }) => {
  await mockWorkflows(page);
  const detachedRun: WorkflowRun = { ...sampleRun, id: 99, displayName: "Detached cleanup run" };
  await page.route("**/api/workflow-runs/99**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/events") || url.pathname.endsWith("/candidates")) {
      await route.fulfill({ json: [] satisfies WorkflowEvent[] | WorkflowCandidate[] });
      return;
    }
    await route.fulfill({ json: workflowRunDetailFixture(detachedRun) });
  });

  await page.goto("/workflows?run=99");

  await expect(page).toHaveURL(/\/workflows\?run=99$/);
  const activity = page.getByRole("region", { name: "Runs", exact: true });
  await expect(activity.getByRole("heading", { name: "Pull DLsite rankings", exact: true })).toBeVisible();
  await expect(activity.getByText("#99", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open full Activity", exact: true })).toHaveCount(0);
});

test("Workflows counts what needs attention on its tab and shows each list's empty state", async ({ page }) => {
  await mockWorkflows(
    page,
    workflowRunsPageFixture([], {
      viewTotals: { running: 0, review: 0, failed: 0, completed: 14, attention: 3, history: 14 },
    }),
  );
  await page.goto("/workflows");
  const runs = page.getByRole("region", { name: "Runs", exact: true });
  const tabs = runs.getByRole("tablist", { name: "Runs", exact: true });
  // Operations is the default tab; Needs attention names its count while something waits.
  await expect(tabs.getByRole("tab")).toHaveText(["Operations", /^Needs attention\s*3$/, "History"]);
  await expect(tabs.getByRole("tab", { name: "Operations", exact: true })).toHaveAttribute("aria-selected", "true");
  await tabs.getByRole("tab", { name: /^Needs attention/ }).click();
  await expect(page).toHaveURL(/\/workflows\?tab=attention$/);
  await expect(runs.getByText("No tasks need attention.", { exact: true })).toBeVisible();
  await tabs.getByRole("tab", { name: "History", exact: true }).click();
  await expect(page).toHaveURL(/\/workflows\?tab=history$/);
  await expect(runs.getByText("No history yet.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("activity preserves its loading state until the scoped request completes", async ({ page }) => {
  let releaseRuns: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    releaseRuns = resolve;
  });
  await mockWorkflows(page);
  await page.route("**/api/workflow-runs?**", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    // Only History narrowed to failed runs reads the failed list.
    if (params.get("view") !== "failed") {
      await route.fallback();
      return;
    }
    await gate;
    await route.fulfill({
      json: workflowRunsPageFixture([], {
        pageSize: 20,
        viewTotals: { running: 0, review: 0, failed: 0, completed: 0, attention: 0, history: 0 },
      }),
    });
  });
  await page.goto("/workflows?tab=history&status=failed");
  const activity = page.getByRole("region", { name: "Runs", exact: true });
  await expect(activity.getByRole("status")).toBeVisible();
  releaseRuns();
  await expect(activity.getByText("No failed runs.", { exact: true })).toBeVisible();
  await expect(activity.getByRole("status")).toHaveCount(0);
});

test("workflow metadata loads as one snapshot without an interim empty panel", async ({ page }) => {
  let releaseDefinitions: () => void = () => undefined;
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
  await expect(page.getByText("No runnable workflow definitions exist yet.", { exact: true })).toHaveCount(0);

  releaseDefinitions();
  await expect(operation(page, "Metadata")).toBeVisible();
  await expect(page.getByRole("status", { name: "Loading workflow data" })).toHaveCount(0);
});

test("mobile header keeps Notifications and the account panel, which holds the rest", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockWorkflows(page);
  await page.goto("/workflows");

  await expect(page.getByRole("button", { name: "Notifications", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Quick actions" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open appearance settings" })).toHaveCount(0);

  const headerActions = page.locator("header").getByRole("button", { name: /^(Notifications|Account menu)$/ });
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
  ).toEqual(["Notifications", "Account menu"]);

  // With the Record library on, Record is the second of five bottom tabs.
  const bottomTabs = page.locator("footer nav").getByRole("button");
  const bottomTabNames = ["Library", "Record", "Favorites", "Circles", "Voice Actors"];
  await expect(bottomTabs).toHaveCount(bottomTabNames.length);
  for (const [index, name] of bottomTabNames.entries()) {
    await expect(bottomTabs.nth(index)).toHaveAccessibleName(name);
  }

  await page.getByRole("button", { name: "Account menu" }).click();
  const accountPopover = page.getByRole("dialog", { name: "Account" });
  await expect(accountPopover).toBeVisible();
  expect(await accountPopover.evaluate((element) => getComputedStyle(element).zIndex)).toBe("50");
  // A phone's account panel tiles For you, Discover, and Insights in one row like a wide screen, then lists
  // Quick actions first, the pages the bottom navigation does not carry, and the account's own entries.
  await expect(accountPopover.getByRole("button", { name: /^Review/ })).toHaveCount(0);
  await expect(accountPopover.getByRole("group", { name: "Mode" })).toHaveCount(0);
  await expect(accountPopover.getByRole("combobox", { name: "UI language" })).toHaveCount(0);
  for (const name of ["For you", "Quick actions", "Discover", "Insights", "Tags", "Settings", "About"]) {
    await expect(accountPopover.getByRole("button", { name, exact: true })).toBeVisible();
  }
  const tileBoxes = await Promise.all(
    ["For you", "Discover", "Insights"].map((name) =>
      accountPopover.getByRole("button", { name, exact: true }).boundingBox(),
    ),
  );
  const listBoxes = await Promise.all(
    ["Quick actions", "Tags", "Settings"].map((name) =>
      accountPopover.getByRole("button", { name, exact: true }).boundingBox(),
    ),
  );
  expect(tileBoxes.every((box) => Math.abs(box!.y - tileBoxes[0]!.y) < 1)).toBe(true);
  expect(tileBoxes.map((box) => box!.x)).toEqual([...tileBoxes.map((box) => box!.x)].sort((a, b) => a - b));
  expect(listBoxes[0]!.y).toBeGreaterThan(tileBoxes[0]!.y + tileBoxes[0]!.height);
  expect(listBoxes.map((box) => box!.y)).toEqual([...listBoxes.map((box) => box!.y)].sort((a, b) => a - b));
  for (const name of ["Library", "Record", "Favorites", "Circles", "Voice Actors", "Workflows", "Users"]) {
    await expect(accountPopover.getByRole("button", { name, exact: true })).toHaveCount(0);
  }
  await expect(accountPopover.getByRole("button", { name: /^Appearance/ })).toBeVisible();
  // About shares the closing row with Sign out, or here with the note of a session that cannot sign out.
  const [aboutBox, noteBox] = await Promise.all([
    accountPopover.getByRole("button", { name: "About", exact: true }).boundingBox(),
    accountPopover.getByText("Dev mode session does not require sign out.", { exact: true }).boundingBox(),
  ]);
  expect(Math.abs(aboutBox!.y + aboutBox!.height / 2 - (noteBox!.y + noteBox!.height / 2))).toBeLessThan(2);
  expect(aboutBox!.x + aboutBox!.width).toBeLessThanOrEqual(noteBox!.x);

  // The Manage pages sit behind one entry, which names the current page while it is one of them.
  const manageEntry = accountPopover.getByRole("button", { name: /^Manage/ });
  await expect(manageEntry).toHaveAttribute("aria-current", "page");
  await expect(manageEntry).toContainText("Workflows");
  await manageEntry.click();
  await expect(accountPopover.getByRole("button", { name: "Back", exact: true })).toBeFocused();
  await expect(accountPopover.getByRole("button", { name: "Workflows", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  // The view lists the Manage pages in the sidebar's order.
  await expect(
    accountPopover.getByRole("button", { name: /^(Workflows|Metadata|Translation|Cleanup|System)$/ }),
  ).toHaveText(["Workflows", "Metadata", "Translation", "Cleanup", "System"]);
  await accountPopover.getByRole("button", { name: "Back", exact: true }).click();
  await expect(manageEntry).toBeFocused();

  await accountPopover.getByRole("button", { name: /^Language/ }).click();
  await expect(accountPopover.getByRole("button", { name: "Back", exact: true })).toBeFocused();
  await accountPopover.getByRole("combobox", { name: "UI language" }).click();
  const languageListbox = page.getByRole("listbox");
  await expect(languageListbox.getByRole("option")).toHaveCount(6);
  const languageListboxBox = await languageListbox.boundingBox();
  expect(languageListboxBox).not.toBeNull();
  expect(languageListboxBox!.x).toBeGreaterThanOrEqual(0);
  expect(languageListboxBox!.x + languageListboxBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(languageListboxBox!.y + languageListboxBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await languageListbox.getByRole("option", { name: "Auto", exact: true }).click();
  await expect(accountPopover).toBeVisible();
  await expect(accountPopover.getByRole("combobox", { name: "UI language" })).toHaveCSS("box-shadow", "none");

  await accountPopover.getByRole("combobox", { name: "UI language" }).click();
  await accountPopover.getByText("Language", { exact: true }).click();
  await expect(languageListbox).toBeHidden();
  await expect(accountPopover).toBeVisible();

  await accountPopover.getByRole("combobox", { name: "UI language" }).click();
  await expect(languageListbox).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(languageListbox).toBeHidden();
  await expect(accountPopover).toBeVisible();
  await accountPopover.getByRole("button", { name: "Back", exact: true }).click();
  await expect(accountPopover.getByRole("button", { name: /^Language/ })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(accountPopover).toHaveCount(0);

  // Appearance opens as a view of the account panel on phones.
  const appearancePopover = await openAppearance(page);
  await expect(appearancePopover.getByRole("button", { name: "Back", exact: true })).toBeFocused();
  await expect(appearancePopover.getByRole("combobox", { name: "UI language" })).toHaveCount(0);

  const modeGroup = appearancePopover.getByRole("group", { name: "Mode" });
  const modeBox = await modeGroup.boundingBox();
  expect(modeBox).not.toBeNull();
  expect(modeBox!.x).toBeGreaterThanOrEqual(0);
  expect(modeBox!.x + modeBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width);

  await modeGroup.getByRole("radio", { name: "Dark", exact: true }).click();
  await expect(modeGroup.getByRole("radio", { name: "Dark", exact: true })).toBeChecked();
  await expect(appearancePopover).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await appearancePopover.getByRole("button", { name: "Apple", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme-preset", "apple");
  await appearancePopover.getByRole("button", { name: "Pink", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme-palette", "pink");
  const colorGroupBox = await appearancePopover.getByRole("group", { name: "Color" }).boundingBox();
  expect(colorGroupBox).not.toBeNull();
  expect(colorGroupBox!.x).toBeGreaterThanOrEqual(0);
  expect(colorGroupBox!.x + colorGroupBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(colorGroupBox!.y + colorGroupBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.keyboard.press("Escape");
  await expect(appearancePopover).toHaveCount(0);

  // Quick actions opens from the account panel on phones.
  await page.getByRole("button", { name: "Account menu" }).click();
  await accountPopover.getByRole("button", { name: "Quick actions", exact: true }).click();
  await expect(accountPopover).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Notifications", exact: true }).click();
  await page.getByRole("dialog", { name: "Notifications" }).getByRole("button", { name: "Open Workflows" }).click();
  await expect(page).toHaveURL(/\/workflows$/);
});

/**
 * Opens Appearance: its own header control on wider screens, a view of the
 * account panel on phones. Returns the surface that holds the controls.
 */
async function openAppearance(page: Page) {
  const headerControl = page.getByRole("button", { name: "Open appearance settings" });
  const accountMenu = page.getByRole("button", { name: "Account menu" });
  // isVisible does not wait, so let the header render before choosing the entry.
  await expect(headerControl.or(accountMenu).first()).toBeVisible();
  if (await headerControl.isVisible()) {
    await headerControl.click();
    const appearance = page.getByRole("dialog", { name: "Appearance" });
    await expect(appearance.getByRole("group", { name: "Color", exact: true })).toBeVisible();
    return appearance;
  }
  await accountMenu.click();
  const account = page.getByRole("dialog", { name: "Account" });
  await account.getByRole("button", { name: /^Appearance/ }).click();
  await expect(account.getByRole("group", { name: "Color", exact: true })).toBeVisible();
  return account;
}

test("opening a header floating select keeps fixed mobile surfaces stable", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 844 });
  await mockWorkflows(page);
  await page.goto("/workflows");

  await page.getByRole("button", { name: "Account menu" }).click();
  const accountPopover = page.getByRole("dialog", { name: "Account" });
  await accountPopover.getByRole("button", { name: /^Language/ }).click();
  const footer = page.locator("footer");
  const footerBefore = await footer.boundingBox();
  expect(footerBefore).not.toBeNull();

  await accountPopover.getByRole("combobox", { name: "UI language" }).click();
  await expect(page.locator("body")).not.toHaveAttribute("data-scroll-locked");

  const footerAfter = await footer.boundingBox();
  expect(footerAfter).not.toBeNull();
  expect(Math.abs(footerAfter!.x - footerBefore!.x)).toBeLessThan(0.5);
  expect(Math.abs(footerAfter!.width - footerBefore!.width)).toBeLessThan(0.5);
});

test("@desktop header popovers render above page content", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockWorkflows(page);
  await page.goto("/workflows");

  await openAppearance(page);
  const modeGroup = page.getByRole("group", { name: "Mode" });
  await expect(modeGroup).toBeVisible();
  const headerBox = await page
    .locator("header")
    .filter({ has: page.getByRole("button", { name: "User menu" }) })
    .boundingBox();
  const popoverBox = await modeGroup.boundingBox();
  expect(headerBox).not.toBeNull();
  expect(popoverBox).not.toBeNull();
  expect(popoverBox!.y + popoverBox!.height).toBeGreaterThan(headerBox!.y + headerBox!.height);
  await modeGroup.getByRole("radio", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
});

test("@desktop sidebar keeps listening destinations in view and folds the rest into Personal and Manage", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockWorkflows(page);
  await page.goto("/");

  const sidebar = page.locator("aside nav");
  const personal = sidebar.getByRole("button", { name: "Personal", exact: true });
  const manage = sidebar.getByRole("button", { name: "Manage", exact: true });
  await expect(personal).toHaveAttribute("aria-expanded", "false");
  await expect(manage).toHaveAttribute("aria-expanded", "false");
  for (const name of ["Workflows", "Metadata", "Translation", "Cleanup", "System", "Settings", "Insights", "Tags"]) {
    await expect(sidebar.getByRole("button", { name, exact: true })).toHaveCount(0);
  }
  // About closes the sidebar's list outside the groups.
  await expect(sidebar.getByRole("button").last()).toHaveAccessibleName("About");
  await expect(page.locator("header").getByRole("button", { name: "Open appearance settings" })).toBeVisible();

  // Each group remembers its own expanded state on this device.
  await manage.click();
  await expect(sidebar.getByRole("button", { name: "Workflows", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "System", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: /^(Workflows|Metadata|Translation|Cleanup|System)$/ })).toHaveText([
    "Workflows",
    "Metadata",
    "Translation",
    "Cleanup",
    "System",
  ]);
  await expect(personal).toHaveAttribute("aria-expanded", "false");
  await page.reload();
  await expect(manage).toHaveAttribute("aria-expanded", "true");
  await expect(personal).toHaveAttribute("aria-expanded", "false");
  await manage.click();
  await expect(manage).toHaveAttribute("aria-expanded", "false");

  // A group's page opens the group without changing the stored choice.
  await page.goto("/workflows");
  await expect(manage).toHaveAttribute("aria-expanded", "true");
  await expect(personal).toHaveAttribute("aria-expanded", "false");
  await expect(sidebar.getByRole("button", { name: "Workflows", exact: true })).toHaveAttribute("aria-current", "page");
  await page.goto("/settings");
  await expect(personal).toHaveAttribute("aria-expanded", "true");
  await expect(manage).toHaveAttribute("aria-expanded", "false");
  await expect(sidebar.getByRole("button", { name: "Settings", exact: true })).toHaveAttribute("aria-current", "page");
  for (const name of ["Insights", "Tags"]) {
    await expect(sidebar.getByRole("button", { name, exact: true })).toBeVisible();
  }

  // The account panel adds For you, Discover, and Insights as tiles and lists Tags and Settings, repeats
  // nothing else the sidebar holds, and marks the current page.
  await page.getByRole("button", { name: "User menu" }).click();
  const account = page.getByRole("dialog", { name: "Account" });
  await expect(account.getByRole("button", { name: /^(For you|Discover|Insights)$/ })).toHaveText([
    "For you",
    "Discover",
    "Insights",
  ]);
  for (const name of ["Tags", "Settings"]) {
    await expect(account.getByRole("button", { name, exact: true })).toBeVisible();
  }
  for (const name of ["Record", "Library", "Users", "About"]) {
    await expect(account.getByRole("button", { name, exact: true })).toHaveCount(0);
  }
  await expect(account.getByRole("button", { name: /^(Manage|Appearance)/ })).toHaveCount(0);
  await account.getByRole("button", { name: "Insights", exact: true }).click();
  await expect(page).toHaveURL(/\/insights/);
  await page.getByRole("button", { name: "User menu" }).click();
  await expect(account.getByRole("button", { name: "Insights", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(account.getByRole("button", { name: "Discover", exact: true })).not.toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.keyboard.press("Escape");
  await sidebar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.getByRole("heading", { name: "About", exact: true, level: 1 })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "About", exact: true })).toHaveAttribute("aria-current", "page");
  await page.goto("/workflows");

  // The icon rail keeps the same structure.
  await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  await expect(manage).toHaveAttribute("aria-expanded", "true");
  await expect(sidebar.getByRole("button", { name: "Translation", exact: true })).toBeVisible();
  await manage.click();
  await expect(sidebar.getByRole("button", { name: "Translation", exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole("button", { name: "Library", exact: true })).toBeVisible();
});

test("@desktop settings theme styles and colors change independently and persist", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockWorkflows(page);
  await page.goto("/settings");

  await expect(page.getByRole("tab", { name: "Appearance", exact: true })).toHaveCount(0);
  await openAppearance(page);

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
  await page.getByRole("button", { name: "Pink", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme-palette", "pink");
  const applePinkTokens = await themeVisualTokens(page);
  expect(applePinkTokens.primary).not.toBe(appleOriginalTokens.primary);
  expect(applePinkTokens.radius).toBe(appleOriginalTokens.radius);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme-preset", "apple");
  await expect(page.locator("html")).toHaveAttribute("data-theme-palette", "pink");
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

test("initial setup creates the first administrator with the setup token", async ({ page }) => {
  await mockWorkflows(page);
  const administrator = currentUserFixture({
    username: "synthetic-admin",
    displayName: "synthetic-admin",
    role: "super_admin",
    permissions: ["system:admin"],
  });
  let authenticated = false;
  const submissions: Array<{ setupToken: string; username: string; password: string }> = [];
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: (authenticated
        ? { authenticated: true, user: administrator }
        : { authenticated: false, setupRequired: true }) satisfies AuthState,
    }),
  );
  await page.route("**/api/auth/setup", async (route) => {
    const payload = route.request().postDataJSON() as { setupToken: string; username: string; password: string };
    submissions.push(payload);
    if (payload.setupToken !== "synthetic-setup-token") {
      await route.fulfill({
        status: 403,
        json: { error: "invalid setup token", code: "invalid_setup_token", retryable: false } satisfies ApiErrorBody,
      });
      return;
    }
    authenticated = true;
    await route.fulfill({ status: 201, json: { authenticated: true, user: administrator } satisfies AuthState });
  });

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Set up Kikoto" })).toBeVisible();
  await page.getByLabel("Setup token").fill("wrong-token");
  await page.getByLabel("Administrator username").fill("synthetic-admin");
  await page.getByLabel("Password", { exact: true }).fill("synthetic-password");
  await page.getByLabel("Confirm password").fill("different-password");
  await page.getByRole("button", { name: "Create administrator" }).click();
  await expect(page.getByRole("alert")).toHaveText("Passwords do not match.");
  expect(submissions).toHaveLength(0);

  await page.getByLabel("Confirm password").fill("synthetic-password");
  await page.getByRole("button", { name: "Create administrator" }).click();
  await expect(page.getByRole("alert")).toContainText("The setup token is incorrect.");

  await page.getByLabel("Setup token").fill(" synthetic-setup-token ");
  await page.getByRole("button", { name: "Create administrator" }).click();
  await expect(page.getByRole("button", { name: "Edit account", exact: true })).toBeVisible();
  expect(submissions.at(-1)).toEqual({
    setupToken: "synthetic-setup-token",
    username: "synthetic-admin",
    password: "synthetic-password",
  });
});

test("settings identifies an environment-managed root password", async ({ page }) => {
  await mockWorkflows(page);
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: authenticatedStateFixture({
        username: "configured-root",
        displayName: "Configured Root",
        role: "super_admin",
        permissions: ["system:admin"],
        passwordManagedBy: "environment",
      }),
    }),
  );

  await page.goto("/settings");
  await page.getByRole("button", { name: "Edit account", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit account", exact: true });
  await expect(dialog.getByRole("status")).toContainText("KIKOTO_ROOT_PASSWORD");
  await expect(dialog.getByLabel("Current password")).toHaveCount(0);
});

test("demo settings keeps account and workflows read-only while allowing appearance changes", async ({ page }) => {
  const demoNotice = "Demo mode: every feature is visible, but server data cannot be changed.";
  await mockWorkflows(page);
  await page.route("**/api/runtime-settings", (route) =>
    route.fulfill({ json: runtimeSettingsFixture({ mode: "demo", demoMode: true, anonymousAccessEnabled: false }) }),
  );
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: authenticatedStateFixture({
        username: "__demo__",
        displayName: "Demo",
        role: "user",
        permissions: ["library:read", "playback:use"],
        demoMode: true,
      }),
    }),
  );

  await page.goto("/settings");
  // Autosaving sections hold their own status regions, so the notice is found by its text.
  const notice = page.getByRole("status").filter({ hasText: demoNotice });
  await expect(notice).toHaveText(demoNotice);
  await expect(page.getByRole("tablist", { name: "Settings", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Export", exact: true })).toBeVisible();
  const noticeBackground = await notice.evaluate((element) => getComputedStyle(element).backgroundColor);
  // Demo opens the Tags page and every System and Cleanup tab read-only, as administrators see them.
  await page.goto("/tags");
  await expect(page.getByText(demoNotice, { exact: true })).toHaveCount(1);
  await page.goto("/system");
  await expect(page.getByText(demoNotice, { exact: true })).toHaveCount(1);
  await expect(page.getByRole("tablist", { name: "System", exact: true }).getByRole("tab")).toHaveText([
    "Library",
    "Cache & Fetch",
    "Proxy",
    "ASR & LLM",
    "Users",
  ]);
  await page.goto("/cleanup");
  await expect(page.getByText(demoNotice, { exact: true })).toHaveCount(1);
  await expect(page.getByRole("tablist", { name: "Cleanup", exact: true }).getByRole("tab")).toHaveText([
    "Works",
    "Cache",
    "Database",
  ]);
  await page.goto("/settings");
  await expect(notice).toHaveText(demoNotice);
  await expect(page.getByRole("tab", { name: "Appearance", exact: true })).toHaveCount(0);
  await openAppearance(page);
  for (const name of ["Anthropic", "OpenAI", "Apple", "Google MD", "Original", "Blue", "Green"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeEnabled();
  }
  await page
    .getByRole("group", { name: "Mode", exact: true })
    .getByRole("radio", { name: "Dark", exact: true })
    .click();
  await page.getByRole("button", { name: "Apple", exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator("html")).toHaveAttribute("data-theme-preset", "apple");
  await expect
    .poll(() => notice.evaluate((element) => getComputedStyle(element).backgroundColor))
    .not.toBe(noticeBackground);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator("html")).toHaveAttribute("data-theme-preset", "apple");

  await page.goto("/workflows");
  await expect(page.getByText(demoNotice, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "New workflow", exact: true })).toHaveCount(0);
  await operation(page, "Scan").getByRole("button", { name: "Scan triggers", exact: true }).click();
  const triggerList = page.getByRole("dialog", { name: "Scan triggers", exact: true });
  await expect(triggerList.getByRole("button", { name: "Add trigger", exact: true })).toBeDisabled();
  await expect(triggerList.getByRole("switch").first()).toBeDisabled();
  await triggerList.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(operation(page, "Metadata").getByRole("button", { name: "Run", exact: true })).toBeDisabled();
  await nextTriggers(page).getByRole("button", { name: "View Scan", exact: true }).first().click();
  const triggerDialog = page.getByRole("dialog", { name: "Edit trigger", exact: true });
  await expect(triggerDialog.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
  await expect(triggerDialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
});

test("the mobile Workflows page stacks the cards above the runs without scrolling sideways", async ({ page }) => {
  await mockWorkflows(page);
  await page.goto("/workflows");
  const cards = page.getByRole("main").getByRole("list").first().getByRole("group");
  await expect(cards).toHaveCount(3);
  // There is no list to choose from first, so there is nothing to go back to.
  await expect(page.getByRole("button", { name: /^Back/ })).toHaveCount(0);
  const [first, second] = await Promise.all([cards.nth(0).boundingBox(), cards.nth(1).boundingBox()]);
  expect(second!.y).toBeGreaterThan(first!.y + first!.height - 1);
  await expect(nextTriggers(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("an operation runs from its card, shows the run, and cannot start again until it ends", async ({ page }) => {
  await mockWorkflows(page);
  const requests: unknown[] = [];
  let scan: WorkflowRun | null = null;
  const scanRun = (overrides: Partial<WorkflowRun>): WorkflowRun => ({
    ...sampleRun,
    id: 61,
    workflowCode: "local_library_scan",
    displayName: "Scan local library",
    definitionId: 7,
    finishedAt: "",
    nodeRunCount: 4,
    completedNodeRuns: 0,
    ...overrides,
  });
  await mockWorkflowStatuses(page, (code) => (code === "local_library_scan" && scan ? [scan] : []));
  await page.route("**/api/workflow-runs?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const active = scan !== null && ["queued", "running"].includes(scan.status);
    const runs =
      params.get("view") === "running"
        ? active && scan
          ? [scan]
          : []
        : params.get("workflowCode") === "local_library_scan" && scan
          ? [scan]
          : [];
    await route.fulfill({
      json: workflowRunsPageFixture(runs, {
        pageSize: Number(params.get("pageSize")),
        viewTotals: { running: active ? 1 : 0, attention: 0, history: 0, review: 0, failed: 0, completed: 0 },
      }),
    });
  });
  await page.route("**/api/workflow-runs/local-scan", async (route) => {
    requests.push(route.request().postDataJSON());
    scan = scanRun({ status: "queued", startedAt: "" });
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
        followUpRun: false,
        newWorkCodes: [],
        failures: [],
      } satisfies LocalScanResult,
    });
  });
  await page.route("**/api/workflow-runs/61", (route) =>
    route.fulfill({ json: workflowRunDetailFixture(scanRun({ status: "failed" })) }),
  );
  await page.route("**/api/workflow-runs/61/*", (route) => route.fulfill({ json: [] }));

  await page.goto("/workflows");
  const row = operation(page, "Scan");
  await expect(row).toContainText("Never run");
  await row.getByRole("button", { name: "Run", exact: true }).click();
  // The row answers at once and holds the run control while the run is queued and running.
  await expect(row.getByRole("button", { name: "Queued", exact: true })).toBeDisabled();
  expect(requests).toEqual([{ followUpRun: false }]);
  await expect(row.getByRole("button", { name: "Run", exact: true })).toHaveCount(0);

  scan = scanRun({ status: "running", completedNodeRuns: 1 });
  await expect(row.getByRole("button", { name: "Running", exact: true })).toBeDisabled();
  await expect(row).toContainText("Step 2 of 4");

  // A failure stays on the operation, the run control returns, and the state leads to the run.
  scan = scanRun({ status: "failed", finishedAt: "2026-07-14T00:01:00Z" });
  await expect(row.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  await row.getByRole("button", { name: "Open run #61 (Failed)", exact: true }).click();
  await expect(page).toHaveURL(/\/workflows\?run=61$/);
  await expect(
    page.getByRole("region", { name: "Runs", exact: true }).getByRole("heading", { name: "Scan local library" }),
  ).toBeVisible();
});

for (const viewport of ["mobile", "@desktop"]) {
  test(`${viewport} what runs stays above the tabs, Needs attention holds what waits, and History what ended`, async ({
    page,
  }, testInfo) => {
    await mockWorkflows(page);
    let reviewed = false;
    const failed: WorkflowRun = {
      ...sampleRun,
      id: 61,
      workflowCode: "local_library_scan",
      displayName: "Example failed fetch",
      status: "failed",
      pendingMetadata: 0,
    };
    const metadata: WorkflowRun = {
      ...sampleRun,
      id: 62,
      workflowCode: "local_library_scan",
      status: "partial",
      pendingMetadata: 2,
      pendingFailedMetadata: 2,
    };
    const running: WorkflowRun = {
      ...sampleRun,
      id: 63,
      workflowCode: "local_library_scan",
      status: "running",
      finishedAt: "",
    };
    await page.route("**/api/workflow-runs?*", async (route) => {
      const params = new URL(route.request().url()).searchParams;
      const view = params.get("view");
      const runs =
        view === "attention"
          ? reviewed
            ? [metadata]
            : [failed, metadata]
          : view === "running"
            ? [running]
            : view === "history"
              ? [sampleRun, ...(reviewed ? [failed] : [])]
              : [];
      await route.fulfill({
        json: workflowRunsPageFixture(runs, {
          pageSize: Number(params.get("pageSize")),
          viewTotals: {
            running: 1,
            attention: reviewed ? 1 : 2,
            history: reviewed ? 2 : 1,
            review: 0,
            failed: 1,
            completed: 1,
          },
        }),
      });
    });
    await page.route("**/api/workflow-runs/61/review", async (route) => {
      reviewed = true;
      await route.fulfill({ json: { ...failed, reviewedAt: "2026-01-01 00:00:00" } satisfies WorkflowRun });
    });
    await page.goto("/workflows");
    const activity = page.getByRole("region", { name: "Runs", exact: true });
    const tab = (name: RegExp) => activity.getByRole("tab", { name });
    const runningList = activity.getByRole("region", { name: "Running", exact: true });
    const panel = activity.getByRole("tabpanel");
    // What runs shows above every tab; Needs attention counts what waits for someone.
    await expect(tab(/^Operations$/)).toHaveAttribute("aria-selected", "true");
    await expect(runningList.getByText("#63", { exact: true })).toBeVisible();
    await tab(/^Needs attention\s*2$/).click();
    await expect(page).toHaveURL(/\/workflows\?tab=attention$/);
    await expect(runningList.getByText("#63", { exact: true })).toBeVisible();
    await expect(panel.getByText("#61", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Mark reviewed", exact: true }).click();
    await expect(tab(/^Needs attention\s*1$/)).toBeVisible();
    await expect(panel.getByText("#61", { exact: true })).toHaveCount(0);
    await tab(/^History$/).click();
    await expect(panel.getByText("#61", { exact: true })).toBeVisible();
    await tab(/^Needs attention/).click();
    await page.screenshot({ path: testInfo.outputPath("workflow-attention.png") });
    await panel.getByRole("button", { name: "Open metadata issues", exact: true }).click();
    await expect(page).toHaveURL(/metadata\?reason=metadata&metadataRun=62/);
    await expect(page.getByRole("heading", { name: "Metadata", exact: true })).toBeVisible();
  });
}

test("Needs attention marks a run reviewed when only not-found products remain", async ({ page }) => {
  await mockWorkflows(page);
  const notFound: WorkflowRun = {
    ...sampleRun,
    id: 64,
    workflowCode: "metadata_sync",
    status: "succeeded",
    pendingMetadata: 1,
    pendingFailedMetadata: 0,
  };
  const retryable: WorkflowRun = { ...notFound, id: 65, status: "partial", pendingFailedMetadata: 1 };
  const reviews: string[] = [];
  await page.route("**/api/workflow-runs?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const runs = params.get("view") === "attention" ? [notFound, retryable] : [];
    await route.fulfill({ json: workflowRunsPageFixture(runs, { pageSize: Number(params.get("pageSize")) }) });
  });
  await page.route("**/api/workflow-runs/*/review", async (route) => {
    reviews.push(new URL(route.request().url()).pathname);
    await route.fulfill({ json: { ...notFound, reviewedAt: "2026-01-01 00:00:00" } satisfies WorkflowRun });
  });
  // An earlier address of the run log opens Workflows on Needs attention.
  await page.goto("/workflows?activity=1&view=attention");
  await expect(page).toHaveURL(/\/workflows\?tab=attention$/);
  const activity = page.getByRole("region", { name: "Runs", exact: true });
  const row = (id: number) => activity.getByRole("listitem").filter({ hasText: `#${id}` });
  await expect(row(65).getByRole("button", { name: "Open metadata issues", exact: true })).toBeVisible();
  await expect(row(65).getByRole("button", { name: "Mark reviewed", exact: true })).toHaveCount(0);
  await row(64).getByRole("button", { name: "Mark reviewed", exact: true }).click();
  await expect.poll(() => reviews).toEqual(["/api/workflow-runs/64/review"]);
});

for (const viewport of ["mobile", "@desktop"]) {
  test(`${viewport} History covers every workflow and narrows to one`, async ({ page }, testInfo) => {
    await mockWorkflows(page);
    const scopes: string[] = [];
    const local: WorkflowRun = {
      ...sampleRun,
      id: 71,
      definitionId: 2,
      workflowCode: "local_library_scan",
      displayName: "Example local run",
    };
    const metadata: WorkflowRun = {
      ...sampleRun,
      id: 72,
      definitionId: 1,
      workflowCode: "metadata_sync",
      displayName: "Example metadata run",
      subject: "RG00000000",
    };
    await page.route("**/api/workflow-runs?*", async (route) => {
      const params = new URL(route.request().url()).searchParams;
      const code = params.get("workflowCode") ?? "";
      // History reads pages of twenty; the notification panel, the cards, and Now read other sizes.
      if (params.get("pageSize") === "20") scopes.push(code);
      const runs = ["attention", "running"].includes(params.get("view") ?? "") ? [] : [local, metadata];
      await route.fulfill({
        json: workflowRunsPageFixture(runs, {
          pageSize: Number(params.get("pageSize")),
          viewTotals: { running: 0, review: 0, failed: 0, completed: 0, attention: 0, history: 2 },
        }),
      });
    });
    await page.route("**/api/workflow-runs/72", (route) => route.fulfill({ json: workflowRunDetailFixture(metadata) }));
    await page.route("**/api/workflow-runs/72/events*", (route) =>
      route.fulfill({ json: [] satisfies WorkflowEvent[] }),
    );
    await page.goto("/workflows?tab=history");
    const panel = page.getByRole("region", { name: "Runs", exact: true });
    await expect(panel.getByText("#71", { exact: true })).toBeVisible();
    await expect(panel.getByText("#72", { exact: true })).toBeVisible();
    expect(scopes).toContain("");

    // The workflow filter narrows History to one workflow's runs.
    scopes.length = 0;
    const filter = panel.getByRole("combobox", { name: "Workflow", exact: true });
    await filter.selectOption("metadata_sync");
    await expect(page).toHaveURL(/\/workflows\?tab=history&workflow=metadata_sync$/);
    await expect.poll(() => scopes).toContain("metadata_sync");
    expect(scopes).not.toContain("");
    await panel.getByRole("button", { name: /#72/ }).click();
    await expect(panel.getByRole("heading", { name: "Sync work metadata · RG00000000", exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/workflows\?tab=history&workflow=metadata_sync&run=72$/);
    await page.screenshot({ path: testInfo.outputPath("workflow-run-panel.png") });
    // The mobile layout returns from a run through the page header; a run beside History closes in place.
    await page.getByRole("button", { name: viewport === "mobile" ? "Back to runs" : "Close run", exact: true }).click();
    await expect(page).toHaveURL(/\/workflows\?tab=history&workflow=metadata_sync$/);
    await filter.selectOption("");
    await expect(page).toHaveURL(/\/workflows\?tab=history$/);
    await expect.poll(() => scopes).toContain("");
  });
}

test("@desktop a run of a list opens beside it, and a run opened from elsewhere takes the page until Back", async ({
  page,
}) => {
  const running: WorkflowRun = {
    ...sampleRun,
    id: 63,
    workflowCode: "local_library_scan",
    status: "running",
    finishedAt: "",
  };
  await mockWorkflows(
    page,
    workflowRunsPageFixture([sampleRun, running], {
      viewTotals: { running: 1, review: 0, failed: 0, completed: 1 },
    }),
  );
  await page.route("**/api/workflow-runs/63**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({
      json: path.endsWith("/events") || path.endsWith("/candidates") ? [] : workflowRunDetailFixture(running),
    });
  });
  await page.goto("/workflows?tab=history");
  const activity = page.getByRole("region", { name: "Runs", exact: true });
  const panel = activity.getByRole("tabpanel");
  const row = panel.getByRole("button", { name: /#51/ });
  const detail = activity.getByRole("heading", { name: "Pull DLsite rankings", exact: true });

  // A History row opens beside the list, and selecting it again closes it.
  await row.click();
  await expect(page).toHaveURL(/\/workflows\?tab=history&run=51$/);
  await expect(detail).toBeVisible();
  await expect(row).toHaveAttribute("aria-current", "true");
  await row.click();
  await expect(page).toHaveURL(/\/workflows\?tab=history$/);
  await expect(detail).toHaveCount(0);

  // Escape and Close each close it and return focus to its row.
  await row.click();
  await expect(detail).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);
  await expect(row).toBeFocused();
  await row.click();
  await activity.getByRole("button", { name: "Close run", exact: true }).click();
  await expect(detail).toHaveCount(0);
  await expect(row).toBeFocused();

  // Another tab shows other runs, so the open run closes with the list it belonged to.
  await row.click();
  await expect(detail).toBeVisible();
  await activity.getByRole("tab", { name: "Operations", exact: true }).click();
  await expect(page).toHaveURL(/\/workflows$/);
  await expect(detail).toHaveCount(0);
  await expect(operation(page, "Scan")).toBeVisible();

  // A running run opens on its own, and Back returns to the list it was opened from.
  await activity.getByRole("tab", { name: "History", exact: true }).click();
  await activity.getByRole("region", { name: "Running", exact: true }).getByRole("button", { name: /#63/ }).click();
  await expect(page).toHaveURL(/\/workflows\?run=63$/);
  await expect(activity.getByRole("heading", { name: "Scan local library" })).toBeVisible();
  await expect(activity.getByRole("tab")).toHaveCount(0);
  await activity.getByRole("button", { name: "Back to runs", exact: true }).click();
  await expect(page).toHaveURL(/\/workflows\?tab=history$/);
  await expect(activity.getByRole("tab", { name: "History", selected: true })).toBeVisible();
});
