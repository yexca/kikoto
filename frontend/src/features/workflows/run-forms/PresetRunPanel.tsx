import { useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  RemoteSourceCheckboxes,
  VoiceActorPicker,
  useCompatibleRemoteSources,
} from "@/features/workflows/CreatorPresetFields";
import {
  presetBlockers,
  presetDefaultValues,
  presetInputsPayload,
  presetMetadataEnabled,
  presetOptionalEnabled,
  presetOptionalFlagKey,
  presetReleaseRange,
  presetSourceCheckEnabled,
  presetSourceIds,
  PRESET_PERSON_NAME_KEY,
  presetTagEnabled,
  presetValuesFromInputs,
  presetVisibleParameters,
  PRESET_GROUPS,
  PRESET_OPTIONAL_FILTERS,
  PRESET_RELEASE_KEYS,
  PRESET_TAG_ENABLED_KEY,
  type PresetBlocker,
  type PresetFormValues,
} from "@/features/workflows/presetWorkflowModel";
import { TagTemplateField } from "@/features/workflows/run-forms/TagTemplateField";
import {
  OptionField,
  RunBlockerNote,
  RunPrefillNote,
  SegmentedControl,
  SwitchControl,
  WorkflowRunButton,
  type RunFormLayout,
} from "@/features/workflows/RunOptionControls";
import {
  presetTagTemplateTokens,
  workflowTagTemplateBlockers,
  workflowTagTemplatePreview,
  workflowTagTemplateTokenValues,
} from "@/features/workflows/tagTemplateModel";
import { clearWorkflowRunPrefill, readWorkflowRunPrefill } from "@/features/workflows/workflowLinks";
import { workflowCopy, type CurrentTriggerRunOptions } from "@/features/workflows/workflowPageModel";
import i18n from "@/i18n";
import type { WorkflowPreset, WorkflowPresetParameter } from "@/lib/api";

export function presetParameterLabel(key: string) {
  return workflowCopy(`presetParams.${key}`);
}

function presetOptionLabel(value: string) {
  return i18n.exists(`workflowPage.presetOptions.${value}`) ? workflowCopy(`presetOptions.${value}`) : value;
}

export function presetBlockerText(blocker: PresetBlocker) {
  switch (blocker.kind) {
    case "required":
      return workflowCopy("presetBlockers.required", { label: presetParameterLabel(blocker.key) });
    case "range":
      return workflowCopy("presetBlockers.range", {
        label: presetParameterLabel(blocker.key),
        min: blocker.minimum,
        max: blocker.maximum,
      });
    case "tag_permission":
      return workflowCopy("presetBlockers.tagPermission");
    case "full_refresh_automated":
      return workflowCopy("presetBlockers.fullRefreshAutomated");
    case "invalid_date":
      return workflowCopy("presetBlockers.invalidDate", { label: presetParameterLabel(blocker.key) });
    case "release_range_open":
      return workflowCopy("presetReleaseRange.bothOpen");
    case "release_range_order":
      return workflowCopy("presetReleaseRange.order");
    case "sources_required":
      return workflowCopy("presetBlockers.sourcesRequired", { label: presetParameterLabel(blocker.key) });
    case "no_steps":
      return workflowCopy("presetBlockers.noSteps");
  }
}

