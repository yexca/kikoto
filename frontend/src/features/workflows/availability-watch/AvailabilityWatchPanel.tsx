import { Edit3, Eye, Loader2, Save, Settings2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input, NativeSelect } from "@/components/ui/input";
import { toastFromError, useToast } from "@/components/ui/toast";
import {
  AvailabilityWatchMonitoringDialog,
  AvailabilityWatchReadyDialog,
} from "@/features/workflows/availability-watch/AvailabilityWatchDialogs";
import {
  OptionField,
  SegmentedControl,
  SwitchControl,
  WorkflowRunButton,
  type RunFormLayout,
} from "@/features/workflows/RunOptionControls";
import { WorkflowAutomationPanel } from "@/features/workflows/triggers/WorkflowAutomationPanel";
import { DefinitionRunMonitor, RecentWorkflowRuns, runFormLayout } from "@/features/workflows/WorkflowDetail";
import { localizedWorkflowDefinition, parseNodes, workflowCopy } from "@/features/workflows/workflowPageModel";
import { ErrorPanel, SkeletonLine, WorkflowMetadataErrorState } from "@/features/workflows/WorkflowPanelParts";
import type { CreatableAutomationTriggerType } from "@/features/workflows/workflowTriggerModel";
import {
  api,
  type AvailabilityWatch,
  type LibrarySource,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowTrigger,
} from "@/lib/api";

type AvailabilityWatchDialog = "monitoring" | "ready" | null;

