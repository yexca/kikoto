import { Globe, HardDrive, Plus, RefreshCw, Settings2, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { SettingsSection } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { FileSource } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import { remoteSourceHealth, remoteSourceHost } from "./remoteSourceModel";

const healthDotClassNames = {
  healthy: "bg-success",
  unavailable: "bg-error",
  unknown: "bg-muted-foreground/40",
  disabled: "bg-muted-foreground/20",
} as const;

const localDotClassNames = {
  online: "bg-success",
  offline: "bg-warning",
  unknown: "bg-muted-foreground/40",
} as const;

/** The local library as the overview lists it; the caller derives it from the library layout. */
export type LocalLibraryEntry = {
  name: string;
  detail: string;
  status: keyof typeof localDotClassNames;
  onConfigure: () => void;
};

/**
 * Every library the server reads, local first and then each remote source,
 * with each source's state and actions. Configuration sections follow it.
 */
export function LibrarySourceList({
  local,
  sources,
  checkingSourceId,
  togglingSourceId,
  readOnly,
  onCreate,
  onEdit,
  onDelete,
  onCheck,
  onToggleEnabled,
}: {
  local: LocalLibraryEntry;
  sources: FileSource[];
  checkingSourceId: number | null;
  togglingSourceId: number | null;
  readOnly: boolean;
  onCreate: () => void;
  onEdit: (source: FileSource) => void;
  onDelete: (source: FileSource) => void;
  onCheck: (id: number) => Promise<void>;
  onToggleEnabled: (source: FileSource, enabled: boolean) => Promise<void>;
}) {
  const { t } = useTranslation();
  const enabledCount = sources.filter((source) => source.enabled).length;
  return (
    <SettingsSection
      title={t("maintenance.library.libraries")}
      description={
        sources.length > 0
          ? t("maintenance.library.librariesSummary", { enabled: enabledCount, total: sources.length })
          : t("maintenance.library.librariesDescription")
      }
      action={
        <Button variant="outline" size="sm" onClick={onCreate} disabled={readOnly}>
          <Plus className="h-4 w-4" />
          {t("maintenance.library.addSource")}
        </Button>
      }
    >
      <GroupLabel>{t("maintenance.library.localGroup")}</GroupLabel>
      <div className="flex min-w-0 items-center gap-3 px-4 py-3">
        <span
          className={cn("h-2.5 w-2.5 shrink-0 rounded-full", localDotClassNames[local.status])}
          aria-hidden="true"
        />
        <button type="button" className="min-w-0 flex-1 text-left" onClick={local.onConfigure}>
          <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
            <HardDrive className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate">{local.name}</span>
          </span>
          <span
            className={cn(
              "mt-0.5 block truncate text-xs text-muted-foreground",
              local.status === "offline" && "text-warning-foreground",
            )}
          >
            {local.detail}
          </span>
        </button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          aria-label={t("maintenance.library.storageSettings")}
          title={t("maintenance.library.storageSettings")}
          onClick={local.onConfigure}
        >
          <Settings2 className="h-4 w-4" />
        </Button>
      </div>
      <GroupLabel id="remote-sources">{t("maintenance.library.remoteGroup")}</GroupLabel>
      {sources.map((source) => {
        const health = remoteSourceHealth(source);
        const host = remoteSourceHost(source) || t("maintenance.noEndpointConfigured");
        const checking = checkingSourceId === source.id;
        return (
          <div key={source.id} className="flex min-w-0 items-center gap-3 px-4 py-3">
            <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", healthDotClassNames[health])} aria-hidden="true" />
            <button
              type="button"
              className="min-w-0 flex-1 text-left disabled:cursor-default"
              onClick={() => onEdit(source)}
            >
              <span
                className={cn(
                  "flex min-w-0 items-center gap-1.5 text-sm font-medium",
                  !source.enabled && "text-muted-foreground",
                )}
              >
                <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="truncate">{source.displayName}</span>
              </span>
              <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <span className={cn(health === "unavailable" && "text-error-foreground")}>
                  {t(`sourceSetup.health.${health}`)}
                </span>
                <span aria-hidden="true">·</span>
                <span className="truncate" title={host}>
                  {host}
                </span>
              </span>
            </button>
            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label={t("maintenance.library.checkHealth")}
                title={t("maintenance.library.checkHealth")}
                onClick={() => void onCheck(source.id)}
                disabled={readOnly || !source.enabled || checkingSourceId !== null}
              >
                <RefreshCw className={cn("h-4 w-4", checking && "animate-spin")} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label={t("maintenance.library.configure")}
                title={t("maintenance.library.configure")}
                onClick={() => onEdit(source)}
              >
                <Settings2 className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                aria-label={t("maintenance.library.deleteSource")}
                title={t("maintenance.library.deleteSource")}
                onClick={() => onDelete(source)}
                disabled={readOnly}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            <Switch
              checked={source.enabled}
              disabled={readOnly || togglingSourceId === source.id}
              onCheckedChange={(enabled) => void onToggleEnabled(source, enabled)}
              aria-label={t("sourceSetup.enableNamed", { name: source.displayName })}
            />
          </div>
        );
      })}
      {sources.length === 0 && (
        <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
          <span className="grid h-10 w-10 place-items-center rounded-full bg-muted text-muted-foreground">
            <Globe className="h-5 w-5" />
          </span>
          <p className="max-w-sm text-sm text-muted-foreground">{t("sourceSetup.empty")}</p>
          <Button size="sm" onClick={onCreate} disabled={readOnly}>
            <Plus className="h-4 w-4" />
            {t("maintenance.library.addSource")}
          </Button>
        </div>
      )}
    </SettingsSection>
  );
}

function GroupLabel({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <h3
      id={id}
      className="scroll-mt-24 bg-muted/30 px-4 py-1.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground"
    >
      {children}
    </h3>
  );
}
