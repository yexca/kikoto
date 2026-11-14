import { Rss } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { toastFromError, useToast } from "@/components/ui/toast";
import { PresetRunPanel } from "@/features/workflows/run-forms/PresetRunPanel";
import type { RunFormLayout } from "@/features/workflows/RunOptionControls";
import { openWorkflowPath, workflowActivityRunPath } from "@/features/workflows/workflowLinks";
import { workflowCopy } from "@/features/workflows/workflowPageModel";
import { api, type WorkflowPreset } from "@/lib/api";

export type CatalogSyncCode = "circle_catalog_sync" | "series_catalog_sync" | "voice_catalog_sync";

/**
 * The run options of a catalog sync, opened from the circle, series, or voice
 * actor it syncs: the target starts filled in, and Run queues the sync and
 * closes the dialog with a link to the run in Activity.
 */
export function CatalogSyncDialog({
  code,
  target,
  readOnly = false,
  canTag,
  canOpenActivity,
  onClose,
}: {
  code: CatalogSyncCode;
  /** The preset's target inputs, such as `{ circleId }`. */
  target: Record<string, string>;
  /** Demo shows the options for inspection; Run stays disabled. */
  readOnly?: boolean;
  canTag: boolean;
  canOpenActivity: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [preset, setPreset] = useState<WorkflowPreset | null | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let current = true;
    api
      .listWorkflowPresets()
      .then((presets) => {
        if (current) setPreset(presets.find((item) => item.code === code) ?? null);
      })
      .catch(() => {
        if (current) setPreset(null);
      });
    return () => {
      current = false;
    };
  }, [code]);

  const run = async (inputs: Record<string, unknown>) => {
    if (readOnly || submitting) return;
    setSubmitting(true);
    try {
      const result = await api.runWorkflowPreset(code, inputs);
      toast.notify({
        kind: "success",
        message: workflowCopy("catalogSyncQueued", { id: result.runId }),
        actionLabel: canOpenActivity ? t("nav.activity") : undefined,
        onAction: canOpenActivity ? () => openWorkflowPath(workflowActivityRunPath(result.runId)) : undefined,
      });
      onClose();
    } catch (error) {
      toast.notify(toastFromError(error, workflowCopy("presetQueueFailed")));
    } finally {
      setSubmitting(false);
    }
  };

  const layout: RunFormLayout = ({ run: runButton, options, blocker }) => (
    <>
      <DialogBody className="workflow-options min-w-0">{options}</DialogBody>
      <DialogFooter className="items-center">
        <div className="mr-auto min-w-0 flex-1">{blocker}</div>
        <Button variant="outline" size="sm" onClick={onClose}>
          {workflowCopy("cancel")}
        </Button>
        {runButton}
      </DialogFooter>
    </>
  );

  return (
    <Dialog onClose={onClose} size="xl">
      <DialogHeader
        icon={<Rss className="h-5 w-5" />}
        title={t(`workflowPage.builtInDefinitions.${code}.name`)}
        description={t(`workflowPage.operations.summaries.${code}`)}
        onClose={onClose}
      />
      {preset ? (
        <PresetRunPanel
          layout={layout}
          preset={preset}
          running={submitting}
          allowed={!readOnly}
          canTag={canTag}
          initialInputs={target}
          onRun={run}
        />
      ) : (
        <DialogBody>
          <p className="py-6 text-center text-sm text-muted-foreground" role={preset === null ? "alert" : "status"}>
            {preset === null ? workflowCopy("catalogSyncUnavailable") : t("common.loading")}
          </p>
        </DialogBody>
      )}
    </Dialog>
  );
}
