import { ArrowUpRight, Ban, CheckCircle2, Circle, CircleAlert, CircleDashed, Loader2, X, XCircle } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { intlLocaleFor } from "@/i18n";
import { useLocale } from "@/i18n/LocaleProvider";
import type { WorkflowEvent, WorkflowNodeRun, WorkflowRun } from "@/lib/api";

import { useRunLabels } from "./RunOverview";
import {
  formatClockTime,
  formatDuration,
  isActiveRunStatus,
  parseWorkflowTimestamp,
  runDurationMs,
  runStatusTone,
} from "./runPresentation";
import { useNow } from "./useRunClock";
import {
  workflowRunLog,
  type WorkflowLogLine,
  type WorkflowStage,
  type WorkflowStageState,
} from "./workflowStageModel";

const visibleLineLimit = 500;
// Within this distance of the bottom the log keeps following new output.
const followThresholdPx = 24;

/**
 * Run console for one workflow: its stages on the left and the latest run's log on the right.
 * An active run streams into the log; selecting a stage narrows the log to that stage.
 */
export function WorkflowRunMonitor({
  stages,
  run,
  events,
  nodeRuns,
  onOpenRun,
}: {
  stages: WorkflowStage[];
  run: WorkflowRun | null;
  events: WorkflowEvent[];
  nodeRuns: WorkflowNodeRun[];
  onOpenRun?: (run: WorkflowRun) => void;
}) {
  const { t } = useTranslation();
  const [selectedStage, setSelectedStage] = useState<string | null>(null);
  const active = run ? isActiveRunStatus(run.status) : false;
  const now = useNow(active || stages.some((stage) => stage.state === "running"));
  const lines = useMemo(() => workflowRunLog(events, nodeRuns), [events, nodeRuns]);
  if (stages.length === 0) return null;
  const selected = stages.find((stage) => stage.id === selectedStage) ?? null;
  return (
    <section
      className="workflow-monitor overflow-hidden rounded-lg border"
      aria-label={t("workflowMonitor.label")}
      data-workflow-run-monitor=""
    >
      <div className="workflow-monitor-grid">
        <div className="workflow-monitor-steps min-w-0 bg-muted/20">
          <RunSummary run={run} now={now} onOpenRun={onOpenRun} />
          <ol className="px-2 py-2" aria-label={t("workflowMonitor.stages")}>
            {stages.map((stage, index) => (
              <StepRow
                key={stage.id}
                stage={stage}
                last={index === stages.length - 1}
                hasRun={Boolean(run)}
                selected={stage.id === selectedStage}
                now={now}
                onSelect={() => setSelectedStage((current) => (current === stage.id ? null : stage.id))}
              />
            ))}
          </ol>
        </div>
        <RunLog
          lines={lines}
          stages={stages}
          selected={selected}
          hasRun={Boolean(run)}
          active={active}
          onClearSelection={() => setSelectedStage(null)}
        />
      </div>
    </section>
  );
}

function RunSummary({
  run,
  now,
  onOpenRun,
}: {
  run: WorkflowRun | null;
  now: number;
  onOpenRun?: (run: WorkflowRun) => void;
}) {
  const { t } = useTranslation();
  const labels = useRunLabels();
  const { resolvedLocale } = useLocale();
  if (!run) {
    return (
      <div className="flex min-h-11 items-center gap-2 border-b px-4 text-xs text-muted-foreground">
        <CircleDashed className="h-4 w-4" aria-hidden />
        {t("workflowMonitor.standby")}
      </div>
    );
  }
  const duration = runDurationMs(run, now);
  const content = (
    <>
      <StepIcon state={runSummaryState(run.status)} />
      <span className="min-w-0 truncate text-sm font-medium">{labels.status(run.status)}</span>
      <span className="font-mono text-xs tabular-nums text-muted-foreground">#{run.id}</span>
      <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">
        {duration !== null ? formatDuration(duration, intlLocaleFor(resolvedLocale)) : ""}
      </span>
    </>
  );
  if (!onOpenRun) return <div className="flex min-h-11 items-center gap-2 border-b px-4">{content}</div>;
  return (
    <button
      type="button"
      className="flex min-h-11 w-full items-center gap-2 border-b px-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:bg-muted/70"
      aria-label={t("workflowMonitor.openRun", { id: run.id, status: labels.status(run.status) })}
      onClick={() => onOpenRun(run)}
    >
      {content}
      <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
    </button>
  );
}

