import { Loader2, RotateCcw, Settings2 } from "lucide-react";
import { useState } from "react";

import { useAuth } from "@/auth/AuthProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toastFromError, useToast } from "@/components/ui/toast";
import { formatBytes } from "@/features/workflows/runPresentation";
import { parseJSONRecord, workflowCopy } from "@/features/workflows/workflowPageModel";
import { usePendingAction } from "@/hooks/usePendingAction";
import { api, type WorkflowCandidate } from "@/lib/api";

type CandidateAction =
  "retry_fetch" | "mark_unavailable" | "delete_files" | "keep_archived" | "delete_archived" | "resolved" | "ignored";

export function CandidateReviewCard({
  candidate,
  onCandidateUpdate,
  readOnly,
}: {
  candidate: WorkflowCandidate;
  onCandidateUpdate: () => Promise<void>;
  readOnly: boolean;
}) {
  const toast = useToast();
  const { hasPermission } = useAuth();
  const [confirmDeleteOldFiles, setConfirmDeleteOldFiles] = useState(false);
  const [archiveDeleteStep, setArchiveDeleteStep] = useState<0 | 1 | 2>(0);
  const { pending, run: runAction } = usePendingAction<CandidateAction>();
  const busy = pending !== null;
  const payload = parseJSONRecord(candidate.payloadJson);
  const cleanupLocations = candidate.type === "local_fetch_merge_cleanup" ? localCleanupLocations(payload) : [];
  const archivedRoots = candidate.type === "local_fetch_merge_cleanup" ? localArchivedRoots(payload) : [];
  const duplicateFolders = candidate.type === "local_duplicate_work_folder" ? localDuplicateFolders(payload) : [];
  const originBlocked = candidate.type === "remote_origin_blocked";
  const blockedOrigin = originBlocked ? stringValue(payload.origin) : "";
  const blockedSourceID = originBlocked ? numberValue(payload.source_id) : null;
  const needsReview = candidateNeedsReview(candidate);
  const reportFailure = (error: unknown) => toast.notify(toastFromError(error, workflowCopy("candidateActionFailed")));
  const cleanup = (action: "mark_unavailable" | "delete_files") => {
    if (cleanupLocations.length === 0) return;
    void runAction(
      action,
      async () => {
        await api.cleanupLocalWorkflowCandidate(candidate.id, {
          action,
          locationIds: cleanupLocations.map((location) => location.locationId),
        });
        setConfirmDeleteOldFiles(false);
        await onCandidateUpdate();
      },
      reportFailure,
    );
  };
  const reviewArchive = (action: "keep_archived" | "delete_archived") =>
    void runAction(
      action,
      async () => {
        await api.reviewArchivedFetchRoots(candidate.id, action, action === "delete_archived" ? "DELETE" : "");
        setArchiveDeleteStep(0);
        await onCandidateUpdate();
      },
      reportFailure,
    );
  const setStatus = (status: "resolved" | "ignored") =>
    void runAction(
      status,
      async () => {
        await api.updateWorkflowCandidate(candidate.id, { status });
        await onCandidateUpdate();
      },
      reportFailure,
    );
  const retryFetch = () =>
    void runAction(
      "retry_fetch",
      async () => {
        await api.retryWorkflowRun(candidate.runId);
        await onCandidateUpdate();
      },
      (error) => toast.notify(toastFromError(error, workflowCopy("runRetryFailed"))),
    );
  const spinner = (action: CandidateAction) =>
    pending === action ? <Loader2 className="h-4 w-4 animate-spin" /> : null;
  return (
    <div className="grid min-w-0 gap-2 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold" title={candidate.externalKey || candidate.type}>
            {candidate.externalKey || candidate.type}
          </div>
          <div className="break-all text-xs text-muted-foreground">
            {candidate.type} · updated {candidate.updatedAt}
          </div>
        </div>
        <StatusBadge status={candidate.status} />
      </div>

      {candidate.type === "local_fetch_merge_cleanup" && (
        <div className="min-w-0 rounded-md border bg-muted/40 p-2 text-xs">
          <div className="mb-1 font-medium">
            {archivedRoots.length > 0 ? workflowCopy("archivedLocalRoots") : workflowCopy("oldLocalLocations")}
          </div>
          {archivedRoots.map((root) => (
            <div key={root.folderId} className="space-y-1 border-b py-2 last:border-b-0">
              <div className="break-all font-medium">{root.originalPath}</div>
              <div className="truncate text-muted-foreground" title={root.archivePath}>
                {root.archivePath}
              </div>
              <div className="text-muted-foreground">
                {root.fileCount} files · {formatBytes(root.sizeBytes)}
              </div>
              {root.files.slice(0, 12).map((file) => (
                <div key={file.path} className="flex gap-2 pl-2">
                  <span className="min-w-0 flex-1 truncate" title={file.path}>
                    {file.path}
                  </span>
                  <span className="shrink-0 text-muted-foreground">{formatBytes(file.sizeBytes)}</span>
                </div>
              ))}
              {root.files.length > 12 && (
                <div className="pl-2 text-muted-foreground">+{root.files.length - 12} more</div>
              )}
            </div>
          ))}
          {archivedRoots.length === 0 && cleanupLocations.length > 0
            ? cleanupLocations.slice(0, 8).map((location) => (
                <div key={location.locationId} className="flex gap-2 py-0.5">
                  <span className="w-12 shrink-0 text-muted-foreground">#{location.locationId}</span>
                  <span className="min-w-0 flex-1 truncate" title={location.path}>
                    {location.path}
                  </span>
                  {location.sizeBytes !== null && (
                    <span className="shrink-0 text-muted-foreground">{formatBytes(location.sizeBytes)}</span>
                  )}
                </div>
              ))
            : archivedRoots.length === 0 && (
                <div className="text-muted-foreground">{workflowCopy("noSelectableLocalLocations")}</div>
              )}
          {archivedRoots.length === 0 && cleanupLocations.length > 8 && (
            <div className="pt-1 text-muted-foreground">+{cleanupLocations.length - 8} more</div>
          )}
        </div>
      )}

      {candidate.type === "local_duplicate_work_folder" && (
        <div className="min-w-0 rounded-md border bg-muted/40 p-2 text-xs">
          <div className="mb-1 font-medium">{workflowCopy("duplicateLocalFolders")}</div>
          {duplicateFolders.map((folder) => (
            <div key={folder.relPath} className="grid gap-0.5 py-1">
              <div className="truncate" title={folder.relPath}>
                {folder.relPath}
              </div>
              <div className="text-muted-foreground">
                {folder.files} files · {folder.audioFiles} audio · {formatBytes(folder.sizeBytes)}
              </div>
            </div>
          ))}
        </div>
      )}

      {originBlocked && (
        <div className="min-w-0 rounded-md border border-warning-border bg-warning-surface p-3 text-sm">
          <div className="font-medium text-warning-foreground">{workflowCopy("outboundOriginBlocked")}</div>
          <div className="mt-1 break-all font-mono text-xs text-warning-foreground">
            {blockedOrigin || workflowCopy("originNotRecorded")}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{workflowCopy("originBlockedDescription")}</p>
        </div>
      )}

      {candidate.type !== "local_fetch_merge_cleanup" &&
        candidate.type !== "local_duplicate_work_folder" &&
        !originBlocked && (
          <JsonPreview value={candidate.payloadJson} empty={workflowCopy("noCandidatePayload")} compact />
        )}
      {hasNonEmptyJSON(candidate.decisionJson) && (
        <JsonPreview value={candidate.decisionJson} empty={workflowCopy("noDecisionPayload")} compact />
      )}
      {needsReview && !readOnly && (!changesLocalFiles(candidate.type) || hasPermission("downloads:manage")) && (
        <div className="flex flex-wrap gap-2">
          {originBlocked && (
            <>
              {blockedSourceID !== null && blockedSourceID > 0 && (
                <Button size="sm" variant="outline" onClick={() => openRemoteSourceConfiguration(blockedSourceID)}>
                  <Settings2 className="h-4 w-4" />
                  {workflowCopy("configureSource")}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                aria-busy={pending === "retry_fetch"}
                onClick={retryFetch}
              >
                {spinner("retry_fetch") ?? <RotateCcw className="h-4 w-4" />}
                {workflowCopy("retryFetch")}
              </Button>
            </>
          )}
          {candidate.type === "local_fetch_merge_cleanup" && cleanupLocations.length > 0 && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                aria-busy={pending === "mark_unavailable"}
                onClick={() => cleanup("mark_unavailable")}
              >
                {spinner("mark_unavailable")}
                {workflowCopy("hideOldLocations")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="border-destructive/40 text-destructive hover:text-destructive"
                disabled={busy}
                onClick={() => setConfirmDeleteOldFiles(true)}
              >
                {workflowCopy("deleteOldFiles")}
              </Button>
            </>
          )}
          {candidate.type === "local_fetch_merge_cleanup" && archivedRoots.length > 0 && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                aria-busy={pending === "keep_archived"}
                onClick={() => reviewArchive("keep_archived")}
              >
                {spinner("keep_archived")}
                {workflowCopy("keepArchived")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="border-destructive/40 text-destructive hover:text-destructive"
                disabled={busy}
                onClick={() => setArchiveDeleteStep(1)}
              >
                {workflowCopy("deleteArchive")}
              </Button>
            </>
          )}
          {archivedRoots.length === 0 && !originBlocked && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                aria-busy={pending === "resolved"}
                onClick={() => setStatus("resolved")}
              >
                {spinner("resolved")}
                {workflowCopy("markResolved")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                aria-busy={pending === "ignored"}
                onClick={() => setStatus("ignored")}
              >
                {spinner("ignored")}
                {workflowCopy("ignore")}
              </Button>
            </>
          )}
        </div>
      )}
      {confirmDeleteOldFiles && (
        <div className="rounded-md border border-error-border bg-error-surface p-3">
          <div className="text-sm font-semibold text-error-foreground">{workflowCopy("deleteOldLocalFilesTitle")}</div>
          <div className="mt-1 text-sm text-muted-foreground">{workflowCopy("deleteOldLocalFilesDescription")}</div>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmDeleteOldFiles(false)}>
              {workflowCopy("cancel")}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              aria-busy={pending === "delete_files"}
              onClick={() => cleanup("delete_files")}
            >
              {spinner("delete_files")}
              {workflowCopy("deleteFiles")}
            </Button>
          </div>
        </div>
      )}
      {archiveDeleteStep > 0 && (
        <div className="rounded-md border border-error-border bg-error-surface p-3">
          <div className="text-sm font-semibold text-error-foreground">
            {archiveDeleteStep === 1 ? workflowCopy("reviewArchivedDirectories") : workflowCopy("finalConfirmation")}
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            {archiveDeleteStep === 1 ? workflowCopy("archivePermanentlyRemoved") : workflowCopy("cannotUndoKeep")}
          </div>
          <div className="mt-2 space-y-1 text-xs">
            {archivedRoots.map((root) => (
              <div key={root.folderId} className="truncate" title={root.archivePath}>
                {root.archivePath}
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setArchiveDeleteStep(0)}>
              {workflowCopy("cancel")}
            </Button>
            {archiveDeleteStep === 1 ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setArchiveDeleteStep(2)}>
                {workflowCopy("continue")}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                aria-busy={pending === "delete_archived"}
                onClick={() => reviewArchive("delete_archived")}
              >
                {spinner("delete_archived")}
                {workflowCopy("permanentlyDelete")}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variant =
    status === "failed"
      ? "error"
      : status === "partial" || status === "disabled"
        ? "warning"
        : status === "succeeded" || status === "enabled"
          ? "success"
          : status === "running" || status === "queued"
            ? "info"
            : "outline";
  return <Badge variant={variant}>{status}</Badge>;
}

function JsonPreview({ value, empty, compact = false }: { value: string; empty: string; compact?: boolean }) {
  const summary = summarizeJSON(value);
  if (!summary) {
    return <div className="mt-2 text-sm text-muted-foreground">{empty}</div>;
  }
  return (
    <pre
      className={`app-scroll mt-2 min-w-0 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background p-3 text-xs text-muted-foreground [overflow-wrap:anywhere] ${compact ? "max-h-32" : "max-h-56"}`}
    >
      {summary}
    </pre>
  );
}

function candidateNeedsReview(candidate: WorkflowCandidate) {
  return !["accepted", "rejected", "ignored", "resolved"].includes(candidate.status);
}

type LocalCleanupLocation = { locationId: number; path: string; sizeBytes: number | null };
type LocalDuplicateFolder = { relPath: string; files: number; audioFiles: number; sizeBytes: number | null };
type LocalArchivedRoot = {
  folderId: number;
  originalPath: string;
  archivePath: string;
  fileCount: number;
  sizeBytes: number | null;
  files: Array<{ path: string; sizeBytes: number | null }>;
};

function localCleanupLocations(payload: Record<string, unknown>): LocalCleanupLocation[] {
  const locations = Array.isArray(payload.candidate_locations) ? payload.candidate_locations : [];
  return locations.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const record = raw as Record<string, unknown>;
    const locationId = numberValue(record.location_id);
    const path = stringValue(record.path);
    if (!locationId || !path) return [];
    return [{ locationId, path, sizeBytes: nullableNumberValue(record.size_bytes) }];
  });
}

function openRemoteSourceConfiguration(sourceID: number) {
  const search = new URLSearchParams({ tab: "library", source: String(sourceID) });
  window.history.pushState({}, "", `/settings?${search}`);
  window.dispatchEvent(new Event("kikoto:navigation"));
}

function localArchivedRoots(payload: Record<string, unknown>): LocalArchivedRoot[] {
  const roots = Array.isArray(payload.archived_roots) ? payload.archived_roots : [];
  return roots.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const record = raw as Record<string, unknown>;
    const folderId = numberValue(record.folder_id);
    const originalPath = stringValue(record.original_path);
    const archivePath = stringValue(record.archive_path);
    if (!folderId || !originalPath || !archivePath) return [];
    const files = Array.isArray(record.files)
      ? record.files.flatMap((file) => {
          if (!file || typeof file !== "object" || Array.isArray(file)) return [];
          const item = file as Record<string, unknown>;
          const path = stringValue(item.path);
          return path ? [{ path, sizeBytes: nullableNumberValue(item.size_bytes) }] : [];
        })
      : [];
    return [
      {
        folderId,
        originalPath,
        archivePath,
        fileCount: numberValue(record.file_count) ?? files.length,
        sizeBytes: nullableNumberValue(record.size_bytes),
        files,
      },
    ];
  });
}

function localDuplicateFolders(payload: Record<string, unknown>): LocalDuplicateFolder[] {
  const folders = Array.isArray(payload.folders) ? payload.folders : [];
  return folders.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const record = raw as Record<string, unknown>;
    const relPath = stringValue(record.rel_path);
    if (!relPath) return [];
    return [
      {
        relPath,
        files: numberValue(record.files) ?? 0,
        audioFiles: numberValue(record.audio_files) ?? 0,
        sizeBytes: nullableNumberValue(record.size_bytes),
      },
    ];
  });
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableNumberValue(value: unknown) {
  const number = numberValue(value);
  return number === null ? null : number;
}

function hasNonEmptyJSON(value: string) {
  return Boolean(summarizeJSON(value));
}

function summarizeJSON(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "{}" || trimmed === "null") {
    return "";
  }
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return trimmed;
  }
}

/** Resolving these candidates removes, archives, or marks unavailable local files, which needs downloads:manage. */
function changesLocalFiles(type: string) {
  return ["local_fetch_merge_cleanup", "local_duplicate_work_folder", "local_symlink_media_location"].includes(type);
}
