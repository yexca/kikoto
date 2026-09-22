import { Download } from "lucide-react";
import { useTranslation } from "react-i18next";

import { intlLocaleFor } from "@/i18n";
import { useLocale } from "@/i18n/LocaleProvider";
import type { WorkflowRun } from "@/lib/api";

import {
  formatBytes,
  formatDuration,
  hasTransferProgress,
  isActiveRunStatus,
  transferProgress,
  type TransferProgress,
} from "./runPresentation";
import { useTransferRate } from "./useRunClock";

type TransferRun = Pick<
  WorkflowRun,
  "id" | "workflowCode" | "status" | "progressBytesCurrent" | "progressBytesTotal" | "progressBytesUnknownItems"
>;

function useTransferCopy() {
  const { t } = useTranslation();
  return (key: string, options?: Record<string, unknown>) => t(`workflowPage.${key}`, options);
}

function transferLabel(progress: TransferProgress, copy: ReturnType<typeof useTransferCopy>) {
  const { current, total, unknownItems } = progress;
  if (unknownItems > 0)
    return `${formatBytes(current)} ${copy("transferred")} · ${formatBytes(total)} ${copy("knownTotal")} · ${unknownItems} ${copy(unknownItems === 1 ? "unknownSizeFile" : "unknownSizeFiles")}`;
  if (total > 0) return `${formatBytes(current)} ${copy("of")} ${formatBytes(total)}`;
  return `${formatBytes(current)} ${copy("transferred")}`;
}

function TransferBar({ progress, label, size }: { progress: TransferProgress; label: string; size: "sm" | "md" }) {
  const copy = useTransferCopy();
  const height = size === "sm" ? "h-1" : "h-1.5";
  if (!progress.determinate) {
    return (
      <div className={`${height} overflow-hidden rounded-full bg-muted`} aria-hidden="true">
        <div className="h-full w-1/3 rounded-full bg-primary/70 motion-safe:animate-pulse" />
      </div>
    );
  }
  return (
    <div
      className={`${height} overflow-hidden rounded-full bg-muted`}
      role="progressbar"
      aria-label={copy("fetchByteProgress")}
      aria-valuemin={0}
      aria-valuemax={progress.total}
      aria-valuenow={Math.min(progress.current, progress.total)}
      aria-valuetext={label}
    >
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-700 ease-out"
        style={{ width: `${progress.percent}%` }}
      />
    </div>
  );
}

/** Live byte progress for a Fetch run, with rate and remaining time derived from observed samples. */
export function RunTransferProgress({ run, compact = false }: { run: TransferRun; compact?: boolean }) {
  const { t } = useTranslation();
  const copy = useTransferCopy();
  const { resolvedLocale } = useLocale();
  const locale = intlLocaleFor(resolvedLocale);
  const active = isActiveRunStatus(run.status);
  const visible = hasTransferProgress(run);
  const progress = transferProgress(run);
  const rate = useTransferRate(run.id, progress.current, visible && active);
  if (!visible) return null;

  const label = transferLabel(progress, copy);
  const percent = progress.determinate ? `${Math.floor(progress.percent)}%` : "";
  const remaining =
    active && progress.determinate && rate && rate > 0
      ? formatDuration(((progress.total - progress.current) / rate) * 1000, locale)
      : "";
  const speed = !active
    ? ""
    : rate === null
      ? t("workflowActivity.transfer.measuring")
      : t("workflowActivity.transfer.rate", { rate: formatBytes(Math.round(rate)) });
  const pace = [speed, remaining && t("workflowActivity.transfer.remaining", { time: remaining })]
    .filter(Boolean)
    .join(" · ");

  if (compact) {
    return (
      <div className="space-y-1.5" role="status" aria-label={copy("fetchTransferProgress")}>
        <TransferBar progress={progress} label={label} size="sm" />
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs tabular-nums text-muted-foreground">
          <span className="min-w-0 break-words">{[percent, label].filter(Boolean).join(" · ")}</span>
          {pace && <span className="shrink-0">{pace}</span>}
        </div>
      </div>
    );
  }

  return (
    <section
      className="min-w-0 space-y-2.5 rounded-lg border bg-card px-3.5 py-3"
      role="status"
      aria-label={copy("fetchTransferProgress")}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-sm font-medium">
          <Download className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {copy("transfer")}
        </span>
        {percent && <span className="text-lg font-semibold tabular-nums leading-none">{percent}</span>}
      </div>
      <TransferBar progress={progress} label={label} size="md" />
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs tabular-nums text-muted-foreground">
        <span className="min-w-0 break-words">{label}</span>
        {pace && <span className="shrink-0 font-medium text-foreground">{pace}</span>}
      </div>
    </section>
  );
}