export function AvailabilityWatchPanel({
  definition,
  triggers,
  recentRuns,
  readOnly,
  canManageDownloads,
  onCreateTrigger,
  onEditTrigger,
  onToggleTrigger,
  onOpenRun,
  onRunQueued,
}: {
  definition: WorkflowDefinition;
  triggers: WorkflowTrigger[];
  recentRuns: WorkflowRun[];
  readOnly: boolean;
  canManageDownloads: boolean;
  onCreateTrigger: (triggerType: CreatableAutomationTriggerType, anchor?: HTMLElement | null) => void;
  onEditTrigger: (trigger: WorkflowTrigger, anchor?: HTMLElement | null) => void;
  onToggleTrigger: (trigger: WorkflowTrigger, enabled: boolean) => Promise<void>;
  onOpenRun: (run: WorkflowRun) => void;
  onRunQueued: () => void;
}) {
  const toast = useToast();
  const [watch, setWatch] = useState<AvailabilityWatch | null>(null);
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const [dialog, setDialog] = useState<AvailabilityWatchDialog>(null);
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

  useEffect(() => {
    const syncDialog = () => {
      const search = new URLSearchParams(window.location.search);
      if (search.get("workflow") === "availability_watch" && search.get("dialog") === "ready") {
        setDialog("ready");
      }
    };
    syncDialog();
    window.addEventListener("popstate", syncDialog);
    window.addEventListener("kikoto:navigation", syncDialog);
    return () => {
      window.removeEventListener("popstate", syncDialog);
      window.removeEventListener("kikoto:navigation", syncDialog);
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

  const openReady = () => {
    const search = new URLSearchParams(window.location.search);
    search.set("workflow", "availability_watch");
    search.set("dialog", "ready");
    search.delete("run");
    window.history.replaceState(window.history.state, "", `/workflows?${search}`);
    setDialog("ready");
  };
  const closeDialog = () => {
    if (dialog === "ready") {
      const search = new URLSearchParams(window.location.search);
      search.set("workflow", "availability_watch");
      search.delete("dialog");
      search.delete("run");
      window.history.replaceState(window.history.state, "", `/workflows?${search}`);
    }
    setDialog(null);
  };

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

  const monitoring = watch.targets.filter((target) => target.state === "monitoring" || target.state === "error");
  const ready = watch.targets.filter(
    (target) => target.state !== "monitoring" && target.state !== "error" && target.state !== "disabled",
  );
  const nodes = parseNodes(definition.definitionJson);
  const displayDefinition = localizedWorkflowDefinition(definition);

  const layout = runFormLayout({
    title: displayDefinition.displayName,
    description: displayDefinition.description,
    optionsTitle: workflowCopy("configuration"),
  });

  return (
    <Card className="min-w-0">
      <CardContent className="min-w-0 space-y-5 p-5">
        <AvailabilityWatchRunForm
          layout={layout}
          watch={watch}
          sources={sources}
          readOnly={readOnly}
          canManageDownloads={canManageDownloads}
          onSaved={setWatch}
          onRunQueued={onRunQueued}
        />

        <section className="grid rounded-lg bg-muted/35 sm:grid-cols-2" aria-label={workflowCopy("availabilityPools")}>
          <div className="flex min-w-0 items-center justify-between gap-3 px-4 py-3.5">
            <div className="min-w-0">
              <div className="text-sm font-semibold">{workflowCopy("monitoring")}</div>
              <div className="mt-1 text-2xl font-semibold">{monitoring.length}</div>
            </div>
            <Button size="sm" variant="outline" onClick={() => setDialog("monitoring")}>
              <Edit3 className="h-4 w-4" />
              {workflowCopy("editNode")}
            </Button>
          </div>
          <div className="flex min-w-0 items-center justify-between gap-3 border-t px-4 py-3.5 sm:border-l sm:border-t-0">
            <div className="min-w-0">
              <div className="text-sm font-semibold">{workflowCopy("ready")}</div>
              <div className="mt-1 text-2xl font-semibold">{ready.length}</div>
            </div>
            <Button size="sm" variant="outline" onClick={openReady}>
              <Eye className="h-4 w-4" />
              {workflowCopy("view")}
            </Button>
          </div>
        </section>

        <DefinitionRunMonitor nodes={nodes} recentRuns={recentRuns} onOpenRun={onOpenRun} />
        <div className="grid min-w-0 gap-x-10 gap-y-5 lg:grid-cols-2">
          <WorkflowAutomationPanel
            definition={definition}
            triggers={triggers}
            canManage={!readOnly}
            readOnly={readOnly}
            onCreate={onCreateTrigger}
            onEdit={onEditTrigger}
            onToggle={onToggleTrigger}
          />
          <RecentWorkflowRuns runs={recentRuns} onOpen={onOpenRun} />
        </div>
      </CardContent>

      {dialog === "monitoring" && (
        <AvailabilityWatchMonitoringDialog watch={watch} readOnly={readOnly} onClose={closeDialog} onSaved={setWatch} />
      )}
      {dialog === "ready" && (
        <AvailabilityWatchReadyDialog
          targets={ready}
          readOnly={readOnly}
          onClose={closeDialog}
          onChanged={() =>
            void refreshWatch().catch((error) =>
              toast.notify(toastFromError(error, workflowCopy("readyPoolRefreshFailed"))),
            )
          }
        />
      )}
    </Card>
  );
}

function availabilityWatchExtensions(value: string) {
  return value
    .split(/[\s,;，；]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function availabilityWatchActionOptions(canManageDownloads: boolean) {
  return [
    { value: "monitor" as const, label: workflowCopy("monitorOnly") },
    { value: "track" as const, label: workflowCopy("track") },
    { value: "fetch" as const, label: workflowCopy("fetch"), disabled: !canManageDownloads },
    { value: "track_fetch" as const, label: workflowCopy("trackFetch"), disabled: !canManageDownloads },
  ];
}

/**
 * Availability Watch keeps a saved configuration, so its header offers
 * Configure beside Run and the section below summarizes what Run will use.
 */
function AvailabilityWatchRunForm({
  layout,
  watch,
  sources,
  readOnly,
  canManageDownloads,
  onSaved,
  onRunQueued,
}: {
  layout: RunFormLayout;
  watch: AvailabilityWatch;
  sources: LibrarySource[];
  readOnly: boolean;
  canManageDownloads: boolean;
  onSaved: (watch: AvailabilityWatch) => void;
  onRunQueued: () => void;
}) {
  const toast = useToast();
  const configureRef = useRef<HTMLButtonElement | null>(null);
  const [configuring, setConfiguring] = useState(false);
  const [running, setRunning] = useState(false);
  const sourceName = watch.sourceId
    ? (sources.find((source) => source.id === watch.sourceId)?.displayName ?? `#${watch.sourceId}`)
    : workflowCopy("anyHealthySource");
  const actionName =
    availabilityWatchActionOptions(true).find((option) => option.value === watch.action)?.label ?? watch.action;

  const run = async () => {
    setRunning(true);
    try {
      await api.runAvailabilityWatch();
      onRunQueued();
    } catch (error) {
      toast.notify(toastFromError(error, workflowCopy("availabilityWatchRunFailed")));
    } finally {
      setRunning(false);
    }
  };

  const summary: [string, string][] = [
    [workflowCopy("remoteSource"), sourceName],
    [workflowCopy("whenAvailable"), actionName],
    [
      workflowCopy("excludeExtensions"),
      watch.excludeExtensions.length > 0 ? watch.excludeExtensions.join(", ") : workflowCopy("noExcludedExtensions"),
    ],
  ];

  return (
    <>
      {layout({
        run: <WorkflowRunButton running={running} disabled={readOnly} onClick={() => void run()} />,
        actions: (
          <Button
            ref={configureRef}
            variant="outline"
            aria-expanded={configuring}
            onClick={() => setConfiguring((open) => !open)}
          >
            <Settings2 className="h-4 w-4" />
            {workflowCopy("configure")}
          </Button>
        ),
        options: (
          <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-3">
            {summary.map(([term, detail]) => (
              <div key={term} className="min-w-0">
                <dt className="text-xs text-muted-foreground">{term}</dt>
                <dd className="mt-1 truncate text-sm font-medium" title={detail}>
                  {detail}
                </dd>
              </div>
            ))}
          </dl>
        ),
      })}
      {configuring && (
        <AvailabilityWatchConfigurePopover
          anchorRef={configureRef}
          watch={watch}
          sources={sources}
          readOnly={readOnly}
          canManageDownloads={canManageDownloads}
          onClose={() => setConfiguring(false)}
          onSaved={onSaved}
        />
      )}
    </>
  );
}

function AvailabilityWatchConfigurePopover({
  anchorRef,
  watch,
  sources,
  readOnly,
  canManageDownloads,
  onClose,
  onSaved,
}: {
  anchorRef: RefObject<HTMLButtonElement | null>;
  watch: AvailabilityWatch;
  sources: LibrarySource[];
  readOnly: boolean;
  canManageDownloads: boolean;
  onClose: () => void;
  onSaved: (watch: AvailabilityWatch) => void;
}) {
  const toast = useToast();
  const [action, setAction] = useState<AvailabilityWatch["action"]>(watch.action);
  const [sourceId, setSourceId] = useState(watch.sourceId ?? 0);
  const [excludeEnabled, setExcludeEnabled] = useState(watch.excludeExtensions.length > 0);
  const [excluded, setExcluded] = useState(watch.excludeExtensions.join(", "));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const disabled = readOnly || saving;

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const saved = await api.updateAvailabilityWatch({
        action,
        sourceId: sourceId || null,
        excludeExtensions: excludeEnabled ? availabilityWatchExtensions(excluded) : [],
      });
      onSaved(saved);
      toast.success(workflowCopy("availabilityWatchSaved"));
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : workflowCopy("availabilityWatchSaveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AnchoredPopover
      open
      anchorRef={anchorRef}
      onOpenChange={(open) => !open && onClose()}
      ariaLabel={workflowCopy("configuration")}
      className="w-[min(28rem,calc(100vw-1.5rem))] p-4"
    >
      <div className="grid gap-4">
        <h4 className="text-sm font-semibold">{workflowCopy("configuration")}</h4>
        <OptionField label={workflowCopy("remoteSource")} htmlFor="availability-watch-source" stacked>
          <NativeSelect
            id="availability-watch-source"
            fieldSize="sm"
            value={sourceId}
            onChange={(event) => setSourceId(Number(event.target.value))}
            disabled={disabled}
          >
            <option value={0}>{workflowCopy("anyHealthySource")}</option>
            {sources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.displayName}
              </option>
            ))}
          </NativeSelect>
        </OptionField>
        <OptionField label={workflowCopy("whenAvailable")} stacked>
          <SegmentedControl
            label={workflowCopy("whenAvailable")}
            value={action}
            onChange={setAction}
            disabled={disabled}
            options={availabilityWatchActionOptions(canManageDownloads)}
          />
        </OptionField>
        <OptionField label={workflowCopy("excludeExtensions")} stacked>
          <SwitchControl
            label={workflowCopy("excludeExtensions")}
            description={workflowCopy("excludeExtensionsDescription")}
            checked={excludeEnabled}
            onCheckedChange={setExcludeEnabled}
            disabled={disabled}
          />
          {excludeEnabled && (
            <Input
              fieldSize="sm"
              aria-label={workflowCopy("extensionsToExclude")}
              value={excluded}
              onChange={(event) => setExcluded(event.target.value)}
              placeholder={workflowCopy("extensionsPlaceholder")}
              disabled={disabled}
            />
          )}
        </OptionField>
        {error && <ErrorPanel error={error} />}
        <div className="flex justify-end gap-2 border-t pt-3">
          <Button size="sm" variant="ghost" onClick={onClose}>
            {workflowCopy("cancel")}
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={disabled}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {workflowCopy("save")}
          </Button>
        </div>
      </div>
    </AnchoredPopover>
  );
}
