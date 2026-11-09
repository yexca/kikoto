import { Activity, ArrowLeft, Check, ChevronLeft, ChevronRight, CircleDashed, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { api, type WorkflowRun, type WorkflowRunsPage } from "@/lib/api";
import { openMetadataIssues } from "@/lib/metadataMaintenance";
import { cn } from "@/lib/tailwindClassNames";

import { ActivityRunSummary } from "./ActivityRunSummary";
import type { ActivityView } from "./useWorkflowActivityLocation";

const listPageSize = 8;
const runningPageSize = 5;

/**
 * Every run across workflows, shown in place of a workflow: the active queue
 * above Needs attention and History. A selected run opens beside the list on
 * wide screens and in place of it otherwise.
 */
export function WorkflowActivity({
  workflowCode,
  workflowName,
  view,
  onViewChange,
  selectedRunId,
  onSelectRun,
  onBack,
  detail,
  refreshKey,
  readOnly,
  staticDemo,
  canSyncMetadata,
  mobile,
  onShowAllWorkflows,
}: {
  /** The workflow the list is narrowed to, or `all`. */
  workflowCode: string;
  workflowName: string;
  view: ActivityView;
  onViewChange: (view: ActivityView) => void;
  selectedRunId: number | null;
  onSelectRun: (run: WorkflowRun) => void;
  onBack: () => void;
  detail?: ReactNode;
  refreshKey: number;
  readOnly: boolean;
  staticDemo: boolean;
  canSyncMetadata: boolean;
  /** The mobile layout returns from a run through the page header instead of a button in the panel. */
  mobile: boolean;
  /** Offered while the list is narrowed to one workflow; widens it to every workflow. */
  onShowAllWorkflows?: () => void;
}) {
  const { t } = useTranslation();
  const detailRef = useRef<HTMLDivElement>(null);
  const wide = useMediaQuery("(min-width: 1280px)");
  const [page, setPage] = useState(1);
  const [activePage, setActivePage] = useState(1);
  const [snapshot, setSnapshot] = useState<{
    code: string;
    view: string;
    page: number;
    result: WorkflowRunsPage;
  } | null>(null);
  // Another workflow scope starts from its first pages, and another list from its first page.
  const [pageScope, setPageScope] = useState({ workflowCode, view });
  if (pageScope.workflowCode !== workflowCode || pageScope.view !== view) {
    setPageScope({ workflowCode, view });
    setPage(1);
    if (pageScope.workflowCode !== workflowCode) setActivePage(1);
  }
  const [active, setActive] = useState<WorkflowRunsPage | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [actionError, setActionError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [totals, setTotals] = useState({ running: 0, attention: 0, history: 0 });

  useEffect(() => {
    if (!workflowCode) return;
    const controller = new AbortController();
    let fetching = false;
    const load = async () => {
      if (fetching || document.hidden || controller.signal.aborted) return;
      fetching = true;
      try {
        const result = await api.listWorkflowRuns(page, listPageSize, view, "", workflowCode, controller.signal);
        if (controller.signal.aborted) return;
        setTotals({
          running: result.viewTotals?.running ?? 0,
          attention: result.viewTotals?.attention ?? 0,
          history: result.viewTotals?.history ?? 0,
        });
        if (page > 1 && result.total <= (page - 1) * listPageSize) {
          setPage(Math.max(1, Math.ceil(result.total / listPageSize)));
          return;
        }
        setSnapshot({ code: workflowCode, view, page, result });
        const running = await api.listWorkflowRuns(
          activePage,
          runningPageSize,
          "running",
          "",
          workflowCode,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setActive(running);
        if (activePage > 1 && running.total <= (activePage - 1) * runningPageSize)
          setActivePage(Math.max(1, Math.ceil(running.total / runningPageSize)));
        setError(false);
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        fetching = false;
      }
    };
    void load();
    const timer = staticDemo ? null : window.setInterval(() => void load(), 5000);
    if (!staticDemo) document.addEventListener("visibilitychange", load);
    return () => {
      controller.abort();
      if (timer !== null) window.clearInterval(timer);
      if (!staticDemo) document.removeEventListener("visibilitychange", load);
    };
  }, [view, page, revision, workflowCode, activePage, refreshKey, staticDemo]);

  // A run chosen low in a long list opens with its detail in view.
  useEffect(() => {
    const element = detailRef.current;
    if (selectedRunId && element && element.getBoundingClientRect().top < 0) element.scrollIntoView({ block: "start" });
  }, [selectedRunId]);

  const acknowledge = async (run: WorkflowRun) => {
    if (readOnly || busy !== null) return;
    setBusy(run.id);
    setActionError(false);
    try {
      await api.reviewWorkflowRun(run.id);
      setRevision((value) => value + 1);
    } catch {
      setActionError(true);
    } finally {
      setBusy(null);
    }
  };
  const runRow = (run: WorkflowRun, running = false) => {
    // Products reported as not found may stay pending, as for a delisted work;
    // candidates and retryable metadata failures must be resolved first.
    const needsAcknowledge =
      !running &&
      view === "attention" &&
      (run.status === "failed" || run.status === "partial" || (run.pendingMetadata ?? 0) > 0) &&
      run.pendingCandidates === 0 &&
      !(run.pendingFailedMetadata ?? 0) &&
      !readOnly;
    const openMetadata = (run.pendingMetadata ?? 0) > 0 && canSyncMetadata;
    const selected = run.id === selectedRunId;
    return (
      <li key={run.id} className="group/run relative">
        <button
          aria-current={selected ? "true" : undefined}
          className={cn(
            "w-full px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:bg-muted/70",
            selected && "bg-primary/10 hover:bg-primary/10",
          )}
          onClick={() => onSelectRun(run)}
        >
          <ActivityRunSummary run={run} />
        </button>
        {((run.pendingMetadata ?? 0) > 0 || needsAcknowledge) && (
          <div className="flex flex-wrap items-center gap-2 px-4 pb-3 pl-9">
            {(run.pendingMetadata ?? 0) > 0 && (
              <span className="text-xs text-warning-foreground">
                {t("workflowActivity.metadataCount", { count: run.pendingMetadata })}
              </span>
            )}
            {openMetadata && (
              <Button size="sm" variant="outline" className="h-8" onClick={() => openMetadataIssues(run.id)}>
                {t("metadataIssues.openIssues")}
              </Button>
            )}
            {needsAcknowledge && (
              <Button
                size="sm"
                variant="ghost"
                className="-ml-2 h-8"
                disabled={busy !== null}
                onClick={() => void acknowledge(run)}
              >
                {busy === run.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                {t("workflowActivity.acknowledge")}
              </Button>
            )}
          </div>
        )}
      </li>
    );
  };
  const displayed =
    snapshot?.code === workflowCode && snapshot.view === view && snapshot.page === page ? snapshot.result : null;
  const runOpen = selectedRunId !== null;
  // Below 1280px an open run replaces the list rather than sitting beside it.
  const listShown = !runOpen || (wide && !mobile);
  const runningPaged = totals.running > runningPageSize;
  const listPaged = (displayed?.total ?? 0) > listPageSize;

  return (
    <section aria-label={t("nav.activity")} className="min-w-0 space-y-5">
      <header className="flex min-w-0 items-start gap-4">
        <span className="hidden h-12 w-12 shrink-0 place-items-center rounded-lg border bg-card text-primary sm:grid">
          <Activity className="h-6 w-6" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="text-xl font-semibold leading-7 tracking-tight">{t("nav.activity")}</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">{t("workflowActivity.description")}</p>
          {workflowName && onShowAllWorkflows && (
            <button
              type="button"
              className="touch-target !mt-2 flex min-h-7 max-w-full items-center gap-1 rounded-md bg-muted px-2 text-xs transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-muted/80"
              aria-label={t("workflowActivity.showAllWorkflows", { name: workflowName })}
              onClick={onShowAllWorkflows}
            >
              <span className="truncate">{workflowName}</span>
              <X className="h-3 w-3 shrink-0" aria-hidden />
            </button>
          )}
        </div>
      </header>
      {(error || actionError) && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-error-border bg-error-surface px-3 py-2 text-sm text-error-foreground"
        >
          {t("errors.unavailable")}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setActionError(false);
              setRevision((value) => value + 1);
            }}
          >
            {t("common.retry")}
          </Button>
        </div>
      )}
      <div
        className={cn(
          "grid min-w-0 gap-5",
          runOpen &&
            listShown &&
            "grid-cols-[minmax(0,22rem)_minmax(0,1fr)] items-start 2xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]",
        )}
      >
        {listShown && (
          <div className="min-w-0 space-y-5">
            <section aria-label={t("workflowActivity.running")} className="space-y-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                {totals.running > 0 ? (
                  <Loader2 className="h-4 w-4 animate-spin text-info-foreground" aria-hidden />
                ) : (
                  <CircleDashed className="h-4 w-4 text-muted-foreground" aria-hidden />
                )}
                {t("workflowActivity.running")}
                <span className="font-normal tabular-nums text-muted-foreground">{totals.running}</span>
              </h3>
              {totals.running === 0 ? (
                <RunningPlaceholder label={t("workflowActivity.empty.running")} />
              ) : (
                <ol className="divide-y overflow-hidden rounded-lg border bg-card">
                  {active?.runs.map((run) => runRow(run, true))}
                </ol>
              )}
              {runningPaged && (
                <Pager page={activePage} pages={Math.ceil(totals.running / runningPageSize)} onChange={setActivePage} />
              )}
            </section>
            <div className="overflow-hidden rounded-lg border bg-card">
              <div
                role="tablist"
                aria-label={t("workflowActivity.categories")}
                className="flex gap-1 border-b bg-muted/30 p-1"
              >
                {(["attention", "history"] as const).map((value) => (
                  <Button
                    key={value}
                    role="tab"
                    aria-selected={view === value}
                    variant={view === value ? "secondary" : "ghost"}
                    className="min-w-0 flex-1 px-2 text-xs"
                    onClick={() => onViewChange(value)}
                  >
                    {t(`workflowActivity.${value}`)} <span className="text-muted-foreground">{totals[value]}</span>
                  </Button>
                ))}
              </div>
              {!displayed && !error ? (
                <p role="status" className="p-4 text-sm text-muted-foreground">
                  {t("workManagement.loading")}
                </p>
              ) : displayed?.runs.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-muted-foreground">
                  {t(`workflowActivity.empty.${view}`)}
                </p>
              ) : (
                <ol className="divide-y">{displayed?.runs.map((run) => runRow(run))}</ol>
              )}
              {displayed && listPaged && (
                <div className="border-t px-1 py-1">
                  <Pager page={page} pages={Math.ceil(displayed.total / listPageSize)} onChange={setPage} />
                </div>
              )}
            </div>
          </div>
        )}
        {runOpen && (
          <div ref={detailRef} className="min-w-0 scroll-mt-20 rounded-lg border bg-card p-4 sm:p-5">
            {!mobile && (
              <Button variant="ghost" size="sm" className="-ml-2 -mt-1 mb-3 min-w-0 px-2" onClick={onBack}>
                <ArrowLeft className="h-4 w-4 shrink-0" />
                <span className="truncate">{t("workflowActivity.backToHistory")}</span>
              </Button>
            )}
            {detail}
          </div>
        )}
      </div>
    </section>
  );
}

function Pager({ page, pages, onChange }: { page: number; pages: number; onChange: (page: number) => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between">
      <Button
        size="icon"
        variant="ghost"
        aria-label={t("workflowActivity.previous")}
        disabled={page === 1}
        onClick={() => onChange(page - 1)}
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <span className="text-xs tabular-nums text-muted-foreground">
        {page} / {pages}
      </span>
      <Button
        size="icon"
        variant="ghost"
        aria-label={t("workflowActivity.next")}
        disabled={page >= pages}
        onClick={() => onChange(page + 1)}
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}

/** Holds the running section's place while idle, so the queue keeps one position whether or not work is active. */
function RunningPlaceholder({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-dashed px-4 py-3">
      <div className="flex min-w-0 gap-2.5">
        <span className="flex h-5 w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
          <span className="h-2 w-2 rounded-full border border-muted-foreground/40" />
        </span>
        <p className="min-w-0 truncate text-sm text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}
