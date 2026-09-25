import { ArchiveRestore, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { SettingsRow, SettingsSection } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { toastFromError, useToast } from "@/components/ui/toast";
import { isActiveWorkflowStatus, useWorkflowRunWatcher } from "@/hooks/useWorkflowRunWatcher";
import { formatDateTime } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import { api, type DatabaseBackupList } from "@/lib/api";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";

import { formatByteSize } from "./cacheCleanupModel";

export function DatabaseBackupSection({ readOnly }: { readOnly: boolean }) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const toast = useToast();
  const [list, setList] = useState<DatabaseBackupList | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const watchedRun = useWorkflowRunWatcher(activeRunId);
  const running = submitting || activeRunId !== null;

  const load = useCallback(async () => {
    try {
      setList(await api.listDatabaseBackups());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const run = watchedRun.run;
    if (!run || run.id !== activeRunId || isActiveWorkflowStatus(run.status)) return;
    setActiveRunId(null);
    if (run.status !== "succeeded") {
      toast.notify({
        kind: "error",
        message: t("cleanup.backup.runFailed"),
        actionLabel: t("notifications.openActivity"),
        onAction: () => openActivityRun(run.id),
      });
      return;
    }
    toast.success(t("cleanup.backup.done"));
    void load();
  }, [activeRunId, load, t, toast, watchedRun.run]);

  const backUp = async () => {
    setSubmitting(true);
    try {
      const queued = await api.backUpDatabase();
      setActiveRunId(queued.runId);
      toast.notify({
        kind: queued.existing ? "info" : "success",
        message: t(queued.existing ? "cleanup.backup.alreadyQueued" : "cleanup.backup.queued", { runId: queued.runId }),
        actionLabel: t("notifications.openActivity"),
        onAction: () => openActivityRun(queued.runId),
      });
    } catch (error) {
      toast.notify(toastFromError(error, t("cleanup.backup.failed")));
    } finally {
      setSubmitting(false);
    }
  };

  const latest = list?.backups[0];
  let description: string;
  if (loadFailed) description = t("cleanup.backup.loadFailed");
  else if (!list) description = t("maintenance.cache.scanning");
  else if (!list.available) description = t("cleanup.backup.unavailable");
  else if (!latest) description = t("cleanup.backup.none");
  else
    description = t("cleanup.backup.latest", {
      time: formatDateTime(latest.createdAt, resolvedLocale),
      kind: t(`cleanup.backup.kinds.${latest.kind}`),
      size: formatByteSize(latest.sizeBytes),
      count: list.backups.length,
    });

  return (
    <SettingsSection title={t("cleanup.backup.title")} icon={<ArchiveRestore />}>
      <SettingsRow title={t("cleanup.backup.backUp")} description={description}>
        <Button
          variant="outline"
          size="sm"
          disabled={readOnly || running || !list?.available}
          onClick={() => void backUp()}
        >
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArchiveRestore className="h-4 w-4" />}
          {running ? t("cleanup.backup.running") : t("cleanup.backup.run")}
        </Button>
      </SettingsRow>
      <p className="px-4 pb-3 text-xs text-muted-foreground">{t("cleanup.backup.policy")}</p>
    </SettingsSection>
  );
}

function openActivityRun(runId: number) {
  window.history.pushState({}, "", `/workflows?activity=1&run=${runId}`);
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}
