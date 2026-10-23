import { ArrowDown, ArrowUp, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FloatingSelect } from "@/components/ui/floating-select";
import { Switch } from "@/components/ui/switch";
import { toastFromError, useToast } from "@/components/ui/toast";
import { formatDateTime } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import { api, type LibrarySource, type RankingList, type RankingPeriod, type RankingSchedule } from "@/lib/api";
import { parseServerTimestamp } from "@/lib/serverTimestamp";

import { isRankingSource, RANKING_DEPTHS, RANKING_INTERVAL_HOURS, rankingListLabel } from "./rankingModel";
import type { RankingOverviewState } from "./useRankingOverview";

const periods: RankingPeriod[] = ["day", "week", "month"];

/** The shared tracked rankings and their refresh schedule. */
export function RankingSettings({
  rankings,
  readOnly,
  canManage,
  onOpenRun,
}: {
  rankings: RankingOverviewState;
  readOnly: boolean;
  /** `metadata:sync`: rankings and their schedule may be changed. */
  canManage: boolean;
  onOpenRun: (runId: number) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { resolvedLocale } = useLocale();
  const { overview, error, reload, setOverview, updateList } = rankings;
  const [busyId, setBusyId] = useState<number | null>(null);

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
  const lists = overview.lists;
  const change = async (list: RankingList, patch: Partial<Pick<RankingList, "enabled" | "depth" | "position">>) => {
    setBusyId(list.id);
    try {
      if (patch.position !== undefined) {
        await api.updateRanking(list.id, patch);
        await reload();
      } else {
        updateList(await api.updateRanking(list.id, patch));
      }
    } catch (updateError) {
      toast.notify(toastFromError(updateError, t("subscriptions.rankings.settings.updateFailed")));
    } finally {
      setBusyId(null);
    }
  };
  const remove = async (list: RankingList) => {
    setBusyId(list.id);
    try {
      await api.deleteRanking(list.id);
      setOverview((current) =>
        current ? { ...current, lists: current.lists.filter((item) => item.id !== list.id) } : current,
      );
    } catch (removeError) {
      toast.notify(toastFromError(removeError, t("subscriptions.rankings.settings.updateFailed")));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="grid gap-6">
      <RankingSchedulePanel
        schedule={overview.schedule}
        editable={editable}
        canRun={editable && lists.some((list) => list.enabled)}
        onSaved={(schedule) => setOverview((current) => (current ? { ...current, schedule } : current))}
        onOpenRun={onOpenRun}
      />
      <section className="space-y-2" aria-labelledby="ranking-lists-heading">
        <div className="space-y-1">
          <h2 id="ranking-lists-heading" className="text-sm font-semibold">
            {t("subscriptions.rankings.settings.title")}
          </h2>
          <p className="text-xs text-muted-foreground">{t("subscriptions.rankings.settings.description")}</p>
        </div>
        {lists.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">{t("subscriptions.rankings.settings.empty")}</p>
        ) : (
          <ul className="divide-y rounded-lg border bg-card">
            {lists.map((list, index) => {
              const name = rankingListLabel(list, t);
              const busy = busyId === list.id;
              const pulled = parseServerTimestamp(list.lastPulledAt);
              const status =
                list.lastStatus === "failed" || list.lastStatus === "source_unavailable"
                  ? t(`subscriptions.rankings.settings.status.${list.lastStatus}`)
                  : null;
              return (
                <li key={list.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
                  <div className="min-w-[12rem] flex-1">
                    <p className="truncate text-sm font-medium">{name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {pulled
                        ? t("subscriptions.rankings.settings.lastPulled", {
                            time: formatDateTime(pulled, resolvedLocale),
                          })
                        : t("subscriptions.rankings.settings.neverPulled")}
                      {status && <span className="text-warning-foreground"> · {status}</span>}
                    </p>
                  </div>
                  <div className="ml-auto flex items-center gap-1">
                    <FloatingSelect
                      value={String(list.depth)}
                      options={depthOptions(list.depth, t)}
                      ariaLabel={`${t("subscriptions.rankings.settings.depth")} · ${name}`}
                      disabled={!editable || busy}
                      onValueChange={(value) => void change(list, { depth: Number(value) })}
                      className="w-28"
                    />
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("subscriptions.rankings.settings.moveUp", { name })}
                      title={t("subscriptions.rankings.settings.moveUp", { name })}
                      disabled={!editable || busy || index === 0}
                      onClick={() => void change(list, { position: index - 1 })}
                    >
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("subscriptions.rankings.settings.moveDown", { name })}
                      title={t("subscriptions.rankings.settings.moveDown", { name })}
                      disabled={!editable || busy || index === lists.length - 1}
                      onClick={() => void change(list, { position: index + 1 })}
                    >
                      <ArrowDown className="h-4 w-4" />
                    </Button>
                    <Switch
                      checked={list.enabled}
                      disabled={!editable || busy}
                      aria-label={t("subscriptions.rankings.settings.track", { name })}
                      onCheckedChange={(enabled) => void change(list, { enabled })}
                    />
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("subscriptions.rankings.settings.remove", { name })}
                      title={t("subscriptions.rankings.settings.remove", { name })}
                      disabled={!editable || busy}
                      onClick={() => void remove(list)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">{t("subscriptions.rankings.settings.retention")}</p>
      </section>
      {editable && <AddRankingForm lists={lists} onAdded={() => void reload()} />}
    </div>
  );
}

function depthOptions(current: number, t: (key: string, options?: Record<string, unknown>) => string) {
  const values: number[] = [...RANKING_DEPTHS];
  if (!values.includes(current)) values.push(current);
  return values
    .sort((left, right) => left - right)
    .map((value) => ({
      value: String(value),
      label: t("subscriptions.rankings.settings.depthValue", { count: value }),
    }));
}

function AddRankingForm({ lists, onAdded }: { lists: RankingList[]; onAdded: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const [provider, setProvider] = useState("dlsite");
  const [period, setPeriod] = useState<RankingPeriod>("day");
  const [newReleases, setNewReleases] = useState(false);
  const [depth, setDepth] = useState(100);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api
      .listLibrarySources(controller.signal)
      .then((next) => setSources(next.filter(isRankingSource)))
      .catch(() => setSources([]));
    return () => controller.abort();
  }, []);

  const remoteSourceId = provider.startsWith("source:") ? Number(provider.slice("source:".length)) : null;
  const tracked = lists.some((list) =>
    remoteSourceId === null
      ? list.provider === "dlsite" && list.period === period && list.releaseWindow === (newReleases ? "30d" : "")
      : list.provider === "remote_source" && list.sourceId === remoteSourceId,
  );
  const providerOptions = [
    { value: "dlsite", label: t("subscriptions.rankings.dlsite") },
    ...sources.map((source) => ({
      value: `source:${source.id}`,
      label: `${source.displayName} · ${t("subscriptions.rankings.popular")}`,
    })),
  ];

  const add = async () => {
    setSaving(true);
    try {
      await api.createRanking(
        remoteSourceId === null
          ? { provider: "dlsite", period, releaseWindow: newReleases ? "30d" : "", depth }
          : { provider: "remote_source", sourceId: remoteSourceId, depth },
      );
      toast.success(t("subscriptions.rankings.settings.added"));
      onAdded();
    } catch (addError) {
      toast.notify(toastFromError(addError, t("subscriptions.rankings.settings.addFailed")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="grid gap-3 rounded-lg border bg-card p-4" aria-labelledby="ranking-add-heading">
      <h2 id="ranking-add-heading" className="text-sm font-semibold">
        {t("subscriptions.rankings.settings.addTitle")}
      </h2>
      <div className="flex items-center justify-between gap-3 text-sm">
        <span>{t("subscriptions.rankings.settings.provider")}</span>
        <FloatingSelect
          value={provider}
          options={providerOptions}
          ariaLabel={t("subscriptions.rankings.settings.provider")}
          onValueChange={setProvider}
          className="w-56"
        />
      </div>
      {remoteSourceId === null && (
        <>
          <div className="flex items-center justify-between gap-3 text-sm">
            <span>{t("subscriptions.rankings.settings.period")}</span>
            <FloatingSelect
              value={period}
              options={periods.map((value) => ({ value, label: t(`subscriptions.rankings.periods.${value}`) }))}
              ariaLabel={t("subscriptions.rankings.settings.period")}
              onValueChange={(value) => setPeriod(value as RankingPeriod)}
              className="w-56"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={newReleases} onCheckedChange={(checked) => setNewReleases(checked === true)} />
            {t("subscriptions.rankings.settings.newReleasesOnly")}
          </label>
        </>
      )}
      <div className="flex items-center justify-between gap-3 text-sm">
        <span>{t("subscriptions.rankings.settings.depth")}</span>
        <FloatingSelect
          value={String(depth)}
          options={depthOptions(depth, t)}
          ariaLabel={t("subscriptions.rankings.settings.depth")}
          onValueChange={(value) => setDepth(Number(value))}
          className="w-56"
        />
      </div>
      <div className="flex justify-end">
        <Button size="sm" disabled={saving || tracked} onClick={() => void add()}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          {t("subscriptions.rankings.settings.add")}
        </Button>
      </div>
    </section>
  );
}

function RankingSchedulePanel({
  schedule,
  editable,
  canRun,
  onSaved,
  onOpenRun,
}: {
  schedule: RankingSchedule;
  editable: boolean;
  canRun: boolean;
  onSaved: (schedule: RankingSchedule) => void;
  onOpenRun: (runId: number) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { resolvedLocale } = useLocale();
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  const save = async (patch: Partial<Pick<RankingSchedule, "enabled" | "intervalHours">>) => {
    setSaving(true);
    try {
      onSaved(await api.updateRankingSchedule(patch));
    } catch (saveError) {
      toast.notify(toastFromError(saveError, t("subscriptions.schedule.saveFailed")));
    } finally {
      setSaving(false);
    }
  };
  const runNow = async () => {
    setRunning(true);
    try {
      const run = await api.runRankingRefresh();
      onSaved({ ...schedule, latestRun: { id: run.runId, status: run.status } });
      toast.success(t("subscriptions.rankings.refreshQueued"));
    } catch (runError) {
      toast.notify(toastFromError(runError, t("subscriptions.rankings.refreshFailed")));
    } finally {
      setRunning(false);
    }
  };

  const intervalOptions = RANKING_INTERVAL_HOURS.map((hours) => ({
    value: String(hours),
    label:
      hours % 24 === 0
        ? t("subscriptions.schedule.days", { count: hours / 24 })
        : t("subscriptions.schedule.hours", { count: hours }),
  }));
  if (!intervalOptions.some((option) => option.value === String(schedule.intervalHours))) {
    intervalOptions.push({
      value: String(schedule.intervalHours),
      label: t("subscriptions.schedule.hours", { count: schedule.intervalHours }),
    });
  }
  const nextRun = parseServerTimestamp(schedule.nextRunAt);
  const lastRun = parseServerTimestamp(schedule.lastRunAt);
  const active = schedule.latestRun?.status === "running" || schedule.latestRun?.status === "queued";
  return (
    <section className="grid gap-4 rounded-lg border bg-card p-4" aria-labelledby="ranking-schedule">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 id="ranking-schedule" className="text-sm font-semibold">
            {t("subscriptions.rankings.schedule.title")}
          </h2>
          <p className="text-xs text-muted-foreground">{t("subscriptions.rankings.schedule.description")}</p>
        </div>
        {editable && (
          <Button size="sm" variant="outline" disabled={!canRun || running || active} onClick={() => void runNow()}>
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {t("subscriptions.schedule.runNow")}
          </Button>
        )}
      </div>
      <div className="grid gap-3">
        <label className="flex items-center justify-between gap-3 text-sm">
          {t("subscriptions.schedule.enabled")}
          <Switch
            checked={schedule.enabled}
            disabled={!editable || saving}
            aria-label={t("subscriptions.schedule.enabled")}
            onCheckedChange={(enabled) => void save({ enabled })}
          />
        </label>
        <div className="flex items-center justify-between gap-3 text-sm">
          <span>{t("subscriptions.schedule.interval")}</span>
          <FloatingSelect
            value={String(schedule.intervalHours)}
            options={intervalOptions}
            ariaLabel={t("subscriptions.schedule.interval")}
            disabled={!editable || saving}
            onValueChange={(value) => void save({ intervalHours: Number(value) })}
            className="w-36"
          />
        </div>
      </div>
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
        <div className="flex gap-1">
          <dt>{t("subscriptions.schedule.nextRun")}</dt>
          <dd>
            {schedule.enabled && nextRun ? formatDateTime(nextRun, resolvedLocale) : t("subscriptions.schedule.off")}
          </dd>
        </div>
        {lastRun && (
          <div className="flex gap-1">
            <dt>{t("subscriptions.schedule.lastRun")}</dt>
            <dd>{formatDateTime(lastRun, resolvedLocale)}</dd>
          </div>
        )}
        {schedule.latestRun && editable && (
          <div>
            <button
              type="button"
              className="underline-offset-2 hover:underline"
              onClick={() => schedule.latestRun && onOpenRun(schedule.latestRun.id)}
            >
              {t("subscriptions.schedule.viewRun")}
            </button>
          </div>
        )}
      </dl>
      {schedule.lastError && (
        <p className="text-xs text-warning-foreground">{t("subscriptions.schedule.lastErrorNotice")}</p>
      )}
    </section>
  );
}
