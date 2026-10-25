import { CalendarPlus, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FloatingSelect } from "@/components/ui/floating-select";
import { Switch } from "@/components/ui/switch";
import { toastFromError, useToast } from "@/components/ui/toast";
import { useLocale } from "@/i18n/LocaleProvider";
import { api, type LibrarySource, type RankingListPatch, type RankingOverview } from "@/lib/api";

import {
  formatRankingTime,
  RANKING_DAILY_RETENTION_DAYS,
  RANKING_DEPTHS,
  RANKING_FULL_RETENTION_DAYS,
  rankingIntervalOptions,
  rankingSettingRows,
  type RankingSettingRow,
} from "./rankingModel";
import type { RankingOverviewState } from "./useRankingOverview";

type Translate = (key: string, options?: Record<string, unknown>) => string;

function intervalLabel(minutes: number, t: Translate) {
  if (minutes % (24 * 60) === 0) return t("subscriptions.schedule.days", { count: minutes / (24 * 60) });
  if (minutes % 60 === 0) return t("subscriptions.schedule.hours", { count: minutes / 60 });
  return t("subscriptions.rankings.settings.minutes", { count: minutes });
}

function depthOptions(current: number, t: Translate) {
  const values: number[] = [...RANKING_DEPTHS];
  if (!values.includes(current)) values.push(current);
  return values
    .sort((left, right) => left - right)
    .map((value) => ({
      value: String(value),
      label: t("subscriptions.rankings.settings.depthValue", { count: value }),
    }));
}

function retentionLabel(days: number, t: Translate) {
  if (days === 0) return t("subscriptions.rankings.settings.retention.forever");
  if (days % 365 === 0) return t("subscriptions.rankings.settings.retention.years", { count: days / 365 });
  return t("subscriptions.rankings.settings.retention.days", { count: days });
}

