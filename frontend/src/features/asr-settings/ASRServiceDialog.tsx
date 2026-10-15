import { ContentMaximumField } from "@/components/settings/ContentMaximumField";
import { Globe, Laptop, Loader2, Plus, RefreshCw, Save } from "lucide-react";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { EnabledModelsField } from "@/components/settings/EnabledModelsField";
import { PresetDialogBody, presetDialogClassName } from "@/components/settings/PresetDialogBody";
import { SettingsField, SettingsSwitchRow } from "@/components/settings/SettingsFormControls";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input, otherCredentialFieldProps } from "@/components/ui/input";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import type { ASRPreset, ASRProvider, ASRScope } from "@/lib/api";

import {
  draftFromPreset,
  draftFromProvider,
  endpointMissing,
  keyMissing,
  portMissing,
  replacesConnection,
  usesDerivedHost,
  withPreset,
  type ASRServiceDraft,
} from "./asrSettingsModel";

/**
 * Adds or edits one speech recognition service. A local deployment on this
 * server's machine is reached through the server's host gateway, so only its
 * port is entered; any other location takes an origin.
 */
export function ASRServiceDialog({
  presets,
  provider,
  hostAddress,
  onSave,
  onFetchModels,
  onClose,
}: {
  presets: ASRPreset[];
  /** The service to edit, or null to add one. */
  provider: ASRProvider | null;
  hostAddress: string;
  /** Resolves to the saved service, or null when the save failed. */
  onSave: (draft: ASRServiceDraft) => Promise<ASRProvider | null>;
  /** Resolves to the service as last saved, or null when it could not be saved. */
  onFetchModels: (draft: ASRServiceDraft) => Promise<ASRProvider | null>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ASRServiceDraft>(() =>
    provider ? draftFromProvider(provider) : draftFromPreset(presets[0]),
  );
  const [pending, setPending] = useState<"save" | "fetch" | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const endpointHintId = useId();
  const portHintId = useId();
  const keyHintId = useId();
  const boundaryHintId = useId();
  const patch = (next: Partial<ASRServiceDraft>) => setDraft((current) => ({ ...current, ...next }));

  const preset = presets.find((item) => item.id === draft.presetId);
  const editing = Boolean(draft.id);
  // A service being added keeps its preset list after fetching models saves it, so the layout stays put.
  const adding = provider === null;
  const busy = pending !== null;
  const derivedHost = usesDerivedHost(draft);
  const missingEndpoint = endpointMissing(draft, preset);
  const missingPort = portMissing(draft);
  const missingKey = keyMissing(draft, preset);
  const invalid = missingEndpoint || missingPort || missingKey;
  const keyWillBeDropped = replacesConnection(draft) && draft.hasApiKey && !draft.apiKey && !draft.clearKey;

  const setScope = (scope: ASRScope) =>
    patch({
      scope,
      baseUrl: scope === "other_machine" && draft.savedScope === "other_machine" ? draft.savedBaseUrl : "",
    });

  const selectPreset = (id: string) => {
    const next = presets.find((item) => item.id === id);
    if (next) setDraft((current) => withPreset(current, next));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (invalid) {
      setShowErrors(true);
      return;
    }
    setPending("save");
    const saved = await onSave(draft);
    setPending(null);
    if (saved) onClose();
  };

  const fetchModels = async () => {
    if (busy) return;
    if (invalid) {
      setShowErrors(true);
      return;
    }
    setPending("fetch");
    const saved = await onFetchModels(draft);
    setPending(null);
    if (saved) setDraft(draftFromProvider(saved));
  };

  const scopes: Array<{ scope: ASRScope; icon: ReactNode; label: string }> = [
    { scope: "local_machine", icon: <Laptop className="h-4 w-4" />, label: t("maintenance.asr.locationLocal") },
    { scope: "other_machine", icon: <Globe className="h-4 w-4" />, label: t("maintenance.asr.locationOther") },
  ];
  const boundaries: Array<{ boundary: ASRServiceDraft["boundary"]; label: string }> = [
    { boundary: "external", label: t("maintenance.asr.boundaryExternal") },
    { boundary: "private", label: t("maintenance.asr.boundaryPrivate") },
  ];

  return (
    <Dialog onClose={onClose} size={adding ? "xl" : "lg"} className={presetDialogClassName} dismissible={!busy}>
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => void submit(event)} noValidate>
        <DialogHeader
          title={editing ? t("maintenance.asr.editTitle") : t("maintenance.asr.addTitle")}
          description={editing ? preset?.name : t("maintenance.asr.serviceDescription")}
          onClose={onClose}
          closeLabel={t("maintenance.close")}
        />
        <PresetDialogBody
          disabled={busy}
          picker={
            adding
              ? {
                  label: t("maintenance.asr.service"),
                  items: presets.map((item) => ({
                    id: item.id,
                    label: t(`maintenance.asr.presets.${item.id}`, { defaultValue: item.name }),
                  })),
                  selectedId: draft.presetId,
                  locked: editing,
                  onSelect: selectPreset,
                }
              : null
          }
        >
          <fieldset disabled={busy} className="min-w-0 space-y-5 border-0 p-0">
            <SettingsField label={t("maintenance.asr.name")} hint={t("maintenance.asr.nameDescription")}>
              <Input
                value={draft.name}
                maxLength={128}
                autoComplete="off"
                placeholder={
                  preset ? t(`maintenance.asr.presets.${preset.id}`, { defaultValue: preset.name }) : undefined
                }
                onChange={(event) => patch({ name: event.target.value })}
              />
            </SettingsField>

            {preset?.local && (
              <div className="space-y-2">
                <div role="radiogroup" aria-label={t("maintenance.asr.location")} className={segmentedListClassName()}>
                  {scopes.map(({ scope, icon, label }) => (
                    <button
                      key={scope}
                      type="button"
                      role="radio"
                      aria-checked={draft.scope === scope}
                      className={segmentedItemClassName(draft.scope === scope)}
                      onClick={() => setScope(scope)}
                    >
                      {icon}
                      {label}
                    </button>
                  ))}
                </div>
                <p className="text-xs leading-5 text-muted-foreground">{t("maintenance.asr.locationDescription")}</p>
              </div>
            )}

            {derivedHost ? (
              <div className="grid min-w-0 gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
                <SettingsField label={t("maintenance.asr.host")} hint={t("maintenance.asr.hostDescription")}>
                  <Input value={hostAddress} readOnly className="min-w-0 bg-muted/40" />
                </SettingsField>
                <SettingsField
                  label={t("maintenance.asr.port")}
                  hintId={portHintId}
                  hint={t("maintenance.asr.portDescription")}
                >
                  <Input
                    className="min-w-0"
                    value={draft.port}
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={5}
                    placeholder={String(preset?.defaultPort ?? 8000)}
                    aria-describedby={portHintId}
                    aria-invalid={showErrors && missingPort}
                    onChange={(event) => patch({ port: event.target.value.replace(/\D/g, "") })}
                  />
                </SettingsField>
              </div>
            ) : (
              <SettingsField
                label={t("maintenance.asr.endpoint")}
                hintId={endpointHintId}
                hint={
                  preset?.defaultUrl
                    ? `${t("maintenance.asr.endpointDescription")} ${t("maintenance.asr.endpointDefaultHint")}`
                    : t("maintenance.asr.endpointDescription")
                }
              >
                <Input
                  value={draft.baseUrl}
                  inputMode="url"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  placeholder={preset?.defaultUrl || "http://asr.example.invalid:8000"}
                  aria-describedby={endpointHintId}
                  aria-invalid={showErrors && missingEndpoint}
                  onChange={(event) => patch({ baseUrl: event.target.value })}
                />
              </SettingsField>
            )}

            <div className="grid min-w-0 gap-2">
              <SettingsField
                label={t("maintenance.asr.apiKey")}
                hintId={keyHintId}
                hintClassName={keyWillBeDropped ? "text-warning-foreground" : undefined}
                hint={
                  keyWillBeDropped
                    ? t("maintenance.asr.connectionChangeHint")
                    : draft.hasApiKey
                      ? t("maintenance.asr.keyConfigured")
                      : `${preset?.keyRequired ? t("maintenance.asr.credentialRequired") : t("maintenance.asr.credentialOptional")} ${t("maintenance.asr.apiKeyDescription")}`
                }
              >
                <Input
                  type="password"
                  {...otherCredentialFieldProps}
                  maxLength={4096}
                  value={draft.clearKey ? "" : draft.apiKey}
                  disabled={draft.clearKey}
                  aria-describedby={keyHintId}
                  aria-invalid={showErrors && missingKey}
                  onChange={(event) => patch({ apiKey: event.target.value })}
                />
              </SettingsField>
              {draft.hasApiKey && (
                <label className="flex w-fit items-center gap-2 text-sm">
                  <Checkbox
                    checked={draft.clearKey}
                    aria-label={t("maintenance.asr.clearKey")}
                    onCheckedChange={(clearKey) => patch({ clearKey })}
                  />
                  {t("maintenance.asr.clearKey")}
                </label>
              )}
            </div>

            <EnabledModelsField
              models={draft.enabledModels}
              defaultModel={draft.defaultModel}
              suggestions={draft.models}
              hint={
                draft.models.length > 0
                  ? t("maintenance.asr.modelsAvailable", { count: draft.models.length })
                  : t("maintenance.asr.modelDescription")
              }
              action={
                <Button type="button" variant="outline" className="shrink-0" onClick={() => void fetchModels()}>
                  {pending === "fetch" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  {t("maintenance.asr.fetchModels")}
                </Button>
              }
              onChange={(enabledModels, defaultModel) => patch({ enabledModels, defaultModel })}
            />

            <div className="space-y-3 border-t pt-5">
              <div className="space-y-2">
                <span className="block text-sm font-medium">{t("maintenance.asr.boundary")}</span>
                <div
                  role="radiogroup"
                  aria-label={t("maintenance.asr.boundary")}
                  aria-describedby={boundaryHintId}
                  className={segmentedListClassName()}
                >
                  {boundaries.map(({ boundary, label }) => (
                    <button
                      key={boundary}
                      type="button"
                      role="radio"
                      aria-checked={draft.boundary === boundary}
                      className={segmentedItemClassName(draft.boundary === boundary)}
                      onClick={() => patch({ boundary })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p id={boundaryHintId} className="text-xs leading-5 text-muted-foreground">
                  {t("maintenance.asr.boundaryHint")}
                </p>
              </div>
              <ContentMaximumField
                value={draft.maxContentClass}
                onChange={(maxContentClass) => patch({ maxContentClass })}
              />
              <SettingsSwitchRow
                title={t("maintenance.asr.enabled")}
                description={t("maintenance.asr.enabledDescription")}
                checked={draft.enabled}
                onCheckedChange={(enabled) => patch({ enabled })}
              />
            </div>

            {showErrors && invalid && (
              <p role="alert" className="text-xs text-error-foreground">
                {missingPort
                  ? t("maintenance.asr.portRequired")
                  : missingEndpoint
                    ? t("maintenance.asr.endpointRequired")
                    : t("maintenance.asr.credentialMissing")}
              </p>
            )}
          </fieldset>
        </PresetDialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onClose}>
            {t("maintenance.cancel")}
          </Button>
          <Button type="submit" size="sm" disabled={busy}>
            {pending === "save" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : editing ? (
              <Save className="h-4 w-4" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            {editing ? t("maintenance.asr.save") : t("maintenance.asr.add")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
