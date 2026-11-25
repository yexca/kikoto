import { SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { OptionField, RunOptionRows, SwitchControl } from "@/features/workflows/RunOptionControls";
import { MetadataSyncFallbackFields } from "@/features/workflows/run-forms/MetadataSyncFallbackFields";
import { workflowCopy } from "@/features/workflows/workflowPageModel";
import type { LibrarySource } from "@/lib/api";

import { maxFallbackSources, type MetadataRunOptions } from "./metadataRunOptions";

/**
 * The Metadata card's options: the remote metadata fallback, which asks the
 * chosen sources in order when DLsite reports a work as not found, and
 * purchase bonus linking. Save keeps them for the card's runs, and the page
 * stores them in Metadata's triggers too.
 */
export function MetadataOptionsDialog({
  value,
  sources,
  sourcesFailed,
  readOnly,
  onRetrySources,
  onSave,
  onClose,
}: {
  value: MetadataRunOptions;
  /** Enabled sources that provide metadata; null while loading. */
  sources: LibrarySource[] | null;
  sourcesFailed: boolean;
  readOnly: boolean;
  onRetrySources: () => void;
  onSave: (value: MetadataRunOptions) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  const fallback = draft.remoteMetadataFallback;
  const fallbackIncomplete =
    fallback.enabled && (fallback.sourceIds.length === 0 || fallback.sourceIds.length > maxFallbackSources);

  return (
    <Dialog onClose={onClose} size="md">
      <DialogHeader
        icon={<SlidersHorizontal className="h-5 w-5" />}
        title={t("workflowPage.cards.metadataOptions")}
        description={t("workflowPage.cards.metadataOptionsDescription")}
        onClose={onClose}
      />
      <DialogBody className="workflow-options grid min-w-0 gap-4">
        <fieldset disabled={readOnly} className="m-0 min-w-0 border-0 p-0">
          <RunOptionRows>
            <OptionField
              label={workflowCopy("remoteMetadataFallback.title")}
              hint={workflowCopy("remoteMetadataFallback.description")}
              stacked
            >
              {sourcesFailed ? (
                <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-error-foreground">
                  {workflowCopy("metadataSyncScope.sourcesFailed")}
                  <Button size="sm" variant="outline" onClick={onRetrySources}>
                    {workflowCopy("retry")}
                  </Button>
                </div>
              ) : sources && sources.length === 0 && !fallback.enabled ? (
                <p className="text-sm text-muted-foreground">{workflowCopy("remoteMetadataFallback.noSources")}</p>
              ) : (
                <MetadataSyncFallbackFields
                  sources={sources ?? []}
                  value={fallback}
                  disabled={readOnly || sources === null}
                  onChange={(remoteMetadataFallback) => setDraft((current) => ({ ...current, remoteMetadataFallback }))}
                />
              )}
              {fallbackIncomplete && (
                <p className="text-xs text-warning-foreground">{workflowCopy("metadataSyncScope.fallbackRequired")}</p>
              )}
            </OptionField>
            <OptionField label={workflowCopy("purchaseBonus.title")} stacked>
              <SwitchControl
                label={workflowCopy("purchaseBonus.autoLink")}
                description={workflowCopy("purchaseBonus.description")}
                checked={draft.purchaseBonusAutoLink}
                onCheckedChange={(purchaseBonusAutoLink) =>
                  setDraft((current) => ({ ...current, purchaseBonusAutoLink }))
                }
              />
            </OptionField>
          </RunOptionRows>
        </fieldset>
      </DialogBody>
      <DialogFooter className="items-center">
        <Button variant="outline" size="sm" onClick={onClose}>
          {workflowCopy("cancel")}
        </Button>
        <Button size="sm" disabled={readOnly || fallbackIncomplete} onClick={() => onSave(draft)}>
          {workflowCopy("save")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