/**
 * The shared rankings, in the fixed order of the chips: a row for each DLsite
 * ranking, the annual ranking of each year, and each compatible remote
 * source's popular list, with how often each is pulled and how long history is
 * kept. A row's list is created when it is first shown; one pull of a DLsite
 * row pulls each of its orders.
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

  useEffect(() => {
    const controller = new AbortController();
    api
      .listLibrarySources(controller.signal)
      .then(setSources)
      .catch(() => setSources([]));
    return () => controller.abort();
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
  const remove = (row: RankingSettingRow) =>
    run(row.key, async () => {
      if (!row.list) return;
      await api.deleteRanking(row.list.id);
      await reload();
    });
  const rowProps = { editable, busyKey, timeZone: overview.timeZone, onShow: show, onChange: change, onRemove: remove };

  return (
    <div className="grid gap-6">
      <RankingPullsPanel overview={overview} editable={editable} onOpenRun={onOpenRun} />
      {!editable && !overview.demo && (
        <p className="text-xs text-muted-foreground">{t("subscriptions.rankings.settings.readOnly")}</p>
      )}
      <RankingRowSection
        title={t("subscriptions.rankings.settings.dlsiteTitle")}
        description={t("subscriptions.rankings.settings.dlsiteDescription")}
      >
        {rows.dlsite.map((row) => (
          <RankingSettingRowView key={row.key} row={row} {...rowProps} />
        ))}
        <li aria-label={t("subscriptions.rankings.settings.annualTitle")}>
          <div className="space-y-0.5 px-3 pt-2.5">
            <p className="text-sm font-medium">{t("subscriptions.rankings.settings.annualTitle")}</p>
            <p className="text-xs text-muted-foreground">{t("subscriptions.rankings.settings.annualDescription")}</p>
          </div>
          <ul className="divide-y pl-3">
            <RankingSettingRowView
              row={{
                ...rows.currentYear,
                label: t("subscriptions.rankings.settings.currentYear", { year: overview.currentYear }),
              }}
              {...rowProps}
              followYear
            />
            {rows.pastYears.map((row) => (
              <RankingSettingRowView key={row.key} row={row} {...rowProps} />
            ))}
            <li className="px-3 py-2.5">
              <AddYearsPicker
                years={rows.addableYears}
                disabled={!editable || busyKey !== null}
                onAdd={(years) =>
                  run("years", async () => {
                    for (const year of years) await api.createRanking({ provider: "dlsite", period: "year", year });
                    toast.success(t("subscriptions.rankings.settings.added"));
                    await reload();
                  })
                }
              />
            </li>
          </ul>
        </li>
        <RankingSettingRowView row={rows.total} {...rowProps} />
      </RankingRowSection>
      <RankingRowSection title={t("subscriptions.rankings.settings.remoteTitle")}>
        {rows.remote.length === 0 ? (
          <li className="px-3 py-2.5 text-sm text-muted-foreground">
            {t("subscriptions.rankings.settings.remoteEmpty")}
          </li>
        ) : (
          rows.remote.map((row) => <RankingSettingRowView key={row.key} row={row} {...rowProps} />)
        )}
      </RankingRowSection>
      <RankingRetentionPanel overview={overview} editable={editable} onSaved={() => void reload()} />
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
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2" aria-label={title}>
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <ul className="divide-y rounded-lg border bg-card">{children}</ul>
    </section>
  );
}

function RankingSettingRowView({
  row,
  editable,
  busyKey,
  timeZone,
  followYear = false,
  onShow,
  onChange,
  onRemove,
}: {
  row: RankingSettingRow;
  editable: boolean;
  busyKey: string | null;
  /** The account's zone for pull times. */
  timeZone: string;
  /** The annual ranking of the year in progress offers to continue with the next year. */
  followYear?: boolean;
  onShow: (row: RankingSettingRow, enabled: boolean) => void;
  onChange: (row: RankingSettingRow, patch: RankingListPatch) => void;
  onRemove: (row: RankingSettingRow) => void;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const list = row.list;
  const busy = busyKey === row.key;
  const finished = Boolean(list?.finalAt);
  const pastYear = row.request.period === "year" && !followYear;
  const scheduled = !finished && !pastYear;
  const name = row.label;
  const interval = list?.refreshIntervalMinutes ?? 0;
  const time = (value: string | null | undefined) => formatRankingTime(value, resolvedLocale, timeZone);
  const details: string[] = [];
  if (list?.lastPulledAt)
    details.push(t("subscriptions.rankings.settings.lastPulled", { time: time(list.lastPulledAt) }));
  else if (list) details.push(t("subscriptions.rankings.settings.neverPulled"));
  if (list?.finalAt) details.push(t("subscriptions.rankings.settings.final", { time: time(list.finalAt) }));
  else if (list?.enabled && list.pullRequested) details.push(t("subscriptions.rankings.settings.pullQueued"));
  else if (list?.enabled && list.nextPullAt)
    details.push(t("subscriptions.rankings.settings.nextPull", { time: time(list.nextPullAt) }));
  if (list && !list.sourceAvailable) details.push(t("subscriptions.rankings.settings.status.source_unavailable"));
  else if (list?.lastStatus === "failed" || list?.lastStatus === "partial")
    details.push(t(`subscriptions.rankings.settings.status.${list.lastStatus}`));
  if (!list) details.push(t("subscriptions.rankings.settings.notShown"));
  if (pastYear && !finished) details.push(t("subscriptions.rankings.settings.pastYearHint"));

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
      <div className="min-w-[10rem] flex-1">
        <p className="truncate text-sm font-medium">{name}</p>
        <p className="text-xs text-muted-foreground">{details.join(" · ")}</p>
      </div>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
        {/* A ranking that was never shown has no list to configure yet; it starts with the defaults. */}
        {list && scheduled && (
          <>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Switch
                checked={list.autoRefresh}
                disabled={!editable || busy}
                aria-label={t("subscriptions.rankings.settings.autoRefresh", { name })}
                onCheckedChange={(autoRefresh) => onChange(row, { autoRefresh })}
              />
              {t("subscriptions.rankings.settings.auto")}
            </label>
            <FloatingSelect
              value={String(interval)}
              options={rankingIntervalOptions(row.kind, interval).map((value) => ({
                value: String(value),
                label: intervalLabel(value, t),
              }))}
              ariaLabel={t("subscriptions.rankings.settings.interval", { name })}
              disabled={!editable || !list.autoRefresh || busy}
              onValueChange={(value) => onChange(row, { refreshIntervalMinutes: Number(value) })}
              className="w-28"
            />
          </>
        )}
        {list && (
          <FloatingSelect
            value={String(list.depth)}
            options={depthOptions(list.depth, t)}
            ariaLabel={`${t("subscriptions.rankings.settings.depth")} · ${name}`}
            disabled={!editable || busy}
            onValueChange={(value) => onChange(row, { depth: Number(value) })}
            className="w-28"
          />
        )}
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Switch
            checked={list?.enabled ?? false}
            disabled={!editable || busy}
            aria-label={t("subscriptions.rankings.settings.show", { name })}
            onCheckedChange={(enabled) => onShow(row, enabled)}
          />
          {t("subscriptions.rankings.settings.shown")}
        </label>
        {list && (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("subscriptions.rankings.settings.remove", { name })}
            title={t("subscriptions.rankings.settings.remove", { name })}
            disabled={!editable || busy}
            onClick={() => onRemove(row)}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          </Button>
        )}
      </div>
      {followYear && list && !finished && (
        <label className="flex w-full items-start gap-2 text-xs text-muted-foreground">
          <Switch
            checked={list.followCurrentYear}
            disabled={!editable || busy}
            aria-label={t("subscriptions.rankings.settings.followYear")}
            onCheckedChange={(followCurrentYear) => onChange(row, { followCurrentYear })}
          />
          <span>
            <span className="font-medium text-foreground">{t("subscriptions.rankings.settings.followYear")}</span>
            {" · "}
            {t("subscriptions.rankings.settings.followYearHint")}
          </span>
        </label>
      )}
    </li>
  );
}

