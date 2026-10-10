import {
  assertResponseCurrent,
  completeResponse,
  deleteJSON,
  fetchAPI,
  getJSON,
  patchJSONBody,
  postJSON,
  postJSONBody,
  putJSONBody,
  responseError,
  responseSignal,
} from "@/lib/apiTransport";
import type { RemoteWorkTrackResult } from "@/lib/remoteSourceApi";
import type { RemoteMetadataFallbackSettings } from "@/lib/settingsApi";

export type WorkflowRun = {
  pendingMetadata?: number;
  id: number;
  workflowCode: string;
  displayName: string;
  status: string;
  triggerType: string;
  triggerReason: string;
  createdAt: string;
  startedAt: string;
  finishedAt: string;
  summaryJson: string;
  nodeRunCount: number;
  completedNodeRuns: number;
  failedNodeRuns: number;
  skippedNodeRuns: number;
  jobCount: number;
  completedJobs: number;
  failedJobs: number;
  skippedJobs: number;
  progressBytesCurrent: number;
  progressBytesTotal: number;
  progressBytesUnknownItems: number;
  candidateCount: number;
  pendingCandidates: number;
  acceptedCandidates: number;
  rejectedCandidates: number;
  reviewedAt: string;
  reviewedByUserId: number | null;
  definitionId: number | null;
  triggerId: number | null;
  /** The work a Fetch run downloads; empty for other runs. */
  workCode?: string;
};

export type WorkflowRunsPage = {
  runs: WorkflowRun[];
  page: number;
  pageSize: number;
  total: number;
  viewTotals: {
    attention?: number;
    history?: number;
    running: number;
    review: number;
    failed: number;
    completed: number;
  };
};

export type WorkflowNodeRun = {
  id: number;
  nodeId: string;
  nodeType: string;
  displayName: string;
  position: number;
  status: string;
  inputJson: string;
  outputJson: string;
  errorMessage: string;
  startedAt: string;
  finishedAt: string;
  createdAt: string;
};

export type WorkflowRunGraphPort = {
  id: string;
  dataType: string;
};

export type WorkflowRunGraphNode = {
  id: string;
  type: string;
  displayName: string;
  position: { x: number; y: number };
  inputs: WorkflowRunGraphPort[];
  outputs: WorkflowRunGraphPort[];
};

export type WorkflowRunGraphEdge = {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
  dataType: string;
};

export type WorkflowRunGraph = {
  schemaVersion: 1;
  nodes: WorkflowRunGraphNode[];
  edges: WorkflowRunGraphEdge[];
};

export type WorkflowRunDetail = WorkflowRun & {
  metadataIssues?: { encountered: number; pending: number };
  /** False when the viewer may see the run but not cancel, retry, or review it. */
  canManage?: boolean;
  nodeRuns: WorkflowNodeRun[];
  graphJson: string;
};

export type FetchFileState = "pending" | "active" | "done" | "failed" | "paused" | "stopped";

/** One planned file of a Fetch run; `path` is relative to the work folder. */
export type FetchFile = {
  path: string;
  kind: string;
  action: string;
  state: FetchFileState;
  sizeBytes: number | null;
  bytesCurrent: number;
};

export type WorkflowEvent = {
  id: number;
  runId: number;
  nodeRunId: number | null;
  jobId: number | null;
  level: string;
  eventType: string;
  message: string;
  detailJson: string;
  createdAt: string;
};

export type WorkflowRunEventStreamMessage =
  { type: "workflow"; event: WorkflowEvent } | { type: "tick"; status: string; lastEventId: number };

