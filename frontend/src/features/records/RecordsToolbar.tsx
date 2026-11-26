import type { TFunction } from "i18next";
import { AlertTriangle, Check, ChevronRight, Clapperboard, Loader2, RefreshCw } from "lucide-react";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import type { RecordAsset, RecordRoot } from "@/lib/api";
import { openWorkflowPath, workflowRunPath } from "@/lib/workflowLinks";

import { RecordContinuePicker } from "./RecordContinuePicker";
import type { RecordCrumb } from "./recordsLocation";
import type { RecordScanState } from "./useRecordScan";

/** The folder path from the root; every step but the current folder opens it. */
export function RecordBreadcrumb({
  trail,
  onOpenCrumb,
}: {
  trail: readonly RecordCrumb[];
  /** The index of the trail step to open; -1 opens the root. */
  onOpenCrumb: (index: number) => void;
}) {
  const { t } = useTranslation();
  const steps = [{ id: 0, name: t("nav.record") }, ...trail];
  return (
    <nav
      aria-label={t("records.breadcrumb")}
      className="app-scrollbar min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
    >
      <ol className="flex w-max items-center gap-0.5 text-sm">
        {steps.map((step, index) => {
          const current = index === steps.length - 1;
          const name = step.name || t("records.unknownFolder");
          return (
            <li key={`${step.id}-${index}`} className="flex items-center gap-0.5">
              {index > 0 && <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
              {current ? (
                <span
                  aria-current="page"
                  className="flex min-h-11 items-center gap-1.5 px-1.5 font-semibold sm:min-h-9"
                >
                  {index === 0 && <Clapperboard className="h-4 w-4 text-primary" aria-hidden="true" />}
                  {name}
                </span>
              ) : (
                <button
                  type="button"
                  className="flex min-h-11 items-center gap-1.5 rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-muted sm:min-h-9"
                  onClick={() => onOpenCrumb(index - 1)}
                >
                  {index === 0 && <Clapperboard className="h-4 w-4" aria-hidden="true" />}
                  {name}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function scanStatusText(t: TFunction, scan: RecordScanState) {
  switch (scan.status) {
    case "running":
      return scan.found > 0
        ? t("records.scanStatus.runningFound", { count: scan.found })
        : t("records.scanStatus.running");
    case "probing":
      return scan.total > 0
        ? t("records.scanStatus.probing", { done: scan.done, total: scan.total })
        : t("records.scanStatus.probingQueued");
    case "queueing":
    case "queued":
    case "finished":
    case "failed":
      return t(`records.scanStatus.${scan.status}`);
    default:
      return "";
  }
}

function lastScannedText(t: TFunction, root: RecordRoot, locale: ReturnType<typeof useLocale>["resolvedLocale"]) {
  const time = root.lastScannedAt ? formatDateTime(root.lastScannedAt, locale) : "";
  return time ? t("records.scanStatus.lastScanned", { time }) : t("records.scanStatus.neverScanned");
}

/**
 * What the record workflows are doing, while a scan or a media details run is
 * queued, running, or just ended. It opens that run on Workflows for an
 * account that may see the run; phones show only its icon.
 */
function RecordScanStatus({ scan, canOpenRun }: { scan: RecordScanState; canOpenRun: boolean }) {
  const { t } = useTranslation();
  if (scan.status === "idle") return null;
  const text = scanStatusText(t, scan);
  const failed = scan.status === "failed";
  const icon = failed ? (
    <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
  ) : scan.status === "finished" ? (
    <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
  ) : (
    <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
  );
  const tone = failed ? "text-error-foreground" : "text-muted-foreground";
  const content = (
    <>
      {icon}
      <span className="hidden sm:inline">{text}</span>
    </>
  );
  const runId = "runId" in scan ? scan.runId : undefined;
  if (canOpenRun && runId !== undefined) {
    const path = workflowRunPath(runId);
    const openRun = (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      openWorkflowPath(path);
    };
    return (
      <p role="status" className="flex">
        <a
          href={path}
          title={text}
          aria-label={text}
          className={`flex min-h-[var(--control-icon-size)] min-w-[var(--control-icon-size)] items-center justify-center gap-1.5 rounded-md px-1.5 text-xs transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-muted ${tone}`}
          onClick={openRun}
        >
          {content}
        </a>
      </p>
    );
  }
  return (
    <p
      role="status"
      title={text}
      aria-label={text}
      className={`flex min-h-[var(--control-icon-size)] items-center gap-1.5 px-1.5 text-xs ${tone}`}
    >
      {content}
    </p>
  );
}

/** Single-row header: breadcrumb on the left; scan status, Continue watching, and Refresh on the right. */
export function RecordsToolbar({
  trail,
  root,
  continueAssets,
  phone,
  refreshing,
  canOpenRun,
  scan,
  onOpenCrumb,
  onOpenContinue,
  onRefresh,
}: {
  trail: readonly RecordCrumb[];
  root: RecordRoot;
  continueAssets: readonly RecordAsset[];
  phone: boolean;
  refreshing: boolean;
  /** Whether the account may open a workflow run on Workflows. */
  canOpenRun: boolean;
  scan: RecordScanState;
  onOpenCrumb: (index: number) => void;
  onOpenContinue: (video: RecordAsset) => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();

  return (
    <div className="flex items-center gap-2">
      <RecordBreadcrumb trail={trail} onOpenCrumb={onOpenCrumb} />
      <div className="flex shrink-0 items-center gap-2">
        <RecordScanStatus scan={scan} canOpenRun={canOpenRun} />
        <RecordContinuePicker assets={continueAssets} phone={phone} onOpen={onOpenContinue} />
        <Button
          variant="toolbar"
          size="icon"
          aria-label={t("records.refresh")}
          title={`${t("records.refresh")}\n${lastScannedText(t, root, resolvedLocale)}`}
          disabled={refreshing}
          onClick={onRefresh}
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
