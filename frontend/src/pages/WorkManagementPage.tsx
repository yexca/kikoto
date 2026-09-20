import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
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
  const currentTab = () =>
    canManageSources && new URLSearchParams(window.location.search).get("tab") === "settings" ? "settings" : "issues";
  const [tab, setTab] = useState(currentTab);
  useEffect(() => {
    const sync = () => setTab(currentTab());
    window.addEventListener("popstate", sync);
    window.addEventListener(NAVIGATION_EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(NAVIGATION_EVENT, sync);
    };
  }, [canManageSources]);
  const selectTab = (next: string) => {
    if (next === tab) return;
    setTab(next);
    window.history.replaceState(
      window.history.state,
      "",
      `/work-management${next === "settings" ? "?tab=settings" : ""}`,
    );
  };
  return (
    <div className="min-w-0 space-y-4">
      {readOnly && (
        <div role="status" className="rounded-lg border p-3 text-sm text-muted-foreground">
          {t("maintenance.demoReadOnly")}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
        <div role="tablist" aria-label={t("nav.workManagement")} className="flex gap-1">
          {["issues", ...(canManageSources ? ["settings"] : [])].map((value) => (
            <Button
              key={value}
              role="tab"
              aria-selected={tab === value}
              variant={tab === value ? "secondary" : "ghost"}
              onClick={() => selectTab(value)}
            >
              {t(`workManagement.${value}`)}
            </Button>
          ))}
        </div>
        {canSyncMetadata && canOpenWorkflows && (
          <Button
            variant="outline"
            onClick={() => {
              window.history.pushState({}, "", "/workflows?workflow=metadata_sync");
              window.dispatchEvent(new Event(NAVIGATION_EVENT));
            }}
          >
            <ExternalLink className="h-4 w-4" />
            {t("workManagement.openSync")}
          </Button>
        )}
      </div>
      {tab === "settings" && canManageSources ? (
        <div className="max-w-4xl">
          <MetadataSettingsPanel readOnly={readOnly} />
        </div>
      ) : (
        <WorkMaintenance canManageSources={canManageSources} canSyncMetadata={canSyncMetadata} readOnly={readOnly} />
      )}
    </div>
  );
}
