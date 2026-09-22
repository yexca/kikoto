import { Check, ChevronRight, Copy } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { intlLocaleFor } from "@/i18n";
import { useLocale } from "@/i18n/LocaleProvider";
import type { WorkflowEvent, WorkflowNodeRun } from "@/lib/api";

import { formatClockTime, parseWorkflowTimestamp } from "./runPresentation";

const visibleEventLimit = 200;

function prettyJSON(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "{}" || trimmed === "null" || trimmed === "[]") return "";
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return trimmed;
  }
}

function levelClass(level: string) {
  if (level === "error") return "text-error-foreground";
  if (level === "warn" || level === "warning") return "text-warning-foreground";
  return "text-muted-foreground";
}

/** Collapsed-by-default event log for a run, meant for diagnosing what happened rather than reading at a glance. */
export function RunDiagnostics({
  events,
  nodeRuns,
  summaryJson,
}: {
  events: WorkflowEvent[];
  nodeRuns: WorkflowNodeRun[];
  summaryJson: string;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const locale = intlLocaleFor(resolvedLocale);
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const nodeNames = useMemo(
    () => new Map(nodeRuns.map((node) => [node.id, node.displayName || node.nodeId])),
    [nodeRuns],
  );
  const warnings = events.filter((event) => event.level === "warn" || event.level === "warning").length;
  const errors = events.filter((event) => event.level === "error").length;
  const summary = prettyJSON(summaryJson);
  const hidden = showAll ? 0 : Math.max(0, events.length - visibleEventLimit);
  const shown = hidden > 0 ? events.slice(-visibleEventLimit) : events;

  const copyLog = async () => {
    const lines = events.map((event) => {
      const node = event.nodeRunId ? nodeNames.get(event.nodeRunId) : "";
      const detail = prettyJSON(event.detailJson).replace(/\s*\n\s*/g, " ");
      return [event.createdAt, event.level.toUpperCase(), event.eventType, node, event.message, detail]
        .filter(Boolean)
        .join("\t");
    });
    if (summary) lines.push("", summary);
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <details className="group min-w-0 rounded-lg border">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-3 text-sm hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
        <span className="font-medium">{t("workflowActivity.diagnostics.title")}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{events.length}</span>
        <span className="ml-auto flex items-center gap-2 text-xs tabular-nums">
          {warnings > 0 && (
            <span className="text-warning-foreground">
              {t("workflowActivity.diagnostics.warnings", { count: warnings })}
            </span>
          )}
          {errors > 0 && (
            <span className="text-error-foreground">{t("workflowActivity.diagnostics.errors", { count: errors })}</span>
          )}
        </span>
      </summary>
      <div className="space-y-1.5 border-t px-3 pb-3 pt-1.5">
        {events.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">{t("workflowActivity.diagnostics.empty")}</p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              {hidden > 0 ? (
                <Button size="sm" variant="ghost" className="-ml-2 h-8 px-2 text-xs" onClick={() => setShowAll(true)}>
                  {t("workflowActivity.diagnostics.showEarlier", { count: hidden })}
                </Button>
              ) : (
                <span />
              )}
              <Button size="sm" variant="ghost" className="-mr-2 h-8 px-2 text-xs" onClick={() => void copyLog()}>
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? t("workflowActivity.diagnostics.copied") : t("workflowActivity.diagnostics.copy")}
              </Button>
            </div>
            <ol className="app-scrollbar max-h-80 overflow-y-auto font-mono text-[11px] leading-5">
              {shown.map((event) => {
                const at = parseWorkflowTimestamp(event.createdAt);
                const node = event.nodeRunId ? nodeNames.get(event.nodeRunId) : "";
                const detail = prettyJSON(event.detailJson);
                const row = (
                  <>
                    <time
                      className="tabular-nums text-muted-foreground"
                      dateTime={at?.toISOString()}
                      title={event.createdAt}
                    >
                      {at ? formatClockTime(at, locale) : event.createdAt}
                    </time>
                    <span className={`uppercase ${levelClass(event.level)}`}>{event.level}</span>
                    <span className="min-w-0 break-words font-sans text-xs [overflow-wrap:anywhere]">
                      <span className={event.level === "error" ? "text-error-foreground" : ""}>{event.message}</span>
                      <span className="text-muted-foreground">
                        {" "}
                        · {node ? `${node} · ` : ""}
                        {event.eventType}
                      </span>
                      {detail && (
                        <ChevronRight
                          className="ml-1 inline h-3 w-3 text-muted-foreground transition-transform group-open/event:rotate-90"
                          aria-hidden="true"
                        />
                      )}
                    </span>
                  </>
                );
                const rowClass = "grid grid-cols-[auto_2.75rem_minmax(0,1fr)] gap-x-2 rounded px-1 py-0.5";
                return (
                  <li key={event.id}>
                    {detail ? (
                      <details className="group/event">
                        <summary
                          className={`${rowClass} cursor-pointer list-none hover:bg-muted/40 [&::-webkit-details-marker]:hidden`}
                        >
                          {row}
                        </summary>
                        <pre className="mx-1 mb-1 mt-0.5 whitespace-pre-wrap break-words rounded bg-muted/40 p-2 text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
                          {detail}
                        </pre>
                      </details>
                    ) : (
                      <div className={rowClass}>{row}</div>
                    )}
                  </li>
                );
              })}
            </ol>
          </>
        )}
        {summary && (
          <details className="group/summary">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
              <ChevronRight className="h-3 w-3 transition-transform group-open/summary:rotate-90" aria-hidden="true" />
              {t("workflowActivity.diagnostics.summary")}
            </summary>
            <pre className="app-scrollbar mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
              {summary}
            </pre>
          </details>
        )}
      </div>
    </details>
  );
}
