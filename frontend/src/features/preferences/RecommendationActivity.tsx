import { ArrowDown, ArrowUp, Eye, FolderOpen, PlayCircle, Shuffle } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { SettingsDisclosure } from "@/components/settings/SettingsSection";
import { formatNumber } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import { api, type RecommendationTelemetrySummary } from "@/lib/api";

const scoreBuckets = ["0-19", "20-39", "40-59", "60-79", "80-100"];

/**
 * The signed-in user's own recommendation signals. It is diagnostic context
 * for tuning, so it stays collapsed and loads only when opened.
 */
export function RecommendationActivity({ userId }: { userId: number }) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const [open, setOpen] = useState(false);
  const [telemetry, setTelemetry] = useState<RecommendationTelemetrySummary | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setTelemetry(null);
    setFailed(false);
  }, [userId]);

  useEffect(() => {
    if (!open || telemetry) return;
    let active = true;
    api
      .getRecommendationTelemetry()
      .then((value) => {
        if (active) setTelemetry(value);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [open, telemetry, userId]);

  const count = (key: string) => formatNumber(telemetry?.eventCounts[key] ?? 0, resolvedLocale);
  const impressions = telemetry?.eventCounts.impression ?? 0;

  return (
    <div className="theme-card-surface overflow-hidden rounded-xl border bg-card">
      <SettingsDisclosure
        title={t("recommendationActivity.title")}
        description={t("recommendationActivity.description", { count: telemetry?.windowDays ?? 30 })}
        open={open}
        onToggle={setOpen}
      >
        {failed ? (
          <p className="px-4 py-4 text-sm text-muted-foreground">{t("maintenance.status.unavailable")}</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-x-4 gap-y-4 px-4 py-4 sm:grid-cols-3">
              <ActivityMetric
                icon={<Eye />}
                label={t("maintenance.recommendation.impressions")}
                value={count("impression")}
              />
              <ActivityMetric
                icon={<FolderOpen />}
                label={t("maintenance.recommendation.opened")}
                value={count("open")}
              />
              <ActivityMetric
                icon={<PlayCircle />}
                label={t("maintenance.recommendation.played")}
                value={count("play")}
              />
              <ActivityMetric
                icon={<ArrowUp />}
                label={t("maintenance.recommendation.positiveMarks")}
                value={count("positive_mark")}
              />
              <ActivityMetric
                icon={<ArrowDown />}
                label={t("maintenance.recommendation.shelvedMarks")}
                value={count("paused_mark")}
              />
              <ActivityMetric
                icon={<Shuffle />}
                label={t("maintenance.recommendation.reshuffles")}
                value={count("reshuffle")}
              />
            </div>
            <div className="space-y-2 px-4 py-4">
              <div className="text-xs font-medium text-muted-foreground">
                {t("maintenance.recommendation.impressionScores")}
              </div>
              {scoreBuckets.map((bucket) => {
                const bucketCount = telemetry?.scoreBuckets[bucket] ?? 0;
                const width = impressions > 0 ? Math.max(2, Math.round((bucketCount / impressions) * 100)) : 0;
                return (
                  <div key={bucket} className="grid grid-cols-[52px_minmax(0,1fr)_44px] items-center gap-3 text-xs">
                    <span className="tabular-nums text-muted-foreground">{bucket}</span>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${width}%` }} />
                    </div>
                    <span className="text-right tabular-nums">{formatNumber(bucketCount, resolvedLocale)}</span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </SettingsDisclosure>
    </div>
  );
}

function ActivityMetric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground [&>svg]:h-4 [&>svg]:w-4">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="truncate text-xs text-muted-foreground">{label}</div>
        <div className="text-base font-semibold tabular-nums">{value}</div>
      </div>
    </div>
  );
}
