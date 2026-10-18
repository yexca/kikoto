import { ContentMaximumField } from "@/components/settings/ContentMaximumField";
import { Globe, Laptop, Loader2, Plus, RefreshCw, Save } from "lucide-react";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { EnabledModelsField } from "@/components/settings/EnabledModelsField";
import { PresetDialogBody, presetDialogClassName } from "@/components/settings/PresetDialogBody";
import { SettingsField as Field, SettingsSwitchRow as SwitchRow } from "@/components/settings/SettingsFormControls";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input, otherCredentialFieldProps } from "@/components/ui/input";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import type { LLMProvider, LLMProviderPreset } from "@/lib/api";

import {
  contextLengthInvalid,
  draftFromPreset,
  draftFromProvider,
  endpointMissing,
  keyMissing,
  OLLAMA_CONTEXT_LENGTH,
  portMissing,
  replacesConnection,
  REQUEST_TIMEOUT_MINUTES,
  requestTimeoutInvalid,
  usesDerivedEndpoint,
  usesDerivedHost,
  withPreset,
  type ProviderDraft,
} from "./llmSettingsModel";

/**
 * Adds or edits one LLM provider. Fetching models saves the connection first,
 * so a provider being added exists from that point and the dialog continues as
 * an edit of it. A local preset on this server's machine is reached through
 * the server's host gateway, so only its port is entered.
 */
