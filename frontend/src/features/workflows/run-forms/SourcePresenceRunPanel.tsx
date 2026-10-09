import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";

import {
  OptionField,
  RunOptionRows,
  SegmentedControl,
  WorkflowRunButton,
  type RunFormLayout,
} from "@/features/workflows/RunOptionControls";
import {
  SOURCE_PRESENCE_DEFAULT_LIMIT,
  SOURCE_PRESENCE_MAX_LIMIT,
  workflowCopy,
  type CurrentTriggerRunOptions,
} from "@/features/workflows/workflowPageModel";
import { workflowSystemTriggerConfig } from "@/features/workflows/workflowTriggerModel";
import {
  api,
  type LibrarySource,
  type SourcePresenceCheckOptions,
  type SourcePresenceFilter,
  type SourcePresenceLibrary,
} from "@/lib/api";

const sourcePresenceLimits = [50, 100, 250, 500, SOURCE_PRESENCE_MAX_LIMIT];

const sourcePresenceDefaults: SourcePresenceCheckOptions = {
  sourceId: 0,
  library: "local",
  filter: "no_remote_source",
  limit: SOURCE_PRESENCE_DEFAULT_LIMIT,
};

/** The source, work scope, and per-run work limit of a source presence check. */
export function SourcePresenceFields({
  stacked = false,
  value,
  onChange,
}: {
  stacked?: boolean;
  value: SourcePresenceCheckOptions;
  /** Receives functional updates so the async source fill does not overwrite edits made meanwhile. */
  onChange: Dispatch<SetStateAction<SourcePresenceCheckOptions>>;
}) {
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const [loadingSources, setLoadingSources] = useState(true);
  const compatibleSources = useMemo(
    () =>
      sources.filter(
        (source) =>
          source.enabled && ["kikoeru_compatible", "kikoeru_compatible_number178"].includes(source.sourceType),
      ),
    [sources],
  );

  useEffect(() => {
    let active = true;
    api
      .listLibrarySources()
      .then((items) => {
        if (!active) return;
        setSources(items);
        const first = items.find(
          (source) =>
            source.enabled && ["kikoeru_compatible", "kikoeru_compatible_number178"].includes(source.sourceType),
        );
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
  }, [onChange]);

  return (
    <>
      <OptionField label={workflowCopy("remoteSource")} stacked={stacked}>
        {compatibleSources.length > 0 ? (
          <SegmentedControl
            label={workflowCopy("remoteSource")}
            value={String(value.sourceId)}
            onChange={(next) => onChange((current) => ({ ...current, sourceId: Number(next) }))}
            options={compatibleSources.map((source) => ({ value: String(source.id), label: source.displayName }))}
          />
        ) : (
          <p className="flex min-h-[var(--control-height-sm)] items-center text-sm text-muted-foreground">
            {loadingSources ? workflowCopy("loadingSources") : workflowCopy("noCompatibleSource")}
          </p>
        )}
      </OptionField>
      <OptionField label={workflowCopy("sourcePresenceLibrary")} stacked={stacked}>
        <SegmentedControl<SourcePresenceLibrary>
          label={workflowCopy("sourcePresenceLibrary")}
          value={value.library}
          onChange={(library) => onChange((current) => ({ ...current, library }))}
          options={[
            { value: "local", label: workflowCopy("sourcePresenceLibraryLocal") },
            { value: "all", label: workflowCopy("sourcePresenceLibraryAll") },
          ]}
        />
      </OptionField>
      <OptionField
        label={workflowCopy("sourcePresenceFilter")}
        hint={value.filter === "no_remote_source" ? workflowCopy("sourcePresenceFilterNoRemoteSourceHint") : undefined}
        stacked={stacked}
      >
        <SegmentedControl<SourcePresenceFilter>
          label={workflowCopy("sourcePresenceFilter")}
          value={value.filter}
          onChange={(filter) => onChange((current) => ({ ...current, filter }))}
          options={[
            { value: "all", label: workflowCopy("sourcePresenceFilterAll") },
            { value: "no_remote_source", label: workflowCopy("sourcePresenceFilterNoRemoteSource") },
          ]}
        />
      </OptionField>
      <OptionField
        label={workflowCopy("sourcePresenceLimit")}
        hint={workflowCopy("sourcePresenceLimitHint")}
        stacked={stacked}
      >
        <SegmentedControl
          label={workflowCopy("sourcePresenceLimit")}
          value={String(value.limit)}
          onChange={(next) => onChange((current) => ({ ...current, limit: Number(next) }))}
          options={sourcePresenceLimits.map((limit) => ({ value: String(limit), label: String(limit) }))}
        />
      </OptionField>
    </>
  );
}

export function SourcePresenceRunPanel({
  layout,
  running,
  allowed,
  onRun,
  onTriggerRunOptionsChange,
}: {
  layout: RunFormLayout;
  running: boolean;
  allowed: boolean;
  onRun: (options: SourcePresenceCheckOptions) => Promise<void>;
  onTriggerRunOptionsChange?: (options: CurrentTriggerRunOptions) => void;
}) {
  const [options, setOptions] = useState<SourcePresenceCheckOptions>(sourcePresenceDefaults);
  useEffect(() => {
    onTriggerRunOptionsChange?.({
      code: "source_presence_check",
      systemConfig: {
        ...workflowSystemTriggerConfig("source_presence_check", null),
        sourceId: options.sourceId,
        library: options.library,
        presenceFilter: options.filter,
        limit: options.limit,
      },
    });
  }, [options, onTriggerRunOptionsChange]);
  return layout({
    run: (
      <WorkflowRunButton
        running={running}
        disabled={!allowed || options.sourceId <= 0}
        onClick={() => void onRun(options)}
      />
    ),
    options: (
      <RunOptionRows>
        <SourcePresenceFields value={options} onChange={setOptions} />
      </RunOptionRows>
    ),
  });
}