export type WorkflowCandidate = {
  id: number;
  runId: number;
  nodeRunId: number | null;
  type: string;
  externalKey: string;
  status: string;
  payloadJson: string;
  decisionJson: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowRunActionResult = {
  runId: number;
  status: string;
  message: string;
  newRunId?: number;
  recovered?: number;
  requeued?: number;
  failed?: number;
  active?: number;
};

export type LocalCandidateCleanupResult = {
  runId: number;
  candidateId: number;
  action: string;
  status: string;
  deleted: number;
  marked: number;
  failed: number;
  failures: string[];
};

export type WorkflowDefinition = {
  id: number;
  code: string;
  displayName: string;
  description: string;
  definitionJson: string;
  scope: "system" | "user";
  editable: boolean;
  ownerUserId: number | null;
  triggerCount: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowPresetParameter = {
  key: string;
  kind:
    | "circle_id"
    | "series_id"
    | "voice_person"
    | "source_ids"
    | "boolean"
    | "select"
    | "integer"
    | "date"
    | "text_template";
  /** Input selects and refreshes a catalog, filter narrows its works, action syncs and tags them. */
  group: "input" | "filter" | "action";
  required: boolean;
  default?: string | number | boolean;
  options?: string[];
  minimum?: number;
  maximum?: number;
  tokens?: string[];
};

/** Existing works a metadata sync covers; an omitted scope is every work with missing metadata. */
export type MetadataSyncOptions = {
  scope: "all" | "circle" | "voice" | "works";
  circleId?: string;
  personId?: number;
  mode: "missing" | "full";
  workCodes?: string[];
  sourceId?: number;
  remoteMetadataFallback?: RemoteMetadataFallbackSettings;
  purchaseBonusAutoLink?: boolean;
};

export type WorkflowPreset = {
  code: string;
  displayName: string;
  description: string;
  target: "circle" | "series" | "voice";
  defaultTagTemplate: string;
  parameters: WorkflowPresetParameter[];
};

export type WorkflowPresetRunResult = {
  runId: number;
  status: string;
  workflowCode: string;
  tagName: string;
  inputs: Record<string, unknown>;
};

export type AvailabilityWatchFamilyMember = {
  code: string;
  /** Empty for a provider-declared edition without its own work. */
  title: string;
  language: string;
  canonical: boolean;
};

export type AvailabilityWatchTarget = {
  id: number;
  workCode: string;
  title: string;
  /** The watched code's cover, or its family original's; empty when none is cached. */
  coverUrl: string;
  state: "monitoring" | "ready" | "action_queued" | "completed" | "error" | "disabled";
  nextCheckAt: string;
  lastCheckedAt: string;
  lastStatus: string;
  lastError: string;
  availableSourceId: number | null;
  /** The family edition the remote source offered. */
  availableCode: string;
  trackRunId: number | null;
  fetchRunId: number | null;
  /** Empty until the watch has fetched the code's family metadata. */
  family: AvailabilityWatchFamilyMember[];
};

export type AvailabilityWatch = {
  id: number;
  action: "monitor" | "track" | "fetch" | "track_fetch";
  sourceId: number | null;
  excludeExtensions: string[];
  revision: number;
  targets: AvailabilityWatchTarget[];
};

export type AvailabilityWatchRunResult = {
  runId: number;
  jobId: number;
  status: string;
  targetCount: number;
  checked: number;
  ready: number;
  dispatched: number;
  newlyAvailableCodes: string[];
  readyCodes: string[];
  failures: string[];
};

export type WorkflowTrigger = {
  id: number;
  workflowDefinitionId: number;
  workflowCode: string;
  displayName: string;
  triggerType: string;
  enabled: boolean;
  scheduleJson: string;
  configJson: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastErrorMessage: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowNotification = {
  id: number;
  workflowRunId: number;
  type: string;
  status: string;
  workId: number | null;
  fileSourceId: number | null;
  workCode: string;
  message: string;
  createdAt: string;
};

export type WorkflowNotificationsPage = {
  notifications: WorkflowNotification[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  clearableTotal: number;
};

export type LocalMediaIndexMode = "incremental" | "full";

export type LocalMediaIndexResult = {
  runId: number;
  jobId: number;
  status: string;
  mode: LocalMediaIndexMode;
  existing: boolean;
};

export type SourcePresenceLibrary = "local" | "all";

export type SourcePresenceFilter = "all" | "no_remote_source";

export type SourcePresenceCheckOptions = {
  sourceId: number;
  library: SourcePresenceLibrary;
  filter: SourcePresenceFilter;
  limit: number;
};

export type SourcePresenceCheckResult = {
  runId: number;
  jobId: number;
  status: string;
  existing: boolean;
};

export type LocalScanResult = {
  runId: number;
  jobId: number;
  fileSourceId: number;
  status: string;
  detectedWorks: number;
  scannedFiles: number;
  updatedLocations: number;
  skippedLocations: number;
  followUpRun: boolean;
  newWorkCodes: string[];
  failures: string[];
};

export type DLsiteSyncResult = {
  runId: number;
  jobId: number;
  status: string;
  targetWorks: number;
  syncedWorks: number;
  failedWorks: number;
  failures: string[];
};

export type RemoteCollectionRunResult = {
  runId: number;
  sourceId: number;
  collectionKind: string;
  action: "track" | "fetch";
  status: string;
  discovered: number;
  accepted: number;
  skipped: number;
  tracked: number;
  fetched: number;
  tagged: number;
  failed: number;
  childRuns: number[];
  failures: string[];
  expectedMaximum: number;
  returnedCount: number;
  tagName: string;
};

export type DLsitePopularRunResult = {
  runId: number;
  status: string;
  period: "day" | "week" | "month" | "year";
  releaseWindow: "30d" | "";
  year: number;
  tagName: string;
  discovered: number;
  synced: number;
  tagged: number;
  failed: number;
  failures: string[];
};

async function streamWorkflowRunEvents(
  id: number,
  afterId: number,
  signal: AbortSignal,
  onMessage: (message: WorkflowRunEventStreamMessage) => void,
) {
  const query = afterId > 0 ? `?afterId=${encodeURIComponent(String(afterId))}` : "";
  const path = `/api/workflow-runs/${id}/events/stream${query}`;
  const response = await fetchAPI(path, {
    signal,
    headers: { Accept: "text/event-stream" },
  });
  if (!response.ok) {
    throw await responseError(response, `GET ${path} failed with ${response.status}`);
  }
  if (!response.body) throw new Error("Workflow event stream is unavailable.");

  assertResponseCurrent(response);
  const reader = response.body.getReader();
  const cancel = () => void reader.cancel().catch(() => undefined);
  const current = responseSignal(response);
  current.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let eventID = "";
  let dataLines: string[] = [];
  let terminal = false;

  const dispatch = () => {
    if (dataLines.length === 0) return;
    assertResponseCurrent(response);
    const data = dataLines.join("\n");
    const payload: unknown = JSON.parse(data);
    if (eventName === "workflow" && typeof payload === "object" && payload !== null && "id" in payload) {
      onMessage({ type: "workflow", event: payload as WorkflowEvent });
    } else if (eventName === "tick" && typeof payload === "object" && payload !== null) {
      const tick = payload as { status?: unknown; lastEventId?: unknown };
      const message: WorkflowRunEventStreamMessage = {
        type: "tick",
        status: typeof tick.status === "string" ? tick.status : "",
        lastEventId: typeof tick.lastEventId === "number" ? tick.lastEventId : Number(eventID) || 0,
      };
      onMessage(message);
      const status = message.status.trim().toLowerCase();
      terminal = status !== "" && status !== "queued" && status !== "running";
    }
    eventName = "";
    eventID = "";
    dataLines = [];
  };

  const consumeLine = (rawLine: string) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, "") : "";
    if (field === "event") eventName = value;
    if (field === "id") eventID = value;
    if (field === "data") dataLines.push(value);
  };

  try {
    while (!terminal) {
      const { value, done } = await reader.read();
      assertResponseCurrent(response);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        consumeLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (terminal) break;
      }
    }
    if (!terminal) {
      buffer += decoder.decode();
      if (buffer) consumeLine(buffer);
      dispatch();
    }
  } catch (error) {
    assertResponseCurrent(response);
    throw error;
  } finally {
    current.removeEventListener("abort", cancel);
    reader.releaseLock();
    completeResponse(response);
  }
  if (terminal) return;
  throw new Error("Workflow event stream closed.");
}

export const workflowApi = {
  listNotifications: (page = 1, pageSize = 50) =>
    getJSON<WorkflowNotificationsPage>(`/api/notifications?page=${page}&pageSize=${pageSize}`),
  dismissNotification: (id: number) => deleteJSON<{ ok: boolean }>(`/api/notifications/${id}`),
  clearSucceededNotifications: () => postJSON<{ ok: boolean; dismissed: number }>("/api/notifications/clear-succeeded"),
  listWorkflowDefinitions: () => getJSON<WorkflowDefinition[]>("/api/workflow-definitions"),
  getAvailabilityWatch: () => getJSON<AvailabilityWatch>("/api/availability-watch"),
  updateAvailabilityWatch: (payload: {
    action: AvailabilityWatch["action"];
    sourceId: number | null;
    excludeExtensions: string[];
  }) => putJSONBody<AvailabilityWatch>("/api/availability-watch", payload),
  updateAvailabilityWatchTargets: (targetCodes: string[]) =>
    putJSONBody<AvailabilityWatch>("/api/availability-watch/targets", { targetCodes }),
  addAvailabilityWatchTargets: (targetCodes: string[]) =>
    postJSONBody<AvailabilityWatch>("/api/availability-watch/targets", { targetCodes }),
  removeAvailabilityWatchTarget: (id: number) => deleteJSON<{ ok: boolean }>(`/api/availability-watch/targets/${id}`),
  trackAvailabilityWatchTarget: (id: number) =>
    postJSON<RemoteWorkTrackResult>(`/api/availability-watch/targets/${id}/track`),
  runAvailabilityWatch: () => postJSON<AvailabilityWatchRunResult>("/api/availability-watch/run"),
  listWorkflowTriggers: () => getJSON<WorkflowTrigger[]>("/api/workflow-triggers"),
  createWorkflowTrigger: (payload: {
    workflowDefinitionId: number;
    displayName: string;
    triggerType: string;
    enabled: boolean;
    scheduleJson: string;
    configJson: string;
    nextRunAt: string | null;
  }) => postJSONBody<WorkflowTrigger>("/api/workflow-triggers", payload),
  updateWorkflowTrigger: (
    id: number,
    payload: {
      workflowDefinitionId: number;
      displayName: string;
      triggerType: string;
      enabled: boolean;
      scheduleJson: string;
      configJson: string;
      nextRunAt: string | null;
    },
  ) => patchJSONBody<WorkflowTrigger>(`/api/workflow-triggers/${id}`, payload),
  deleteWorkflowTrigger: (id: number) => deleteJSON<{ ok: boolean }>(`/api/workflow-triggers/${id}`),
  listWorkflowRuns: (page = 1, pageSize = 10, view = "running", query = "", workflowCode = "", signal?: AbortSignal) =>
    getJSON<WorkflowRunsPage>(
      `/api/workflow-runs?page=${page}&pageSize=${pageSize}&view=${encodeURIComponent(view)}${query.trim() ? `&q=${encodeURIComponent(query.trim())}` : ""}${workflowCode.trim() ? `&workflowCode=${encodeURIComponent(workflowCode.trim())}` : ""}`,
      signal,
    ),
  getWorkflowRun: (id: number) => getJSON<WorkflowRunDetail>(`/api/workflow-runs/${id}`),
  listWorkflowRunEvents: (id: number, afterId = 0) =>
    getJSON<WorkflowEvent[]>(`/api/workflow-runs/${id}/events${afterId > 0 ? `?afterId=${afterId}` : ""}`),
  streamWorkflowRunEvents: (
    id: number,
    afterId: number,
    signal: AbortSignal,
    onMessage: (message: WorkflowRunEventStreamMessage) => void,
  ) => streamWorkflowRunEvents(id, afterId, signal, onMessage),
  listWorkflowRunCandidates: (id: number) => getJSON<WorkflowCandidate[]>(`/api/workflow-runs/${id}/candidates`),
  listWorkflowRunFetchFiles: (id: number) =>
    getJSON<{ runId: number; files: FetchFile[] }>(`/api/workflow-runs/${id}/fetch-files`),
  updateWorkflowCandidate: (
    id: number,
    payload: { status: "accepted" | "rejected" | "ignored" | "resolved"; decisionJson?: string },
  ) =>
    patchJSONBody<WorkflowCandidate>(`/api/workflow-candidates/${id}`, {
      status: payload.status,
      decisionJson: payload.decisionJson ?? "{}",
    }),
  cleanupLocalWorkflowCandidate: (
    id: number,
    payload: { action: "mark_unavailable" | "delete_files"; locationIds?: number[] },
  ) => postJSONBody<LocalCandidateCleanupResult>(`/api/workflow-candidates/${id}/local-cleanup`, payload),
  reviewArchivedFetchRoots: (id: number, action: "keep_archived" | "delete_archived", confirm = "") =>
    postJSONBody<{ candidateId: number; status: string; action: string }>(
      `/api/workflow-candidates/${id}/archived-root-review`,
      { action, confirm },
    ),
  cancelWorkflowRun: (id: number) => postJSON<WorkflowRunActionResult>(`/api/workflow-runs/${id}/cancel`),
  retryWorkflowRun: (id: number) => postJSON<WorkflowRunActionResult>(`/api/workflow-runs/${id}/retry`),
  reviewWorkflowRun: (id: number) => postJSON<WorkflowRun>(`/api/workflow-runs/${id}/review`),
  recoverStaleWorkflowRuns: () => postJSON<WorkflowRunActionResult>("/api/workflow-runs/recover-stale"),
  runLocalScan: (payload: { followUpRun: boolean } = { followUpRun: false }) =>
    postJSONBody<LocalScanResult>("/api/workflow-runs/local-scan", payload),
  runLocalMediaIndex: (payload: { mode: LocalMediaIndexMode }) =>
    postJSONBody<LocalMediaIndexResult>("/api/workflow-runs/local-media-index", payload),
  runSourcePresenceCheck: (payload: SourcePresenceCheckOptions) =>
    postJSONBody<SourcePresenceCheckResult>("/api/workflow-runs/source-presence-check", payload),
  runRemotePopularCollection: (payload: {
    action: "track" | "fetch";
    sourceId: number;
    limit: number;
    tagNameTemplate: string;
    skipTag?: boolean;
  }) => postJSONBody<RemoteCollectionRunResult>("/api/workflow-runs/remote-popular", payload),
  listWorkflowPresets: () => getJSON<WorkflowPreset[]>("/api/workflow-presets"),
  runWorkflowPreset: (code: string, inputs: Record<string, unknown>) =>
    postJSONBody<WorkflowPresetRunResult>(`/api/workflow-presets/${encodeURIComponent(code)}/runs`, { inputs }),
  runDLsitePopularCollection: (payload: {
    period: "day" | "week" | "month" | "year";
    releaseWindow: "30d" | "";
    year: number;
    tagNameTemplate: string;
    skipTag?: boolean;
  }) => postJSONBody<DLsitePopularRunResult>("/api/workflow-runs/dlsite-popular", payload),
  recordRemoteBulkRun: (payload: {
    action: "track" | "fetch" | "track_fetch" | "sync" | "sync_fetch" | "save" | "sync_save";
    sourceId: number;
    codes: string[];
  }) =>
    postJSONBody<{
      runId: number;
      sourceId: number;
      action: string;
      codes: string[];
      status: string;
      synced: number;
      fetched: number;
      failed: number;
      failures: string[];
      childRuns: number[];
    }>("/api/workflow-runs/remote-bulk", payload),
  runDLsiteSync: (options?: MetadataSyncOptions) =>
    options
      ? postJSONBody<DLsiteSyncResult>("/api/workflow-runs/dlsite-sync", options)
      : postJSON<DLsiteSyncResult>("/api/workflow-runs/dlsite-sync"),
};
