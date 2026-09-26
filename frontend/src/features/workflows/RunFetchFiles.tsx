import { useEffect, useRef, useState } from "react";
import { Ban, CheckCircle2, ChevronDown, CircleDashed, Download, PauseCircle, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { api, type FetchFile, type FetchFileState, type WorkflowRun } from "@/lib/api";

import { fetchFilePercent, fetchFilesSummary, isCurrentFetchFile, orderFetchFiles } from "./fetchFilesModel";
import { formatBytes } from "./runPresentation";

type FetchFilesRun = Pick<
  WorkflowRun,
  "id" | "workflowCode" | "status" | "progressBytesCurrent" | "progressBytesTotal" | "progressBytesUnknownItems"
>;

function useFetchFilesCopy() {
  const { t } = useTranslation();
  return (key: string, options?: Record<string, unknown>) => t(`workflowPage.${key}`, options);
}

const stateIcons: Record<FetchFileState, { icon: typeof Download; className: string; labelKey: string }> = {
  pending: { icon: CircleDashed, className: "text-muted-foreground", labelKey: "fetchFilePending" },
  active: { icon: Download, className: "text-primary", labelKey: "fetchFileActive" },
  done: { icon: CheckCircle2, className: "text-success", labelKey: "fetchFileDone" },
  failed: { icon: XCircle, className: "text-error", labelKey: "fetchFileFailed" },
  paused: { icon: PauseCircle, className: "text-warning", labelKey: "fetchFilePaused" },
  stopped: { icon: Ban, className: "text-muted-foreground", labelKey: "fetchFileStopped" },
};

const actionLabelKeys: Record<string, string> = {
  cache_hit: "fetchFileFromCache",
  copy_local: "fetchFileLocalCopy",
  skip: "fetchFileAlreadyPresent",
};

/**
 * Reloads a Fetch run's file list whenever the watched run reports new byte
 * progress or a new status, so it follows the run detail's own refresh cadence.
 */
function useFetchFiles(run: FetchFilesRun) {
  const [files, setFiles] = useState<FetchFile[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const requestSeq = useRef(0);
  const { id, status, progressBytesCurrent, progressBytesTotal, progressBytesUnknownItems } = run;
  useEffect(() => {
    const seq = ++requestSeq.current;
    api
      .listWorkflowRunFetchFiles(id)
      .then((result) => {
        if (seq !== requestSeq.current) return;
        setFiles(result.files);
        setFailed(false);
      })
      .catch(() => {
        // Keep the last known list; only an empty panel needs the failure state.
        if (seq === requestSeq.current) setFailed(true);
      });
  }, [id, status, progressBytesCurrent, progressBytesTotal, progressBytesUnknownItems, attempt]);
  return { files, failed, retry: () => setAttempt((value) => value + 1) };
}

function FetchFileRow({ file }: { file: FetchFile }) {
  const copy = useFetchFilesCopy();
  const state = stateIcons[file.state];
  const Icon = state.icon;
  const percent = fetchFilePercent(file);
  const current = isCurrentFetchFile(file);
  const size = formatBytes(file.sizeBytes);
  const actionKey = file.state === "done" ? actionLabelKeys[file.action] : undefined;
  const detail = current
    ? [formatBytes(file.bytesCurrent), size].filter(Boolean).join(" / ")
    : [actionKey ? copy(actionKey) : "", size].filter(Boolean).join(" · ");
  return (
    <li className="min-w-0 space-y-1 px-3 py-1.5">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <Icon className={`h-3.5 w-3.5 shrink-0 ${state.className}`} aria-label={copy(state.labelKey)} role="img" />
        <span
          className={`min-w-0 flex-1 truncate ${file.state === "pending" ? "text-muted-foreground" : ""}`}
          title={file.path}
        >
          {file.path}
        </span>
        {detail && <span className="shrink-0 tabular-nums text-muted-foreground">{detail}</span>}
      </div>
      {current && (
        <div
          className="ml-5 h-1 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label={copy("fetchFileProgress", { path: file.path })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent === null ? undefined : Math.floor(percent)}
        >
          {percent === null ? (
            <div className="h-full w-1/3 rounded-full bg-primary/70 motion-safe:animate-pulse" />
          ) : (
            <div
              className={`h-full rounded-full transition-[width] duration-700 ease-out ${file.state === "active" ? "bg-primary" : "bg-muted-foreground/50"}`}
              style={{ width: `${percent}%` }}
            />
          )}
        </div>
      )}
    </li>
  );
}

/** Per-file state of a Fetch run: the current file stays visible, the full list expands on demand. */
export function RunFetchFiles({ run }: { run: FetchFilesRun }) {
  const { t } = useTranslation();
  const copy = useFetchFilesCopy();
  const [expanded, setExpanded] = useState(false);
  const { files, failed, retry } = useFetchFiles(run);

  if (files === null) {
    if (!failed) return null;
    return (
      <div
        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3.5 py-2.5 text-sm"
        role="alert"
      >
        <span className="text-muted-foreground">{copy("fetchFilesLoadFailed")}</span>
        <Button size="sm" variant="outline" onClick={retry}>
          {t("common.retry")}
        </Button>
      </div>
    );
  }
  if (files.length === 0) return null;

  const summary = fetchFilesSummary(files);
  const ordered = orderFetchFiles(files);
  const listId = `fetch-files-${run.id}`;
  return (
    <section className="min-w-0 overflow-hidden rounded-lg border bg-card" aria-label={copy("fetchFiles")}>
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left text-sm transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="font-medium">{copy("fetchFiles")}</span>
        <span className="flex items-center gap-2 text-xs tabular-nums text-muted-foreground">
          {copy("fetchFilesDone", { done: summary.done, total: summary.total })}
          <ChevronDown
            className={`h-4 w-4 transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </span>
      </button>
      {!expanded && summary.current && (
        <ul className="border-t py-1">
          <FetchFileRow file={summary.current} />
        </ul>
      )}
      {expanded && (
        <ul id={listId} className="app-scroll max-h-72 overflow-auto overscroll-contain border-t py-1">
          {ordered.map((file) => (
            <FetchFileRow key={file.path} file={file} />
          ))}
        </ul>
      )}
    </section>
  );
}
