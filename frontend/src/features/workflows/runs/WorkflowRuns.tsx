import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/input";
import { SubNavTabs } from "@/components/ui/sub-nav";
import { workflowTabs, type HistoryStatus, type WorkflowTab } from "@/features/workflows/workflowLinks";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import type { WorkflowRun } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import { Pager, RunCount, RunListItem, RunSearch } from "./RunListParts";
import { useRunList } from "./useRunList";

const historyPageSize = 20;
const panelId = "workflow-runs";

export type RunWorkflowOption = { code: string; name: string };

/**
 * The runs under the operations: Now (what runs, what needs attention, what
 * runs next) and History (the runs that ended), narrowed by status, workflow,
 * and search. A selected run opens beside the list on wide screens and in
 * place of it otherwise.
 */
export function WorkflowRuns({
  tab,
  onTabChange,
  nowCount,
  now,
  status,
  onStatusChange,
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
  staticDemo,
  canSyncMetadata,
  mobile,
}: {
  tab: WorkflowTab;
  onTabChange: (tab: WorkflowTab) => void;
  /** Runs that are running or need attention, beside Now's name. */
  nowCount: number;
  now: ReactNode;
  status: HistoryStatus;
  onStatusChange: (status: HistoryStatus) => void;
  /** The workflow History is narrowed to; empty for every workflow. */
  workflowCode: string;
  workflowOptions: RunWorkflowOption[];
  onWorkflowChange: (code: string) => void;
  query: string;
  onQueryChange: (query: string) => void;
  /** Shown above History, such as where the selected workflow is configured. */
  note?: ReactNode;
  selectedRunId: number | null;
  onSelectRun: (run: WorkflowRun) => void;
  onBack: () => void;
  detail?: ReactNode;
  refreshKey: number;
  staticDemo: boolean;
  canSyncMetadata: boolean;
  /** The mobile layout returns from a run through the page header instead of a button in the panel. */
  mobile: boolean;
}) {
  const { t } = useTranslation();
  const detailRef = useRef<HTMLDivElement>(null);
  const wide = useMediaQuery("(min-width: 1280px)");
  const runOpen = selectedRunId !== null;
  // Below 1280px an open run replaces the list rather than sitting beside it.
  const listShown = !runOpen || (wide && !mobile);

  // A run chosen low in a long list opens with its detail in view.
  useEffect(() => {
    const element = detailRef.current;
    if (selectedRunId && element && element.getBoundingClientRect().top < 0) element.scrollIntoView({ block: "start" });
  }, [selectedRunId]);

  return (
    <section aria-label={t("workflowPage.runs.label")} className="min-w-0 space-y-4">
      {listShown && (
        <SubNavTabs
          label={t("workflowPage.runs.label")}
          selected={tab}
          onSelect={onTabChange}
          items={workflowTabs.map((value) => ({
            value,
            label: t(`workflowPage.runs.tabs.${value}`),
            id: `workflow-runs-${value}`,
            controls: panelId,
            suffix: value === "now" ? <RunCount value={nowCount} tone="info" /> : undefined,
          }))}
          trailing={
            tab === "history" ? (
              // A phone gives the filters the row under the tabs, sharing its width.
              <div className="flex min-w-0 flex-wrap items-center gap-2 max-sm:w-full">
                <NativeSelect
                  fieldSize="sm"
                  className="min-w-0 max-sm:flex-1 sm:w-32"
                  aria-label={t("workflowPage.runs.status")}
                  value={status}
                  onChange={(event) => onStatusChange(event.target.value === "failed" ? "failed" : "")}
                >
                  <option value="">{t("workflowActivity.views.all")}</option>
                  <option value="failed">{t("workflowActivity.views.failed")}</option>
                </NativeSelect>
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
                <RunSearch query={query} onQueryChange={onQueryChange} />
              </div>
            ) : undefined
          }
        />
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
          <div id={panelId} role="tabpanel" aria-labelledby={`workflow-runs-${tab}`} className="min-w-0">
            {tab === "now" ? (
              now
            ) : (
              <HistoryList
                status={status}
                workflowCode={workflowCode}
                query={query}
                note={note}
                selectedRunId={selectedRunId}
                onSelectRun={onSelectRun}
                refreshKey={refreshKey}
                staticDemo={staticDemo}
                canSyncMetadata={canSyncMetadata}
              />
            )}
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

/** Ended runs, newest first, a page at a time. */
function HistoryList({
  status,
  workflowCode,
  query,
  note,
  selectedRunId,
  onSelectRun,
  refreshKey,
  staticDemo,
  canSyncMetadata,
}: {
  status: HistoryStatus;
  workflowCode: string;
  query: string;
  note?: ReactNode;
  selectedRunId: number | null;
  onSelectRun: (run: WorkflowRun) => void;
  refreshKey: number;
  staticDemo: boolean;
  canSyncMetadata: boolean;
}) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  // Another status, workflow, or search starts from its first page.
  const scope = `${status}\n${workflowCode}\n${query}`;
  const [pageScope, setPageScope] = useState(scope);
  if (pageScope !== scope) {
    setPageScope(scope);
    setPage(1);
  }
  const list = useRunList({
    view: status === "failed" ? "failed" : "history",
    page,
    pageSize: historyPageSize,
    workflowCode,
    query,
    refreshKey,
    staticDemo,
    onPageOutOfRange: setPage,
  });
  const result = list.result;
  const pages = result ? Math.ceil(result.total / historyPageSize) : 0;
  return (
    <div className="min-w-0 space-y-4">
      {note}
      {list.error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-error-border bg-error-surface px-3 py-2 text-sm text-error-foreground"
        >
          {t("errors.unavailable")}
          <Button size="sm" variant="outline" onClick={list.reload}>
            {t("common.retry")}
          </Button>
        </div>
      )}
      {!result && !list.error ? (
        <p role="status" className="px-3 py-4 text-sm text-muted-foreground">
          {t("workManagement.loading")}
        </p>
      ) : result?.runs.length === 0 ? (
        <p className="px-3 py-10 text-center text-sm text-muted-foreground">
          {query || workflowCode
            ? t("workflowActivity.empty.filtered")
            : status === "failed"
              ? t("workflowActivity.empty.failed")
              : t("workflowActivity.empty.history")}
        </p>
      ) : (
        <ol className="divide-y border-b">
          {result?.runs.map((run) => (
            <RunListItem
              key={run.id}
              run={run}
              selected={run.id === selectedRunId}
              onSelect={onSelectRun}
              canSyncMetadata={canSyncMetadata}
            />
          ))}
        </ol>
      )}
      {result && pages > 1 && <Pager page={page} pages={pages} onChange={setPage} />}
    </div>
  );
}
