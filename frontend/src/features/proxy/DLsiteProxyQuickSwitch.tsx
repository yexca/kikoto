import { ArrowRight } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { AppSettings, ProxySettings } from "@/lib/api";

import { routeSelection, setRouteEnabled, setRouteSelection, type RouteSelection } from "./proxyModel";
import { useProxyLabel } from "./ProxySettingsSection";
import { useProxySettingsSave } from "./useProxySettingsSave";

/**
 * A shortcut to the DLsite proxy scope from Settings: the same switch and
 * proxy choice, saved immediately. Proxies themselves are managed in
 * Settings, which onManage opens.
 */
export function DLsiteProxyQuickSwitch({
  proxy,
  readOnly,
  onSaved,
  onManage,
}: {
  proxy: ProxySettings;
  readOnly: boolean;
  onSaved: (settings: AppSettings) => void;
  onManage: () => void;
}) {
  const { t } = useTranslation();
  const proxyLabel = useProxyLabel();
  const { draft, saving, save } = useProxySettingsSave(proxy, onSaved);
  const route = draft.routes.dlsite;
  const selection = routeSelection(route.proxyIds);
  const hasProxies = draft.proxies.length > 0;
  const locked = readOnly || saving;
  const title = t("maintenance.proxy.scopes.dlsite");

  return (
    <div className="space-y-2">
      {hasProxies ? (
        <div className="flex min-w-0 items-center gap-2">
          <NativeSelect
            fieldSize="sm"
            className="min-w-0 flex-1"
            value={selection}
            disabled={locked || !route.enabled}
            aria-label={t("maintenance.proxy.proxyFor", { scope: title })}
            onChange={(event) =>
              void save(
                setRouteSelection(draft, "dlsite", event.target.value as RouteSelection),
                t("maintenance.metadata.proxyUpdated"),
              )
            }
          >
            <option value="all">{t("maintenance.proxy.allProxies")}</option>
            {selection === "custom" && <option value="custom">{t("maintenance.proxy.customSelection")}</option>}
            {draft.proxies.map((candidate) => (
              <option key={candidate.id} value={`proxy:${candidate.id}`}>
                {proxyLabel(candidate)}
              </option>
            ))}
          </NativeSelect>
          <Switch
            checked={route.enabled}
            disabled={locked}
            aria-label={t("maintenance.proxy.useProxyFor", { scope: title })}
            onCheckedChange={(enabled) =>
              void save(setRouteEnabled(draft, "dlsite", enabled), t("maintenance.metadata.proxyUpdated"))
            }
          />
        </div>
      ) : (
        <p className="text-xs leading-5 text-muted-foreground">{t("maintenance.metadata.noProxies")}</p>
      )}
      <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={onManage}>
        {t("maintenance.metadata.manageProxies")}
        <ArrowRight className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
