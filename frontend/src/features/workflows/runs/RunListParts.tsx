import { Check, ChevronLeft, ChevronRight, Loader2, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ActivityRunSummary } from "@/features/workflows/ActivityRunSummary";
import type { WorkflowRun } from "@/lib/api";
import { openMetadataIssues } from "@/lib/metadataMaintenance";
import { cn } from "@/lib/tailwindClassNames";

const searchDelayMs = 300;

/**
 * Whether a run that needs attention can be marked reviewed. Products reported
 * as not found may stay pending, as for a delisted work; candidates and
 * retryable metadata failures must be resolved first.
 */
export function canAcknowledgeRun(run: WorkflowRun) {
  return (
    (run.status === "failed" || run.status === "partial" || (run.pendingMetadata ?? 0) > 0) &&
    run.pendingCandidates === 0 &&
    !(run.pendingFailedMetadata ?? 0)
  );
}

/** One run in a list: its summary opens it; a run with metadata issues or one to review shows those actions. */
export function RunListItem({
  run,
  selected,
  onSelect,
  canSyncMetadata,
  acknowledge,
}: {
  run: WorkflowRun;
  selected: boolean;
  onSelect: (run: WorkflowRun) => void;
  canSyncMetadata: boolean;
  /** Offered in Needs attention; `busy` is the run being marked, if any. */
  acknowledge?: { busy: number | null; onAcknowledge: (run: WorkflowRun) => void };
}) {
  const { t } = useTranslation();
  const pendingMetadata = run.pendingMetadata ?? 0;
  const acknowledgeable = Boolean(acknowledge) && canAcknowledgeRun(run);
  return (
    <li className="relative">
      <button
        aria-current={selected ? "true" : undefined}
        className={cn(
          "w-full px-3 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:bg-muted/70",
          selected && "bg-primary/10 hover:bg-primary/10",
        )}
        onClick={() => onSelect(run)}
      >
        <ActivityRunSummary run={run} />
      </button>
      {(pendingMetadata > 0 || acknowledgeable) && (
        <div className="flex flex-wrap items-center gap-2 px-3 pb-3 pl-9">
          {pendingMetadata > 0 && (
            <span className="text-xs text-warning-foreground">
              {t("workflowActivity.metadataCount", { count: pendingMetadata })}
            </span>
          )}
          {pendingMetadata > 0 && canSyncMetadata && (
            <Button size="sm" variant="outline" className="h-8" onClick={() => openMetadataIssues(run.id)}>
              {t("metadataIssues.openIssues")}
            </Button>
          )}
          {acknowledge && acknowledgeable && (
            <Button
              size="sm"
              variant="ghost"
              className="-ml-2 h-8"
              disabled={acknowledge.busy !== null}
              onClick={() => acknowledge.onAcknowledge(run)}
            >
              {acknowledge.busy === run.id ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              {t("workflowActivity.acknowledge")}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/** A count beside a list's name, shown only when there is something in it. */
export function RunCount({ value, tone }: { value: number; tone: "info" | "warning" }) {
  if (value <= 0) return null;
  return (
    <span
      className={cn(
        "rounded-full px-1.5 text-2xs font-semibold tabular-nums leading-5",
        tone === "info" ? "bg-info-surface text-info-foreground" : "bg-warning-surface text-warning-foreground",
      )}
    >
      {value}
    </span>
  );
}

/** Search by workflow name, trigger reason, or the work, circle, or source a run acts on. */
export function RunSearch({ query, onQueryChange }: { query: string; onQueryChange: (query: string) => void }) {
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

export function Pager({ page, pages, onChange }: { page: number; pages: number; onChange: (page: number) => void }) {
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
