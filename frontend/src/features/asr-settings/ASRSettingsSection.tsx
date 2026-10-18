import { AudioLines, Cloud, Loader2, Plus, RefreshCw, Server, Settings2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { SettingsSection } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { toastFromError, useToast } from "@/components/ui/toast";
import { api, type ASRPreset, type ASRProvider } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import { ASRServiceDialog } from "./ASRServiceDialog";
import { createPayload, updatePayload, type ASRServiceDraft } from "./asrSettingsModel";

/**
 * Administrator speech recognition settings: the OpenAI-compatible services
 * tracks can be transcribed with, each added and edited in a dialog.
 */
export function ASRSettingsSection({ readOnly = false }: { readOnly?: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [providers, setProviders] = useState<ASRProvider[]>([]);
  const [presets, setPresets] = useState<ASRPreset[]>([]);
  const [hostAddress, setHostAddress] = useState("");
  const [loadState, setLoadState] = useState<"loading" | "ready" | "failed">("loading");
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<{ provider: ASRProvider | null } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ASRProvider | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [togglingID, setTogglingID] = useState<string | null>(null);

  // The first load owns the section's loading and failed states; a later refresh keeps the list in place.
  const load = useCallback(
    async (refresh = false) => {
      if (refresh) setRefreshing(true);
      else setLoadState("loading");
      try {
        const result = await api.listASRProviders();
        setProviders(result.providers);
        setPresets(result.presets);
        setHostAddress(result.hostAddress);
        setLoadState("ready");
      } catch (error) {
        if (!refresh) setLoadState("failed");
        toast.notify(toastFromError(error, t("maintenance.asr.loadFailed")));
      } finally {
        setRefreshing(false);
      }
    },
    [t, toast],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const upsert = (next: ASRProvider) =>
    setProviders((current) =>
      current.some((provider) => provider.id === next.id)
        ? current.map((provider) => (provider.id === next.id ? next : provider))
        : [...current, next],
    );

  const persist = async (draft: ASRServiceDraft) => {
    try {
      const saved = draft.id
        ? await api.updateASRProvider(draft.id, updatePayload(draft))
        : await api.createASRProvider(createPayload(draft));
      upsert(saved);
      return saved;
    } catch (error) {
      toast.notify(toastFromError(error, t("maintenance.asr.saveFailed")));
      return null;
    }
  };

  const saveProvider = async (draft: ASRServiceDraft) => {
    const saved = await persist(draft);
    if (saved) toast.success(draft.id ? t("maintenance.asr.saved") : t("maintenance.asr.added"));
    return saved;
  };

  const fetchModels = async (draft: ASRServiceDraft) => {
    const saved = await persist(draft);
    if (!saved) return null;
    if (!draft.id) toast.success(t("maintenance.asr.added"));
    try {
      const next = await api.fetchASRModels(saved.id);
      upsert(next);
      toast.success(t("maintenance.asr.modelsFetched", { count: next.models.length }));
      return next;
    } catch (error) {
      toast.notify(toastFromError(error, t("maintenance.asr.fetchFailed")));
      return saved;
    }
  };

  const setEnabled = async (provider: ASRProvider, enabled: boolean) => {
    setTogglingID(provider.id);
    // Show the choice at once; a failed save puts the row back.
    upsert({ ...provider, enabled });
    try {
      upsert(await api.updateASRProvider(provider.id, { enabled }));
    } catch (error) {
      upsert(provider);
      toast.notify(toastFromError(error, t("maintenance.asr.saveFailed")));
    } finally {
      setTogglingID(null);
    }
  };

  const deleteProvider = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.deleteASRProvider(pendingDelete.id);
      setProviders((current) => current.filter((provider) => provider.id !== pendingDelete.id));
      setPendingDelete(null);
      toast.success(t("maintenance.asr.deleted"));
    } catch (error) {
      toast.notify(toastFromError(error, t("maintenance.asr.deleteFailed")));
    } finally {
      setDeleting(false);
    }
  };

  const ready = loadState === "ready";
  const presetName = (provider: ASRProvider) => {
    const preset = presets.find((item) => item.id === provider.presetId);
    return t(`maintenance.asr.presets.${provider.presetId}`, { defaultValue: preset?.name ?? provider.presetId });
  };
  const location = (provider: ASRProvider) =>
    provider.scope === "local_machine"
      ? t("maintenance.asr.locationLocalPort", { port: provider.port })
      : provider.boundary === "private"
        ? t("maintenance.asr.privateBoundary")
        : t("maintenance.asr.externalBoundary");

  return (
    <div className="space-y-6">
      <SettingsSection
        title={t("maintenance.asr.title")}
        description={t("maintenance.asr.description")}
        action={
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("maintenance.asr.refresh")}
              title={t("maintenance.asr.refresh")}
              disabled={!ready || refreshing}
              onClick={() => void load(true)}
            >
              <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={readOnly || !ready || presets.length === 0}
              onClick={() => setEditing({ provider: null })}
            >
              <Plus className="h-4 w-4" />
              {t("maintenance.asr.add")}
            </Button>
          </>
        }
      >
        {loadState === "loading" ? (
          <EmptyState icon={<Loader2 className="h-5 w-5 animate-spin" />}>{t("maintenance.asr.loading")}</EmptyState>
        ) : loadState === "failed" ? (
          <div role="alert" className="flex flex-col items-center gap-3 px-4 py-8 text-center">
            <p className="max-w-sm text-sm text-error-foreground">{t("maintenance.asr.loadFailed")}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw className="h-4 w-4" />
              {t("common.retry")}
            </Button>
          </div>
        ) : providers.length === 0 ? (
          <EmptyState icon={<AudioLines className="h-5 w-5" />}>{t("maintenance.asr.empty")}</EmptyState>
        ) : (
          providers.map((provider) => (
            <div key={provider.id} className="flex min-w-0 items-center gap-3 px-4 py-3">
              <span
                className={cn(
                  "hidden h-9 w-9 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground sm:grid",
                  !provider.enabled && "opacity-60",
                )}
                aria-hidden="true"
              >
                {provider.boundary === "private" ? <Server className="h-4 w-4" /> : <Cloud className="h-4 w-4" />}
              </span>
              <button
                type="button"
                className={cn("min-w-0 flex-1 text-left", !provider.enabled && "opacity-60")}
                onClick={() => setEditing({ provider })}
              >
                <span className="block truncate text-sm font-medium">{provider.name}</span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {presetName(provider)}
                  {" · "}
                  {location(provider)}
                  {" · "}
                  {provider.defaultModel ? (
                    provider.enabledModels.length > 1 ? (
                      t("serviceModels.summary", {
                        model: provider.defaultModel,
                        count: provider.enabledModels.length - 1,
                      })
                    ) : (
                      provider.defaultModel
                    )
                  ) : (
                    <span className="text-warning-foreground">{t("maintenance.asr.modelNone")}</span>
                  )}
                </span>
              </button>
              <div className="flex shrink-0 items-center gap-0.5">
                <Switch
                  className="mr-2"
                  checked={provider.enabled}
                  disabled={readOnly || togglingID === provider.id}
                  aria-label={t("maintenance.asr.enableNamed", { name: provider.name })}
                  onCheckedChange={(enabled) => void setEnabled(provider, enabled)}
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("maintenance.asr.editNamed", { name: provider.name })}
                  title={t("maintenance.asr.editNamed", { name: provider.name })}
                  onClick={() => setEditing({ provider })}
                >
                  <Settings2 className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  aria-label={t("maintenance.asr.deleteNamed", { name: provider.name })}
                  title={t("maintenance.asr.deleteNamed", { name: provider.name })}
                  disabled={readOnly}
                  onClick={() => setPendingDelete(provider)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))
        )}
      </SettingsSection>

      {editing && (
        <ASRServiceDialog
          presets={presets}
          provider={editing.provider}
          hostAddress={hostAddress}
          onSave={saveProvider}
          onFetchModels={fetchModels}
          onClose={() => setEditing(null)}
          readOnly={readOnly}
        />
      )}
      {pendingDelete && (
        <Dialog onClose={() => setPendingDelete(null)} size="md" dismissible={!deleting}>
          <DialogHeader title={t("maintenance.asr.deleteTitle")} />
          <DialogBody>
            <div className="rounded-lg border bg-muted/25 px-3 py-3">
              <div className="truncate text-sm font-semibold">{pendingDelete.name}</div>
              <p className="mt-1 text-xs text-muted-foreground">{t("maintenance.asr.deleteDescription")}</p>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" size="sm" disabled={deleting} onClick={() => setPendingDelete(null)}>
              {t("maintenance.cancel")}
            </Button>
            <Button variant="destructive" size="sm" disabled={deleting} onClick={() => void deleteProvider()}>
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {t("maintenance.asr.delete")}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </div>
  );
}

function EmptyState({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
      <span className="grid h-10 w-10 place-items-center rounded-full bg-muted text-muted-foreground">{icon}</span>
      <p className="max-w-sm text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