function runSummaryState(status: string): WorkflowStageState {
  const tone = runStatusTone(status);
  if (status === "queued") return "queued";
  if (tone === "info") return "running";
  if (tone === "success") return "succeeded";
  if (tone === "warning") return "partial";
  if (tone === "error") return "failed";
  return status === "skipped" || status === "cancelled" ? "skipped" : "idle";
}

const stepIconClass: Record<WorkflowStageState, string> = {
  idle: "text-muted-foreground/60",
  queued: "text-muted-foreground",
  running: "text-info",
  succeeded: "text-success",
  partial: "text-warning",
  failed: "text-error",
  skipped: "text-muted-foreground/70",
};

function StepIcon({ state }: { state: WorkflowStageState }) {
  const className = `h-4 w-4 shrink-0 ${stepIconClass[state]}`;
  if (state === "running") return <Loader2 className={`${className} animate-spin`} aria-hidden />;
  if (state === "succeeded") return <CheckCircle2 className={className} aria-hidden />;
  if (state === "failed") return <XCircle className={className} aria-hidden />;
  if (state === "partial") return <CircleAlert className={className} aria-hidden />;
  if (state === "skipped") return <Ban className={className} aria-hidden />;
  if (state === "queued") return <CircleDashed className={className} aria-hidden />;
  return <Circle className={className} aria-hidden />;
}

