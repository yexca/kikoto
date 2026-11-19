import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "@/auth/AuthProvider";
import { AutosaveStatus, useAutosaveStatus } from "@/components/settings/AutosaveStatus";
import { SettingsRow, SettingsSection } from "@/components/settings/SettingsSection";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { api, type RecordRoot } from "@/lib/api";

import { useRecordRoot } from "./useRecordLibrary";

const rootBadge: Record<RecordRoot["state"], "secondary" | "success" | "warning"> = {
  unconfigured: "secondary",
  online: "success",
  offline: "warning",
  unreadable: "warning",
};

/**
 * Record in System -> Library: the switch that offers the Record library to
 * the instance and, while it is on, the record root's state and its one-time
 * initialization.
 */
export function RecordSettingsSection({
  enabled,
  savedEnabled,
  readOnly,
  onEnabledChange,
}: {
  /** The switch, which follows a choice before it is saved. */
  enabled: boolean;
  /** Whether the server has Record on, so its root can be read. */
  savedEnabled: boolean;
  readOnly: boolean;
  /** Saves the switch; resolves to whether it was saved. */
  onEnabledChange: (enabled: boolean) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const auth = useAuth();
  const status = useAutosaveStatus();
  // Demo has no record root to read.
  const showRoot = enabled && savedEnabled && !auth.demoMode;
  const { state: rootState, reload, setRoot } = useRecordRoot(showRoot);
  const [initializing, setInitializing] = useState<"idle" | "busy" | "failed">("idle");

  const change = (next: boolean) =>
    void status.track(
      onEnabledChange(next).then(async (saved) => {
        // The navigation follows the instance's runtime settings.
        if (saved) await auth.refreshRuntime().catch(() => undefined);
        return saved;
      }),
    );

  const initialize = async () => {
    setInitializing("busy");
    try {
      const result = await api.initializeRecordRoot();
      setRoot(result.root);
      setInitializing("idle");
    } catch {
      setInitializing("failed");
    }
  };

  const root = rootState.status === "ready" ? rootState.root : null;

  return (
    <SettingsSection
      id="record"
      title={t("records.settings.title")}
      action={
        <>
          <AutosaveStatus state={status.state} />
          <Switch
            checked={enabled}
            disabled={readOnly}
            aria-label={t("records.settings.enable")}
            onCheckedChange={change}
          />
        </>
      }
    >
      {showRoot && (
        <SettingsRow
          title={t("records.settings.root")}
          description={rootState.status === "error" ? t("records.settings.rootLoadFailed") : undefined}
        >
          <div className="flex flex-wrap items-center justify-end gap-2">
            {initializing === "failed" && (
              <p role="alert" className="text-sm text-error-foreground">
                {t("records.initializeFailed")}
              </p>
            )}
            {rootState.status === "loading" && (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label={t("records.loading")} />
            )}
            {rootState.status === "error" && (
              <Button size="sm" variant="outline" onClick={() => void reload()}>
                {t("records.retry")}
              </Button>
            )}
            {root && <Badge variant={rootBadge[root.state]}>{t(`records.settings.rootStates.${root.state}`)}</Badge>}
            {root?.state === "unconfigured" && !readOnly && (
              <Button size="sm" disabled={initializing === "busy"} onClick={() => void initialize()}>
                {initializing === "busy" && <Loader2 className="h-4 w-4 animate-spin" />}
                {initializing === "busy" ? t("records.initializing") : t("records.initialize")}
              </Button>
            )}
          </div>
        </SettingsRow>
      )}
    </SettingsSection>
  );
}
