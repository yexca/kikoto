import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { VoiceActorPicker } from "@/features/workflows/CreatorPresetFields";
import {
  METADATA_SYNC_MODES,
  METADATA_SYNC_SCOPES,
  metadataSyncBlockers,
  metadataSyncDefaultValues,
  metadataSyncPayload,
  metadataSyncSelectScope,
  metadataSyncSourceId,
  metadataSyncSources,
  type MetadataSyncBlocker,
  type MetadataSyncFormValues,
} from "@/features/workflows/metadataSyncModel";
import { presetParameterLabel } from "@/features/workflows/run-forms/PresetRunPanel";
import { MetadataSyncFallbackFields } from "@/features/workflows/run-forms/MetadataSyncFallbackFields";
import { useMetadataSyncSources } from "@/features/workflows/useMetadataSyncSources";
import {
  OptionField,
  RunBlockerNote,
  RunOptionRows,
  SegmentedControl,
  SwitchControl,
  WorkflowRunButton,
  type RunFormLayout,
} from "@/features/workflows/RunOptionControls";
import {
  workflowCopy,
  type CurrentTriggerRunOptions,
  type LocalScanMode,
} from "@/features/workflows/workflowPageModel";
import { workflowSystemTriggerConfig } from "@/features/workflows/workflowTriggerModel";
import type { LibrarySource, MetadataSyncOptions } from "@/lib/api";

export function LocalScanRunPanel({
  layout,
  running,
  allowed,
  onRun,
}: {
  layout: RunFormLayout;
  running: boolean;
  allowed: boolean;
  onRun: (followUpRun: boolean) => Promise<void>;
}) {
  const [followUpRun, setFollowUpRun] = useState(false);
  return layout({
    run: <WorkflowRunButton running={running} disabled={!allowed} onClick={() => void onRun(followUpRun)} />,
    options: (
      <RunOptionRows>
        <OptionField label={workflowCopy("followUpRun")}>
          <SwitchControl
            label={workflowCopy("followUpRun")}
            description={workflowCopy("followUpDescription")}
            checked={followUpRun}
            onCheckedChange={setFollowUpRun}
            disabled={running || !allowed}
          />
        </OptionField>
      </RunOptionRows>
    ),
  });
}

export function LocalMediaIndexRunPanel({
  layout,
  running,
  allowed,
  onRun,
  onTriggerRunOptionsChange,
}: {
  layout: RunFormLayout;
  running: boolean;
  allowed: boolean;
  onRun: (mode: LocalScanMode) => Promise<void>;
  onTriggerRunOptionsChange?: (options: CurrentTriggerRunOptions) => void;
}) {
  const [mode, setMode] = useState<LocalScanMode>("incremental");
  useEffect(() => {
    onTriggerRunOptionsChange?.({
      code: "local_media_index",
      systemConfig: { ...workflowSystemTriggerConfig("local_media_index", null), scanMode: mode },
    });
  }, [mode, onTriggerRunOptionsChange]);
  return layout({
    run: <WorkflowRunButton running={running} disabled={!allowed} onClick={() => void onRun(mode)} />,
    options: (
      <RunOptionRows>
        <LocalMediaIndexModeField value={mode} onChange={setMode} disabled={running || !allowed} />
      </RunOptionRows>
    ),
  });
}

/** Incremental indexes only never-scanned work folders; full re-indexes every local work folder. */
export function LocalMediaIndexModeField({
  value,
  onChange,
  disabled = false,
  stacked = false,
}: {
  value: LocalScanMode;
  onChange: (mode: LocalScanMode) => void;
  disabled?: boolean;
  stacked?: boolean;
}) {
  return (
    <OptionField
      label={workflowCopy("scanMode")}
      hint={
        value === "incremental"
          ? workflowCopy("localMediaIndexIncrementalHint")
          : workflowCopy("localMediaIndexFullHint")
      }
      stacked={stacked}
    >
      <SegmentedControl
        label={workflowCopy("scanMode")}
        value={value}
        onChange={onChange}
        disabled={disabled}
        options={[
          { value: "incremental", label: workflowCopy("incremental") },
          { value: "full", label: workflowCopy("full") },
        ]}
      />
    </OptionField>
  );
}

