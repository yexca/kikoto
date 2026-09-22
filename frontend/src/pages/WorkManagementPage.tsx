import { ExternalLink, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogHeader } from "@/components/ui/dialog";
import { WorkMaintenance } from "@/features/maintenance/WorkMaintenance";
import { MetadataSettingsPanel } from "@/features/maintenance/MetadataSettingsPanel";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";

export function WorkManagementPage({
  canSyncMetadata,
  canManageSources,
  canOpenWorkflows,
  readOnly = false,
}: {
  canSyncMetadata: boolean;
  canManageSources: boolean;
  canOpenWorkflows: boolean;
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const [settingsOpen, setSettingsOpen] = useState(
    () => new URLSearchParams(window.location.search).get("tab") === "settings",
  );
  useEffect(() => {
    const sync = () => setSettingsOpen(new URLSearchParams(window.location.search).get("tab") === "settings");
    window.addEventListener("popstate", sync);
    window.addEventListener(NAVIGATION_EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(NAVIGATION_EVENT, sync);
    };
  }, []);
  const showSettings = (open: boolean) => {
    const url = new URL(window.location.href);
    if (open) url.searchParams.set("tab", "settings");
    else url.searchParams.delete("tab");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    setSettingsOpen(open);
  };
  return (
    <div className="min-w-0 space-y-4">
      {readOnly && (
        <div
          role="status"
          className="rounded-lg border border-info-border bg-info-surface px-3 py-2 text-sm text-info-foreground"
        >
          {t("maintenance.demoReadOnly")}
        </div>
      )}
      <WorkMaintenance
        canManageSources={canManageSources}
        canSyncMetadata={canSyncMetadata}
        readOnly={readOnly}
        actions={
          <>
            {canManageSources && (
              <Button
                variant="toolbar"
                aria-label={t("workManagement.settings")}
                title={t("workManagement.settings")}
                onClick={() => showSettings(true)}
              >
                <Settings className="h-4 w-4" />
                <span className="hidden sm:inline">{t("workManagement.settings")}</span>
              </Button>
            )}
            {canSyncMetadata && canOpenWorkflows && (
              <Button
                variant="toolbar"
                aria-label={t("workManagement.openSync")}
                title={t("workManagement.openSync")}
                onClick={() => {
                  window.history.pushState({}, "", "/workflows?workflow=metadata_sync");
                  window.dispatchEvent(new Event(NAVIGATION_EVENT));
                }}
              >
                <ExternalLink className="h-4 w-4" />
                <span className="hidden sm:inline">{t("workManagement.openSync")}</span>
              </Button>
            )}
          </>
        }
      />
      {canManageSources && settingsOpen && (
        <Dialog onClose={() => showSettings(false)} size="xl">
          <DialogHeader
            title={t("workManagement.settings")}
            icon={<Settings className="h-4 w-4" />}
            onClose={() => showSettings(false)}
            closeLabel={t("common.close")}
          />
          <MetadataSettingsPanel readOnly={readOnly} />
        </Dialog>
      )}
    </div>
  );
}
