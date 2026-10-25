import { ChevronDown, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { FloatingSelect } from "@/components/ui/floating-select";
import { toastFromError, useToast } from "@/components/ui/toast";
import { useLocale } from "@/i18n/LocaleProvider";
import { api, type LibrarySource, type RankingListPatch, type RankingOverview } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import { EarlierYearsRow, RankingDeleteDialog, RankingSettingRowView } from "./RankingSettingRow";
import {
  formatRankingRelative,
  latestRankingPull,
  RANKING_DAILY_RETENTION_DAYS,
  RANKING_FULL_RETENTION_DAYS,
  rankingSettingRows,
  type RankingSettingRow,
} from "./rankingModel";
import type { RankingOverviewState } from "./useRankingOverview";

type Translate = (key: string, options?: Record<string, unknown>) => string;

function retentionLabel(days: number, t: Translate) {
  if (days === 0) return t("subscriptions.rankings.settings.retention.forever");
  if (days % 365 === 0) return t("subscriptions.rankings.settings.retention.years", { count: days / 365 });
  return t("subscriptions.rankings.settings.retention.days", { count: days });
}

/**
 * The shared rankings, in the fixed order of the chips: a row for each DLsite
 * ranking, the annual ranking of the year in progress with the earlier years
 * on one line, and each compatible remote source's popular list, then how
 * long history is kept. A row's list is created when it is first shown; one
 * pull of a DLsite row pulls each of its orders.
 */
export function RankingSettings({
  rankings,
  readOnly,
  canManage,
  onOpenRun,
}: {
  rankings: RankingOverviewState;
  readOnly: boolean;
  /** `metadata:sync`: rankings, their schedules, and the history setting may be changed. */
  canManage: boolean;
  onOpenRun: (runId: number) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { overview, error, reload, updateList } = rankings;
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<RankingSettingRow | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const controller = new AbortController();
    api
      .listLibrarySources(controller.signal)
      .then(setSources)
      .catch(() => setSources([]));
    return () => controller.abort();
  }, []);

  // Pull times read relative to now, so they follow the clock.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  if (!overview) {
    return error ? (
      <div className="space-y-3 rounded-lg border border-error-border bg-error-surface p-4 text-sm" role="alert">
        <p className="text-error-foreground">{t("subscriptions.rankings.loadFailed")}</p>
        <Button size="sm" variant="outline" onClick={() => void reload()}>
          {t("common.retry")}
        </Button>
      </div>
    ) : (
      <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("subscriptions.rankings.loading")}
      </div>
    );
  }

  const editable = canManage && !readOnly && !overview.demo;
  const rows = rankingSettingRows(overview.lists, sources, overview.currentYear, t);
  const run = async (key: string, action: () => Promise<void>) => {
    setBusyKey(key);
    try {
      await action();
    } catch (actionError) {
      toast.notify(toastFromError(actionError, t("subscriptions.rankings.settings.updateFailed")));
    } finally {
      setBusyKey(null);
    }
  };
  const show = (row: RankingSettingRow, enabled: boolean) =>
    run(row.key, async () => {
      if (!enabled && expandedKey === row.key) setExpandedKey(null);
      if (row.list) {
        updateList(await api.updateRanking(row.list.id, { enabled }));
        return;
      }
      await api.createRanking(row.request);
      toast.success(t("subscriptions.rankings.settings.added"));
      await reload();
    });
  const change = (row: RankingSettingRow, patch: RankingListPatch) =>
    run(row.key, async () => {
      if (row.list) updateList(await api.updateRanking(row.list.id, patch));
    });
  const pullNow = (row: RankingSettingRow) =>
    run(row.key, async () => {
      if (!row.list) return;
      await api.runRankingRefresh([row.list.id]);
      toast.success(t("subscriptions.rankings.refreshQueued"));
      await reload();
    });
  const confirmDelete = (row: RankingSettingRow) =>
    run(row.key, async () => {
      if (!row.list) return;
      await api.deleteRanking(row.list.id);
      setDeleting(null);
      setExpandedKey(null);
      toast.success(t("subscriptions.rankings.settings.deleted"));
      await reload();
    });
  const rowView = (row: RankingSettingRow, followYear = false) => (
    <RankingSettingRowView
      key={row.key}
      row={row}
      editable={editable}
      busy={busyKey === row.key}
      expanded={expandedKey === row.key}
      timeZone={overview.timeZone}
      now={now}
      followYear={followYear}
      onExpandedChange={(expanded) => setExpandedKey(expanded ? row.key : null)}
      onShow={show}
      onChange={change}
      onPullNow={pullNow}
      onDelete={setDeleting}
    />
  );

  return (
    <div className="grid grid-cols-1 gap-5">
      <RankingPullsHeader overview={overview} editable={editable} now={now} onOpenRun={onOpenRun} />
      {!editable && !overview.demo && (
        <p className="text-xs text-muted-foreground">{t("subscriptions.rankings.settings.readOnly")}</p>
      )}
      <RankingRowSection
        title={t("subscriptions.rankings.settings.dlsiteTitle")}
        description={t("subscriptions.rankings.settings.dlsiteDescription")}
      >
        {rows.dlsite.map((row) => rowView(row))}
        {rowView(
          {
            ...rows.currentYear,
            label: t("subscriptions.rankings.settings.annualYear", { year: overview.currentYear }),
          },
          true,
        )}
        <EarlierYearsRow
          rows={rows.pastYears}
          addableYears={rows.addableYears}
          addDisabled={!editable || busyKey !== null}
          onAddYears={(years) =>
            void run("years", async () => {
              for (const year of years) await api.createRanking({ provider: "dlsite", period: "year", year });
              toast.success(t("subscriptions.rankings.settings.added"));
              await reload();
            })
          }
          renderRow={(row) => rowView(row)}
        />
        {rowView(rows.total)}
      </RankingRowSection>
      <RankingRowSection title={t("subscriptions.rankings.settings.remoteTitle")}>
        {rows.remote.length === 0 ? (
          <li className="px-3 py-2.5 text-sm text-muted-foreground">
            {t("subscriptions.rankings.settings.remoteEmpty")}
          </li>
        ) : (
          rows.remote.map((row) => rowView(row))
        )}
      </RankingRowSection>
      <RankingRetentionPanel overview={overview} editable={editable} onSaved={() => void reload()} />
      {deleting && (
        <RankingDeleteDialog
          name={deleting.label}
          busy={busyKey === deleting.key}
          onCancel={() => setDeleting(null)}
          onConfirm={() => void confirmDelete(deleting)}
        />
      )}
    </div>
  );
}

function RankingRowSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2" aria-label={title}>
      <div className="space-y-0.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <ul className="divide-y rounded-lg border bg-card">{children}</ul>
    </section>
  );
}

/** Who shares the rankings and when they were last pulled, refresh every shown ranking, and the latest runs. */
function RankingPullsHeader({
  overview,
  editable,
  now,
  onOpenRun,
}: {
  overview: RankingOverview;
  editable: boolean;
  now: number;
  onOpenRun: (runId: number) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { resolvedLocale } = useLocale();
  const [running, setRunning] = useState(false);
  const canRun = editable && overview.lists.some((list) => list.enabled);
  const latest = latestRankingPull(overview.lists);
  const runNow = async () => {
    setRunning(true);
    try {
      await api.runRankingRefresh();
      toast.success(t("subscriptions.rankings.refreshQueued"));
    } catch (runError) {
      toast.notify(toastFromError(runError, t("subscriptions.rankings.refreshFailed")));
    } finally {
      setRunning(false);
    }
  };
  const runs = overview.workflows.filter((workflow) => workflow.latestRun);
  const summary = [t("subscriptions.rankings.settings.shared")];
  if (latest) {
    summary.push(
      t("subscriptions.rankings.settings.lastPull", {
        time: formatRankingRelative(latest, resolvedLocale, overview.timeZone, now),
      }),
    );
  }
  return (
    <section className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2" aria-labelledby="ranking-pulls">
      <div className="min-w-0 space-y-0.5">
        <h2 id="ranking-pulls" className="sr-only">
          {t("subscriptions.rankings.settings.title")}
        </h2>
        <p className="text-xs text-muted-foreground">{summary.join(" · ")}</p>
        {editable && runs.length > 0 && (
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
            {runs.map((workflow) => (
              <button
                key={workflow.code}
                type="button"
                className="rounded-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => workflow.latestRun && onOpenRun(workflow.latestRun.id)}
              >
                {t(`subscriptions.rankings.settings.latestRun.${workflow.code}`)}
              </button>
            ))}
          </div>
        )}
      </div>
      {editable && (
        <Button size="sm" variant="outline" disabled={!canRun || running} onClick={() => void runNow()}>
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {t("subscriptions.rankings.settings.refreshAll")}
        </Button>
      )}
    </section>
  );
}

/** How long history is kept, as one line that expands to its two choices. */
function RankingRetentionPanel({
  overview,
  editable,
  onSaved,
}: {
  overview: RankingOverview;
  editable: boolean;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const retention = overview.retention;
  const save = async (next: typeof retention) => {
    setSaving(true);
    try {
      await api.updateRankingRetention(next);
      onSaved();
    } catch (saveError) {
      toast.notify(toastFromError(saveError, t("subscriptions.rankings.settings.retention.saveFailed")));
    } finally {
      setSaving(false);
    }
  };
  const fullOptions = [...new Set([...RANKING_FULL_RETENTION_DAYS, retention.fullDays])].sort((a, b) => a - b);
  const dailyOptions = [...new Set([...RANKING_DAILY_RETENTION_DAYS, retention.dailyDays])]
    .filter((days) => days === 0 || days >= retention.fullDays)
    .sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b));
  const full = retentionLabel(retention.fullDays, t);
  const summary =
    retention.dailyDays === 0
      ? t("subscriptions.rankings.settings.retention.summaryForever", { full })
      : t("subscriptions.rankings.settings.retention.summary", {
          full,
          daily: retentionLabel(retention.dailyDays, t),
        });
  return (
    <section className="space-y-2" aria-labelledby="ranking-retention">
      <h2 id="ranking-retention" className="text-sm font-semibold">
        {t("subscriptions.rankings.settings.retention.title")}
      </h2>
      <div className="rounded-lg border bg-card">
        <button
          type="button"
          aria-expanded={open}
          className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setOpen((current) => !current)}
        >
          <span className="min-w-0">{summary}</span>
          <ChevronDown
            className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
            aria-hidden="true"
          />
        </button>
        {open && (
          <div className="grid gap-2.5 border-t px-3 py-3 text-sm">
            <p className="text-xs text-muted-foreground">
              {t("subscriptions.rankings.settings.retention.description")}
            </p>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{t("subscriptions.rankings.settings.retention.full")}</span>
              <FloatingSelect
                value={String(retention.fullDays)}
                options={fullOptions.map((days) => ({ value: String(days), label: retentionLabel(days, t) }))}
                ariaLabel={t("subscriptions.rankings.settings.retention.full")}
                disabled={!editable || saving}
                onValueChange={(value) => {
                  const fullDays = Number(value);
                  void save({
                    fullDays,
                    dailyDays:
                      retention.dailyDays !== 0 && retention.dailyDays < fullDays ? fullDays : retention.dailyDays,
                  });
                }}
                className="w-32"
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{t("subscriptions.rankings.settings.retention.daily")}</span>
              <FloatingSelect
                value={String(retention.dailyDays)}
                options={dailyOptions.map((days) => ({ value: String(days), label: retentionLabel(days, t) }))}
                ariaLabel={t("subscriptions.rankings.settings.retention.daily")}
                disabled={!editable || saving}
                onValueChange={(value) => void save({ fullDays: retention.fullDays, dailyDays: Number(value) })}
                className="w-32"
              />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