export function LLMProviderDialog({
  presets,
  provider,
  hostAddress,
  onSave,
  onFetchModels,
  onClose,
  readOnly = false,
}: {
  presets: LLMProviderPreset[];
  /** The provider to edit, or null to add one. */
  provider: LLMProvider | null;
  hostAddress: string;
  /** Resolves to the saved provider, or null when the save failed. */
  onSave: (draft: ProviderDraft) => Promise<LLMProvider | null>;
  /** Resolves to the provider as last saved, or null when it could not be saved. */
  onFetchModels: (draft: ProviderDraft) => Promise<LLMProvider | null>;
  onClose: () => void;
  /** Demo opens a provider for inspection; every field stays visible but cannot be changed. */
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ProviderDraft>(() =>
    provider ? draftFromProvider(provider) : draftFromPreset(presets[0]),
  );
  const [pending, setPending] = useState<"save" | "fetch" | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const endpointHintId = useId();
  const portHintId = useId();
  const keyHintId = useId();
  const boundaryHintId = useId();
  const timeoutHintId = useId();
  const contextHintId = useId();
  const patch = (next: Partial<ProviderDraft>) => setDraft((current) => ({ ...current, ...next }));

  const preset = presets.find((item) => item.id === draft.presetId);
  const editing = Boolean(draft.id);
  // A provider being added keeps its preset list after fetching models saves it, so the layout stays put.
  const adding = provider === null;
  const busy = pending !== null;
  const derivedEndpoint = usesDerivedEndpoint(draft);
  const derivedHost = usesDerivedHost(draft);
  const missingEndpoint = endpointMissing(draft, preset);
  const missingPort = portMissing(draft);
  const missingKey = keyMissing(draft, preset);
  const keyWillBeDropped = replacesConnection(draft) && draft.hasApiKey && !draft.apiKey && !draft.clearKey;
  const timeoutInvalid = requestTimeoutInvalid(draft);
  const contextInvalid = contextLengthInvalid(draft);
  const connectionInvalid = missingEndpoint || missingPort || missingKey;
  const invalid = connectionInvalid || timeoutInvalid || contextInvalid;
  const ollama = draft.kind === "ollama";
  // Ollama keeps its own fixed-port location; a local preset is placed by scope and port.
  const location = ollama ? draft.ollamaScope : draft.scope;

  const setLocation = (scope: NonNullable<ProviderDraft["scope"]>) => {
    const savedScope = ollama ? draft.savedOllamaScope : draft.savedScope;
    // The address of a same-machine provider is derived by the server, not an origin to keep.
    const baseUrl = scope === "other_machine" && savedScope === "other_machine" ? draft.savedBaseUrl : "";
    patch(ollama ? { ollamaScope: scope, baseUrl } : { scope, baseUrl });
  };

  const selectPreset = (id: string) => {
    const next = presets.find((item) => item.id === id);
    if (next) setDraft((current) => withPreset(current, next));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || readOnly) return;
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

  const locations: Array<{ scope: NonNullable<ProviderDraft["scope"]>; icon: ReactNode; label: string }> = [
    { scope: "local_machine", icon: <Laptop className="h-4 w-4" />, label: t("maintenance.llm.ollamaLocal") },
    { scope: "other_machine", icon: <Globe className="h-4 w-4" />, label: t("maintenance.llm.ollamaOther") },
  ];
  const boundaries: Array<{ boundary: ProviderDraft["boundary"]; label: string }> = [
    { boundary: "external", label: t("maintenance.llm.boundaryExternal") },
    { boundary: "private", label: t("maintenance.llm.boundaryPrivate") },
  ];

  return (
    <Dialog onClose={onClose} size={adding ? "xl" : "lg"} className={presetDialogClassName} dismissible={!busy}>
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => void submit(event)} noValidate>
        <DialogHeader
          title={editing ? t("maintenance.llm.editTitle") : t("maintenance.llm.addTitle")}
          description={editing ? preset?.name : t("maintenance.llm.providerDescription")}
          onClose={onClose}
          closeLabel={t("maintenance.close")}
        />
        <PresetDialogBody
          disabled={busy}
          picker={
            adding
              ? {
                  label: t("maintenance.llm.provider"),
                  items: presets.map((item) => ({ id: item.id, label: item.name })),
                  selectedId: draft.presetId,
                  locked: editing,
                  onSelect: selectPreset,
                }
              : null
          }
        >
          <fieldset disabled={busy || readOnly} className="min-w-0 space-y-5 border-0 p-0">
            <Field label={t("maintenance.llm.name")} hint={t("maintenance.llm.nameDescription")}>
              <Input
                value={draft.name}
                maxLength={128}
                autoComplete="off"
                placeholder={preset?.name}
                onChange={(event) => patch({ name: event.target.value })}
              />
            </Field>

            {location && (
              <div className="space-y-2">
                <div
                  role="radiogroup"
                  aria-label={ollama ? t("maintenance.llm.ollamaLocation") : t("maintenance.llm.location")}
                  className={segmentedListClassName()}
                >
                  {locations.map(({ scope, icon, label }) => (
                    <button
                      key={scope}
                      type="button"
                      role="radio"
                      aria-checked={location === scope}
                      className={segmentedItemClassName(location === scope)}
                      onClick={() => setLocation(scope)}
                    >
                      {icon}
                      {label}
                    </button>
                  ))}
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  {ollama ? t("maintenance.llm.ollamaLocationDescription") : t("maintenance.llm.locationDescription")}
                </p>
              </div>
            )}

            {derivedHost ? (
              <div className="grid min-w-0 gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
                <Field label={t("maintenance.llm.host")} hint={t("maintenance.llm.ollamaLocalEndpoint")}>
                  <Input value={hostAddress} readOnly className="min-w-0 bg-muted/40" />
                </Field>
                <Field
                  label={t("maintenance.llm.port")}
                  hintId={portHintId}
                  hint={t("maintenance.llm.portDescription")}
                >
                  <Input
                    className="min-w-0"
                    value={draft.port}
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={5}
                    placeholder={preset?.defaultPort ? String(preset.defaultPort) : undefined}
                    aria-describedby={portHintId}
                    aria-invalid={showErrors && missingPort}
                    onChange={(event) => patch({ port: event.target.value.replace(/\D/g, "") })}
                  />
                </Field>
              </div>
            ) : derivedEndpoint ? (
              <Field label={t("maintenance.llm.endpoint")} hint={t("maintenance.llm.ollamaLocalEndpoint")}>
                <Input
                  value={
                    draft.savedOllamaScope === "local_machine" && draft.savedBaseUrl
                      ? draft.savedBaseUrl
                      : t("maintenance.llm.ollamaDerivedEndpoint")
                  }
                  readOnly
                  className="bg-muted/40"
                />
              </Field>
            ) : (
              <Field
                label={t("maintenance.llm.endpoint")}
                hintId={endpointHintId}
                hint={
                  preset?.defaultUrl
                    ? `${t("maintenance.llm.endpointDescription")} ${t("maintenance.llm.endpointDefaultHint")}`
                    : t("maintenance.llm.endpointDescription")
                }
              >
                <Input
                  value={draft.baseUrl}
                  inputMode="url"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  placeholder={preset?.defaultUrl || "https://llm.example.invalid"}
                  aria-describedby={endpointHintId}
                  aria-invalid={showErrors && missingEndpoint}
                  onChange={(event) => patch({ baseUrl: event.target.value })}
                />
              </Field>
            )}

            <div className="grid min-w-0 gap-2">
              <Field
                label={t("maintenance.llm.apiKey")}
                hintId={keyHintId}
                hintClassName={keyWillBeDropped ? "text-warning-foreground" : undefined}
                hint={
                  keyWillBeDropped
                    ? t("maintenance.llm.connectionChangeHint")
                    : draft.hasApiKey
                      ? t("maintenance.llm.keyConfigured")
                      : preset?.keyRequired
                        ? `${t("maintenance.llm.credentialRequired")} ${t("maintenance.llm.apiKeyDescription")}`
                        : t("maintenance.llm.apiKeyDescription")
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
              </Field>
              {draft.hasApiKey && (
                <label className="flex w-fit items-center gap-2 text-sm">
                  <Checkbox
                    checked={draft.clearKey}
                    aria-label={t("maintenance.llm.clearKey")}
                    onCheckedChange={(clearKey) => patch({ clearKey })}
                  />
                  {t("maintenance.llm.clearKey")}
                </label>
              )}
            </div>

            <EnabledModelsField
              models={draft.enabledModels}
              defaultModel={draft.defaultModel}
              suggestions={draft.models}
              hint={
                draft.models.length > 0
                  ? t("maintenance.llm.modelsAvailable", { count: draft.models.length })
                  : t("maintenance.llm.modelDescription")
              }
              action={
                <Button type="button" variant="outline" className="shrink-0" onClick={() => void fetchModels()}>
                  {pending === "fetch" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  {t("maintenance.llm.fetchModels")}
                </Button>
              }
              onChange={(enabledModels, defaultModel) => patch({ enabledModels, defaultModel })}
            />

            <div className="space-y-4 border-t pt-5">
              <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                <Field
                  label={t("maintenance.llm.requestTimeout")}
                  hintId={timeoutHintId}
                  hintClassName={showErrors && timeoutInvalid ? "text-error-foreground" : undefined}
                  hint={t("maintenance.llm.requestTimeoutDescription", REQUEST_TIMEOUT_MINUTES)}
                >
                  <Input
                    className="min-w-0"
                    value={draft.requestTimeoutMinutes}
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={2}
                    placeholder={String(REQUEST_TIMEOUT_MINUTES.default)}
                    aria-describedby={timeoutHintId}
                    aria-invalid={showErrors && timeoutInvalid}
                    onChange={(event) => patch({ requestTimeoutMinutes: event.target.value.replace(/\D/g, "") })}
                  />
                </Field>
                {draft.kind === "ollama" && (
                  <Field
                    label={t("maintenance.llm.ollamaContextLength")}
                    hintId={contextHintId}
                    hintClassName={showErrors && contextInvalid ? "text-error-foreground" : undefined}
                    hint={t("maintenance.llm.ollamaContextLengthDescription", OLLAMA_CONTEXT_LENGTH)}
                  >
                    <Input
                      className="min-w-0"
                      value={draft.ollamaContextLength}
                      inputMode="numeric"
                      autoComplete="off"
                      maxLength={7}
                      placeholder={t("maintenance.llm.ollamaContextLengthDefault")}
                      aria-describedby={contextHintId}
                      aria-invalid={showErrors && contextInvalid}
                      onChange={(event) => patch({ ollamaContextLength: event.target.value.replace(/\D/g, "") })}
                    />
                  </Field>
                )}
              </div>
              {draft.kind === "ollama" && (
                <SwitchRow
                  title={t("maintenance.llm.ollamaDisableThinking")}
                  description={t("maintenance.llm.ollamaDisableThinkingDescription")}
                  checked={draft.ollamaDisableThinking}
                  onCheckedChange={(ollamaDisableThinking) => patch({ ollamaDisableThinking })}
                />
              )}
            </div>

            <div className="space-y-3 border-t pt-5">
              <div className="space-y-2">
                <span className="block text-sm font-medium">{t("maintenance.llm.boundary")}</span>
                <div
                  role="radiogroup"
                  aria-label={t("maintenance.llm.boundary")}
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
                  {t("maintenance.llm.boundaryHint")}
                </p>
              </div>
              <ContentMaximumField
                value={draft.maxContentClass}
                onChange={(maxContentClass) => patch({ maxContentClass })}
              />
              <SwitchRow
                title={t("maintenance.llm.enabled")}
                description={t("maintenance.llm.enabledDescription")}
                checked={draft.enabled}
                onCheckedChange={(enabled) => patch({ enabled })}
              />
            </div>

            {showErrors && connectionInvalid && (
              <p role="alert" className="text-xs text-error-foreground">
                {missingPort
                  ? t("maintenance.llm.portRequired")
                  : missingEndpoint
                    ? t("maintenance.llm.endpointRequired")
                    : t("maintenance.llm.credentialMissing")}
              </p>
            )}
          </fieldset>
        </PresetDialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onClose}>
            {readOnly ? t("maintenance.close") : t("maintenance.cancel")}
          </Button>
          {!readOnly && (
            <Button type="submit" size="sm" disabled={busy}>
              {pending === "save" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : editing ? (
                <Save className="h-4 w-4" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              {editing ? t("maintenance.llm.save") : t("maintenance.llm.add")}
            </Button>
          )}
        </DialogFooter>
      </form>
    </Dialog>
  );
}
