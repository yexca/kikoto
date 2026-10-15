import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FloatingSelect } from "@/components/ui/floating-select";
import { Switch } from "@/components/ui/switch";
import { toastFromError, useToast } from "@/components/ui/toast";
import { formatDateTime } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import {
  api,
  type CreatorSubscription,
  type CreatorSubscriptionKind,
  type CreatorSubscriptionSchedule,
  type CreatorSubscriptionView,
} from "@/lib/api";
import { parseServerTimestamp } from "@/lib/serverTimestamp";

import { SUBSCRIPTION_INTERVAL_HOURS, subscriptionSubjectName, subscriptionSubjectPath } from "./subscriptionModel";

const kindOrder: CreatorSubscriptionKind[] = ["circle", "series", "voice"];

/** The account's subscriptions and the shared refresh schedule. */
export function SubscriptionManager({
  readOnly,
  canManageSchedule,
  onOpenPath,
  onOpenRun,
}: {
  readOnly: boolean;
  /** `metadata:sync`: the shared schedule may be changed and run now. */
  canManageSchedule: boolean;
  onOpenPath: (path: string) => void;
  onOpenRun: (runId: number) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [view, setView] = useState<CreatorSubscriptionView | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setView(await api.listCreatorSubscriptions(signal));
        setError("");
      } catch (loadError) {
        if (!signal?.aborted)
          setError(loadError instanceof Error ? loadError.message : t("subscriptions.list.loadFailed"));
      }
    },
    [t],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (!view) {
    return error ? (
      <div className="space-y-3 rounded-lg border border-error-border bg-error-surface p-4 text-sm" role="alert">
        <p className="text-error-foreground">{error}</p>
        <Button size="sm" variant="outline" onClick={() => void load()}>
          {t("common.retry")}
        </Button>
      </div>
    ) : (
      <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("subscriptions.list.loading")}
      </div>
    );
  }

  const editable = !readOnly && !view.demo;
  const update = async (subscription: CreatorSubscription, watchAvailability: boolean) => {
    setBusyId(subscription.id);
    try {
      const updated = await api.updateCreatorSubscription(subscription.id, { watchAvailability });
      setView((current) =>
        current
          ? {
              ...current,
              subscriptions: current.subscriptions.map((item) => (item.id === updated.id ? updated : item)),
            }
          : current,
      );
    } catch (updateError) {
      toast.notify(toastFromError(updateError, t("subscriptions.button.updateFailed")));
    } finally {
      setBusyId(null);
    }
  };
  const remove = async (subscription: CreatorSubscription) => {
    setBusyId(subscription.id);
    try {
      await api.deleteCreatorSubscription(subscription.id);
      setView((current) =>
        current
          ? { ...current, subscriptions: current.subscriptions.filter((item) => item.id !== subscription.id) }
          : current,
      );
    } catch (removeError) {
      toast.notify(toastFromError(removeError, t("subscriptions.button.updateFailed")));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="grid gap-6">
      <SubscriptionSchedulePanel
        schedule={view.schedule}
        editable={editable && canManageSchedule}
        onSaved={(schedule) => setView((current) => (current ? { ...current, schedule } : current))}
        onOpenRun={onOpenRun}
      />
      {view.subscriptions.length === 0 ? (
        <p className="py-6 text-sm text-muted-foreground">{t("subscriptions.list.empty")}</p>
      ) : (
        kindOrder.map((kind) => {
          const items = view.subscriptions.filter((item) => item.kind === kind);
          if (items.length === 0) return null;
          return (
            <section key={kind} className="space-y-2" aria-labelledby={`subscriptions-${kind}`}>
              <h2 id={`subscriptions-${kind}`} className="text-sm font-semibold">
                {t(`subscriptions.list.kinds.${kind}`)}
              </h2>
              <ul className="divide-y rounded-lg border bg-card">
                {items.map((subscription) => (
                  <SubscriptionRow
                    key={subscription.id}
                    subscription={subscription}
                    editable={editable}
                    busy={busyId === subscription.id}
                    onOpenPath={onOpenPath}
                    onWatchChange={(checked) => void update(subscription, checked)}
                    onRemove={() => void remove(subscription)}
                  />
                ))}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}

function SubscriptionRow({
  subscription,
  editable,
  busy,
  onOpenPath,
  onWatchChange,
  onRemove,
}: {
  subscription: CreatorSubscription;
  editable: boolean;
  busy: boolean;
  onOpenPath: (path: string) => void;
  onWatchChange: (checked: boolean) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const path = editable ? subscriptionSubjectPath(subscription) : null;
  const name = subscriptionSubjectName(subscription);
  const synced = parseServerTimestamp(subscription.catalogSyncedAt);
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5">
      <div className="min-w-[14rem] flex-1">
        <div className="flex min-w-0 items-center gap-2">
          {path ? (
            <a
              href={path}
              className="truncate font-medium hover:underline"
              onClick={(event) => {
                event.preventDefault();
                onOpenPath(path);
              }}
            >
              {name}
            </a>
          ) : (
            <span className="truncate font-medium">{name}</span>
          )}
          <Badge variant={subscription.status === "active" ? "success" : "warning"} className="shrink-0">
            {t(`subscriptions.list.status.${subscription.status}`)}
          </Badge>
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {subscription.kind === "series" && subscription.circleName ? `${subscription.circleName} · ` : ""}
          {synced
            ? t("subscriptions.list.catalogSynced", { time: formatDateTime(synced, resolvedLocale) })
            : t("subscriptions.list.catalogNeverSynced")}
        </p>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          {t("subscriptions.watchAvailability")}
          <Switch
            checked={subscription.watchAvailability}
            disabled={!editable || busy}
            aria-label={t("subscriptions.list.watchFor", { name })}
            onCheckedChange={onWatchChange}
          />
        </label>
        <Button size="sm" variant="ghost" disabled={!editable || busy} onClick={onRemove}>
          {t("subscriptions.button.unsubscribe")}
        </Button>
      </div>
    </li>
  );
}

function SubscriptionSchedulePanel({
  schedule,
  editable,
  onSaved,
  onOpenRun,
}: {
  schedule: CreatorSubscriptionSchedule;
  editable: boolean;
  onSaved: (schedule: CreatorSubscriptionSchedule) => void;
  onOpenRun: (runId: number) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { resolvedLocale } = useLocale();
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  const save = async (
    patch: Partial<Pick<CreatorSubscriptionSchedule, "enabled" | "intervalHours" | "availabilityWatch">>,
  ) => {
    setSaving(true);
    try {
      onSaved(await api.updateCreatorSubscriptionSchedule(patch));
    } catch (saveError) {
      toast.notify(toastFromError(saveError, t("subscriptions.schedule.saveFailed")));
    } finally {
      setSaving(false);
    }
  };
  const runNow = async () => {
    setRunning(true);
    try {
      const run = await api.runCreatorSubscriptionRefresh();
      onSaved({ ...schedule, latestRun: { id: run.runId, status: run.status } });
      toast.success(t("subscriptions.schedule.queued"));
    } catch (runError) {
      toast.notify(toastFromError(runError, t("subscriptions.schedule.runFailed")));
    } finally {
      setRunning(false);
    }
  };

  const intervalOptions = SUBSCRIPTION_INTERVAL_HOURS.map((hours) => ({
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
  return (
    <section className="grid gap-4 rounded-lg border bg-card p-4" aria-labelledby="subscription-schedule">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 id="subscription-schedule" className="text-sm font-semibold">
            {t("subscriptions.schedule.title")}
          </h2>
          <p className="text-xs text-muted-foreground">{t("subscriptions.schedule.description")}</p>
        </div>
        {editable && (
          <Button
            size="sm"
            variant="outline"
            disabled={running || schedule.latestRun?.status === "running" || schedule.latestRun?.status === "queued"}
            onClick={() => void runNow()}
          >
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
        <label className="flex items-center justify-between gap-3 text-sm">
          <span className="min-w-0">
            {t("subscriptions.schedule.availabilityWatch")}
            <span className="block text-xs text-muted-foreground">
              {t("subscriptions.schedule.availabilityWatchDescription")}
            </span>
          </span>
          <Switch
            checked={schedule.availabilityWatch}
            disabled={!editable || saving}
            aria-label={t("subscriptions.schedule.availabilityWatch")}
            onCheckedChange={(availabilityWatch) => void save({ availabilityWatch })}
          />
        </label>
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