export function PresetParameterFields({
  idPrefix,
  preset,
  values,
  compact = false,
  onChange,
}: {
  idPrefix: string;
  /** Dialogs stack labels over two field columns; the page detail uses label-beside-control rows. */
  compact?: boolean;
  preset: WorkflowPreset;
  values: PresetFormValues;
  /** Receives functional updates so concurrent async fills do not overwrite each other. */
  onChange: Dispatch<SetStateAction<PresetFormValues>>;
}) {
  const { sources, loading: loadingSources } = useCompatibleRemoteSources();
  const visible = presetVisibleParameters(preset, values);
  const update = (key: string, value: string) => onChange((current) => ({ ...current, [key]: value }));
  const tagEnabled = presetTagEnabled(values);
  const tagTokens = presetTagTemplateTokens(preset, values, new Date());
  const tagPreview = workflowTagTemplatePreview(
    values.tagNameTemplate ?? "",
    workflowTagTemplateTokenValues(tagTokens),
  );
  const tagError =
    tagEnabled && (values.tagNameTemplate ?? "").trim()
      ? workflowTagTemplateBlockers(
          values.tagNameTemplate ?? "",
          tagTokens.map((token) => token.name),
        )[0]
      : undefined;

  // Catalog sources start with every compatible source selected; a stored or
  // prefilled selection is kept as it is. The ref makes this a one-time fill,
  // so a later change to the preset or handler does not repeat it.
  const catalogSourcesInitialized = useRef(false);
  useEffect(() => {
    if (catalogSourcesInitialized.current || loadingSources) return;
    catalogSourcesInitialized.current = true;
    if (!preset.parameters.some((parameter) => parameter.key === "sourceIds")) return;
    if (sources.length === 0) return;
    onChange((current) =>
      presetSourceIds(current.sourceIds).length > 0
        ? current
        : { ...current, sourceIds: sources.map((source) => source.id).join(",") },
    );
  }, [loadingSources, onChange, preset.parameters, sources]);

  const renderField = (parameter: WorkflowPresetParameter) => {
    const id = `${idPrefix}-${parameter.key}`;
    const label = `${presetParameterLabel(parameter.key)}${parameter.required ? " *" : ""}`;
    const value = values[parameter.key] ?? "";
    const optional = parameter.key in PRESET_OPTIONAL_FILTERS;
    const optionalEnabled = optional && presetOptionalEnabled(values, parameter.key);
    // Switchable filters show their switch first and the control only while it is on.
    const optionalControl = (control: ReactNode) => (
      <>
        <SwitchControl
          label={workflowCopy(`presetOptionalFilters.${parameter.key}`)}
          description={workflowCopy(`presetOptionalFilters.${parameter.key}`)}
          checked={optionalEnabled}
          onCheckedChange={(next) => update(presetOptionalFlagKey(parameter.key), next ? "true" : "false")}
        />
        {optionalEnabled && control}
      </>
    );
    const field = (control: ReactNode, options: { hint?: ReactNode; labelFor?: boolean } = {}) => (
      <OptionField
        key={parameter.key}
        label={label}
        htmlFor={options.labelFor === false ? undefined : id}
        hint={options.hint}
        stacked={compact}
      >
        {control}
      </OptionField>
    );
    const stepSwitch = (checked: boolean, onCheckedChange: (next: boolean) => void) => (
      <SwitchControl
        label={workflowCopy(`presetSwitches.${parameter.key}`)}
        description={workflowCopy(`presetSwitchHints.${parameter.key}`)}
        checked={checked}
        onCheckedChange={onCheckedChange}
      />
    );
    switch (parameter.kind) {
      case "boolean":
        return field(
          stepSwitch(value !== "false", (next) => update(parameter.key, next ? "true" : "false")),
          { labelFor: false },
        );
      case "voice_person":
        return field(
          <VoiceActorPicker
            id={id}
            personId={value}
            displayName={values[PRESET_PERSON_NAME_KEY] ?? ""}
            onChange={(personId, displayName) =>
              onChange((current) => ({ ...current, [parameter.key]: personId, [PRESET_PERSON_NAME_KEY]: displayName }))
            }
          />,
        );
      case "source_ids": {
        const checkboxes = (
          <RemoteSourceCheckboxes
            label={presetParameterLabel(parameter.key)}
            sources={sources}
            loading={loadingSources}
            selected={presetSourceIds(value)}
            onChange={(ids) => update(parameter.key, ids.join(","))}
          />
        );
        if (parameter.key !== "checkSourceIds") return field(checkboxes, { labelFor: false });
        const enabled = presetSourceCheckEnabled(values);
        return field(
          <>
            {stepSwitch(enabled, (next) =>
              onChange((current) => ({
                ...current,
                [presetOptionalFlagKey(parameter.key)]: next ? "true" : "false",
                // Turning the check on starts from every compatible source.
                [parameter.key]:
                  next && presetSourceIds(current[parameter.key]).length === 0
                    ? sources.map((source) => source.id).join(",")
                    : current[parameter.key],
              })),
            )}
            {enabled && checkboxes}
          </>,
          { labelFor: false },
        );
      }
      case "select":
        return field(
          <SegmentedControl
            label={presetParameterLabel(parameter.key)}
            value={value}
            onChange={(next) => update(parameter.key, next)}
            options={(parameter.options ?? []).map((option) => ({ value: option, label: presetOptionLabel(option) }))}
          />,
          { labelFor: false },
        );
      case "integer": {
        const input = (
          <Input
            id={id}
            fieldSize="sm"
            className="max-w-40"
            type="number"
            inputMode="numeric"
            aria-label={optional ? presetParameterLabel(parameter.key) : undefined}
            min={parameter.minimum}
            max={parameter.maximum}
            value={value}
            onChange={(event) => update(parameter.key, event.target.value)}
          />
        );
        if (!optional) return field(input);
        return field(optionalControl(input), {
          labelFor: false,
          hint: optionalEnabled ? undefined : workflowCopy("presetWorkLimitOff"),
        });
      }
      case "date": {
        // The release bounds share one row: a range switch, then each end with its own "No limit".
        if (parameter.key === "releaseTo") return null;
        if (parameter.key !== "releaseFrom") {
          return field(
            <Input
              id={id}
              fieldSize="sm"
              className="max-w-48"
              type="date"
              value={value}
              onChange={(event) => update(parameter.key, event.target.value)}
            />,
          );
        }
        const range = presetReleaseRange(values);
        const ends = [
          { key: "releaseFrom", open: range.fromOpen, openKey: PRESET_RELEASE_KEYS.fromOpen },
          { key: "releaseTo", open: range.toOpen, openKey: PRESET_RELEASE_KEYS.toOpen },
        ].filter((end) => preset.parameters.some((candidate) => candidate.key === end.key));
        return (
          <OptionField
            key="releaseRange"
            label={workflowCopy("presetReleaseRange.label")}
            hint={range.enabled ? workflowCopy("presetReleaseRange.inclusive") : undefined}
            stacked={compact}
          >
            <SwitchControl
              label={workflowCopy("presetReleaseRange.toggle")}
              description={workflowCopy("presetReleaseRange.toggle")}
              checked={range.enabled}
              onCheckedChange={(next) => update(PRESET_RELEASE_KEYS.enabled, next ? "true" : "false")}
            />
            {range.enabled && (
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                {ends.map((end) => {
                  const endLabel = workflowCopy(`presetReleaseRange.${end.key}`);
                  const endId = `${idPrefix}-${end.key}`;
                  return (
                    <div key={end.key} className="flex min-w-0 items-center gap-2">
                      <label htmlFor={endId} className="w-8 shrink-0 text-xs text-muted-foreground">
                        {endLabel}
                      </label>
                      <Input
                        id={endId}
                        fieldSize="sm"
                        className="w-40"
                        type="date"
                        aria-label={presetParameterLabel(end.key)}
                        disabled={end.open}
                        value={end.open ? "" : (values[end.key] ?? "")}
                        onChange={(event) => update(end.key, event.target.value)}
                      />
                      <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                        <Checkbox
                          checked={end.open}
                          aria-label={`${endLabel}: ${workflowCopy("presetReleaseRange.noLimit")}`}
                          onCheckedChange={(next) => update(end.openKey, next ? "true" : "false")}
                        />
                        {workflowCopy("presetReleaseRange.noLimit")}
                      </label>
                    </div>
                  );
                })}
              </div>
            )}
          </OptionField>
        );
      }
      case "text_template":
        return (
          <TagTemplateField
            key={parameter.key}
            id={id}
            row={!compact}
            spanColumns={compact}
            enabled={tagEnabled}
            onEnabledChange={(next) => update(PRESET_TAG_ENABLED_KEY, next ? "true" : "false")}
            value={value}
            defaultValue={preset.defaultTagTemplate}
            tokens={tagTokens}
            preview={tagPreview}
            error={tagError}
            onChange={(next) => update(parameter.key, next)}
          />
        );
      default:
        // Circle and series targets accept a list; the server combines their catalogs.
        return field(
          <Input
            id={id}
            fieldSize="sm"
            className="max-w-md"
            value={value}
            placeholder={workflowCopy(`presetTargetPlaceholders.${parameter.key}`)}
            onChange={(event) => update(parameter.key, event.target.value)}
          />,
          { hint: workflowCopy("presetTargetsHint") },
        );
    }
  };

  // Input reads a catalog, the filter narrows its works without metadata, and
  // the actions sync, tag, or check them. Without metadata the filter has
  // nothing to narrow, so it stays hidden.
  const metadataEnabled = presetMetadataEnabled(values);
  return (
    <div className="grid divide-y">
      {PRESET_GROUPS.map((group) => {
        const parameters = visible.filter((parameter) => parameter.group === group);
        if (parameters.length === 0) return null;
        const groupTitleId = `${idPrefix}-group-${group}`;
        return (
          <section
            key={group}
            className={`grid min-w-0 content-start gap-4 py-4 first:pt-0 last:pb-0 ${compact ? "sm:grid-cols-2" : ""}`}
            aria-labelledby={groupTitleId}
          >
            <div className={compact ? "sm:col-span-2" : undefined}>
              <h4 id={groupTitleId} className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {workflowCopy(`presetGroups.${group}`)}
              </h4>
              {group === "filter" && metadataEnabled && (
                <p className="mt-1 text-xs text-muted-foreground">{workflowCopy("presetFilterHint")}</p>
              )}
            </div>
            {parameters.map(renderField)}
          </section>
        );
      })}
    </div>
  );
}

