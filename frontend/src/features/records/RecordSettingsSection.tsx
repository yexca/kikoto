import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "@/auth/AuthProvider";
import { AutosaveStatus, useAutosaveStatus } from "@/components/settings/AutosaveStatus";
import { SettingsRow, SettingsSection } from "@/components/settings/SettingsSection";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { ApiError, api, type RecordRoot } from "@/lib/api";

import { useRecordRoot } from "./useRecordLibrary";

const rootBadge: Record<RecordRoot["state"], "secondary" | "success" | "warning"> = {
  unconfigured: "secondary",
  online: "success",
  offline: "warning",
  unreadable: "warning",
  marker_missing: "warning",
};

// The refusals an administrator can act on name what to do; any other failure
// shows the general message.
const initializeFailures: Record<string, string> = {
  record_root_empty: "records.initializeRootEmpty",
  record_root_path_missing: "records.initializeRootPathMissing",
};
const restoreFailures: Record<string, string> = {
  record_root_not_recognized: "records.restoreMarkerNotRecognized",
};

function failureKey(error: unknown, known: Record<string, string>, fallback: string) {
  return (error instanceof ApiError && known[error.code]) || fallback;
}

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
  const [initializeFailure, setInitializeFailure] = useState("records.initializeFailed");
  const [restoring, setRestoring] = useState<"idle" | "busy" | "failed">("idle");
  const [restoreFailure, setRestoreFailure] = useState("records.restoreMarkerFailed");
  const [confirmingFresh, setConfirmingFresh] = useState(false);

  const change = (next: boolean) =>
    void status.track(
      onEnabledChange(next).then(async (saved) => {
        // The navigation follows the instance's runtime settings.
        if (saved) await auth.refreshRuntime().catch(() => undefined);
        return saved;
      }),
    );

  const initialize = async (fresh = false) => {
    setInitializing("busy");
    try {
      const result = await api.initializeRecordRoot({ fresh });
      setRoot(result.root);
      setInitializing("idle");
      setConfirmingFresh(false);
    } catch (error) {
      setInitializeFailure(failureKey(error, initializeFailures, "records.initializeFailed"));
      setInitializing("failed");
      setConfirmingFresh(false);
    }
  };

  const restoreMarker = async () => {
    setRestoring("busy");
    try {
      const result = await api.restoreRecordMarker();
      setRoot(result.root);
      setRestoring("idle");
    } catch (error) {
      setRestoreFailure(failureKey(error, restoreFailures, "records.restoreMarkerFailed"));
      setRestoring("failed");
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
                {t(initializeFailure)}
              </p>
            )}
            {restoring === "failed" && (
              <p role="alert" className="text-sm text-error-foreground">
                {t(restoreFailure)}
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
            {/* Another disk at the root, like one that lost its marker, keeps the
                catalog until an administrator starts a new one. */}
            {(root?.state === "marker_missing" || root?.state === "offline") && !readOnly && (
              <>
                {root.state === "marker_missing" && (
                  <Button size="sm" disabled={restoring === "busy"} onClick={() => void restoreMarker()}>
                    {restoring === "busy" && <Loader2 className="h-4 w-4 animate-spin" />}
                    {t("records.restoreMarker")}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={restoring === "busy" || initializing === "busy"}
                  onClick={() => setConfirmingFresh(true)}
                >
                  {t("records.startNewCatalog")}
                </Button>
              </>
            )}
          </div>
        </SettingsRow>
      )}
      {confirmingFresh && (
        <Dialog onClose={() => setConfirmingFresh(false)} size="md" dismissible={initializing !== "busy"}>
          <DialogHeader
            title={t("records.startNewCatalog")}
            onClose={() => setConfirmingFresh(false)}
            closeLabel={t("content.close")}
          />
          <DialogBody className="text-sm">{t("records.startNewCatalogWarning")}</DialogBody>
          <DialogFooter>
            <Button variant="outline" disabled={initializing === "busy"} onClick={() => setConfirmingFresh(false)}>
              {t("content.cancel")}
            </Button>
            <Button variant="destructive" disabled={initializing === "busy"} onClick={() => void initialize(true)}>
              {initializing === "busy" && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("records.startNewCatalog")}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </SettingsSection>
  );
}
