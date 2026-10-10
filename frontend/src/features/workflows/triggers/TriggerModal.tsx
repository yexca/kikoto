import { Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type Dispatch, type RefObject, type SetStateAction } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, NativeSelect } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  metadataSyncBlockers,
  metadataSyncDefaultValues,
  metadataSyncPayload,
  metadataSyncSourceId,
  metadataSyncValuesFromConfig,
  type MetadataSyncFormValues,
} from "@/features/workflows/metadataSyncModel";
import {
  presetBlockers,
  presetDefaultValues,
  presetInputsPayload,
  presetRunsUnfiltered,
  presetValuesFromInputs,
  type PresetFormValues,
} from "@/features/workflows/presetWorkflowModel";
import {
  LocalMediaIndexModeField,
  MetadataSyncFields,
  metadataSyncBlockerText,
} from "@/features/workflows/run-forms/LibraryRunPanels";
import { PresetParameterFields, presetBlockerText } from "@/features/workflows/run-forms/PresetRunPanel";
import { SourcePresenceFields } from "@/features/workflows/run-forms/SourcePresenceRunPanel";
import { TagTemplateField } from "@/features/workflows/run-forms/TagTemplateField";
import { useMetadataSyncSources } from "@/features/workflows/useMetadataSyncSources";
import {
  REMOTE_POPULAR_TAG_TEMPLATE,
  dlsitePopularDefaultTagTemplate,
  dlsitePopularTagTemplateTokens,
  remotePopularTagTemplateTokens,
  workflowTagTemplateBlockers,
  workflowTagTemplatePreview,
  workflowTagTemplateTokenValues,
} from "@/features/workflows/tagTemplateModel";
import {
  parseJSONRecord,
  workflowCopy,
  type CurrentTriggerRunOptions,
  type DLsitePopularPeriod,
  type SystemWorkflowTriggerConfig,
} from "@/features/workflows/workflowPageModel";
import { ErrorPanel, Field, Modal } from "@/features/workflows/WorkflowPanelParts";
import {
  workflowSystemTriggerConfig,
  workflowSystemTriggerConfigBlockers,
  workflowSystemTriggerConfigPayload,
  type AutomationTriggerType,
  type CreatableAutomationTriggerType,
} from "@/features/workflows/workflowTriggerModel";
import {
  api,
  type LibrarySource,
  type SourcePresenceCheckOptions,
  type WorkflowDefinition,
  type WorkflowPreset,
  type WorkflowTrigger,
} from "@/lib/api";
import { wholeNumberFromInput } from "@/lib/numberInput";

