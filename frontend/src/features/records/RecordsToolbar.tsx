import { ChevronRight, Clapperboard, Loader2, RefreshCw, ScanLine } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { FloatingSelect } from "@/components/ui/floating-select";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { formatDateTime } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import type { RecordRoot } from "@/lib/api";

import type { RecordScanState } from "./useRecordScan";
import {
  recordKindFilters,
  recordSortOrders,
  type RecordCrumb,
  type RecordKindFilter,
  type RecordSortOrder,
} from "./recordsLocation";

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
    <nav aria-label={t("records.breadcrumb")} className="app-scrollbar min-w-0 overflow-x-auto overflow-y-hidden">
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
  t: (key: string, options?: Record<string, unknown>) => string,
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

/** Filter, order, Refresh, and Scan with its inline state. */
export function RecordsToolbar({
  root,
  filter,
  sort,
  refreshing,
  canScan,
  scan,
  onFilter,
  onSort,
  onRefresh,
  onScan,
}: {
  root: RecordRoot;
  filter: RecordKindFilter;
  sort: RecordSortOrder;
  refreshing: boolean;
  canScan: boolean;
  scan: RecordScanState;
  onFilter: (filter: RecordKindFilter) => void;
  onSort: (sort: RecordSortOrder) => void;
  onRefresh: () => void;
  onScan: () => void;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const scanBusy = scan.status === "queueing" || scan.status === "queued" || scan.status === "running";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div role="group" aria-label={t("records.filter")} className={segmentedListClassName()}>
        {recordKindFilters.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            className={segmentedItemClassName(filter === value, "touch-target")}
            onClick={() => onFilter(value)}
          >
            {t(`records.filters.${value}`)}
          </button>
        ))}
      </div>
      <FloatingSelect
        value={sort}
        ariaLabel={t("records.sort")}
        options={recordSortOrders.map((value) => ({ value, label: t(`records.sorts.${value}`) }))}
        onValueChange={(value) => onSort(value as RecordSortOrder)}
        className="w-auto"
      />
      <div className="ml-auto flex min-w-0 items-center gap-2">
        <p
          role="status"
          className={`min-w-0 text-xs ${scan.status === "failed" ? "text-error-foreground" : "text-muted-foreground"}`}
        >
          {scanBusy && <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin align-[-2px]" aria-hidden="true" />}
          {scanStatusText(t, scan, root, resolvedLocale)}
        </p>
        <Button
          variant="toolbar"
          size="icon"
          aria-label={t("records.refresh")}
          title={t("records.refresh")}
          disabled={refreshing}
          onClick={onRefresh}
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
        </Button>
        {canScan && (
          <Button variant="outline" size="sm" disabled={scanBusy} onClick={onScan}>
            <ScanLine className="h-4 w-4" />
            {t("records.scan")}
          </Button>
        )}
      </div>
    </div>
  );
}
