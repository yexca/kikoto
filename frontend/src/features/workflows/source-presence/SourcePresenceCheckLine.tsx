import {
  formatRelativeTime,
  formatTimestamp,
  isActiveRunStatus,
  parseWorkflowTimestamp,
} from "@/features/workflows/runPresentation";
import { useNow } from "@/features/workflows/useRunClock";
import { workflowCopy } from "@/features/workflows/workflowPageModel";
import { intlLocaleFor } from "@/i18n";
import { useLocale } from "@/i18n/LocaleProvider";
import type { FileSourcePresenceCheck } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

/**
 * A remote source's library work check in one quiet line: not checked yet,
 * queued, running, or when the latest check ended and how many works the
 * source has, then the next scheduled check. A line with a run opens it.
 */
export function SourcePresenceCheckLine({
  check,
  onOpenRun,
  className,
}: {
  check: FileSourcePresenceCheck;
  /** Opens the latest check in Activity; without it the line is plain text. */
  onOpenRun?: (runId: number) => void;
  className?: string;
}) {
  const { resolvedLocale } = useLocale();
  const locale = intlLocaleFor(resolvedLocale);
  const now = useNow(true, 30_000);
  const relative = (value: string | null) => {
    const date = parseWorkflowTimestamp(value);
    return date ? { text: formatRelativeTime(date, locale, now), title: formatTimestamp(date, locale) } : null;
  };
  const run = check.lastRun;
  const at = run ? relative(run.at) : null;
  const next = relative(check.nextRunAt);
  const parts: string[] = [];
  let tone = "text-muted-foreground";
  if (!run) parts.push(workflowCopy("sourceCheck.never"));
  else if (run.status === "queued") parts.push(workflowCopy("sourceCheck.queuedLine"));
  else if (isActiveRunStatus(run.status)) parts.push(workflowCopy("sourceCheck.running"));
  else if (run.status === "succeeded" || run.status === "partial") {
    parts.push(
      workflowCopy(run.status === "partial" ? "sourceCheck.partial" : "sourceCheck.checked", { time: at?.text ?? "" }),
    );
    parts.push(workflowCopy("sourceCheck.available", { count: run.availableWorks }));
    if (run.status === "partial") tone = "text-warning-foreground";
  } else {
    parts.push(workflowCopy("sourceCheck.failed", { time: at?.text ?? "" }));
    tone = "text-error-foreground";
  }
  if (next) parts.push(workflowCopy("sourceCheck.nextLine", { time: next.text }));
  const text = parts.join(" · ");
  if (!run || !onOpenRun) return <span className={cn(tone, className)}>{text}</span>;
  return (
    <button
      type="button"
      className={cn(
        "rounded-sm text-left underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        tone,
        className,
      )}
      title={at?.title}
      aria-label={`${text}. ${workflowCopy("sourceCheck.openRun")}`}
      onClick={() => onOpenRun(run.id)}
    >
      {text}
    </button>
  );
}
