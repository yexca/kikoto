import { Settings2 } from "lucide-react";
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { VoiceActorPicker } from "@/features/workflows/CreatorPresetFields";
import {
  METADATA_SYNC_MODES,
  METADATA_SYNC_SCOPES,
  metadataSyncBlockers,
  metadataSyncDefaultValues,
  metadataSyncPayload,
  type MetadataSyncBlocker,
  type MetadataSyncFormValues,
} from "@/features/workflows/metadataSyncModel";
import { presetParameterLabel } from "@/features/workflows/run-forms/PresetRunPanel";
import { RemoteMetadataFallbackPopover } from "@/features/workflows/run-forms/RemoteMetadataFallbackPopover";
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
import type { MetadataSyncOptions } from "@/lib/api";

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
  return blocker === "circle_required"
    ? workflowCopy("metadataSyncScope.circleRequired")
    : workflowCopy("metadataSyncScope.voiceRequired");
}

/** Metadata sync scope: which existing works to refresh, and how much of their metadata. */
export function MetadataSyncFields({
  idPrefix,
  values,
  compact = false,
  disabled = false,
  onChange,
}: {
  idPrefix: string;
  values: MetadataSyncFormValues;
  compact?: boolean;
  disabled?: boolean;
  onChange: Dispatch<SetStateAction<MetadataSyncFormValues>>;
}) {
  const update = (next: Partial<MetadataSyncFormValues>) => onChange((current) => ({ ...current, ...next }));
  return (
    <RunOptionRows>
      <OptionField
        label={workflowCopy("metadataSyncScope.label")}
        hint={workflowCopy("metadataSyncScope.hint")}
        stacked={compact}
      >
        <SegmentedControl
          label={workflowCopy("metadataSyncScope.label")}
          value={values.scope}
          onChange={(scope) => update({ scope: scope as MetadataSyncFormValues["scope"] })}
          options={METADATA_SYNC_SCOPES.map((scope) => ({
            value: scope,
            label: workflowCopy(`metadataSyncScope.scopes.${scope}`),
            disabled,
          }))}
        />
      </OptionField>
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
            onChange={(personId, personName) => update({ personId, personName })}
          />
        </OptionField>
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
    </RunOptionRows>
  );
}

/**
 * Metadata sync run form. Administrators who manage sources also get
 * Configure beside Run for the instance-wide remote metadata fallback.
 */
export function MetadataSyncRunPanel({
  layout,
  running,
  allowed,
  configurable = false,
  readOnly = false,
  onRun,
  onTriggerRunOptionsChange,
}: {
  layout: RunFormLayout;
  running: boolean;
  allowed: boolean;
  /** Shows Configure; saving the configuration also needs `readOnly` to be false. */
  configurable?: boolean;
  readOnly?: boolean;
  onRun: (options: MetadataSyncOptions) => Promise<void>;
  onTriggerRunOptionsChange?: (options: CurrentTriggerRunOptions) => void;
}) {
  const [values, setValues] = useState<MetadataSyncFormValues>(metadataSyncDefaultValues);
  const configureRef = useRef<HTMLButtonElement | null>(null);
  const [configuring, setConfiguring] = useState(false);
  useEffect(() => {
    onTriggerRunOptionsChange?.({ code: "metadata_sync", metadataSync: values });
  }, [values, onTriggerRunOptionsChange]);
  const blockers = metadataSyncBlockers(values);
  return (
    <>
      {layout({
        run: (
          <WorkflowRunButton
            running={running}
            disabled={!allowed || blockers.length > 0}
            onClick={() => void onRun(metadataSyncPayload(values))}
          />
        ),
        actions: configurable ? (
          <Button
            ref={configureRef}
            variant="outline"
            aria-expanded={configuring}
            aria-haspopup="dialog"
            onClick={() => setConfiguring((open) => !open)}
          >
            <Settings2 className="h-4 w-4" />
            {workflowCopy("configure")}
          </Button>
        ) : undefined,
        options: <MetadataSyncFields idPrefix="metadata-sync-run" values={values} onChange={setValues} />,
        blocker: blockers.length > 0 ? <RunBlockerNote>{metadataSyncBlockerText(blockers[0])}</RunBlockerNote> : null,
      })}
      {configuring && (
        <RemoteMetadataFallbackPopover
          anchorRef={configureRef}
          readOnly={readOnly}
          onClose={() => setConfiguring(false)}
        />
      )}
    </>
  );
}
