import type { WorkflowRun } from "@/lib/api";

export type RunTone = "info" | "success" | "warning" | "error" | "neutral";

const zonelessTimestamp = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;

/** Workflow timestamps are stored as UTC; SQLite values arrive without a zone designator. */
export function parseWorkflowTimestamp(value: string | null | undefined): Date | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const zoneless = zonelessTimestamp.exec(trimmed);
  const date = new Date(zoneless ? `${zoneless[1]}T${zoneless[2]}Z` : trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isActiveRunStatus(status: string) {
  return status === "queued" || status === "running";
}

export function runStatusTone(status: string): RunTone {
  if (isActiveRunStatus(status)) return "info";
  if (status === "succeeded") return "success";
  if (status === "failed") return "error";
  if (status === "partial") return "warning";
  return "neutral";
}

/** Elapsed run time; active runs measure against `now`, terminal runs need both endpoints. */
export function runDurationMs(
  run: Pick<WorkflowRun, "status" | "startedAt" | "finishedAt">,
  now = Date.now(),
): number | null {
  const started = parseWorkflowTimestamp(run.startedAt);
  if (!started) return null;
  const finished = parseWorkflowTimestamp(run.finishedAt);
  const end = finished?.getTime() ?? (isActiveRunStatus(run.status) ? now : null);
  if (end === null) return null;
  return Math.max(0, end - started.getTime());
}

export function formatDuration(ms: number, locale: string) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const unit = (value: number, name: "hour" | "minute" | "second") =>
    new Intl.NumberFormat(locale, { style: "unit", unit: name, unitDisplay: "narrow" }).format(value);
  if (hours > 0) return minutes > 0 ? `${unit(hours, "hour")} ${unit(minutes, "minute")}` : unit(hours, "hour");
  if (minutes > 0)
    return seconds > 0 ? `${unit(minutes, "minute")} ${unit(seconds, "second")}` : unit(minutes, "minute");
  return unit(seconds, "second");
}

export function formatRelativeTime(date: Date, locale: string, now = Date.now()) {
  const seconds = Math.round((date.getTime() - now) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  const abs = Math.abs(seconds);
  if (abs < 45) return format.format(0, "second");
  if (abs < 45 * 60) return format.format(Math.round(seconds / 60), "minute");
  if (abs < 22 * 3600) return format.format(Math.round(seconds / 3600), "hour");
  if (abs < 7 * 86400) return format.format(Math.round(seconds / 86400), "day");
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(date);
}

export function formatTimestamp(date: Date, locale: string) {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(date);
}

export function formatClockTime(date: Date, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

export function formatBytes(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export type TransferSample = { at: number; bytes: number };

export const transferRateWindowMs = 15_000;
const minimumRateSpanMs = 1_500;

/** Bytes per second across the retained window, or null until enough time has been observed. */
export function transferRate(samples: TransferSample[]): number | null {
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const span = last.at - first.at;
  if (span < minimumRateSpanMs || last.bytes < first.bytes) return null;
  return ((last.bytes - first.bytes) * 1000) / span;
}

/**
 * Records a byte counter observation. Only changes are kept, because the counter reaches the
 * client at the polling cadence and repeated values would read as a stall. A counter that moves
 * backwards (a retried transfer) restarts sampling.
 */
export function appendTransferSample(samples: TransferSample[], sample: TransferSample): TransferSample[] {
  const last = samples[samples.length - 1];
  if (last && sample.bytes === last.bytes) return samples;
  if (last && sample.bytes < last.bytes) return [sample];
  const next = [...samples, sample];
  const cutoff = sample.at - transferRateWindowMs;
  while (next.length > 2 && next[0].at < cutoff) next.shift();
  return next;
}

/** No counter change for this long means the transfer is not currently moving. */
export const transferStallMs = 12_000;

export type TransferProgress = {
  current: number;
  total: number;
  unknownItems: number;
  determinate: boolean;
  percent: number;
};

export function transferProgress(
  run: Pick<WorkflowRun, "progressBytesCurrent" | "progressBytesTotal" | "progressBytesUnknownItems">,
): TransferProgress {
  const current = Math.max(0, run.progressBytesCurrent ?? 0);
  const total = Math.max(0, run.progressBytesTotal ?? 0);
  const unknownItems = Math.max(0, run.progressBytesUnknownItems ?? 0);
  const determinate = unknownItems === 0 && total > 0;
  return {
    current,
    total,
    unknownItems,
    determinate,
    percent: determinate ? Math.min(100, Math.max(0, (current / total) * 100)) : 0,
  };
}

/**
 * A run's title. A Fetch names the work it downloads so several Fetches can
 * be told apart in Activity; other runs use their workflow's translated name.
 */
export function runTitle(
  run: Pick<WorkflowRun, "workflowCode" | "displayName" | "workCode">,
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  if (run.workflowCode === "remote_work_fetch" && run.workCode) {
    return t("workflowPage.fetchRunTitle", { code: run.workCode });
  }
  return t(`workflowPage.builtInDefinitions.${run.workflowCode}.name`, { defaultValue: run.displayName });
}

export function hasTransferProgress(
  run: Pick<
    WorkflowRun,
    "workflowCode" | "status" | "progressBytesCurrent" | "progressBytesTotal" | "progressBytesUnknownItems"
  >,
) {
  if (run.workflowCode !== "remote_work_fetch") return false;
  const progress = transferProgress(run);
  return progress.current > 0 || progress.total > 0 || progress.unknownItems > 0 || isActiveRunStatus(run.status);
}
