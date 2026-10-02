import { ArrowDown, ArrowUp, Shuffle } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { formatNumber, numberFormat } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import { api, type RecommendationTelemetrySummary } from "@/lib/api";

const scoreBuckets = ["0-19", "20-39", "40-59", "60-79", "80-100"];
const DEFAULT_WINDOW_DAYS = 30;

/**
 * The signed-in user's own recommendation signals as a report: how shown
 * recommendations turned into opens and plays, the feedback given, and the
 * affinity scores of what was shown. It is context for the tuning beside it.
 */
export function RecommendationActivity({ userId }: { userId: number }) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const headingId = useId();
  const [telemetry, setTelemetry] = useState<RecommendationTelemetrySummary | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setTelemetry(null);
    setFailed(false);
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
  }, [userId]);

  const windowDays = telemetry?.windowDays ?? DEFAULT_WINDOW_DAYS;
  const countOf = (key: string) => telemetry?.eventCounts[key] ?? 0;
  const format = (value: number) => formatNumber(value, resolvedLocale);
  const percent = numberFormat(resolvedLocale, { style: "percent", maximumFractionDigits: 0 });
  const impressions = countOf("impression");
  const shareOfImpressions = (value: number) => (impressions > 0 ? Math.min(1, value / impressions) : 0);
  const bucketMax = Math.max(0, ...scoreBuckets.map((bucket) => telemetry?.scoreBuckets[bucket] ?? 0));

  return (
    <section aria-labelledby={headingId} className="min-w-0 space-y-3">
      <div className="px-1">
        <h2 id={headingId} className="text-sm font-semibold">
          {t("recommendationActivity.title")}
        </h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {t("recommendationActivity.description", { count: windowDays })}
        </p>
      </div>
      <div className="theme-card-surface min-w-0 overflow-hidden rounded-xl border bg-card">
        {failed ? (
          <p className="px-4 py-4 text-sm text-muted-foreground">{t("maintenance.status.unavailable")}</p>
        ) : !telemetry ? (
          <div role="status" aria-label={t("common.loading")} className="h-48 animate-pulse bg-muted/40" />
        ) : telemetry.totalEvents === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            {t("recommendationActivity.empty", { count: windowDays })}
          </p>
        ) : (
          <div className="grid divide-y lg:grid-cols-2 lg:divide-x lg:divide-y-0">
            <div className="space-y-5 p-4">
              <div className="space-y-3">
                <h3 className="text-xs font-medium text-muted-foreground">{t("recommendationActivity.engagement")}</h3>
                <dl className="space-y-3">
                  <FunnelStep
                    label={t("maintenance.recommendation.impressions")}
                    value={format(impressions)}
                    share={1}
                  />
                  <FunnelStep
                    label={t("maintenance.recommendation.opened")}
                    value={format(countOf("open"))}
                    share={shareOfImpressions(countOf("open"))}
                    detail={
                      impressions > 0
                        ? t("recommendationActivity.ofImpressions", {
                            percent: percent.format(shareOfImpressions(countOf("open"))),
                          })
                        : undefined
                    }
                  />
                  <FunnelStep
                    label={t("maintenance.recommendation.played")}
                    value={format(countOf("play"))}
                    share={shareOfImpressions(countOf("play"))}
                    detail={
                      impressions > 0
                        ? t("recommendationActivity.ofImpressions", {
                            percent: percent.format(shareOfImpressions(countOf("play"))),
                          })
                        : undefined
                    }
                  />
                </dl>
              </div>
              <div className="space-y-3">
                <h3 className="text-xs font-medium text-muted-foreground">{t("recommendationActivity.feedback")}</h3>
                <dl className="grid grid-cols-3 gap-2">
                  <FeedbackTile
                    icon={<ArrowUp />}
                    label={t("maintenance.recommendation.positiveMarks")}
                    value={format(countOf("positive_mark"))}
                  />
                  <FeedbackTile
                    icon={<ArrowDown />}
                    label={t("maintenance.recommendation.shelvedMarks")}
                    value={format(countOf("paused_mark"))}
                  />
                  <FeedbackTile
                    icon={<Shuffle />}
                    label={t("maintenance.recommendation.reshuffles")}
                    value={format(countOf("reshuffle"))}
                  />
                </dl>
              </div>
            </div>
            <figure className="flex min-w-0 flex-col gap-3 p-4">
              <figcaption className="text-xs font-medium text-muted-foreground">
                {t("maintenance.recommendation.impressionScores")}
              </figcaption>
              <div className="flex min-h-40 flex-1 items-end gap-2 border-b border-border/80" aria-hidden="true">
                {scoreBuckets.map((bucket) => {
                  const bucketCount = telemetry.scoreBuckets[bucket] ?? 0;
                  const height = bucketMax > 0 && bucketCount > 0 ? Math.max(3, (bucketCount / bucketMax) * 100) : 0;
                  return (
                    <div key={bucket} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
                      <span className="text-2xs tabular-nums text-muted-foreground">{format(bucketCount)}</span>
                      <div className="w-full rounded-t bg-primary/70" style={{ height: `${height}%` }} />
                    </div>
                  );
                })}
              </div>
              <div className="flex gap-2 text-2xs tabular-nums text-muted-foreground" aria-hidden="true">
                {scoreBuckets.map((bucket) => (
                  <span key={bucket} className="min-w-0 flex-1 text-center">
                    {bucket}
                  </span>
                ))}
              </div>
              <table className="sr-only">
                <caption>{t("maintenance.recommendation.impressionScores")}</caption>
                <tbody>
                  {scoreBuckets.map((bucket) => (
                    <tr key={bucket}>
                      <th scope="row">{bucket}</th>
                      <td>{format(telemetry.scoreBuckets[bucket] ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </figure>
          </div>
        )}
      </div>
    </section>
  );
}

/** One stage of the shown → opened → played funnel, as a bar relative to impressions. */
function FunnelStep({ label, value, share, detail }: { label: string; value: string; share: number; detail?: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <dt className="truncate">{label}</dt>
        <dd className="shrink-0 tabular-nums">
          <span className="font-semibold">{value}</span>
          {detail && <span className="ml-2 text-xs text-muted-foreground">{detail}</span>}
        </dd>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div
          className="h-full rounded-full bg-primary/70"
          style={{ width: `${share > 0 ? Math.max(2, share * 100) : 0}%` }}
        />
      </div>
    </div>
  );
}

function FeedbackTile({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col justify-between rounded-lg bg-muted/50 px-3 py-2">
      <dt className="flex min-w-0 items-start gap-1.5 text-2xs text-muted-foreground [&>svg]:h-3 [&>svg]:w-3 [&>svg]:shrink-0">
        {icon}
        <span className="min-w-0 leading-tight">{label}</span>
      </dt>
      <dd className="mt-0.5 text-base font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
