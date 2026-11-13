import { ArrowLeft, Check, ChevronLeft, ChevronRight, Loader2, Search } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { SubNavTabs } from "@/components/ui/sub-nav";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { api, type WorkflowRun, type WorkflowRunsPage } from "@/lib/api";
import { openMetadataIssues } from "@/lib/metadataMaintenance";
import { cn } from "@/lib/tailwindClassNames";

import { ActivityRunSummary } from "./ActivityRunSummary";
import { activityViews, type ActivityView } from "./workflowLinks";

const listPageSize = 20;
const searchDelayMs = 300;
const listPanelId = "activity-runs";

export type ActivityWorkflowOption = { code: string; name: string };

/**
 * The run log: every workflow's runs, newest first, narrowed by list, by
 * workflow, and by search. A selected run opens beside the list on wide
 * screens and in place of it otherwise.
 */
export function WorkflowActivity({
  view,
  onViewChange,
  workflowCode,
  workflowOptions,
  onWorkflowChange,
  query,
  onQueryChange,
  note,
  selectedRunId,
  onSelectRun,
  onBack,
  detail,
  refreshKey,
  readOnly,
  staticDemo,
  canSyncMetadata,
  mobile,
}: {
  view: ActivityView;
  onViewChange: (view: ActivityView) => void;
  /** The workflow the list is narrowed to; empty for every workflow. */
  workflowCode: string;
  workflowOptions: ActivityWorkflowOption[];
  onWorkflowChange: (code: string) => void;
  query: string;
  onQueryChange: (query: string) => void;
  /** Shown above the list, such as where the selected workflow is configured. */
  note?: ReactNode;
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
}) {
  const { t } = useTranslation();
  const detailRef = useRef<HTMLDivElement>(null);
  const wide = useMediaQuery("(min-width: 1280px)");
  const [page, setPage] = useState(1);
  const scope = `${view}\n${workflowCode}\n${query}`;
  const [snapshot, setSnapshot] = useState<{ scope: string; page: number; result: WorkflowRunsPage } | null>(null);
  // Another list, workflow, or search starts from its first page.
  const [pageScope, setPageScope] = useState(scope);
  if (pageScope !== scope) {
    setPageScope(scope);
    setPage(1);
  }
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [actionError, setActionError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [totals, setTotals] = useState({ running: 0, attention: 0 });

  useEffect(() => {
    const controller = new AbortController();
    let fetching = false;
    const load = async () => {
      if (fetching || document.hidden || controller.signal.aborted) return;
      fetching = true;
      try {
        const result = await api.listWorkflowRuns(
          page,
          listPageSize,
          view === "all" ? "" : view,
          query,
          workflowCode,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setTotals({ running: result.viewTotals?.running ?? 0, attention: result.viewTotals?.attention ?? 0 });
        if (page > 1 && result.total <= (page - 1) * listPageSize) {
          setPage(Math.max(1, Math.ceil(result.total / listPageSize)));
          return;
        }
        setSnapshot({ scope, page, result });
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
  }, [view, page, revision, workflowCode, query, scope, refreshKey, staticDemo]);

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
  const runRow = (run: WorkflowRun) => {
    // Products reported as not found may stay pending, as for a delisted work;
    // candidates and retryable metadata failures must be resolved first.
    const needsAcknowledge =
      view === "attention" &&
      (run.status === "failed" || run.status === "partial" || (run.pendingMetadata ?? 0) > 0) &&
      run.pendingCandidates === 0 &&
      !(run.pendingFailedMetadata ?? 0) &&
      !readOnly;
    const openMetadata = (run.pendingMetadata ?? 0) > 0 && canSyncMetadata;
    const selected = run.id === selectedRunId;
    return (
      <li key={run.id} className="relative">
        <button
          aria-current={selected ? "true" : undefined}
          className={cn(
            "w-full px-3 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:bg-muted/70",
            selected && "bg-primary/10 hover:bg-primary/10",
          )}
          onClick={() => onSelectRun(run)}
        >
          <ActivityRunSummary run={run} />
        </button>
        {((run.pendingMetadata ?? 0) > 0 || needsAcknowledge) && (
          <div className="flex flex-wrap items-center gap-2 px-3 pb-3 pl-9">
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
  const displayed = snapshot?.scope === scope && snapshot.page === page ? snapshot.result : null;
  const runOpen = selectedRunId !== null;
  // Below 1280px an open run replaces the list rather than sitting beside it.
  const listShown = !runOpen || (wide && !mobile);
  const pages = displayed ? Math.ceil(displayed.total / listPageSize) : 0;
  const count = (value: number, tone: "info" | "warning") =>
    value > 0 ? (
      <span
        className={cn(
          "rounded-full px-1.5 text-2xs font-semibold tabular-nums leading-5",
          tone === "info" ? "bg-info-surface text-info-foreground" : "bg-warning-surface text-warning-foreground",
        )}
      >
        {value}
      </span>
    ) : undefined;

  return (
    <section aria-label={t("nav.activity")} className="min-w-0 space-y-4">
      {listShown && (
        <SubNavTabs
          label={t("workflowActivity.categories")}
          selected={view}
          onSelect={onViewChange}
          items={activityViews.map((value) => ({
            value,
            label: t(`workflowActivity.views.${value}`),
            id: `activity-view-${value}`,
            controls: listPanelId,
            suffix:
              value === "running"
                ? count(totals.running, "info")
                : value === "attention"
                  ? count(totals.attention, "warning")
                  : undefined,
          }))}
          trailing={
            // A phone gives the two filters the row under the tabs, sharing its width.
            <div className="flex min-w-0 items-center gap-2 max-sm:w-full">
              <NativeSelect
                fieldSize="sm"
                className="min-w-0 max-sm:flex-1 sm:w-48"
                aria-label={t("workflowActivity.workflowFilter")}
                value={workflowCode}
                onChange={(event) => onWorkflowChange(event.target.value)}
              >
                <option value="">{t("workflowActivity.allWorkflows")}</option>
                {workflowCode && !workflowOptions.some((option) => option.code === workflowCode) && (
                  <option value={workflowCode}>{workflowCode}</option>
                )}
                {workflowOptions.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.name}
                  </option>
                ))}
              </NativeSelect>
              <ActivitySearch query={query} onQueryChange={onQueryChange} />
            </div>
          }
        />
      )}
      {listShown && note}
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
          <div id={listPanelId} role="tabpanel" aria-labelledby={`activity-view-${view}`} className="min-w-0">
            {!displayed && !error ? (
              <p role="status" className="px-3 py-4 text-sm text-muted-foreground">
                {t("workManagement.loading")}
              </p>
            ) : displayed?.runs.length === 0 ? (
              <p className="px-3 py-10 text-center text-sm text-muted-foreground">
                {query || workflowCode ? t("workflowActivity.empty.filtered") : t(`workflowActivity.empty.${view}`)}
              </p>
            ) : (
              <ol className="divide-y border-b">{displayed?.runs.map((run) => runRow(run))}</ol>
            )}
            {displayed && pages > 1 && <Pager page={page} pages={pages} onChange={setPage} />}
          </div>
        )}
        {runOpen && (
          <div ref={detailRef} className={cn("min-w-0 scroll-mt-20", listShown && "border-l pl-5")}>
            {!mobile && (
              <Button variant="ghost" size="sm" className="-ml-2 mb-3 min-w-0 px-2" onClick={onBack}>
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

/** Search by workflow name, trigger reason, or the work, circle, or source a run acts on. */
function ActivitySearch({ query, onQueryChange }: { query: string; onQueryChange: (query: string) => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(query);
  // An address change, such as Back, replaces what is typed.
  const [applied, setApplied] = useState(query);
  if (applied !== query) {
    setApplied(query);
    setDraft(query);
  }
  const submit = useRef(onQueryChange);
  submit.current = onQueryChange;
  useEffect(() => {
    if (draft.trim() === query) return;
    const timer = window.setTimeout(() => submit.current(draft), searchDelayMs);
    return () => window.clearTimeout(timer);
  }, [draft, query]);
  return (
    <div className="relative min-w-0 max-sm:flex-1">
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        type="search"
        fieldSize="sm"
        className="w-full pl-8 sm:w-48"
        aria-label={t("workflowActivity.search")}
        placeholder={t("workflowActivity.search")}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
    </div>
  );
}

function Pager({ page, pages, onChange }: { page: number; pages: number; onChange: (page: number) => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between pt-1">
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
