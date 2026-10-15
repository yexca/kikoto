import { ExternalLink, Loader2, RotateCcw, Save } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toastFromError, useToast } from "@/components/ui/toast";
import { TokenInput } from "@/components/ui/token-input";
import { AvailabilityWatchPool } from "@/features/workflows/availability-watch/AvailabilityWatchPool";
import {
  availabilityWatchConfig,
  availabilityWatchConfigDirty,
  availabilityWatchConfigPayload,
  type AvailabilityWatchConfig,
} from "@/features/workflows/availability-watch/availabilityWatchModel";
import {
  OptionField,
  SegmentedControl,
  SwitchControl,
  WorkflowRunButton,
  type RunFormLayout,
} from "@/features/workflows/RunOptionControls";
import {
  DefinitionRunMonitor,
  RecentWorkflowRuns,
  runFormLayout,
  WorkflowPanel,
} from "@/features/workflows/WorkflowDetail";
import { WorkflowDetailFrame } from "@/features/workflows/WorkflowDetailFrame";
import { parseNodes, workflowCopy } from "@/features/workflows/workflowPageModel";
import { ErrorPanel, SkeletonLine, WorkflowMetadataErrorState } from "@/features/workflows/WorkflowPanelParts";
import {
  api,
  type AvailabilityWatch,
  type LibrarySource,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowTrigger,
} from "@/lib/api";
import { normalizeFetchExtension } from "@/lib/remoteFetchFilters";
import { WORD_TOKEN_SEPARATORS } from "@/lib/tokenDraft";

/**
 * A workflow configured on the Subscriptions page, such as Availability Watch
 * and the subscription refresh, keeps its run history on Workflows and links
 * to where it is managed.
 */
export function SubscriptionsManagedWorkflowPanel({
  definition,
  triggers,
  recentRuns,
  message,
  onOpenRun,
  onOpenSubscriptions,
}: {
  definition: WorkflowDefinition;
  triggers: WorkflowTrigger[];
  recentRuns: WorkflowRun[];
  message: string;
  onOpenRun: (run: WorkflowRun) => void;
  onOpenSubscriptions: () => void;
}) {
  const nodes = parseNodes(definition.definitionJson);
  return (
    <WorkflowDetailFrame definition={definition} recentRuns={recentRuns} triggers={triggers} onOpenRun={onOpenRun}>
      <div className="workflow-detail grid min-w-0 gap-5">
        <WorkflowPanel>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 text-sm text-muted-foreground">{message}</p>
            <Button size="sm" variant="outline" onClick={onOpenSubscriptions}>
              <ExternalLink className="h-4 w-4" />
              {workflowCopy("openSubscriptions")}
            </Button>
          </div>
        </WorkflowPanel>
        <DefinitionRunMonitor nodes={nodes} recentRuns={recentRuns} onOpenRun={onOpenRun} />
        <WorkflowPanel>
          <RecentWorkflowRuns runs={recentRuns} onOpen={onOpenRun} />
        </WorkflowPanel>
      </div>
    </WorkflowDetailFrame>
  );
}

