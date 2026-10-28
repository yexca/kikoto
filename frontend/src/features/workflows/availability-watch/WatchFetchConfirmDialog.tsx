import { ArrowRight, HardDriveDownload } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { TokenInput } from "@/components/ui/token-input";
import { SwitchControl } from "@/features/workflows/RunOptionControls";
import { workflowCopy } from "@/features/workflows/workflowPageModel";
import { api } from "@/lib/api";
import { normalizeFetchExtension } from "@/lib/remoteFetchFilters";
import { WORD_TOKEN_SEPARATORS } from "@/lib/tokenDraft";

import { WATCH_ACTION_MAX_TARGETS, watchTargetOtherEdition } from "./availabilityWatchModel";
import type { WatchActionTarget } from "./useWatchTargetActions";

const EXCLUSION_STORE = "kikoto:watch-fetch-exclusion";

type FetchExclusion = { enabled: boolean; extensions: string[] };

/** The last exclusion chosen on this device; none until one is chosen. */
function readExclusion(): FetchExclusion {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(EXCLUSION_STORE) ?? "null");
    if (parsed && typeof parsed === "object") {
      const { enabled, extensions } = parsed as Partial<FetchExclusion>;
      return {
        enabled: enabled === true,
        extensions: Array.isArray(extensions) ? extensions.filter((value) => typeof value === "string") : [],
      };
    }
  } catch {
    // An unreadable choice starts over.
  }
  return { enabled: false, extensions: [] };
}

function writeExclusion(exclusion: FetchExclusion) {
  try {
    localStorage.setItem(EXCLUSION_STORE, JSON.stringify(exclusion));
  } catch {
    // The choice lasts for this Fetch when local storage is unavailable.
  }
}

/**
 * Confirms a Fetch of watched works: how many, which ones are available only
 * as another edition (whose code is fetched), the sources they come from, and
 * which file extensions to leave out. The exclusion is remembered per device.
 */
export function WatchFetchConfirmDialog({
  targets,
  onClose,
  onConfirm,
}: {
  targets: readonly WatchActionTarget[];
  onClose: () => void;
  onConfirm: (excludeExtensions: string[]) => void;
}) {
  const [exclusion, setExclusion] = useState(readExclusion);
  const [sourceNames, setSourceNames] = useState<Map<number, string>>(() => new Map());
  const queued = targets.slice(0, WATCH_ACTION_MAX_TARGETS);
  const editions = queued.filter((target) => watchTargetOtherEdition(target));
  const bySource = new Map<number, number>();
  for (const target of queued) {
    if (target.availableSourceId)
      bySource.set(target.availableSourceId, (bySource.get(target.availableSourceId) ?? 0) + 1);
  }

  useEffect(() => {
    let cancelled = false;
    api
      .listLibrarySources()
      .then((sources) => {
        if (!cancelled) setSourceNames(new Map(sources.map((source) => [source.id, source.displayName])));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const confirm = () => {
    writeExclusion(exclusion);
    onConfirm(exclusion.enabled ? exclusion.extensions : []);
  };

  return (
    <Dialog onClose={onClose} size="md">
      <DialogHeader
        icon={<HardDriveDownload className="h-5 w-5" />}
        title={workflowCopy("watchView.fetchConfirmTitle", { count: queued.length })}
        description={workflowCopy("watchView.fetchConfirmDescription")}
      />
      <DialogBody className="space-y-4">
        {queued.length < targets.length && (
          <p className="rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-sm text-warning-foreground">
            {workflowCopy("watchView.fetchCapped", {
              count: WATCH_ACTION_MAX_TARGETS,
              rest: targets.length - queued.length,
            })}
          </p>
        )}
        <section className="space-y-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">{workflowCopy("watchView.fetchFrom")}</h3>
          <ul className="space-y-1 text-sm">
            {Array.from(bySource, ([sourceId, count]) => (
              <li key={sourceId} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate">{sourceNames.get(sourceId) ?? `#${sourceId}`}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {workflowCopy("watchView.workCount", { count })}
                </span>
              </li>
            ))}
          </ul>
        </section>
        {editions.length > 0 && (
          <section className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground">
              {workflowCopy("watchView.fetchEditions", { count: editions.length })}
            </h3>
            <ul className="max-h-40 space-y-1 overflow-y-auto font-mono text-sm">
              {editions.map((target) => (
                <li key={target.id} className="flex items-center gap-2">
                  <span>{target.workCode}</span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="sr-only">{workflowCopy("watchView.fetchesEdition")}</span>
                  <span className="font-semibold">{watchTargetOtherEdition(target)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section className="grid gap-2 rounded-md border bg-muted/25 p-3">
          <SwitchControl
            label={workflowCopy("excludeExtensions")}
            description={workflowCopy("excludeExtensionsDescription")}
            checked={exclusion.enabled}
            onCheckedChange={(enabled) => setExclusion((current) => ({ ...current, enabled }))}
          />
          {exclusion.enabled && (
            <TokenInput
              ariaLabel={workflowCopy("extensionsToExclude")}
              values={exclusion.extensions}
              onChange={(extensions) => setExclusion((current) => ({ ...current, extensions }))}
              normalize={normalizeFetchExtension}
              separators={WORD_TOKEN_SEPARATORS}
              placeholder={workflowCopy("extensionsPlaceholder")}
            />
          )}
        </section>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>
          {workflowCopy("cancel")}
        </Button>
        <Button size="sm" onClick={confirm} disabled={queued.length === 0}>
          <HardDriveDownload className="h-4 w-4" />
          {workflowCopy("watchView.fetchConfirm", { count: queued.length })}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
