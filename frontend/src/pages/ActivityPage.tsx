import { Compass } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { usePageHeaderBack } from "@/app/pageHeader";
import { useAuth } from "@/auth/AuthProvider";
import { DemoReadOnlyNotice } from "@/components/DemoReadOnlyNotice";
import { Button } from "@/components/ui/button";
import { RunDetail } from "@/features/workflows/RunDetail";
import { useActivityLocation } from "@/features/workflows/useActivityLocation";
import { WorkflowActivity } from "@/features/workflows/WorkflowActivity";
import { openWorkflowPath } from "@/features/workflows/workflowLinks";
import { workflowCopy } from "@/features/workflows/workflowPageModel";
import { discoverManagedWorkflows } from "@/features/workflows/workflowTriggerModel";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import { useWorkflowRunWatcher } from "@/hooks/useWorkflowRunWatcher";
import { api, type WorkflowDefinition } from "@/lib/api";

/**
 * Activity is the run log of every workflow: what is running, what needs
 * attention, and what finished, with one run's details beside the list.
 */
export function ActivityPage({ canSyncMetadata, readOnly = false }: { canSyncMetadata: boolean; readOnly?: boolean }) {
  const { t } = useTranslation();
  const auth = useAuth();
  const location = useActivityLocation();
  const watched = useWorkflowRunWatcher(location.runId, !auth.demoMode);
  const run = watched.run?.id === location.runId ? watched.run : null;
  const [revision, setRevision] = useState(0);
  const [definitions, setDefinitions] = useState<WorkflowDefinition[]>([]);
  const mobile = useMobileNavigationLayout();

  // The workflow filter is a convenience: without the definitions the list still shows every run.
  useEffect(() => {
    let active = true;
    api
      .listWorkflowDefinitions()
      .then((items) => {
        if (active) setDefinitions(items);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const workflowOptions = useMemo(
    () =>
      definitions
        .map((definition) => ({
          code: definition.code,
          name: t(`workflowPage.builtInDefinitions.${definition.code}.name`, { defaultValue: definition.displayName }),
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    [definitions, t],
  );

  usePageHeaderBack({
    label: t("workflowActivity.backToHistory"),
    onBack: location.backToList,
    enabled: mobile && location.runId !== null,
  });

  const refreshRun = async () => {
    await watched.refresh(true);
    setRevision((value) => value + 1);
  };
  const managed = discoverManagedWorkflows[location.workflowCode];

  return (
    <div className="space-y-4">
      {readOnly && <DemoReadOnlyNotice />}
      <WorkflowActivity
        view={location.view}
        onViewChange={location.setView}
        workflowCode={location.workflowCode}
        workflowOptions={workflowOptions}
        onWorkflowChange={location.setWorkflow}
        query={location.query}
        onQueryChange={location.setQuery}
        note={
          managed ? (
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
              <p className="min-w-0">{workflowCopy(managed.message)}</p>
              <Button size="sm" variant="outline" onClick={() => openWorkflowPath(managed.path)}>
                <Compass className="h-4 w-4" />
                {workflowCopy("openSubscriptions")}
              </Button>
            </div>
          ) : undefined
        }
        selectedRunId={location.runId}
        onSelectRun={(selected) => location.openRun(selected.id)}
        onBack={location.backToList}
        refreshKey={revision}
        readOnly={readOnly}
        staticDemo={auth.demoMode}
        canSyncMetadata={canSyncMetadata}
        mobile={mobile}
        detail={
          location.runId ? (
            <>
              {watched.error && (
                <div role="alert" className="mb-4 rounded-md border p-3 text-sm">
                  {workflowCopy("activityLoadFailed")}{" "}
                  <Button variant="outline" onClick={() => void watched.refresh(true)}>
                    {t("common.retry")}
                  </Button>
                </div>
              )}
              <RunDetail
                key={location.runId}
                run={run}
                candidates={run ? watched.candidates : []}
                events={run ? watched.events : []}
                loading={!run && !watched.error}
                onCandidateUpdate={refreshRun}
                onRunAction={refreshRun}
                canSyncMetadata={canSyncMetadata}
                readOnly={readOnly}
              />
            </>
          ) : undefined
        }
      />
    </div>
  );
}
