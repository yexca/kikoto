import { ArrowDown, ArrowUp, Network, Plus, Route, Settings2, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { SettingsRow, SettingsSection } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { AppSettings, FileSource, OutboundProxy, ProxySettings } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import { ProxyDialog } from "./ProxyDialog";
import {
  allRoutesEnabled,
  emptyProxy,
  moveProxy,
  PROXY_SCOPES,
  proxyAddress,
  removeProxy,
  routeSelection,
  setAllRoutesEnabled,
  setDirectFallback,
  setRouteEnabled,
  setRouteSelection,
  setSourceSelection,
  sourceSelection,
  upsertProxy,
  type ProxyDraft,
  type ProxyScope,
  type RouteSelection,
  type SourceSelection,
} from "./proxyModel";
import { useProxySettingsSave } from "./useProxySettingsSave";

/** Short protocol label shown in proxy rows and selects. */
export function proxySchemeLabel(scheme: OutboundProxy["scheme"]) {
  return scheme === "socks5h" ? "SOCKS5h" : scheme.toUpperCase();
}

/** A proxy's display name: its own name, or where it runs. */
export function useProxyLabel() {
  const { t } = useTranslation();
  return (proxy: OutboundProxy) =>
    proxy.name || (proxy.kind === "host" ? t("maintenance.proxy.localMachine") : `${proxy.host}:${proxy.port}`);
}

/**
 * Administrator proxy settings: an ordered proxy list tried by priority, and
 * the scopes that use it, with per-source overrides for remote sources. Every
 * change is saved immediately.
 */
export function ProxySettingsSection({
  proxy: saved,
  remoteSources,
  readOnly,
  onSaved,
}: {
  proxy: ProxySettings;
  remoteSources: FileSource[];
  readOnly: boolean;
  onSaved: (settings: AppSettings) => void;
}) {
  const { t } = useTranslation();
  const proxyLabel = useProxyLabel();
  const { draft, saving, save } = useProxySettingsSave(saved, onSaved);
  const [editing, setEditing] = useState<{ proxy: ProxyDraft; existing: boolean } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProxyDraft | null>(null);
  const hasProxies = draft.proxies.length > 0;
  const locked = readOnly || saving;
  // The row title already names an unnamed proxy by its kind or address.
  const proxyDetails = (proxy: ProxyDraft) =>
    [
      proxy.name || proxy.kind === "custom"
        ? proxy.kind === "host"
          ? t("maintenance.proxy.localMachine")
          : t("maintenance.proxy.otherAddress")
        : null,
      proxySchemeLabel(proxy.scheme),
      proxy.name || proxy.kind === "host" ? proxyAddress(proxy, saved.hostAddress) : null,
      proxy.username ? t("maintenance.proxy.authenticated") : null,
    ]
      .filter(Boolean)
      .join(" · ");

  const saveProxy = async (proxy: ProxyDraft) => {
    if (await save(upsertProxy(draft, proxy))) setEditing(null);
  };

  const deleteProxy = async () => {
    if (!pendingDelete) return;
    if (await save(removeProxy(draft, pendingDelete.id), t("maintenance.proxy.deleted"))) setPendingDelete(null);
  };

  const scopeCopy: Record<ProxyScope, { title: string; description: string }> = {
    dlsite: {
      title: t("maintenance.proxy.scopes.dlsite"),
      description: t("maintenance.proxy.scopes.dlsiteDescription"),
    },
    remote: {
      title: t("maintenance.proxy.scopes.remote"),
      description: t("maintenance.proxy.scopes.remoteDescription"),
    },
    other: { title: t("maintenance.proxy.scopes.other"), description: t("maintenance.proxy.scopes.otherDescription") },
  };

  const proxyOptions = draft.proxies.map((proxy) => (
    <option key={proxy.id} value={`proxy:${proxy.id}`}>
      {proxyLabel(proxy)}
    </option>
  ));

  return (
    <>
      <SettingsSection
        id="proxy"
        title={t("maintenance.proxy.title")}
        description={t("maintenance.proxy.description")}
        icon={<Network />}
        action={
          <Button
            variant="outline"
            size="sm"
            disabled={locked}
            onClick={() => setEditing({ proxy: emptyProxy(draft.proxies), existing: false })}
          >
            <Plus className="h-4 w-4" />
            {t("maintenance.proxy.add")}
          </Button>
        }
      >
        {draft.proxies.map((proxy, index) => (
          <div key={proxy.id} className="flex min-w-0 items-center gap-3 px-4 py-3">
            <span
              className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium tabular-nums text-muted-foreground"
              title={t("maintenance.proxy.priority", { count: index + 1 })}
            >
              {index + 1}
            </span>
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              onClick={() => setEditing({ proxy, existing: true })}
            >
              <span className="block truncate text-sm font-medium">{proxyLabel(proxy)}</span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">{proxyDetails(proxy)}</span>
            </button>
            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label={t("maintenance.proxy.moveUp", { name: proxyLabel(proxy) })}
                title={t("maintenance.proxy.moveUp", { name: proxyLabel(proxy) })}
                disabled={locked || index === 0}
                onClick={() => void save(moveProxy(draft, proxy.id, -1))}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label={t("maintenance.proxy.moveDown", { name: proxyLabel(proxy) })}
                title={t("maintenance.proxy.moveDown", { name: proxyLabel(proxy) })}
                disabled={locked || index === draft.proxies.length - 1}
                onClick={() => void save(moveProxy(draft, proxy.id, 1))}
              >
                <ArrowDown className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label={t("maintenance.proxy.edit", { name: proxyLabel(proxy) })}
                title={t("maintenance.proxy.edit", { name: proxyLabel(proxy) })}
                onClick={() => setEditing({ proxy, existing: true })}
              >
                <Settings2 className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                aria-label={t("maintenance.proxy.delete", { name: proxyLabel(proxy) })}
                title={t("maintenance.proxy.delete", { name: proxyLabel(proxy) })}
                disabled={locked}
                onClick={() => setPendingDelete(proxy)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ))}
        {!hasProxies && (
          <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
            <span className="grid h-10 w-10 place-items-center rounded-full bg-muted text-muted-foreground">
              <Network className="h-5 w-5" />
            </span>
            <p className="max-w-sm text-sm text-muted-foreground">{t("maintenance.proxy.empty")}</p>
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        id="proxy-scope"
        title={t("maintenance.proxy.scopeTitle")}
        description={hasProxies ? t("maintenance.proxy.scopeDescription") : t("maintenance.proxy.scopeNeedsProxy")}
        icon={<Route />}
      >
        <SettingsRow
          title={t("maintenance.proxy.scopes.all")}
          description={t("maintenance.proxy.scopes.allDescription")}
        >
          <Switch
            checked={allRoutesEnabled(draft.routes)}
            disabled={locked || !hasProxies}
            aria-label={t("maintenance.proxy.useProxyFor", { scope: t("maintenance.proxy.scopes.all") })}
            onCheckedChange={(enabled) => void save(setAllRoutesEnabled(draft, enabled))}
          />
        </SettingsRow>
        {PROXY_SCOPES.map((scope) => {
          const route = draft.routes[scope];
          const selection = routeSelection(route.proxyIds);
          return (
            <div key={scope} className="min-w-0">
              <SettingsRow title={scopeCopy[scope].title} description={scopeCopy[scope].description}>
                <NativeSelect
                  fieldSize="sm"
                  className="w-full min-w-0 sm:w-52"
                  value={selection}
                  disabled={locked || !route.enabled}
                  aria-label={t("maintenance.proxy.proxyFor", { scope: scopeCopy[scope].title })}
                  onChange={(event) => void save(setRouteSelection(draft, scope, event.target.value as RouteSelection))}
                >
                  <option value="all">{t("maintenance.proxy.allProxies")}</option>
                  {selection === "custom" && <option value="custom">{t("maintenance.proxy.customSelection")}</option>}
                  {proxyOptions}
                </NativeSelect>
                <Switch
                  checked={route.enabled}
                  disabled={locked || !hasProxies}
                  aria-label={t("maintenance.proxy.useProxyFor", { scope: scopeCopy[scope].title })}
                  onCheckedChange={(enabled) => void save(setRouteEnabled(draft, scope, enabled))}
                />
              </SettingsRow>
              {scope === "remote" && remoteSources.length > 0 && (
                <div className="divide-y border-t bg-muted/15">
                  {remoteSources.map((source) => {
                    const value = sourceSelection(draft.routes, source.id);
                    return (
                      <SettingsRow key={source.id} className="py-2.5 sm:pl-10" title={source.displayName}>
                        <NativeSelect
                          fieldSize="sm"
                          className={cn("w-full min-w-0 sm:w-52", value !== "inherit" && "font-medium")}
                          value={value}
                          disabled={locked}
                          aria-label={t("maintenance.proxy.sourceProxy", { name: source.displayName })}
                          onChange={(event) =>
                            void save(setSourceSelection(draft, source.id, event.target.value as SourceSelection))
                          }
                        >
                          <option value="inherit">{t("maintenance.proxy.sourceInherit")}</option>
                          <option value="direct">{t("maintenance.proxy.sourceDirect")}</option>
                          {hasProxies && <option value="all">{t("maintenance.proxy.allProxies")}</option>}
                          {value === "custom" && (
                            <option value="custom">{t("maintenance.proxy.customSelection")}</option>
                          )}
                          {proxyOptions}
                        </NativeSelect>
                      </SettingsRow>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        <SettingsRow
          title={t("maintenance.proxy.directFallback")}
          description={t("maintenance.proxy.directFallbackDescription")}
        >
          <Switch
            checked={draft.directFallback}
            disabled={locked || !hasProxies}
            aria-label={t("maintenance.proxy.directFallback")}
            onCheckedChange={(enabled) => void save(setDirectFallback(draft, enabled))}
          />
        </SettingsRow>
      </SettingsSection>

      {editing && (
        <ProxyDialog
          proxy={editing.proxy}
          hostAddress={saved.hostAddress}
          editing={editing.existing}
          saving={saving}
          readOnly={readOnly}
          onSave={saveProxy}
          onClose={() => setEditing(null)}
        />
      )}
      {pendingDelete && (
        <Dialog onClose={() => setPendingDelete(null)} size="md" dismissible={!saving}>
          <DialogHeader title={t("maintenance.proxy.deleteTitle")} />
          <DialogBody>
            <div className="rounded-lg border bg-muted/25 px-3 py-3">
              <div className="truncate text-sm font-semibold">{proxyLabel(pendingDelete)}</div>
              <p className="mt-1 text-xs text-muted-foreground">{t("maintenance.proxy.deleteDescription")}</p>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" size="sm" disabled={saving} onClick={() => setPendingDelete(null)}>
              {t("maintenance.cancel")}
            </Button>
            <Button variant="destructive" size="sm" disabled={saving} onClick={() => void deleteProxy()}>
              {t("maintenance.proxy.deleteConfirm")}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </>
  );
}
