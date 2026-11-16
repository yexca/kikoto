import type { Dispatch, SetStateAction } from "react";

import { OptionField, SegmentedControl } from "@/features/workflows/RunOptionControls";
import { SOURCE_PRESENCE_MAX_LIMIT, workflowCopy } from "@/features/workflows/workflowPageModel";
import type { SourcePresenceCheckOptions, SourcePresenceFilter, SourcePresenceLibrary } from "@/lib/api";

const sourcePresenceLimits = [50, 100, 250, 500, SOURCE_PRESENCE_MAX_LIMIT];

/** The works a source presence check asks one source about, and how many per run. */
export function SourcePresenceScopeFields({
  stacked = false,
  disabled = false,
  value,
  onChange,
}: {
  stacked?: boolean;
  disabled?: boolean;
  value: SourcePresenceCheckOptions;
  onChange: Dispatch<SetStateAction<SourcePresenceCheckOptions>>;
}) {
  return (
    <>
      <OptionField label={workflowCopy("sourcePresenceLibrary")} stacked={stacked}>
        <SegmentedControl<SourcePresenceLibrary>
          label={workflowCopy("sourcePresenceLibrary")}
          value={value.library}
          disabled={disabled}
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
          disabled={disabled}
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
          disabled={disabled}
          onChange={(next) => onChange((current) => ({ ...current, limit: Number(next) }))}
          options={sourcePresenceLimits.map((limit) => ({ value: String(limit), label: String(limit) }))}
        />
      </OptionField>
    </>
  );
}
