import { ChevronRight, ChevronDown, ExternalLink, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { MobileSheet } from "@/components/ui/mobile-sheet";
import { AvailabilityMeter } from "@/components/creator/AvailabilityMeter";
import type { CircleSeries } from "@/lib/api";
import { openCircleSeriesRoute } from "@/lib/circleNavigationState";

export function CircleSeriesSidebar({
  externalId,
  series,
  selectedSeriesCode,
  allCount,
}: {
  externalId: string;
  series: CircleSeries[];
  selectedSeriesCode: string | null;
  allCount: number;
}) {
  return (
    <aside className="hidden self-start rounded-lg border bg-card p-1.5 lg:sticky lg:top-4 lg:block">
      <CircleSeriesOptions
        series={series}
        selectedSeriesCode={selectedSeriesCode}
        allCount={allCount}
        onSelect={openCircleSeriesRoute.bind(null, externalId)}
      />
    </aside>
  );
}

export function MobileCircleSeriesHeader({
  externalId,
  series,
  selectedSeries,
  selectedSeriesCode,
  allCount,
  subscribe,
}: {
  externalId: string;
  series: CircleSeries[];
  selectedSeries: CircleSeries | null;
  selectedSeriesCode: string | null;
  allCount: number;
  /** The selected series' subscribe control. */
  subscribe?: ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const selectedName = selectedSeries?.name ?? t("detailActions.allSeries");
  const selectedCount = selectedSeries?.works ?? allCount;
  const selectSeries = (titleId?: string) => {
    setOpen(false);
    openCircleSeriesRoute(externalId, titleId);
  };
  return (
    <div className="flex min-h-12 items-center gap-1 rounded-lg border bg-card px-3 lg:hidden">
      <button
        className="flex min-w-0 flex-1 items-center justify-between gap-3 self-stretch text-left text-sm"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("detailActions.series")}
        onClick={() => setOpen(true)}
      >
        <span className="min-w-0 truncate font-semibold">{selectedName}</span>
        <span className="shrink-0 text-muted-foreground">{selectedCount}</span>
      </button>
      {subscribe}
      {selectedSeries?.url && (
        <Button variant="ghost" size="icon" className="shrink-0" asChild>
          <a
            href={selectedSeries.url}
            target="_blank"
            rel="noreferrer"
            aria-label={t("detailActions.openDlsite")}
            title={t("detailActions.openDlsite")}
          >
            <ExternalLink className="h-4 w-4" />
          </a>
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="shrink-0"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("detailActions.series")}
        title={t("detailActions.series")}
        onClick={() => setOpen(true)}
      >
        <ChevronDown className="h-4 w-4" />
      </Button>
      <MobileSheet open={open} onOpenChange={setOpen} ariaLabel={t("detailActions.series")} className="p-4">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold">{t("detailActions.series")}</h2>
          <Button variant="ghost" size="icon" aria-label={t("content.close")} onClick={() => setOpen(false)}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="mt-4 space-y-1">
          <CircleSeriesOptions
            series={series}
            selectedSeriesCode={selectedSeriesCode}
            allCount={allCount}
            onSelect={selectSeries}
          />
        </div>
      </MobileSheet>
    </div>
  );
}

function CircleSeriesOptions({
  series,
  selectedSeriesCode,
  allCount,
  onSelect,
}: {
  series: CircleSeries[];
  selectedSeriesCode: string | null;
  allCount: number;
  onSelect: (titleId?: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <button
        className={`flex min-h-12 w-full items-center justify-between gap-3 rounded-md px-3 text-left text-sm transition-colors hover:bg-muted ${selectedSeriesCode === null ? "bg-primary/10 text-primary hover:bg-primary/15" : ""}`}
        onClick={() => onSelect()}
      >
        <span className="min-w-0 truncate font-medium">{t("detailActions.allSeries")}</span>
        <span className={`tabular-nums ${selectedSeriesCode === null ? "text-primary/80" : "text-muted-foreground"}`}>
          {allCount}
        </span>
      </button>
      <div className="mt-2 space-y-1">
        {series.length > 0 ? (
          series.map((item) => {
            const selected = selectedSeriesCode === item.titleId;
            return (
              <button
                key={item.titleId}
                className={`grid min-h-14 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md px-3 text-left text-sm transition-colors hover:bg-muted ${selected ? "bg-primary/10 text-primary hover:bg-primary/15" : ""}`}
                onClick={() => onSelect(item.titleId)}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{item.name}</span>
                  <span
                    className={
                      selected
                        ? "block truncate font-mono text-xs text-primary/75"
                        : "block truncate font-mono text-xs text-muted-foreground"
                    }
                  >
                    {item.titleId}
                  </span>
                </span>
                <span className={`tabular-nums ${selected ? "text-primary/80" : "text-muted-foreground"}`}>
                  {item.works}
                </span>
              </button>
            );
          })
        ) : (
          <div className="px-3 py-2 text-sm text-muted-foreground">{t("detailActions.noSeries")}</div>
        )}
      </div>
    </>
  );
}

export function CircleSeriesSummaryCard({ externalId, series }: { externalId: string; series: CircleSeries }) {
  const { t } = useTranslation();
  const stats = [
    { key: "works", value: series.works, label: t("detailActions.works"), className: "text-foreground" },
    { key: "local", value: series.localWorks, label: t("detailActions.local"), className: "" },
    { key: "remote", value: series.remoteWorks, label: t("detailActions.remote"), className: "" },
    {
      key: "missing",
      value: series.missingWorks,
      label: t("detailActions.missing"),
      className: series.missingWorks > 0 ? "text-warning-foreground" : "",
    },
  ];
  return (
    <Card className="h-full transition-colors hover:border-primary/40">
      <CardContent className="flex h-full flex-col gap-3 p-4">
        <button
          className="group block w-full rounded-sm text-left"
          onClick={() => openCircleSeriesRoute(externalId, series.titleId)}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="line-clamp-2 text-[0.95rem] font-semibold leading-snug">{series.name}</h3>
              <div className="mt-1 font-mono text-xs tracking-tight text-muted-foreground">{series.titleId}</div>
            </div>
            <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
          </div>
        </button>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {stats.map((stat) => (
            <span key={stat.key} className="flex items-baseline gap-1">
              <span className={`text-sm font-semibold tabular-nums ${stat.className || "text-foreground"}`}>
                {stat.value}
              </span>
              <span className={stat.className}>{stat.label}</span>
            </span>
          ))}
        </div>
        <AvailabilityMeter
          total={series.works}
          local={series.localWorks}
          available={series.localWorks + series.remoteWorks}
          label={t("creator.availabilityBreakdown", {
            local: series.localWorks,
            remote: series.remoteWorks,
            missing: series.missingWorks,
          })}
        />
        <div className="mt-auto flex flex-wrap gap-1">
          {series.workCodes.slice(0, 8).map((code) => (
            <Badge key={code} variant="outline" className="font-mono text-2xs font-normal text-muted-foreground">
              {code}
            </Badge>
          ))}
          {series.workCodes.length > 8 && (
            <Badge variant="secondary" className="text-2xs">
              +{series.workCodes.length - 8}
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
