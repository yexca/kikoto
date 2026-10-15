import { ContentMaximumField } from "@/components/settings/ContentMaximumField";
import { Globe, Laptop, Loader2, Plus, RefreshCw, Save } from "lucide-react";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { PresetDialogBody, presetDialogClassName } from "@/components/settings/PresetDialogBody";
import { SettingsField as Field, SettingsSwitchRow as SwitchRow } from "@/components/settings/SettingsFormControls";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input, otherCredentialFieldProps } from "@/components/ui/input";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import type { LLMProvider, LLMProviderPreset } from "@/lib/api";

import {
  draftFromPreset,
  draftFromProvider,
  endpointMissing,
  replacesConnection,
  usesDerivedEndpoint,
  withPreset,
  type ProviderDraft,
} from "./llmSettingsModel";

/**
 * Adds or edits one LLM provider. Fetching models saves the connection first,
 * so a provider being added exists from that point and the dialog continues as
 * an edit of it.
 */
export function LLMProviderDialog({
  presets,
  provider,
  onSave,
  onFetchModels,
  onClose,
}: {
  presets: LLMProviderPreset[];
  /** The provider to edit, or null to add one. */
  provider: LLMProvider | null;
  /** Resolves to the saved provider, or null when the save failed. */
  onSave: (draft: ProviderDraft) => Promise<LLMProvider | null>;
  /** Resolves to the provider as last saved, or null when it could not be saved. */
  onFetchModels: (draft: ProviderDraft) => Promise<LLMProvider | null>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ProviderDraft>(() =>
    provider ? draftFromProvider(provider) : draftFromPreset(presets[0]),
  );
  const [pending, setPending] = useState<"save" | "fetch" | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const modelListId = useId();
  const endpointHintId = useId();
  const keyHintId = useId();
  const modelHintId = useId();
  const boundaryHintId = useId();
  const patch = (next: Partial<ProviderDraft>) => setDraft((current) => ({ ...current, ...next }));

  const preset = presets.find((item) => item.id === draft.presetId);
  const editing = Boolean(draft.id);
  // A provider being added keeps its preset list after fetching models saves it, so the layout stays put.
  const adding = provider === null;
  const busy = pending !== null;
  const derivedEndpoint = usesDerivedEndpoint(draft);
  const missingEndpoint = endpointMissing(draft, preset);
  const keyWillBeDropped = replacesConnection(draft) && draft.hasApiKey && !draft.apiKey && !draft.clearKey;

  const setOllamaScope = (ollamaScope: NonNullable<ProviderDraft["ollamaScope"]>) =>
    patch({
      ollamaScope,
      // The address shown for a same-machine Ollama is derived by the server, not an origin to keep.
      baseUrl: ollamaScope === "other_machine" && draft.savedOllamaScope === "other_machine" ? draft.savedBaseUrl : "",
    });

  const selectPreset = (id: string) => {
    const next = presets.find((item) => item.id === id);
    if (next) setDraft((current) => withPreset(current, next));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (missingEndpoint) {
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
    if (missingEndpoint) {
      setShowErrors(true);
      return;
    }
    setPending("fetch");
    const saved = await onFetchModels(draft);
    setPending(null);
    if (saved) setDraft(draftFromProvider(saved));
  };

  const ollamaScopes: Array<{ scope: NonNullable<ProviderDraft["ollamaScope"]>; icon: ReactNode; label: string }> = [
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
          <fieldset disabled={busy} className="min-w-0 space-y-5 border-0 p-0">
            <Field label={t("maintenance.llm.name")} hint={t("maintenance.llm.nameDescription")}>
              <Input
                value={draft.name}
                maxLength={128}
                autoComplete="off"
                placeholder={preset?.name}
                onChange={(event) => patch({ name: event.target.value })}
              />
            </Field>

            {draft.kind === "ollama" && (
              <div className="space-y-2">
                <div
                  role="radiogroup"
                  aria-label={t("maintenance.llm.ollamaLocation")}
                  className={segmentedListClassName()}
                >
                  {ollamaScopes.map(({ scope, icon, label }) => (
                    <button
                      key={scope}
                      type="button"
                      role="radio"
                      aria-checked={draft.ollamaScope === scope}
                      className={segmentedItemClassName(draft.ollamaScope === scope)}
                      onClick={() => setOllamaScope(scope)}
                    >
                      {icon}
                      {label}
                    </button>
                  ))}
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  {t("maintenance.llm.ollamaLocationDescription")}
                </p>
              </div>
            )}

            {derivedEndpoint ? (
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

            <div className="grid min-w-0 gap-1.5 border-t pt-5">
              <span className="text-sm font-medium">{t("maintenance.llm.model")}</span>
              <div className="flex min-w-0 gap-2">
                <Input
                  aria-label={t("maintenance.llm.model")}
                  aria-describedby={modelHintId}
                  className="min-w-0 flex-1"
                  value={draft.defaultModel}
                  maxLength={256}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  list={modelListId}
                  onChange={(event) => patch({ defaultModel: event.target.value })}
                />
                <datalist id={modelListId}>
                  {draft.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </datalist>
                <Button type="button" variant="outline" className="shrink-0" onClick={() => void fetchModels()}>
                  {pending === "fetch" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  {t("maintenance.llm.fetchModels")}
                </Button>
              </div>
              <p id={modelHintId} className="text-xs leading-5 text-muted-foreground">
                {draft.models.length > 0
                  ? t("maintenance.llm.modelsAvailable", { count: draft.models.length })
                  : t("maintenance.llm.modelDescription")}
              </p>
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

            {showErrors && missingEndpoint && (
              <p role="alert" className="text-xs text-error-foreground">
                {t("maintenance.llm.endpointRequired")}
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
            {editing ? t("maintenance.llm.save") : t("maintenance.llm.add")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
