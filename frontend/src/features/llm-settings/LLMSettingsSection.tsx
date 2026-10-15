import { Bot, Cloud, Loader2, Plus, RefreshCw, Save, Server, Settings2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { SettingsSection } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { toastFromError, useToast } from "@/components/ui/toast";
import { api, type LLMPolicy, type LLMProvider, type LLMProviderPreset } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import { LLMPolicyEditor } from "./LLMPolicyEditor";
import { LLMProviderDialog } from "./LLMProviderDialog";
import { ServiceNotice } from "./ServiceNotice";
import { createPayload, emptyPolicy, policiesEqual, updatePayload, type ProviderDraft } from "./llmSettingsModel";

/**
 * Administrator LLM settings: the providers offered for translation, each
 * added and edited in a dialog, and the content safety policy that decides
 * what may be sent to them. `otherServices` sits between the providers and the
 * policy, for services that the same policy governs.
 */
export function LLMSettingsSection({
  readOnly = false,
  otherServices,
}: {
  readOnly?: boolean;
  otherServices?: ReactNode;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [providers, setProviders] = useState<LLMProvider[]>([]);
  const [presets, setPresets] = useState<LLMProviderPreset[]>([]);
  const [savedPolicy, setSavedPolicy] = useState<LLMPolicy>(emptyPolicy);
  const [policy, setPolicy] = useState<LLMPolicy>(emptyPolicy);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "failed">("loading");
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<{ provider: LLMProvider | null } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<LLMProvider | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [togglingID, setTogglingID] = useState<string | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [noticeAccepted, setNoticeAccepted] = useState(false);

  const policyDirty = !policiesEqual(policy, savedPolicy);
  const policyDirtyRef = useRef(policyDirty);
  useEffect(() => {
    policyDirtyRef.current = policyDirty;
  });

  // The first load owns the section's loading and failed states; a later refresh keeps the list in place.
  const load = useCallback(
    async (refresh = false) => {
      if (refresh) setRefreshing(true);
      else setLoadState("loading");
      try {
        const result = await api.listProviders();
        setProviders(result.providers);
        setPresets(result.presets);
        setSavedPolicy(result.policy);
        setNoticeAccepted(result.noticeAccepted);
        // A refresh leaves unsaved policy edits as they are.
        if (!refresh || !policyDirtyRef.current) setPolicy(result.policy);
        setLoadState("ready");
      } catch (error) {
        if (!refresh) setLoadState("failed");
        toast.notify(toastFromError(error, t("maintenance.llm.loadFailed")));
      } finally {
        setRefreshing(false);
      }
    },
    [t, toast],
  );

  useEffect(() => {
    if (!readOnly) void load();
  }, [load, readOnly]);

  const upsert = (next: LLMProvider) =>
    setProviders((current) =>
      current.some((provider) => provider.id === next.id)
        ? current.map((provider) => (provider.id === next.id ? next : provider))
        : [...current, next],
    );

  const persist = async (draft: ProviderDraft) => {
    try {
      const saved = draft.id
        ? await api.updateProvider(draft.id, updatePayload(draft))
        : await api.createProvider(createPayload(draft));
      upsert(saved);
      return saved;
    } catch (error) {
      toast.notify(toastFromError(error, t("maintenance.llm.saveFailed")));
      return null;
    }
  };

  const saveProvider = async (draft: ProviderDraft) => {
    const saved = await persist(draft);
    if (saved) toast.success(draft.id ? t("maintenance.llm.saved") : t("maintenance.llm.added"));
    return saved;
  };

  const fetchModels = async (draft: ProviderDraft) => {
    const saved = await persist(draft);
    if (!saved) return null;
    if (!draft.id) toast.success(t("maintenance.llm.added"));
    try {
      const next = await api.fetchModels(saved.id);
      upsert(next);
      toast.success(t("maintenance.llm.modelsFetched", { count: next.models.length }));
      return next;
    } catch (error) {
      toast.notify(toastFromError(error, t("maintenance.llm.fetchFailed")));
      return saved;
    }
  };

  const setEnabled = async (provider: LLMProvider, enabled: boolean) => {
    setTogglingID(provider.id);
    // Show the choice at once; a failed save puts the row back.
    upsert({ ...provider, enabled });
    try {
      upsert(await api.updateProvider(provider.id, { enabled }));
    } catch (error) {
      upsert(provider);
      toast.notify(toastFromError(error, t("maintenance.llm.saveFailed")));
    } finally {
      setTogglingID(null);
    }
  };

  const deleteProvider = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.deleteProvider(pendingDelete.id);
      setProviders((current) => current.filter((provider) => provider.id !== pendingDelete.id));
      setPendingDelete(null);
      toast.success(t("maintenance.llm.deleted"));
    } catch (error) {
      toast.notify(toastFromError(error, t("maintenance.llm.deleteFailed")));
    } finally {
      setDeleting(false);
    }
  };

  const savePolicy = async () => {
    setSavingPolicy(true);
    try {
      const next = await api.updatePolicy(policy);
      setSavedPolicy(next);
      setPolicy(next);
      toast.success(t("maintenance.llm.policySaved"));
    } catch (error) {
      toast.notify(toastFromError(error, t("maintenance.llm.policySaveFailed")));
    } finally {
      setSavingPolicy(false);
    }
  };

  if (readOnly) {
    return (
      <div className="space-y-6">
        <SettingsSection title={t("maintenance.llm.title")} description={t("maintenance.llm.description")}>
          <EmptyState icon={<Bot className="h-5 w-5" />}>{t("maintenance.llm.demoDisabled")}</EmptyState>
        </SettingsSection>
        {otherServices}
      </div>
    );
  }

  const ready = loadState === "ready";
  // Until the external service notice is accepted, the tab stays visible but cannot be used.
  const locked = ready && !noticeAccepted;
  const presetName = (provider: LLMProvider) =>
    presets.find((preset) => preset.id === provider.presetId)?.name ?? provider.presetId;

  return (
    <div className="relative">
      <div className="space-y-6" inert={locked} aria-hidden={locked || undefined}>
        <SettingsSection
          title={t("maintenance.llm.title")}
          description={t("maintenance.llm.description")}
          action={
            <>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("maintenance.llm.refresh")}
                title={t("maintenance.llm.refresh")}
                disabled={!ready || refreshing}
                onClick={() => void load(true)}
              >
                <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!ready || presets.length === 0}
                onClick={() => setEditing({ provider: null })}
              >
                <Plus className="h-4 w-4" />
                {t("maintenance.llm.add")}
              </Button>
            </>
          }
        >
          {loadState === "loading" ? (
            <EmptyState icon={<Loader2 className="h-5 w-5 animate-spin" />}>{t("maintenance.llm.loading")}</EmptyState>
          ) : loadState === "failed" ? (
            <div role="alert" className="flex flex-col items-center gap-3 px-4 py-8 text-center">
              <p className="max-w-sm text-sm text-error-foreground">{t("maintenance.llm.loadFailed")}</p>
              <Button variant="outline" size="sm" onClick={() => void load()}>
                <RefreshCw className="h-4 w-4" />
                {t("common.retry")}
              </Button>
            </div>
          ) : providers.length === 0 ? (
            <EmptyState icon={<Bot className="h-5 w-5" />}>{t("maintenance.llm.empty")}</EmptyState>
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
                    {provider.boundary === "private"
                      ? t("maintenance.llm.privateBoundary")
                      : t("maintenance.llm.externalBoundary")}
                    {" · "}
                    {provider.defaultModel ? (
                      provider.defaultModel
                    ) : (
                      <span className="text-warning-foreground">{t("maintenance.llm.modelNone")}</span>
                    )}
                  </span>
                </button>
                <div className="flex shrink-0 items-center gap-0.5">
                  <Switch
                    className="mr-2"
                    checked={provider.enabled}
                    disabled={togglingID === provider.id}
                    aria-label={t("maintenance.llm.enableNamed", { name: provider.name })}
                    onCheckedChange={(enabled) => void setEnabled(provider, enabled)}
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("maintenance.llm.editNamed", { name: provider.name })}
                    title={t("maintenance.llm.editNamed", { name: provider.name })}
                    onClick={() => setEditing({ provider })}
                  >
                    <Settings2 className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    aria-label={t("maintenance.llm.deleteNamed", { name: provider.name })}
                    title={t("maintenance.llm.deleteNamed", { name: provider.name })}
                    onClick={() => setPendingDelete(provider)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </SettingsSection>

        {otherServices}

        {ready && (
          <SettingsSection
            title={t("maintenance.llm.policyTitle")}
            description={t("maintenance.llm.policyDescription")}
            footer={
              <>
                {policyDirty && (
                  <span className="mr-auto text-xs text-muted-foreground">{t("maintenance.llm.policyUnsaved")}</span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={savingPolicy || !policyDirty}
                  onClick={() => setPolicy(savedPolicy)}
                >
                  {t("maintenance.llm.policyDiscard")}
                </Button>
                <Button size="sm" disabled={savingPolicy || !policyDirty} onClick={() => void savePolicy()}>
                  {savingPolicy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  {t("maintenance.llm.save")}
                </Button>
              </>
            }
          >
            <LLMPolicyEditor policy={policy} onChange={setPolicy} disabled={savingPolicy} />
          </SettingsSection>
        )}
      </div>
      {locked && (
        <div className="absolute inset-0 z-10 bg-background/70 px-4 pt-6 backdrop-blur-[2px]">
          <ServiceNotice onAccepted={() => setNoticeAccepted(true)} />
        </div>
      )}

      {editing && (
        <LLMProviderDialog
          presets={presets}
          provider={editing.provider}
          onSave={saveProvider}
          onFetchModels={fetchModels}
          onClose={() => setEditing(null)}
        />
      )}
      {pendingDelete && (
        <Dialog onClose={() => setPendingDelete(null)} size="md" dismissible={!deleting}>
          <DialogHeader title={t("maintenance.llm.deleteTitle")} />
          <DialogBody>
            <div className="rounded-lg border bg-muted/25 px-3 py-3">
              <div className="truncate text-sm font-semibold">{pendingDelete.name}</div>
              <p className="mt-1 text-xs text-muted-foreground">{t("maintenance.llm.deleteDescription")}</p>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" size="sm" disabled={deleting} onClick={() => setPendingDelete(null)}>
              {t("maintenance.cancel")}
            </Button>
            <Button variant="destructive" size="sm" disabled={deleting} onClick={() => void deleteProvider()}>
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {t("maintenance.llm.delete")}
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