export function PresetRunPanel({
  layout,
  preset,
  running,
  allowed,
  canTag,
  onRun,
  onTriggerRunOptionsChange,
}: {
  layout: RunFormLayout;
  preset: WorkflowPreset;
  running: boolean;
  allowed: boolean;
  canTag: boolean;
  onRun: (inputs: Record<string, unknown>) => Promise<void>;
  onTriggerRunOptionsChange?: (options: CurrentTriggerRunOptions) => void;
}) {
  // A detail page's Follow shortcut prefills this preset's target; the note
  // keeps saying so after the link's query is cleared.
  const [prefilledTargets] = useState(() =>
    Object.entries(readWorkflowRunPrefill(preset.code)).filter(([key]) =>
      preset.parameters.some((parameter) => parameter.key === key),
    ),
  );
  const [values, setValues] = useState<PresetFormValues>(() =>
    prefilledTargets.length > 0
      ? presetValuesFromInputs(preset, Object.fromEntries(prefilledTargets))
      : presetDefaultValues(preset),
  );
  useEffect(() => clearWorkflowRunPrefill(), []);
  useEffect(() => {
    onTriggerRunOptionsChange?.({ code: preset.code, presetValues: values });
  }, [preset.code, values, onTriggerRunOptionsChange]);
  const blockers = presetBlockers(preset, values, { canTag, automated: false });
  const tagTemplate = (values.tagNameTemplate ?? "").trim();
  const tagInvalid =
    presetTagEnabled(values) &&
    tagTemplate !== "" &&
    workflowTagTemplateBlockers(
      tagTemplate,
      presetTagTemplateTokens(preset, values, new Date()).map((token) => token.name),
    ).length > 0;
  const canSubmit = allowed && blockers.length === 0 && !tagInvalid;
  return layout({
    run: (
      <WorkflowRunButton
        running={running}
        disabled={!canSubmit}
        onClick={() => void onRun(presetInputsPayload(preset, values))}
      />
    ),
    options: (
      <div className="grid gap-5">
        {prefilledTargets.length > 0 && (
          <RunPrefillNote>
            {workflowCopy("prefillNotice", {
              // The voice picker names its target; a circle id is shown as typed.
              fields: prefilledTargets
                .map(([key, value]) =>
                  key === "personId" ? presetParameterLabel(key) : `${presetParameterLabel(key)} ${value}`,
                )
                .join(", "),
            })}
          </RunPrefillNote>
        )}
        <PresetParameterFields idPrefix="preset-run" preset={preset} values={values} onChange={setValues} />
        {blockers.length > 0 && <RunBlockerNote>{presetBlockerText(blockers[0])}</RunBlockerNote>}
      </div>
    ),
  });
}
