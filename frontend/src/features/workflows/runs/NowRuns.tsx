import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { api, type WorkflowRun } from "@/lib/api";

import { Pager, RunCount, RunListItem } from "./RunListParts";
import { useRunList } from "./useRunList";

/** How many entries Running and Next show before Show all. */
export const nowSectionLimit = 5;
const attentionPageSize = 20;

/** One list of the page under a plain heading and a hairline, with its count beside the name it is known by. */
export function NowSection({
  title,
  count,
  tone,
  actions,
  children,
}: {
  title: string;
  count?: number;
  tone?: "info" | "warning";
  actions?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="min-w-0">
      <div className="flex min-h-9 items-center justify-between gap-3 border-b pb-1.5">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <span id={id}>{title}</span>
          {count !== undefined && tone && <RunCount value={count} tone={tone} />}
        </h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Show all or Show less under a section that holds more than it shows. */
export function ShowAllButton({
  expanded,
  total,
  onToggle,
}: {
  expanded: boolean;
  total: number;
  onToggle: (expanded: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <Button size="sm" variant="ghost" className="mt-1 text-muted-foreground" onClick={() => onToggle(!expanded)}>
      {expanded ? t("workflowPage.showLess") : t("workflowPage.showAll", { count: total })}
    </Button>
  );
}

/** Queued and running runs of every workflow, newest first. Nothing shows while none is active. */
export function RunningRuns({
  runs,
  total,
  selectedRunId,
  canSyncMetadata,
  onSelectRun,
}: {
  runs: WorkflowRun[];
  total: number;
  selectedRunId: number | null;
  canSyncMetadata: boolean;
  onSelectRun: (run: WorkflowRun) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  if (runs.length === 0) return null;
  const shown = expanded ? runs : runs.slice(0, nowSectionLimit);
  return (
    <NowSection title={t("workflowActivity.views.running")} count={total} tone="info">
      <ol className="divide-y">
        {shown.map((run) => (
          <RunListItem
            key={run.id}
            run={run}
            selected={run.id === selectedRunId}
            onSelect={onSelectRun}
            canSyncMetadata={canSyncMetadata}
          />
        ))}
      </ol>
      {nowSectionLimit < runs.length && <ShowAllButton expanded={expanded} total={total} onToggle={setExpanded} />}
    </NowSection>
  );
}

/**
 * Runs that wait for a decision, a page at a time: candidates to review,
 * metadata issues, and failures nobody has looked at. A run whose remaining
 * items allow it is marked reviewed here.
 */
export function AttentionRuns({
  refreshKey,
  staticDemo,
  readOnly,
  canSyncMetadata,
  selectedRunId,
  onSelectRun,
  onChanged,
}: {
  refreshKey: number;
  staticDemo: boolean;
  readOnly: boolean;
  canSyncMetadata: boolean;
  selectedRunId: number | null;
  onSelectRun: (run: WorkflowRun) => void;
  /** A run was marked reviewed. */
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState<number | null>(null);
  const [actionError, setActionError] = useState(false);
  const list = useRunList({
    view: "attention",
    page,
    pageSize: attentionPageSize,
    refreshKey,
    staticDemo,
    onPageOutOfRange: setPage,
  });
  const result = list.result;

  const acknowledge = async (run: WorkflowRun) => {
    if (readOnly || busy !== null) return;
    setBusy(run.id);
    setActionError(false);
    try {
      await api.reviewWorkflowRun(run.id);
      list.reload();
      onChanged();
    } catch {
      setActionError(true);
    } finally {
      setBusy(null);
    }
  };
  const pages = result ? Math.ceil(result.total / attentionPageSize) : 0;
  return (
    <div className="min-w-0 space-y-4">
      {(actionError || list.error) && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-error-border bg-error-surface px-3 py-2 text-sm text-error-foreground"
        >
          {t("errors.unavailable")}
          {list.error && (
            <Button size="sm" variant="outline" onClick={list.reload}>
              {t("common.retry")}
            </Button>
          )}
        </div>
      )}
      {!result && !list.error ? (
        <p role="status" className="px-3 py-4 text-sm text-muted-foreground">
          {t("workManagement.loading")}
        </p>
      ) : result?.runs.length === 0 ? (
        <p className="px-3 py-10 text-center text-sm text-muted-foreground">{t("workflowActivity.empty.attention")}</p>
      ) : (
        <ol className="divide-y border-b">
          {result?.runs.map((run) => (
            <RunListItem
              key={run.id}
              run={run}
              selected={run.id === selectedRunId}
              onSelect={onSelectRun}
              canSyncMetadata={canSyncMetadata}
              acknowledge={readOnly ? undefined : { busy, onAcknowledge: (item) => void acknowledge(item) }}
            />
          ))}
        </ol>
      )}
      {result && pages > 1 && <Pager page={page} pages={pages} onChange={setPage} />}
    </div>
  );
}