export function TriggerModal({
  definition,
  preset = null,
  canTag = false,
  trigger,
  readOnly = false,
  initialTriggerType,
  currentRunOptions,
  anchorRef,
  onClose,
  onSaved,
  onDeleted,
}: {
  definition: WorkflowDefinition;
  preset?: WorkflowPreset | null;
  canTag?: boolean;
  trigger: WorkflowTrigger | null;
  readOnly?: boolean;
  initialTriggerType: CreatableAutomationTriggerType;
  currentRunOptions?: CurrentTriggerRunOptions | null;
  anchorRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSaved: (trigger: WorkflowTrigger) => void;
  onDeleted: () => void;
}) {
  const triggerType: AutomationTriggerType =
    trigger?.triggerType === "startup" ||
    trigger?.triggerType === "filesystem_event" ||
    trigger?.triggerType === "schedule"
      ? trigger.triggerType
      : initialTriggerType;
  const [systemConfig, setSystemConfig] = useState<SystemWorkflowTriggerConfig>(() =>
    trigger
      ? workflowSystemTriggerConfig(definition.code, trigger)
      : (currentRunOptions?.systemConfig ?? workflowSystemTriggerConfig(definition.code, null)),
  );
  const [displayName, setDisplayName] = useState(
    trigger?.displayName ??
      (triggerType === "startup" ? workflowCopy("runAtStartup") : workflowCopy("scheduledWorkflow")),
  );
  const enabled = trigger?.enabled ?? true;
  const [intervalMinutes, setIntervalMinutes] = useState(() => {
    const value = parseJSONRecord(trigger?.scheduleJson ?? "").intervalMinutes;
    return typeof value === "number" ? value : 60;
  });
  const [presetValues, setPresetValues] = useState<PresetFormValues>(() =>
    preset
      ? trigger
        ? presetValuesFromInputs(preset, parseJSONRecord(trigger.configJson).inputs)
        : (currentRunOptions?.presetValues ?? presetDefaultValues(preset))
      : {},
  );
  const isMetadataSync = definition.code === "metadata_sync";
  const metadataSources = useMetadataSyncSources(isMetadataSync);
  const [metadataSyncValues, setMetadataSyncValues] = useState<MetadataSyncFormValues>(() =>
    trigger
      ? metadataSyncValuesFromConfig(parseJSONRecord(trigger.configJson))
      : (currentRunOptions?.metadataSync ?? metadataSyncDefaultValues()),
  );
  const customizable =
    Boolean(preset) ||
    isMetadataSync ||
    definition.code === "remote_popular_collection" ||
    definition.code === "dlsite_popular_collection" ||
    definition.code === "source_presence_check";
  const [customize, setCustomize] = useState(() => customizable && Boolean(trigger));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const presetTriggerBlockers = preset
    ? presetBlockers(preset, presetValues, { canTag, automated: true }).map((blocker) => presetBlockerText(blocker))
    : [];
  const systemConfigBlockers = isMetadataSync
    ? metadataSyncBlockers(metadataSyncValues, metadataSources.sources ?? undefined).map(metadataSyncBlockerText)
    : workflowSystemTriggerConfigBlockers(definition.code, systemConfig);
  // An unfiltered follow syncs every catalog work without metadata on each
  // automated run. It is allowed, but recommend a filter before saving one.
  const unfilteredFollowWarning = Boolean(preset && presetRunsUnfiltered(preset, presetValues));
  const automationBlockers = [
    ...(triggerType === "schedule" && (intervalMinutes < 5 || intervalMinutes > 10080)
      ? [workflowCopy("intervalRange")]
      : []),
    ...systemConfigBlockers,
    ...presetTriggerBlockers,
  ];

  useEffect(() => {
    const needsSource = definition.code === "remote_popular_collection" || definition.code === "source_presence_check";
    if (!needsSource || systemConfig.sourceId > 0) return;
    let active = true;
    api
      .listLibrarySources()
      .then((sources) => {
        if (!active) return;
        const source = sources.find(
          (item) => item.enabled && ["kikoeru_compatible", "kikoeru_compatible_number178"].includes(item.sourceType),
        );
        if (source)
          setSystemConfig((current) => (current.sourceId > 0 ? current : { ...current, sourceId: source.id }));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [definition.code, systemConfig.sourceId]);

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      if (automationBlockers.length > 0) throw new Error(automationBlockers[0]);
      const configPayload = preset
        ? presetInputsPayload(preset, presetValues)
        : isMetadataSync
          ? metadataSyncPayload(metadataSyncValues)
          : workflowSystemTriggerConfigPayload(definition.code, triggerType, systemConfig);
      const payload = {
        // Editing never moves an existing trigger to another workflow.
        workflowDefinitionId: trigger?.workflowDefinitionId ?? definition.id,
        displayName,
        triggerType,
        enabled,
        scheduleJson:
          triggerType === "schedule"
            ? JSON.stringify({ intervalMinutes })
            : (trigger?.scheduleJson ?? JSON.stringify({ type: "startup" })),
        configJson: preset ? JSON.stringify({ inputs: configPayload }) : JSON.stringify(configPayload),
        nextRunAt: null,
      };
      const saved = trigger
        ? await api.updateWorkflowTrigger(trigger.id, payload)
        : await api.createWorkflowTrigger(payload);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : workflowCopy("saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!trigger) return;
    setSaving(true);
    try {
      await api.deleteWorkflowTrigger(trigger.id);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : workflowCopy("deleteFailed"));
    } finally {
      setSaving(false);
    }
  };

  const showSystemOptions =
    definition.code === "local_library_scan" || definition.code === "local_media_index" || customize;
  const showPresetOptions = Boolean(preset && customize);
  const setCustomizeAndReset = (next: boolean) => {
    if (!next) {
      if (preset) setPresetValues(currentRunOptions?.presetValues ?? presetDefaultValues(preset));
      else if (isMetadataSync) setMetadataSyncValues(currentRunOptions?.metadataSync ?? metadataSyncDefaultValues());
      else setSystemConfig(currentRunOptions?.systemConfig ?? workflowSystemTriggerConfig(definition.code, null));
    }
    setCustomize(next);
  };

  return (
    <Modal
      title={
        trigger
          ? workflowCopy("editTrigger")
          : triggerType === "startup"
            ? workflowCopy("newStartupTrigger")
            : workflowCopy("newSchedule")
      }
      onClose={onClose}
      dismissible={!customize && !saving}
      anchorRef={anchorRef}
      popoverClassName={customize ? "w-[min(42rem,calc(100vw-1.5rem))]" : "w-[min(27rem,calc(100vw-1.5rem))]"}
    >
      <fieldset disabled={readOnly} className="m-0 grid min-w-0 gap-3 border-0 p-0">
        <Field label={workflowCopy("name")}>
          <Input
            fieldSize="sm"
            value={displayName}
            disabled={triggerType === "filesystem_event"}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </Field>
        {triggerType === "schedule" && (
          <Field label={workflowCopy("intervalMinutes")}>
            <Input
              fieldSize="sm"
              type="number"
              min={5}
              max={10080}
              value={intervalMinutes}
              step={1}
              inputMode="numeric"
              onChange={(event) => setIntervalMinutes(wholeNumberFromInput(event.target.value))}
            />
          </Field>
        )}
        {customizable && (
          <label className="flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
            <Checkbox
              checked={customize}
              onCheckedChange={setCustomizeAndReset}
              aria-label={workflowCopy("customizeTrigger")}
            />
            <span className="grid gap-0.5">
              <span className="font-medium">{workflowCopy("customizeTrigger")}</span>
              <span className="text-xs text-muted-foreground">{workflowCopy("customizeTriggerDescription")}</span>
            </span>
          </label>
        )}
        {(showPresetOptions || showSystemOptions) && (
          <section className="grid min-w-0 gap-3 border-t pt-4" aria-label={workflowCopy("runOptions")}>
            {customize && (
              <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {workflowCopy("runOptions")}
              </h4>
            )}
            {showPresetOptions && preset ? (
              <PresetParameterFields
                idPrefix="preset-trigger"
                compact
                preset={preset}
                values={presetValues}
                onChange={setPresetValues}
              />
            ) : showSystemOptions && isMetadataSync ? (
              <MetadataSyncFields
                idPrefix="metadata-sync-trigger"
                compact
                values={metadataSyncValues}
                onChange={setMetadataSyncValues}
                sources={metadataSources.sources}
                sourceLoadFailed={metadataSources.failed}
                onRetrySources={metadataSources.retry}
                disabled={saving || readOnly}
              />
            ) : showSystemOptions ? (
              <SystemWorkflowTriggerFields
                definitionCode={definition.code}
                triggerType={triggerType}
                value={systemConfig}
                onChange={setSystemConfig}
              />
            ) : null}
          </section>
        )}
        {unfilteredFollowWarning && (
          <div
            role="note"
            className="rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-sm text-warning-foreground"
          >
            {workflowCopy("presetUnfilteredAutomation")}
          </div>
        )}
        {automationBlockers.length > 0 && (
          <div className="rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-sm text-warning-foreground">
            {automationBlockers.map((blocker) => (
              <div key={blocker}>{blocker}</div>
            ))}
          </div>
        )}
        {error && <ErrorPanel error={error} />}
        <div className="flex justify-end gap-2">
          {trigger && triggerType !== "filesystem_event" && (
            <Button variant="outline" onClick={remove} disabled={saving}>
              <Trash2 className="h-4 w-4" />
              {workflowCopy("delete")}
            </Button>
          )}
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {workflowCopy("cancel")}
          </Button>
          <Button
            onClick={save}
            disabled={
              saving ||
              automationBlockers.length > 0 ||
              !displayName.trim() ||
              (isMetadataSync &&
                metadataSources.sources === null &&
                (metadataSyncValues.scope === "voice" ||
                  metadataSyncSourceId(metadataSyncValues) > 0 ||
                  metadataSyncValues.remoteMetadataFallback.enabled))
            }
          >
            <Save className="h-4 w-4" />
            {saving ? workflowCopy("saving") : trigger ? workflowCopy("save") : workflowCopy("addTrigger")}
          </Button>
        </div>
      </fieldset>
    </Modal>
  );
}

function SystemWorkflowTriggerFields({
  definitionCode,
  triggerType,
  value,
  onChange,
}: {
  definitionCode: string;
  triggerType: AutomationTriggerType;
  value: SystemWorkflowTriggerConfig;
  /** Receives functional updates so the async source fill does not overwrite edits made meanwhile. */
  onChange: Dispatch<SetStateAction<SystemWorkflowTriggerConfig>>;
}) {
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const [loadingSources, setLoadingSources] = useState(definitionCode === "remote_popular_collection");
  const compatibleSources = useMemo(
    () =>
      sources.filter(
        (source) =>
          source.enabled && ["kikoeru_compatible", "kikoeru_compatible_number178"].includes(source.sourceType),
      ),
    [sources],
  );

  useEffect(() => {
    if (definitionCode !== "remote_popular_collection") return;
    let active = true;
    api
      .listLibrarySources()
      .then((items) => {
        if (!active) return;
        setSources(items);
        const compatible = items.filter(
          (source) =>
            source.enabled && ["kikoeru_compatible", "kikoeru_compatible_number178"].includes(source.sourceType),
        );
        const first = compatible[0];
        if (first) onChange((current) => (current.sourceId > 0 ? current : { ...current, sourceId: first.id }));
      })
      .catch(() => {
        if (active) setSources([]);
      })
      .finally(() => {
        if (active) setLoadingSources(false);
      });
    return () => {
      active = false;
    };
  }, [definitionCode, onChange]);

  if (definitionCode === "local_media_index") {
    return (
      <LocalMediaIndexModeField
        value={value.scanMode}
        onChange={(scanMode) => onChange({ ...value, scanMode })}
        stacked
      />
    );
  }

  if (definitionCode === "local_library_scan") {
    if (triggerType === "filesystem_event") {
      return (
        <div className="grid gap-1.5 text-sm">
          <div id="local-scan-mode-label" className="font-medium">
            {workflowCopy("scanMode")}
          </div>
          <div
            className="grid grid-cols-2 rounded-md border bg-muted/30 p-1"
            role="radiogroup"
            aria-labelledby="local-scan-mode-label"
          >
            {(["incremental", "full"] as const).map((scanMode) => {
              const selected = value.scanMode === scanMode;
              return (
                <button
                  key={scanMode}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={`h-9 rounded px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    selected ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => onChange({ ...value, scanMode })}
                >
                  {scanMode === "incremental" ? workflowCopy("incremental") : workflowCopy("full")}
                </button>
              );
            })}
          </div>
        </div>
      );
    }
    return (
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-sm font-medium">{workflowCopy("followUpRun")}</div>
          <div className="text-xs text-muted-foreground">{workflowCopy("followUpEachDescription")}</div>
        </div>
        <Switch
          checked={value.followUpRun}
          onCheckedChange={(followUpRun) => onChange({ ...value, followUpRun })}
          aria-label={workflowCopy("followUpRun")}
        />
      </div>
    );
  }

  if (definitionCode === "remote_popular_collection") {
    const selectedSource = compatibleSources.find((source) => source.id === value.sourceId);
    const tokens = remotePopularTagTemplateTokens(selectedSource, value.action, new Date());
    const preview = workflowTagTemplatePreview(value.tagNameTemplate, workflowTagTemplateTokenValues(tokens));
    const error = workflowTagTemplateBlockers(
      value.tagNameTemplate,
      tokens.map((token) => token.name),
    )[0];
    return (
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={workflowCopy("remoteSource")}>
          <NativeSelect
            fieldSize="sm"
            value={value.sourceId}
            disabled={loadingSources || compatibleSources.length === 0}
            onChange={(event) => onChange({ ...value, sourceId: Number(event.target.value) })}
          >
            {compatibleSources.length === 0 && (
              <option value={0}>
                {loadingSources ? workflowCopy("loadingSources") : workflowCopy("noCompatibleSource")}
              </option>
            )}
            {compatibleSources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.displayName}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label={workflowCopy("action")}>
          <NativeSelect
            fieldSize="sm"
            value={value.action}
            onChange={(event) => onChange({ ...value, action: event.target.value === "fetch" ? "fetch" : "track" })}
          >
            <option value="track">{workflowCopy("track")}</option>
            <option value="fetch" disabled>
              {workflowCopy("fetchManualOnly")}
            </option>
          </NativeSelect>
        </Field>
        <Field label={workflowCopy("workLimit")}>
          <NativeSelect
            fieldSize="sm"
            value={value.limit}
            onChange={(event) => onChange({ ...value, limit: Number(event.target.value) })}
          >
            {[10, 25, 50, 100].map((limit) => (
              <option key={limit} value={limit}>
                {workflowCopy("worksCount", { count: limit })}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <TagTemplateField
          id="remote-trigger-tag-template"
          enabled={!value.skipTag}
          onEnabledChange={(enabled) => onChange({ ...value, skipTag: !enabled })}
          value={value.tagNameTemplate}
          defaultValue={REMOTE_POPULAR_TAG_TEMPLATE}
          tokens={tokens}
          preview={preview}
          error={error}
          onChange={(tagNameTemplate) => onChange({ ...value, tagNameTemplate })}
        />
      </div>
    );
  }

  if (definitionCode === "source_presence_check") {
    return <SourcePresenceTriggerFields value={value} onChange={onChange} />;
  }

  if (definitionCode === "dlsite_popular_collection") {
    const defaultTemplate = dlsitePopularDefaultTagTemplate(value.period);
    const tokens = dlsitePopularTagTemplateTokens(value.period, value.releaseWindow, value.year, new Date());
    const preview = workflowTagTemplatePreview(value.tagNameTemplate, workflowTagTemplateTokenValues(tokens));
    const error = workflowTagTemplateBlockers(
      value.tagNameTemplate,
      tokens.map((token) => token.name),
    )[0];
    return (
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={workflowCopy("rankingPeriod")}>
          <NativeSelect
            fieldSize="sm"
            value={value.period}
            onChange={(event) => {
              const period = event.target.value as DLsitePopularPeriod;
              const tagNameTemplate =
                value.tagNameTemplate === dlsitePopularDefaultTagTemplate(value.period)
                  ? dlsitePopularDefaultTagTemplate(period)
                  : value.tagNameTemplate;
              onChange({ ...value, period, tagNameTemplate });
            }}
          >
            <option value="day">{workflowCopy("period24Hours")}</option>
            <option value="week">{workflowCopy("period7Days")}</option>
            <option value="month">{workflowCopy("period30Days")}</option>
            <option value="year">{workflowCopy("periodAnnual")}</option>
          </NativeSelect>
        </Field>
        {value.period === "year" ? (
          <Field label={workflowCopy("rankingYear")}>
            <Input
              fieldSize="sm"
              type="number"
              min={2000}
              max={new Date().getUTCFullYear()}
              value={value.year}
              step={1}
              inputMode="numeric"
              onChange={(event) => onChange({ ...value, year: wholeNumberFromInput(event.target.value) })}
            />
          </Field>
        ) : (
          <Field label={workflowCopy("releaseWindow")}>
            <NativeSelect
              fieldSize="sm"
              value={value.releaseWindow}
              onChange={(event) => onChange({ ...value, releaseWindow: event.target.value === "30d" ? "30d" : "" })}
            >
              <option value="30d">{workflowCopy("releasedIn30Days")}</option>
              <option value="">{workflowCopy("allReleases")}</option>
            </NativeSelect>
          </Field>
        )}
        <TagTemplateField
          id="dlsite-trigger-tag-template"
          enabled={!value.skipTag}
          onEnabledChange={(enabled) => onChange({ ...value, skipTag: !enabled })}
          value={value.tagNameTemplate}
          defaultValue={defaultTemplate}
          tokens={tokens}
          preview={preview}
          error={error}
          onChange={(tagNameTemplate) => onChange({ ...value, tagNameTemplate })}
        />
      </div>
    );
  }

  return null;
}

/** Edits the source presence options stored in the shared system trigger config. */
function SourcePresenceTriggerFields({
  value,
  onChange,
}: {
  value: SystemWorkflowTriggerConfig;
  onChange: Dispatch<SetStateAction<SystemWorkflowTriggerConfig>>;
}) {
  const options: SourcePresenceCheckOptions = {
    sourceId: value.sourceId,
    library: value.library,
    filter: value.presenceFilter,
    limit: value.limit,
  };
  const changeOptions = useCallback(
    (update: SetStateAction<SourcePresenceCheckOptions>) =>
      onChange((current) => {
        const next =
          typeof update === "function"
            ? update({
                sourceId: current.sourceId,
                library: current.library,
                filter: current.presenceFilter,
                limit: current.limit,
              })
            : update;
        return {
          ...current,
          sourceId: next.sourceId,
          library: next.library,
          presenceFilter: next.filter,
          limit: next.limit,
        };
      }),
    [onChange],
  );
  return (
    <div className="grid gap-3">
      <SourcePresenceFields stacked value={options} onChange={changeOptions} />
    </div>
  );
}
