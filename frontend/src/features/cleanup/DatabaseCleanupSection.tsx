import { AlertTriangle, ArrowRight, Database, Gauge, Loader2, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { SettingsRow, SettingsSection } from "@/components/settings/SettingsSection";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { toastFromError, useToast } from "@/components/ui/toast";
import { formatNumber } from "@/i18n/format";
import { isActiveWorkflowStatus, useWorkflowRunWatcher } from "@/hooks/useWorkflowRunWatcher";
import { useLocale } from "@/i18n/LocaleProvider";
import { api, type DatabaseCleanupTaskKey, type DatabaseMaintenanceOverview } from "@/lib/api";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import { cn } from "@/lib/tailwindClassNames";

import { formatByteSize } from "./cacheCleanupModel";

export const databaseCleanupGroups: Array<{ key: "library" | "history"; tasks: DatabaseCleanupTaskKey[] }> = [
  {
    key: "library",
    tasks: [
      "missing_folders",
      "missing_files",
      "empty_media_items",
      "missing_presence",
      "orphan_snapshots",
      "unused_tags",
    ],
  },
  {
    key: "history",
    tasks: [
      "expired_sessions",
      "dismissed_notifications",
      "old_runs",
      "old_recommendation_events",
      "stale_recommendation_generations",
    ],
  },
];

export function DatabaseCleanupSection({
  overview,
  scanning,
  readOnly,
  unlinkedWorks,
  onRescan,
  onOpenUnlinkedWorks,
}: {
  overview: DatabaseMaintenanceOverview | null;
  scanning: boolean;
  readOnly: boolean;
  unlinkedWorks: number | null;
  onRescan: () => Promise<void>;
  onOpenUnlinkedWorks: () => void;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const toast = useToast();
  const [selected, setSelected] = useState<Set<DatabaseCleanupTaskKey>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const tasks = useMemo(() => new Map(overview?.tasks.map((task) => [task.key, task]) ?? []), [overview]);
  const cleanable = (key: DatabaseCleanupTaskKey) => {
    const task = tasks.get(key);
    return Boolean(task?.available && task.count > 0);
  };
  const selectedTasks = [...selected].filter(cleanable);
  const selectedRecords = selectedTasks.reduce((total, key) => total + (tasks.get(key)?.count ?? 0), 0);
  const cleanableTasks = databaseCleanupGroups.flatMap((group) => group.tasks).filter(cleanable);

  const toggle = (key: DatabaseCleanupTaskKey, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });

  const clean = async () => {
    setCleaning(true);
    try {
      const result = await api.cleanupDatabase(selectedTasks);
      const skipped = result.results.filter((item) => item.skipped).length;
      setConfirming(false);
      setSelected(new Set());
      toast.success(t("cleanup.database.cleaned", { count: result.removed }));
      if (skipped > 0) toast.warning(t("cleanup.database.skippedDiskTasks"));
      await onRescan();
    } catch (error) {
      toast.notify(toastFromError(error, t("cleanup.database.cleanFailed")));
    } finally {
      setCleaning(false);
    }
  };

  return (
    <SettingsSection
      title={t("cleanup.database.title")}
      description={t("cleanup.database.description")}
      icon={<Database />}
      action={
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => void onRescan()}
          disabled={scanning}
          aria-label={t("cleanup.database.rescan")}
          title={t("cleanup.database.rescan")}
        >
          <RefreshCw className={cn("h-4 w-4", scanning && "animate-spin")} />
        </Button>
      }
    >
      {overview && !overview.dataRootAvailable && (
        <div
          role="status"
          className="flex items-start gap-2 bg-warning-surface px-4 py-3 text-xs text-warning-foreground"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t("cleanup.database.dataRootUnavailable")}</span>
        </div>
      )}
      {databaseCleanupGroups.map((group) => {
        const groupCleanable = group.tasks.filter(cleanable);
        const groupSelected = groupCleanable.filter((key) => selected.has(key)).length;
        return (
          <div key={group.key}>
            <div className="flex items-center gap-3 bg-muted/30 px-4 py-2">
              <Checkbox
                checked={groupCleanable.length > 0 && groupSelected === groupCleanable.length}
                indeterminate={groupSelected > 0 && groupSelected < groupCleanable.length}
                disabled={readOnly || groupCleanable.length === 0}
                onCheckedChange={(checked) => groupCleanable.forEach((key) => toggle(key, checked))}
                aria-label={t("cleanup.database.selectGroup", { group: t(`cleanup.database.groups.${group.key}`) })}
              />
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t(`cleanup.database.groups.${group.key}`)}
              </span>
            </div>
            <div className="divide-y">
              {group.tasks.map((key) => {
                const task = tasks.get(key);
                const enabled = cleanable(key);
                return (
                  <label
                    key={key}
                    className={cn(
                      "flex min-w-0 items-start gap-3 px-4 py-3",
                      enabled && !readOnly ? "cursor-pointer hover:bg-muted/30" : "opacity-80",
                    )}
                  >
                    <Checkbox
                      className="mt-0.5"
                      checked={selected.has(key) && enabled}
                      disabled={readOnly || !enabled}
                      onCheckedChange={(checked) => toggle(key, checked)}
                      aria-label={t(`cleanup.tasks.${key}.title`)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{t(`cleanup.tasks.${key}.title`)}</span>
                      <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                        {t(`cleanup.tasks.${key}.description`)}
                      </span>
                    </span>
                    <TaskCount
                      loading={!overview}
                      available={task?.available ?? true}
                      count={task?.count ?? 0}
                      label={formatNumber(task?.count ?? 0, resolvedLocale)}
                    />
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
      <SettingsRow title={t("cleanup.database.unlinkedTitle")} description={t("cleanup.database.unlinkedDescription")}>
        {unlinkedWorks !== null && (
          <Badge variant={unlinkedWorks > 0 ? "warning" : "outline"} className="tabular-nums">
            {formatNumber(unlinkedWorks, resolvedLocale)}
          </Badge>
        )}
        <Button variant="outline" size="sm" onClick={onOpenUnlinkedWorks}>
          {t("cleanup.database.review")}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </SettingsRow>
      <div className="flex flex-wrap items-center justify-end gap-2 bg-muted/25 px-4 py-2.5">
        <span className="mr-auto text-xs text-muted-foreground">
          {cleanableTasks.length === 0 && overview
            ? t("cleanup.database.nothingToClean")
            : t("cleanup.database.selectedSummary", {
                tasks: selectedTasks.length,
                records: formatNumber(selectedRecords, resolvedLocale),
              })}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={readOnly || cleanableTasks.length === 0}
          onClick={() => setSelected(new Set(cleanableTasks))}
        >
          {t("cleanup.database.selectAll")}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={readOnly || cleaning || scanning || selectedTasks.length === 0}
          onClick={() => setConfirming(true)}
        >
          <Trash2 className="h-4 w-4" />
          {t("cleanup.database.cleanSelected")}
        </Button>
      </div>
      {confirming && (
        <Dialog onClose={() => setConfirming(false)} size="md" role="alertdialog" dismissible={!cleaning}>
          <DialogHeader
            title={t("cleanup.database.confirmTitle")}
            description={t("cleanup.database.confirmDescription")}
            icon={<Trash2 className="h-4 w-4" />}
          />
          <DialogBody>
            <ul className="divide-y rounded-lg border">
              {selectedTasks.map((key) => (
                <li key={key} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0 truncate">{t(`cleanup.tasks.${key}.title`)}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {formatNumber(tasks.get(key)?.count ?? 0, resolvedLocale)}
                  </span>
                </li>
              ))}
            </ul>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" size="sm" disabled={cleaning} onClick={() => setConfirming(false)}>
              {t("maintenance.cancel")}
            </Button>
            <Button variant="destructive" size="sm" disabled={cleaning} onClick={() => void clean()}>
              {cleaning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {t("cleanup.database.confirmClean", { count: selectedRecords })}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </SettingsSection>
  );
}

function TaskCount({
  loading,
  available,
  count,
  label,
}: {
  loading: boolean;
  available: boolean;
  count: number;
  label: string;
}) {
  const { t } = useTranslation();
  if (loading) return <span className="h-5 w-8 shrink-0 animate-pulse rounded-full bg-muted" />;
  if (!available)
    return (
      <Badge variant="outline" className="shrink-0 text-muted-foreground">
        {t("cleanup.database.unavailable")}
      </Badge>
    );
  return (
    <Badge variant={count > 0 ? "warning" : "outline"} className="shrink-0 tabular-nums">
      {count > 0 ? label : t("cleanup.database.clean")}
    </Badge>
  );
}

export function DatabaseOptimizeSection({
  overview,
  readOnly,
  onOptimized,
}: {
  overview: DatabaseMaintenanceOverview | null;
  readOnly: boolean;
  onOptimized: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const [result, setResult] = useState("");
  const watchedRun = useWorkflowRunWatcher(activeRunId);
  const running = submitting || activeRunId !== null;

  useEffect(() => {
    const run = watchedRun.run;
    if (!run || run.id !== activeRunId || isActiveWorkflowStatus(run.status)) return;
    setActiveRunId(null);
    if (run.status !== "succeeded") {
      toast.notify({
        kind: "error",
        message: t("cleanup.optimize.runFailed"),
        actionLabel: t("notifications.openActivity"),
        onAction: () => openActivityRun(run.id),
      });
      return;
    }
    const summary = parseOptimizeSummary(run.summaryJson);
    if (summary) {
      setResult(
        t("cleanup.optimize.result", {
          before: formatByteSize(summary.beforeBytes),
          after: formatByteSize(summary.afterBytes),
        }),
      );
    }
    toast.success(t("cleanup.optimize.done"));
    void onOptimized();
  }, [activeRunId, onOptimized, t, toast, watchedRun.run]);

  const optimize = async () => {
    setSubmitting(true);
    try {
      const queued = await api.optimizeDatabase();
      setConfirming(false);
      setResult("");
      setActiveRunId(queued.runId);
      toast.notify({
        kind: queued.existing ? "info" : "success",
        message: t(queued.existing ? "cleanup.optimize.alreadyQueued" : "cleanup.optimize.queued", {
          runId: queued.runId,
        }),
        actionLabel: t("notifications.openActivity"),
        onAction: () => openActivityRun(queued.runId),
      });
    } catch (error) {
      toast.notify(toastFromError(error, t("cleanup.optimize.failed")));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SettingsSection title={t("cleanup.optimize.title")} icon={<Gauge />}>
      <SettingsRow
        title={t("cleanup.optimize.compact")}
        description={
          result ||
          (overview
            ? t("cleanup.optimize.description", {
                size: formatByteSize(overview.databaseBytes),
                free: formatByteSize(overview.freeBytes),
              })
            : t("maintenance.cache.scanning"))
        }
      >
        <Button
          variant="outline"
          size="sm"
          disabled={readOnly || running || !overview}
          onClick={() => setConfirming(true)}
        >
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {running ? t("cleanup.optimize.running") : t("cleanup.optimize.run")}
        </Button>
      </SettingsRow>
      {confirming && (
        <Dialog onClose={() => setConfirming(false)} size="md" role="alertdialog" dismissible={!running}>
          <DialogHeader
            title={t("cleanup.optimize.confirmTitle")}
            description={t("cleanup.optimize.confirmDescription")}
          />
          <DialogFooter>
            <Button variant="outline" size="sm" disabled={running} onClick={() => setConfirming(false)}>
              {t("maintenance.cancel")}
            </Button>
            <Button size="sm" disabled={running} onClick={() => void optimize()}>
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {t("cleanup.optimize.run")}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </SettingsSection>
  );
}

function parseOptimizeSummary(raw: string): { beforeBytes: number; afterBytes: number } | null {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object") return null;
    const { before_bytes: beforeBytes, after_bytes: afterBytes } = parsed as Record<string, unknown>;
    return typeof beforeBytes === "number" && typeof afterBytes === "number" ? { beforeBytes, afterBytes } : null;
  } catch {
    return null;
  }
}

function openActivityRun(runId: number) {
  window.history.pushState({}, "", `/workflows?activity=1&run=${runId}`);
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}