function AddYearsPicker({
  years,
  disabled,
  onAdd,
}: {
  years: number[];
  disabled: boolean;
  onAdd: (years: number[]) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const toggle = (year: number, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(year);
      else next.delete(year);
      return next;
    });
  return (
    <div ref={anchorRef} className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs text-muted-foreground">
        {years.length > 0
          ? t("subscriptions.rankings.settings.addYearsHint")
          : t("subscriptions.rankings.settings.addYearsEmpty")}
      </p>
      <Button
        size="sm"
        variant="outline"
        aria-expanded={open}
        disabled={disabled || years.length === 0}
        onClick={() => setOpen((current) => !current)}
      >
        <CalendarPlus className="h-4 w-4" />
        {t("subscriptions.rankings.settings.addYears")}
      </Button>
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        align="end"
        onOpenChange={setOpen}
        ariaLabel={t("subscriptions.rankings.settings.addYears")}
        className="w-[min(14rem,calc(100vw-1.5rem))] p-2 text-sm"
      >
        <div className="app-scroll max-h-64 overflow-y-auto">
          {years.map((year) => (
            <label key={year} className="flex min-h-9 items-center gap-2 rounded-md px-2 hover:bg-muted">
              <Checkbox checked={selected.has(year)} onCheckedChange={(checked) => toggle(year, checked === true)} />
              {year}
            </label>
          ))}
        </div>
        <div className="flex justify-end pt-2">
          <Button
            size="sm"
            disabled={selected.size === 0}
            onClick={() => {
              onAdd([...selected].sort((left, right) => right - left));
              setSelected(new Set());
              setOpen(false);
            }}
          >
            {t("subscriptions.rankings.settings.addSelectedYears", { count: selected.size })}
          </Button>
        </div>
      </AnchoredPopover>
    </div>
  );
}

/** Refresh every shown ranking now, and open each pulling workflow's latest run. */
function RankingPullsPanel({
  overview,
  editable,
  onOpenRun,
}: {
  overview: RankingOverview;
  editable: boolean;
  onOpenRun: (runId: number) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const canRun = editable && overview.lists.some((list) => list.enabled);
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
  return (
    <section className="grid gap-3 rounded-lg border bg-card p-4" aria-labelledby="ranking-pulls">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 id="ranking-pulls" className="text-sm font-semibold">
            {t("subscriptions.rankings.settings.title")}
          </h2>
          <p className="text-xs text-muted-foreground">{t("subscriptions.rankings.settings.description")}</p>
        </div>
        {editable && (
          <Button size="sm" variant="outline" disabled={!canRun || running} onClick={() => void runNow()}>
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {t("subscriptions.rankings.settings.refreshAll")}
          </Button>
        )}
      </div>
      {editable && runs.length > 0 && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
          {runs.map((workflow) => (
            <button
              key={workflow.code}
              type="button"
              className="underline-offset-2 hover:underline"
              onClick={() => workflow.latestRun && onOpenRun(workflow.latestRun.id)}
            >
              {t(`subscriptions.rankings.settings.latestRun.${workflow.code}`)}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

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
  return (
    <section className="grid gap-3 rounded-lg border bg-card p-4" aria-labelledby="ranking-retention">
      <div className="space-y-1">
        <h2 id="ranking-retention" className="text-sm font-semibold">
          {t("subscriptions.rankings.settings.retention.title")}
        </h2>
        <p className="text-xs text-muted-foreground">{t("subscriptions.rankings.settings.retention.description")}</p>
      </div>
      <div className="flex items-center justify-between gap-3 text-sm">
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
              dailyDays: retention.dailyDays !== 0 && retention.dailyDays < fullDays ? fullDays : retention.dailyDays,
            });
          }}
          className="w-32"
        />
      </div>
      <div className="flex items-center justify-between gap-3 text-sm">
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
    </section>
  );
}
