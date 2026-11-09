import {
  ArrowUpRight,
  Ban,
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleAlert,
  CircleDashed,
  List,
  Loader2,
  X,
  XCircle,
} from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { intlLocaleFor } from "@/i18n";
import { useLocale } from "@/i18n/LocaleProvider";
import type { WorkflowEvent, WorkflowNodeRun, WorkflowRun } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import { RunHistoryStrip } from "./RunHistoryStrip";
import { useRunLabels } from "./RunOverview";
import {
  formatClockTime,
  formatDuration,
  formatRelativeTime,
  isActiveRunStatus,
  isDemoShowcaseActiveRun,
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

/** A run whose log opens on its own: one still working, or one whose outcome needs reading. */
function logOpensByItself(run: WorkflowRun) {
  return isActiveRunStatus(run.status) || run.status === "failed" || run.status === "partial";
}

/**
 * The selected workflow's latest run: its outcome, its stages, its log, and the
 * durations of the runs before it. The log stays folded for an ordinary success
 * and opens while a run is active or after it failed; an active run streams into
 * it, and selecting a stage narrows it to that stage.
 */
export function WorkflowRunMonitor({
  stages,
  run,
  runs,
  events,
  nodeRuns,
  onOpenRun,
  onOpenRuns,
}: {
  stages: WorkflowStage[];
  run: WorkflowRun | null;
  /** The workflow's recent runs, newest first, for the history strip. */
  runs: WorkflowRun[];
  events: WorkflowEvent[];
  nodeRuns: WorkflowNodeRun[];
  onOpenRun?: (run: WorkflowRun) => void;
  /** Opens Activity on this workflow's runs. */
  onOpenRuns?: () => void;
}) {
  const { t } = useTranslation();
  const [selectedStage, setSelectedStage] = useState<string | null>(null);
  // An explicit toggle wins for the run it was made on; a run that opened its log keeps it open once it settles.
  const [logChoice, setLogChoice] = useState<{ runId: number | null; open: boolean } | null>(null);
  const [openedRunId, setOpenedRunId] = useState<number | null>(null);
  const runId = run?.id ?? null;
  if (run && logOpensByItself(run) && openedRunId !== run.id) setOpenedRunId(run.id);
  const logOpen =
    logChoice && logChoice.runId === runId
      ? logChoice.open
      : Boolean(run && (logOpensByItself(run) || openedRunId === run.id));
  const active = run ? isActiveRunStatus(run.status) : false;
  const staticExample = run ? isDemoShowcaseActiveRun(run) : false;
  const live = !staticExample && (active || stages.some((stage) => stage.state === "running"));
  const now = useNow(true, live ? 1000 : 30_000);
  const lines = useMemo(() => workflowRunLog(events, nodeRuns), [events, nodeRuns]);
  const selected = stages.find((stage) => stage.id === selectedStage) ?? null;
  const hasStages = stages.length > 0;
  return (
    <section
      className="workflow-monitor overflow-hidden rounded-lg border bg-card"
      aria-label={t("workflowMonitor.label")}
      data-workflow-run-monitor=""
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-1 border-b pr-2">
        <RunSummary run={run} now={now} onOpenRun={onOpenRun} />
        <div className="ml-auto flex shrink-0 items-center gap-1 py-1">
          {hasStages && run && (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={logOpen}
              onClick={() => setLogChoice({ runId, open: !logOpen })}
            >
              <ChevronDown className={cn("h-4 w-4 transition-transform", logOpen && "rotate-180")} aria-hidden />
              {logOpen ? t("workflowMonitor.hideLog") : t("workflowMonitor.showLog")}
            </Button>
          )}
          {onOpenRuns && (
            <Button size="sm" variant="ghost" onClick={onOpenRuns}>
              <List className="h-4 w-4" aria-hidden />
              {t("workflowMonitor.allRuns")}
            </Button>
          )}
        </div>
      </div>
      {hasStages && (
        <div className="workflow-monitor-grid" data-log-open={logOpen || undefined}>
          <div className="workflow-monitor-steps min-w-0 bg-muted/20">
            <ol className="workflow-monitor-stage-list px-2 py-2" aria-label={t("workflowMonitor.stages")}>
              {stages.map((stage, index) => (
                <StepRow
                  key={stage.id}
                  stage={stage}
                  last={!logOpen || index === stages.length - 1}
                  hasRun={Boolean(run)}
                  demoShowcase={staticExample}
                  selected={stage.id === selectedStage}
                  now={now}
                  onSelect={() => {
                    const next = selectedStage === stage.id ? null : stage.id;
                    setSelectedStage(next);
                    if (next && !logOpen) setLogChoice({ runId, open: true });
                  }}
                />
              ))}
            </ol>
          </div>
          {logOpen && (
            <RunLog
              lines={lines}
              stages={stages}
              selected={selected}
              hasRun={Boolean(run)}
              active={active}
              onClearSelection={() => setSelectedStage(null)}
            />
          )}
        </div>
      )}
      <RunHistoryStrip runs={runs} now={now} onOpenRun={onOpenRun} />
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
  const locale = intlLocaleFor(resolvedLocale);
  if (!run) {
    return (
      <div className="flex min-h-11 min-w-0 flex-[1_1_18rem] items-center gap-2 px-4 text-sm text-muted-foreground">
        <CircleDashed className="h-4 w-4" aria-hidden />
        {t("workflowMonitor.standby")}
      </div>
    );
  }
  const duration = runDurationMs(run, now);
  const moment = parseWorkflowTimestamp(
    isActiveRunStatus(run.status) ? run.startedAt || run.createdAt : run.finishedAt || run.startedAt || run.createdAt,
  );
  const content = (
    <>
      <StepIcon state={runSummaryState(run.status)} />
      <span className="shrink-0 text-sm font-medium">{labels.status(run.status)}</span>
      <span className="min-w-0 truncate text-xs tabular-nums text-muted-foreground">
        #{run.id}
        {moment && !isDemoShowcaseActiveRun(run) && <> · {formatRelativeTime(moment, locale, now)}</>}
        {duration !== null && <> · {formatDuration(duration, locale)}</>}
      </span>
    </>
  );
  // A narrow card keeps the whole summary on its line and moves the log and All runs actions below it.
  if (!onOpenRun)
    return <div className="flex min-h-11 min-w-0 flex-[1_1_18rem] items-center gap-2 px-4">{content}</div>;
  return (
    <button
      type="button"
      className="flex min-h-11 min-w-0 flex-[1_1_18rem] items-center gap-2 px-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:bg-muted/70"
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
  return status === "skipped" || status === "cancelled" ? status : "idle";
}

const stepIconClass: Record<WorkflowStageState, string> = {
  idle: "text-muted-foreground/60",
  queued: "text-muted-foreground",
  running: "text-info",
  succeeded: "text-success",
  partial: "text-warning",
  failed: "text-error",
  skipped: "text-muted-foreground/70",
  cancelled: "text-muted-foreground/70",
};

function StepIcon({ state }: { state: WorkflowStageState }) {
  const className = `h-4 w-4 shrink-0 ${stepIconClass[state]}`;
  if (state === "running") return <Loader2 className={`${className} animate-spin`} aria-hidden />;
  if (state === "succeeded") return <CheckCircle2 className={className} aria-hidden />;
  if (state === "failed") return <XCircle className={className} aria-hidden />;
  if (state === "partial") return <CircleAlert className={className} aria-hidden />;
  if (state === "skipped" || state === "cancelled") return <Ban className={className} aria-hidden />;
  if (state === "queued") return <CircleDashed className={className} aria-hidden />;
  return <Circle className={className} aria-hidden />;
}

function StepRow({
  stage,
  last,
  hasRun,
  demoShowcase,
  selected,
  now,
  onSelect,
}: {
  stage: WorkflowStage;
  last: boolean;
  hasRun: boolean;
  demoShowcase: boolean;
  selected: boolean;
  now: number;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const labels = useRunLabels();
  const { resolvedLocale } = useLocale();
  const duration =
    stage.state === "idle" || (demoShowcase && stage.state === "running")
      ? null
      : runDurationMs({ ...stage, status: stage.state }, now);
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
              stage.state === "idle" || stage.state === "skipped" || stage.state === "cancelled"
                ? "text-muted-foreground"
                : ""
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
