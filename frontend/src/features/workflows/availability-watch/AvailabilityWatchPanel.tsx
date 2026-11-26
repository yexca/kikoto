import { Loader2, RotateCcw, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import type { AvailabilityWatchState } from "@/features/workflows/availability-watch/useAvailabilityWatch";
import { LatestRunStatus } from "@/features/workflows/LatestRunStatus";
import { OptionField, SegmentedControl } from "@/features/workflows/RunOptionControls";
import { useLatestRun } from "@/features/workflows/useLatestRun";
import { workflowCopy } from "@/features/workflows/workflowPageModel";
import { ErrorPanel, SkeletonLine, WorkflowMetadataErrorState } from "@/features/workflows/WorkflowPanelParts";
import { api, type AvailabilityWatch, type LibrarySource } from "@/lib/api";

const AVAILABILITY_WATCH_CODE = "availability_watch";

/** A loading or failed shared watch, in place of the surface that needs it. */
export function AvailabilityWatchLoadState({ state }: { state: AvailabilityWatchState }) {
  if (state.loading) {
    return (
      <Card className="skeleton-reveal">
        <CardContent className="space-y-3 p-5">
          <SkeletonLine className="h-6 w-48" />
          <SkeletonLine className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }
  return (
    <WorkflowMetadataErrorState
      message={state.loadError || workflowCopy("availabilityWatchLoadFailed")}
      onRetry={state.retry}
    />
  );
}

/**
 * The watch's one setting, in the page's settings: which remote source it
 * checks, and the latest check. The watch only monitors; checking, Track, and
 * Fetch are on the Watch view, which shares this watch state and its poll. It
 * has no schedule: it runs after each subscription refresh that includes it,
 * and when someone checks, so its latest run may be either's.
 */
export function AvailabilityWatchSettings({
  state,
  readOnly,
  onOpenRun,
}: {
  state: AvailabilityWatchState;
  /** Demo, or an account without `metadata:sync`, which every check needs. */
  readOnly: boolean;
  onOpenRun: (runId: number) => void;
}) {
  const { watch } = state;
  const latestRun = useLatestRun({ code: AVAILABILITY_WATCH_CODE, enabled: true });
  if (!watch) return <AvailabilityWatchLoadState state={state} />;
  return (
    <div className="grid min-w-0 gap-4">
      <LatestRunStatus label={workflowCopy("watchView.latestRun")} run={latestRun} onOpen={onOpenRun} />
      <AvailabilityWatchSourceForm watch={watch} sources={state.sources} readOnly={readOnly} onSaved={state.setWatch} />
    </div>
  );
}

/** Any healthy source, then each enabled compatible source; a saved source that is no longer listed stays selectable. */
function availabilityWatchSourceOptions(sources: LibrarySource[], selectedId: number) {
  const options = [
    { value: "0", label: workflowCopy("anyHealthySource") },
    ...sources.map((source) => ({ value: String(source.id), label: source.displayName })),
  ];
  if (selectedId > 0 && !sources.some((source) => source.id === selectedId)) {
    options.push({ value: String(selectedId), label: `#${selectedId}` });
  }
  return options;
}

/** The saved source is edited in place; Save stores it. */
function AvailabilityWatchSourceForm({
  watch,
  sources,
  readOnly,
  onSaved,
}: {
  watch: AvailabilityWatch;
  sources: LibrarySource[];
  readOnly: boolean;
  onSaved: (watch: AvailabilityWatch) => void;
}) {
  const toast = useToast();
  const [sourceId, setSourceId] = useState(watch.sourceId ?? 0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dirty = sourceId !== (watch.sourceId ?? 0);

  // A source saved elsewhere replaces the form only while it holds no edits.
  const latest = useRef({ watch, dirty });
  latest.current = { watch, dirty };
  useEffect(() => {
    if (!latest.current.dirty) setSourceId(latest.current.watch.sourceId ?? 0);
  }, [watch.revision]);

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const saved = await api.updateAvailabilityWatch({ sourceId: sourceId || null });
      setSourceId(saved.sourceId ?? 0);
      onSaved(saved);
      toast.success(workflowCopy("availabilityWatchSaved"));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : workflowCopy("availabilityWatchSaveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid min-w-0 gap-4">
      <OptionField label={workflowCopy("remoteSource")} stacked hint={workflowCopy("watchView.sourceHint")}>
        <SegmentedControl
          label={workflowCopy("remoteSource")}
          value={String(sourceId)}
          onChange={(value) => setSourceId(Number(value))}
          disabled={readOnly || saving}
          options={availabilityWatchSourceOptions(sources, sourceId)}
        />
      </OptionField>
      <p className="text-xs text-muted-foreground">{workflowCopy("watchView.settingsNote")}</p>
      {error && <ErrorPanel error={error} />}
      {!readOnly && (
        <div className="flex flex-wrap justify-end gap-2">
          {dirty && !saving && (
            <Button size="sm" variant="ghost" onClick={() => setSourceId(watch.sourceId ?? 0)}>
              <RotateCcw className="h-4 w-4" />
              {workflowCopy("discardChanges")}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => void save()} disabled={saving || !dirty}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {workflowCopy("save")}
          </Button>
        </div>
      )}
    </div>
  );
}