function StepRow({
  stage,
  last,
  hasRun,
  selected,
  now,
  onSelect,
}: {
  stage: WorkflowStage;
  last: boolean;
  hasRun: boolean;
  selected: boolean;
  now: number;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const labels = useRunLabels();
  const { resolvedLocale } = useLocale();
  const duration = stage.state === "idle" ? null : runDurationMs({ ...stage, status: stage.state }, now);
  const stateLabel = stage.state === "idle" ? t("workflowMonitor.notRun") : labels.status(stage.state);
  return (
    <li className="relative">
      {!last && <span className="workflow-monitor-connector" data-state={stage.state} aria-hidden />}
      <button
        type="button"
        className="relative flex min-h-10 w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-muted/80 aria-pressed:bg-muted"
        aria-pressed={selected}
        title={stage.errorMessage || undefined}
        onClick={onSelect}
      >
        <span className="grid h-5 w-5 shrink-0 place-items-center">
          <StepIcon state={stage.state} />
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate text-sm ${stage.state === "running" ? "font-medium" : ""} ${
              stage.state === "idle" || stage.state === "skipped" ? "text-muted-foreground" : ""
            }`}
          >
            {stage.title}
          </span>
          <span className="sr-only">{stateLabel}</span>
        </span>
        {hasRun && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
            {duration !== null ? formatDuration(duration, intlLocaleFor(resolvedLocale)) : ""}
          </span>
        )}
      </button>
    </li>
  );
}

function RunLog({
  lines,
  stages,
  selected,
  hasRun,
  active,
  onClearSelection,
}: {
  lines: WorkflowLogLine[];
  stages: WorkflowStage[];
  selected: WorkflowStage | null;
  hasRun: boolean;
  active: boolean;
  onClearSelection: () => void;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const locale = intlLocaleFor(resolvedLocale);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const following = useRef(true);
  const stageIndex = useMemo(() => new Map(stages.map((stage, index) => [stage.id, index])), [stages]);
  const filtered = selected ? lines.filter((line) => line.stageId === selected.id) : lines;
  const hidden = Math.max(0, filtered.length - visibleLineLimit);
  const shown = hidden > 0 ? filtered.slice(-visibleLineLimit) : filtered;

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [shown.length, selected?.id, active]);

  const rows: ReactNode[] = [];
  let previousStage: string | null | undefined;
  shown.forEach((line, index) => {
    if (!selected && line.stageId && line.stageId !== previousStage) {
      const position = stageIndex.get(line.stageId);
      const stage = position === undefined ? undefined : stages[position];
      rows.push(
        <div key={`group-${line.key}`} className="workflow-log-group" data-state={stage?.state ?? "idle"}>
          <span className="workflow-log-gutter" aria-hidden />
          <span className="min-w-0 truncate">
            <span className="text-muted-foreground">
              {position === undefined ? "··" : String(position + 1).padStart(2, "0")}
            </span>{" "}
            {stage?.title ?? line.stageId}
          </span>
        </div>,
      );
    }
    if (line.stageId) previousStage = line.stageId;
    rows.push(<LogRow key={line.key} line={line} number={hidden + index + 1} locale={locale} />);
  });

  return (
    <div className="workflow-monitor-log flex min-w-0 flex-col">
      <div className="flex min-h-11 items-center gap-2 border-b px-4">
        <span className="text-sm font-medium">{t("workflowMonitor.log")}</span>
        {active && (
          <span className="flex items-center gap-1.5 text-xs text-info-foreground">
            <span className="workflow-log-live" aria-hidden />
            {t("workflowMonitor.live")}
          </span>
        )}
        {selected && (
          <button
            type="button"
            className="ml-auto flex min-h-7 max-w-[60%] items-center gap-1 rounded-md bg-muted px-2 text-xs transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t("workflowMonitor.showAll")}
            onClick={onClearSelection}
          >
            <span className="truncate">{selected.title}</span>
            <X className="h-3 w-3 shrink-0" aria-hidden />
          </button>
        )}
      </div>
      <div
        ref={scrollRef}
        className="workflow-log app-scrollbar min-h-0 flex-1 overflow-y-auto py-2 font-mono text-xs leading-5"
        role="log"
        aria-label={t("workflowMonitor.log")}
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget;
          following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= followThresholdPx;
        }}
      >
        {!hasRun ? (
          <p className="px-4 py-2 font-sans text-sm text-muted-foreground">{t("workflowMonitor.empty")}</p>
        ) : shown.length === 0 && !active ? (
          <p className="px-4 py-2 font-sans text-sm text-muted-foreground">{t("workflowMonitor.noOutput")}</p>
        ) : (
          <>
            {hidden > 0 && (
              <p className="px-4 pb-1 text-muted-foreground">{t("workflowMonitor.earlierHidden", { count: hidden })}</p>
            )}
            {rows}
            {active && (
              <div className="workflow-log-row" aria-hidden>
                <span className="workflow-log-gutter" />
                <span className="workflow-log-cursor" />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function LogRow({ line, number, locale }: { line: WorkflowLogLine; number: number; locale: string }) {
  const { t } = useTranslation();
  const labels = useRunLabels();
  const at = parseWorkflowTimestamp(line.at);
  let message: ReactNode;
  let detail = "";
  let title: string | undefined;
  if (line.kind === "event") {
    message = line.message;
    detail = line.detail;
    title = line.rawDetail && line.rawDetail !== "{}" ? line.rawDetail : undefined;
  } else if (line.phase === "started") {
    message = t("workflowMonitor.stageStarted", { name: line.title });
  } else {
    message = t("workflowMonitor.stageFinished", { name: line.title, status: labels.status(line.state) });
    detail = line.errorMessage;
  }
  return (
    <div className="workflow-log-row" data-level={line.level} title={title}>
      <span className="workflow-log-gutter tabular-nums">{number}</span>
      <span className="min-w-0 break-words [overflow-wrap:anywhere]">
        <time className="mr-3 tabular-nums text-muted-foreground" dateTime={at?.toISOString()}>
          {at ? formatClockTime(at, locale) : "--:--:--"}
        </time>
        <span className="workflow-log-message">{message}</span>
        {detail && <span className="ml-2 text-muted-foreground">{detail}</span>}
      </span>
    </div>
  );
}
