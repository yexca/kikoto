import type { TFunction } from "i18next";
import { ChevronRight, Clapperboard, Loader2, RefreshCw, ScanLine } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import type { RecordAsset, RecordRoot } from "@/lib/api";

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

function scanStatusText(
  t: TFunction,
  scan: RecordScanState,
  root: RecordRoot,
  locale: ReturnType<typeof useLocale>["resolvedLocale"],
) {
  switch (scan.status) {
    case "queueing":
    case "queued":
    case "running":
    case "finished":
    case "failed":
    case "unconfirmed":
      return t(`records.scanStatus.${scan.status}`);
    default: {
      const time = root.lastScannedAt ? formatDateTime(root.lastScannedAt, locale) : "";
      return time ? t("records.scanStatus.lastScanned", { time }) : t("records.scanStatus.neverScanned");
    }
  }
}

/** Single-row header: breadcrumb on the left, Continue watching and Scan on the right. */
export function RecordsToolbar({
  trail,
  root,
  continueAssets,
  phone,
  refreshing,
  canScan,
  scan,
  onOpenCrumb,
  onOpenContinue,
  onRefresh,
  onScan,
}: {
  trail: readonly RecordCrumb[];
  root: RecordRoot;
  continueAssets: readonly RecordAsset[];
  phone: boolean;
  refreshing: boolean;
  canScan: boolean;
  scan: RecordScanState;
  onOpenCrumb: (index: number) => void;
  onOpenContinue: (video: RecordAsset) => void;
  onRefresh: () => void;
  onScan: () => void;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const scanBusy = scan.status === "queueing" || scan.status === "queued" || scan.status === "running";
  const statusText = scanStatusText(t, scan, root, resolvedLocale);
  const showInlineStatus = scan.status !== "idle";

  return (
    <div className="flex items-center gap-2">
      <RecordBreadcrumb trail={trail} onOpenCrumb={onOpenCrumb} />
      <div className="flex shrink-0 items-center gap-2">
        {showInlineStatus && (
          <p
            role="status"
            className={`sr-only text-xs sm:not-sr-only ${
              scan.status === "failed" ? "text-error-foreground" : "text-muted-foreground"
            }`}
          >
            {statusText}
          </p>
        )}
        <RecordContinuePicker assets={continueAssets} phone={phone} onOpen={onOpenContinue} />
        {canScan ? (
          <Button
            variant="toolbar"
            size="sm"
            className="h-[var(--control-icon-size)] w-[var(--control-icon-size)] px-0 sm:w-auto sm:px-3"
            aria-label={t("records.scan")}
            title={statusText}
            disabled={scanBusy}
            onClick={onScan}
          >
            {scanBusy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <ScanLine className="h-4 w-4" aria-hidden="true" />
            )}
            <span className="hidden sm:inline">{t("records.scan")}</span>
          </Button>
        ) : (
          <Button
            variant="toolbar"
            size="icon"
            aria-label={t("records.refresh")}
            title={t("records.refresh")}
            disabled={refreshing}
            onClick={onRefresh}
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  );
}
