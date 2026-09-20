import { ExternalLink, Settings, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
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
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const sync = () => setSettingsOpen(new URLSearchParams(window.location.search).get("tab") === "settings");
    window.addEventListener("popstate", sync);
    window.addEventListener(NAVIGATION_EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(NAVIGATION_EVENT, sync);
    };
  }, []);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (settingsOpen && canManageSources) dialog?.showModal();
    else dialog?.close();
  }, [settingsOpen, canManageSources]);
  const showSettings = (open: boolean) => {
    const url = new URL(window.location.href);
    if (open) url.searchParams.set("tab", "settings");
    else url.searchParams.delete("tab");
    window.history.replaceState(window.history.state, "", url.pathname + url.search);
    setSettingsOpen(open);
  };
  return (
    <div className="min-w-0 space-y-4">
      {readOnly && (
        <div role="status" className="rounded-lg border p-3 text-sm text-muted-foreground">
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
                variant="outline"
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
                variant="outline"
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
      {canManageSources && (
        <dialog
          ref={dialogRef}
          aria-labelledby="metadata-settings-title"
          className="w-[calc(100%-2rem)] max-w-4xl overflow-hidden rounded-lg border bg-background p-0 text-foreground shadow-xl backdrop:bg-black/50"
          onCancel={() => showSettings(false)}
          onClick={(event) => {
            if (event.target === event.currentTarget) showSettings(false);
          }}
        >
          <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
            <h2 id="metadata-settings-title" className="font-semibold">
              {t("workManagement.settings")}
            </h2>
            <Button
              autoFocus
              variant="ghost"
              size="icon"
              aria-label={t("common.close")}
              onClick={() => showSettings(false)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="max-h-[calc(85dvh-4rem)] overflow-y-auto p-4">
            {settingsOpen && <MetadataSettingsPanel readOnly={readOnly} />}
          </div>
        </dialog>
      )}
    </div>
  );
}