export function metadataSyncBlockerText(blocker: MetadataSyncBlocker) {
  const keys = {
    circle_required: "circleRequired",
    voice_required: "voiceRequired",
    voice_source_required: "voiceSourceRequired",
    works_required: "worksRequired",
    source_required: "sourceRequired",
    fallback_required: "fallbackRequired",
  };
  return workflowCopy(`metadataSyncScope.${keys[blocker]}`);
}

/** Metadata sync scope: which existing works to refresh, and how much of their metadata. */
export function MetadataSyncFields({
  idPrefix,
  values,
  compact = false,
  disabled = false,
  onChange,
  sources,
  sourceLoadFailed = false,
  onRetrySources,
}: {
  idPrefix: string;
  values: MetadataSyncFormValues;
  compact?: boolean;
  disabled?: boolean;
  onChange: Dispatch<SetStateAction<MetadataSyncFormValues>>;
  sources: LibrarySource[] | null;
  sourceLoadFailed?: boolean;
  onRetrySources: () => void;
}) {
  const update = (next: Partial<MetadataSyncFormValues>) => onChange((current) => ({ ...current, ...next }));
  const capableSources = metadataSyncSources(sources ?? []);
  const sourceId = metadataSyncSourceId(values);
  const sourceOptions = [
    ...(values.scope === "voice" ? [] : [{ value: "0", label: workflowCopy("metadataSyncScope.dlsite") }]),
    ...(values.scope === "circle"
      ? []
      : capableSources.map((source) => ({ value: String(source.id), label: source.displayName }))),
    ...(sourceId > 0 && !capableSources.some((source) => source.id === sourceId)
      ? [{ value: String(sourceId), label: workflowCopy("metadataSyncScope.sourceRequired"), disabled: true }]
      : []),
  ];
  return (
    <RunOptionRows>
      <OptionField
        label={workflowCopy("metadataSyncScope.label")}
        hint={
          sources !== null && capableSources.length === 0
            ? workflowCopy("metadataSyncScope.voiceSourceRequired")
            : workflowCopy("metadataSyncScope.hint")
        }
        stacked={compact}
      >
        <SegmentedControl
          label={workflowCopy("metadataSyncScope.label")}
          value={values.scope}
          onChange={(scope) => onChange((current) => metadataSyncSelectScope(current, scope, sources ?? []))}
          options={METADATA_SYNC_SCOPES.map((scope) => ({
            value: scope,
            label: workflowCopy(`metadataSyncScope.scopes.${scope}`),
            disabled: disabled || (scope === "voice" && capableSources.length === 0),
          }))}
        />
      </OptionField>
      {values.scope === "works" && (
        <OptionField
          label={workflowCopy("metadataSyncScope.workCodes")}
          htmlFor={`${idPrefix}-works`}
          hint={workflowCopy("metadataSyncScope.workCodesHint")}
          stacked={compact}
        >
          <Textarea
            id={`${idPrefix}-works`}
            value={values.workCodes}
            placeholder={workflowCopy("metadataSyncScope.workCodesPlaceholder")}
            disabled={disabled}
            onChange={(event) => update({ workCodes: event.target.value })}
          />
        </OptionField>
      )}
      {values.scope === "circle" && (
        <OptionField label={presetParameterLabel("circleId")} htmlFor={`${idPrefix}-circle`} stacked={compact}>
          <Input
            id={`${idPrefix}-circle`}
            fieldSize="sm"
            className="max-w-48"
            value={values.circleId}
            placeholder={workflowCopy("metadataSyncScope.circlePlaceholder")}
            disabled={disabled}
            onChange={(event) => update({ circleId: event.target.value })}
          />
        </OptionField>
      )}
      {values.scope === "voice" && (
        <OptionField label={presetParameterLabel("personId")} htmlFor={`${idPrefix}-voice`} stacked={compact}>
          <VoiceActorPicker
            id={`${idPrefix}-voice`}
            personId={values.personId}
            displayName={values.personName}
            disabled={disabled || capableSources.length === 0}
            onChange={(personId, personName) => update({ personId, personName })}
          />
        </OptionField>
      )}
      {sourceOptions.length > 0 && (
        <OptionField
          label={workflowCopy("metadataSyncScope.source")}
          hint={workflowCopy("metadataSyncScope.sourceHint")}
          stacked={compact}
        >
          <SegmentedControl
            label={workflowCopy("metadataSyncScope.source")}
            value={String(sourceId)}
            options={sourceOptions}
            disabled={disabled}
            onChange={(value) => update({ sourceId: Number(value) })}
          />
        </OptionField>
      )}
      {sourceLoadFailed && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-error-foreground">
          {workflowCopy("metadataSyncScope.sourcesFailed")}
          <Button size="sm" variant="outline" onClick={onRetrySources}>
            {workflowCopy("retry")}
          </Button>
        </div>
      )}
      <OptionField
        label={workflowCopy("metadataSyncScope.mode")}
        hint={
          values.mode === "full" && values.scope === "all"
            ? workflowCopy("metadataSyncScope.fullLibraryHint")
            : undefined
        }
        stacked={compact}
      >
        <SegmentedControl
          label={workflowCopy("metadataSyncScope.mode")}
          value={values.mode}
          onChange={(mode) => update({ mode: mode as MetadataSyncFormValues["mode"] })}
          options={METADATA_SYNC_MODES.map((mode) => ({
            value: mode,
            label: workflowCopy(`metadataSyncScope.modes.${mode}`),
            disabled,
          }))}
        />
      </OptionField>
      {sourceId === 0 && values.scope !== "voice" && (
        <>
          {(capableSources.length > 0 || values.remoteMetadataFallback.enabled) && (
            <OptionField
              label={workflowCopy("remoteMetadataFallback.title")}
              hint={workflowCopy("metadataSyncScope.fallbackHint")}
              stacked={compact}
            >
              <MetadataSyncFallbackFields
                sources={capableSources}
                value={values.remoteMetadataFallback}
                disabled={disabled || sources === null}
                onChange={(remoteMetadataFallback) => update({ remoteMetadataFallback })}
              />
            </OptionField>
          )}
          <OptionField label={workflowCopy("purchaseBonus.title")} stacked={compact}>
            <SwitchControl
              label={workflowCopy("purchaseBonus.autoLink")}
              description={workflowCopy("metadataSyncScope.bonusHint")}
              checked={values.purchaseBonusAutoLink}
              disabled={disabled}
              onCheckedChange={(purchaseBonusAutoLink) => update({ purchaseBonusAutoLink })}
            />
          </OptionField>
        </>
      )}
    </RunOptionRows>
  );
}