/** The watch's configuration and shared pool, managed from the Subscriptions page. */
export function AvailabilityWatchManager({
  readOnly,
  canSyncMetadata,
  canTrackRemote,
  canFetchRemote,
  onRunQueued,
}: {
  readOnly: boolean;
  /** Availability Watch refreshes DLsite family metadata on every run. */
  canSyncMetadata: boolean;
  /** `remote:track`: the watch may track ready works. */
  canTrackRemote: boolean;
  /** `remote:fetch`: the watch may fetch ready works. */
  canFetchRemote: boolean;
  onRunQueued: () => void;
}) {
  const toast = useToast();
  const [watch, setWatch] = useState<AvailabilityWatch | null>(null);
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const refreshWatch = useCallback(async () => {
    const next = await api.getAvailabilityWatch();
    setWatch(next);
    setLoadError("");
    return next;
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getAvailabilityWatch(), api.listLibrarySources()])
      .then(([next, nextSources]) => {
        if (cancelled) return;
        setWatch(next);
        setSources(
          nextSources.filter(
            (source) =>
              source.enabled && ["kikoeru_compatible", "kikoeru_compatible_number178"].includes(source.sourceType),
          ),
        );
        setLoadError("");
      })
      .catch((error) => {
        if (!cancelled)
          setLoadError(error instanceof Error ? error.message : workflowCopy("availabilityWatchLoadFailed"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Polling starts once a watch has loaded; each poll's fresh object must not restart the timer.
  const watchId = watch?.id;
  useEffect(() => {
    if (watchId === undefined) return;
    const poll = () => {
      if (!document.hidden) void refreshWatch().catch(() => undefined);
    };
    const timer = window.setInterval(poll, 5000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [refreshWatch, watchId]);

  if (loading) {
    return (
      <Card>
        <CardContent className="space-y-3 p-5">
          <SkeletonLine className="h-6 w-48" />
          <SkeletonLine className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }
  if (!watch || loadError) {
    return (
      <WorkflowMetadataErrorState
        message={loadError || workflowCopy("availabilityWatchLoadFailed")}
        onRetry={() => void refreshWatch()}
      />
    );
  }

  const layout = runFormLayout({ optionsTitle: workflowCopy("configuration") });
  // The targets decide what the configured action tracks or fetches, so
  // editing them needs the same permissions as that action.
  const manageReadOnly =
    readOnly || !availabilityWatchActionAllowed(watch.action, canSyncMetadata, canTrackRemote, canFetchRemote);
  const sourceName = (sourceId: number | null) =>
    sourceId ? (sources.find((source) => source.id === sourceId)?.displayName ?? `#${sourceId}`) : "";

  return (
    <div className="workflow-detail grid min-w-0 gap-5">
      <AvailabilityWatchRunForm
        layout={layout}
        watch={watch}
        sources={sources}
        readOnly={manageReadOnly}
        canSyncMetadata={canSyncMetadata}
        canTrackRemote={canTrackRemote}
        canFetchRemote={canFetchRemote}
        onSaved={setWatch}
        onRunQueued={onRunQueued}
      />

      <AvailabilityWatchPool
        watch={watch}
        sourceName={sourceName}
        readOnly={manageReadOnly}
        onWatchChange={setWatch}
        onRefresh={() =>
          void refreshWatch().catch((error) =>
            toast.notify(toastFromError(error, workflowCopy("readyPoolRefreshFailed"))),
          )
        }
      />
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

function availabilityWatchActionAllowed(
  action: string,
  canSyncMetadata: boolean,
  canTrackRemote: boolean,
  canFetchRemote: boolean,
) {
  if (!canSyncMetadata) return false;
  if (action === "track") return canTrackRemote;
  if (action === "fetch") return canFetchRemote;
  if (action === "track_fetch") return canTrackRemote && canFetchRemote;
  return true;
}

function availabilityWatchActionOptions(canSyncMetadata: boolean, canTrackRemote: boolean, canFetchRemote: boolean) {
  return (["monitor", "track", "fetch", "track_fetch"] as const).map((value) => ({
    value,
    label: workflowCopy(
      ({ monitor: "monitorOnly", track: "track", fetch: "fetch", track_fetch: "trackFetch" } as const)[value],
    ),
    disabled: !availabilityWatchActionAllowed(value, canSyncMetadata, canTrackRemote, canFetchRemote),
  }));
}

/**
 * Availability Watch keeps a saved configuration that is edited in place; the
 * run bar saves it, and Run waits until the edits are saved.
 */
function AvailabilityWatchRunForm({
  layout,
  watch,
  sources,
  readOnly,
  canSyncMetadata,
  canTrackRemote,
  canFetchRemote,
  onSaved,
  onRunQueued,
}: {
  layout: RunFormLayout;
  watch: AvailabilityWatch;
  sources: LibrarySource[];
  readOnly: boolean;
  canSyncMetadata: boolean;
  canTrackRemote: boolean;
  canFetchRemote: boolean;
  onSaved: (watch: AvailabilityWatch) => void;
  onRunQueued: () => void;
}) {
  const toast = useToast();
  const [config, setConfig] = useState(() => availabilityWatchConfig(watch));
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const dirty = availabilityWatchConfigDirty(config, watch);
  const disabled = readOnly || saving;
  const update = (patch: Partial<AvailabilityWatchConfig>) => setConfig((current) => ({ ...current, ...patch }));

  // A configuration saved elsewhere replaces the form only while it holds no edits.
  const latest = useRef({ watch, dirty });
  latest.current = { watch, dirty };
  useEffect(() => {
    if (!latest.current.dirty) setConfig(availabilityWatchConfig(latest.current.watch));
  }, [watch.revision]);

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const saved = await api.updateAvailabilityWatch(availabilityWatchConfigPayload(config));
      setConfig(availabilityWatchConfig(saved));
      onSaved(saved);
      toast.success(workflowCopy("availabilityWatchSaved"));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : workflowCopy("availabilityWatchSaveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const run = async () => {
    setRunning(true);
    try {
      await api.runAvailabilityWatch();
      onRunQueued();
    } catch (runError) {
      toast.notify(toastFromError(runError, workflowCopy("availabilityWatchRunFailed")));
    } finally {
      setRunning(false);
    }
  };

  return layout({
    run: <WorkflowRunButton running={running} disabled={readOnly || dirty || saving} onClick={() => void run()} />,
    actions: (
      <Button variant="outline" onClick={() => void save()} disabled={disabled || !dirty}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        {workflowCopy("save")}
      </Button>
    ),
    optionsActions: dirty && !saving && (
      <Button size="sm" variant="ghost" onClick={() => setConfig(availabilityWatchConfig(watch))}>
        <RotateCcw className="h-4 w-4" />
        {workflowCopy("discardChanges")}
      </Button>
    ),
    blocker: dirty && !readOnly && (
      <span className="text-xs text-muted-foreground">{workflowCopy("saveBeforeRunning")}</span>
    ),
    options: (
      <div className="grid gap-4">
        <OptionField label={workflowCopy("remoteSource")}>
          <SegmentedControl
            label={workflowCopy("remoteSource")}
            value={String(config.sourceId)}
            onChange={(sourceId) => update({ sourceId: Number(sourceId) })}
            disabled={disabled}
            options={availabilityWatchSourceOptions(sources, config.sourceId)}
          />
        </OptionField>
        <OptionField label={workflowCopy("whenAvailable")}>
          <SegmentedControl
            label={workflowCopy("whenAvailable")}
            value={config.action}
            onChange={(action) => update({ action })}
            disabled={disabled}
            options={availabilityWatchActionOptions(canSyncMetadata, canTrackRemote, canFetchRemote)}
          />
        </OptionField>
        <OptionField label={workflowCopy("excludeExtensions")}>
          <div className="grid gap-2">
            <SwitchControl
              label={workflowCopy("excludeExtensions")}
              description={workflowCopy("excludeExtensionsDescription")}
              checked={config.excludeEnabled}
              onCheckedChange={(excludeEnabled) => update({ excludeEnabled })}
              disabled={disabled}
            />
            {config.excludeEnabled && (
              <TokenInput
                ariaLabel={workflowCopy("extensionsToExclude")}
                values={config.excludeExtensions}
                onChange={(excludeExtensions) => update({ excludeExtensions })}
                normalize={normalizeFetchExtension}
                separators={WORD_TOKEN_SEPARATORS}
                placeholder={workflowCopy("extensionsPlaceholder")}
                disabled={disabled}
              />
            )}
          </div>
        </OptionField>
        {error && <ErrorPanel error={error} />}
      </div>
    ),
  });
}
