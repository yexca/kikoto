import { ArrowRight, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { api, type AppSettings } from "@/lib/api";
import { DLsiteProxyQuickSwitch } from "@/features/proxy";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import { InfoHint } from "./InfoHint";
import i18n from "@/i18n";
const maintenanceCopy = (key: string, options?: Record<string, unknown>) => i18n.t(`maintenance.${key}`, options);
/**
 * Metadata settings shown in the page's settings popover: the DLsite proxy
 * shortcut, which saves on its own, and links to the metadata settings kept
 * elsewhere (catalog freshness in Library settings, remote fallback in
 * Metadata sync).
 */
export function MetadataSettingsPanel({ readOnly = false, onClose }: { readOnly?: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setError(false);
    api
      .getSettings()
      .then((next) => {
        if (active) setSettings(next);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [revision]);
  const navigate = (path: string) => {
    onClose();
    window.history.pushState({}, "", path);
    window.dispatchEvent(new Event(NAVIGATION_EVENT));
  };
  const header = (
    <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
      <h2 className="text-sm font-semibold">{t("workManagement.settings")}</h2>
      <Button
        size="icon-sm"
        variant="ghost"
        className="-mr-2 text-muted-foreground"
        aria-label={t("common.close")}
        title={t("common.close")}
        onClick={onClose}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
  const proxy = error ? (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-error-border bg-error-surface px-3 py-2 text-sm text-error-foreground"
    >
      {t("errors.unavailable")}
      <Button size="sm" variant="outline" onClick={() => setRevision((value) => value + 1)}>
        {t("common.retry")}
      </Button>
    </div>
  ) : !settings ? (
    <div role="status" aria-label={t("workManagement.loading")} aria-busy="true" className="space-y-2">
      <div className="h-9 animate-pulse rounded-md bg-muted" />
    </div>
  ) : (
    <DLsiteProxyQuickSwitch
      proxy={settings.proxy}
      readOnly={readOnly}
      onSaved={setSettings}
      onManage={() => navigate("/settings?tab=proxy")}
    />
  );
  return (
    <>
      {header}
      <div className="min-w-0 space-y-4 px-4 py-3">
        <SettingsGroup title={maintenanceCopy("metadata.proxy")} hint={maintenanceCopy("metadata.proxyDescription")}>
          {proxy}
        </SettingsGroup>
        <section className="space-y-1" aria-labelledby="metadata-settings-elsewhere">
          <h3 id="metadata-settings-elsewhere" className="text-xs font-semibold text-muted-foreground">
            {maintenanceCopy("metadata.elsewhere")}
          </h3>
          <SettingsLink onClick={() => navigate("/settings?tab=library")}>
            {maintenanceCopy("metadata.openCatalogFreshness")}
          </SettingsLink>
          <SettingsLink onClick={() => navigate("/workflows?workflow=metadata_sync")}>
            {maintenanceCopy("metadata.openRemoteFallback")}
          </SettingsLink>
        </section>
      </div>
    </>
  );
}

function SettingsGroup({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-1">
        <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
        <InfoHint label={title}>{hint}</InfoHint>
      </div>
      {children}
    </section>
  );
}

function SettingsLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" className="-ml-2 flex text-muted-foreground" onClick={onClick}>
      {children}
      <ArrowRight className="h-3.5 w-3.5" />
    </Button>
  );
}