/**
 * Run and trigger options share one form; edits never write instance settings.
 */
export function MetadataSyncRunPanel({
  layout,
  running,
  allowed,
  onRun,
  onTriggerRunOptionsChange,
}: {
  layout: RunFormLayout;
  running: boolean;
  allowed: boolean;
  onRun: (options: MetadataSyncOptions) => Promise<void>;
  onTriggerRunOptionsChange?: (options: CurrentTriggerRunOptions) => void;
}) {
  const [values, setValues] = useState<MetadataSyncFormValues>(metadataSyncDefaultValues);
  const sourceState = useMetadataSyncSources();
  useEffect(() => {
    onTriggerRunOptionsChange?.({ code: "metadata_sync", metadataSync: values });
  }, [values, onTriggerRunOptionsChange]);
  const blockers = metadataSyncBlockers(values, sourceState.sources ?? undefined);
  const sourcePending =
    sourceState.sources === null &&
    (values.scope === "voice" || metadataSyncSourceId(values) > 0 || values.remoteMetadataFallback.enabled);
  return (
    <>
      {layout({
        run: (
          <WorkflowRunButton
            running={running}
            disabled={!allowed || blockers.length > 0 || sourcePending}
            onClick={() => void onRun(metadataSyncPayload(values))}
          />
        ),
        options: (
          <MetadataSyncFields
            idPrefix="metadata-sync-run"
            values={values}
            onChange={setValues}
            sources={sourceState.sources}
            sourceLoadFailed={sourceState.failed}
            onRetrySources={sourceState.retry}
            disabled={running || !allowed}
          />
        ),
        blocker: blockers.length > 0 ? <RunBlockerNote>{metadataSyncBlockerText(blockers[0])}</RunBlockerNote> : null,
      })}
    </>
  );
}
