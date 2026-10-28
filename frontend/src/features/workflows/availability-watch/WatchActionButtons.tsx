import { GitFork, HardDriveDownload } from "lucide-react";

import { WorkCardActionButton } from "@/components/work-card/WorkCardShell";
import { workflowCopy } from "@/features/workflows/workflowPageModel";

import type { WatchCardPermissions } from "./AvailabilityWatchTargetCard";
import { watchRunState, watchTargetActionCode, watchTargetOtherEdition } from "./availabilityWatchModel";
import type { WatchTargetActions } from "./useWatchTargetActions";

/**
 * Track and Fetch of an available watched work in a card footer, as on a
 * remote source's cards. When another edition is what a source offers, the
 * buttons name its code, and Fetch shows it. Without the permission a button
 * stays in place, disabled, with the reason as its tooltip.
 */
export function WatchTrackFetchButtons({
  target,
  canTrack,
  canFetch,
  trackAllowed,
  fetchAllowed,
  busy,
  onTrack,
  onFetch,
}: {
  target: { workCode: string; availableCode: string };
  /** The account holds the permission. */
  canTrack: boolean;
  canFetch: boolean;
  /** The target can take the action now, such as when no run of it is in progress. */
  trackAllowed: boolean;
  fetchAllowed: boolean;
  busy: boolean;
  onTrack: () => void;
  onFetch: () => void;
}) {
  const code = watchTargetActionCode(target);
  const edition = watchTargetOtherEdition(target);
  return (
    <>
      <WorkCardActionButton
        title={
          canTrack ? workflowCopy("watchView.trackCode", { code }) : workflowCopy("watchView.needsTrackPermission")
        }
        disabled={!canTrack || !trackAllowed || busy}
        onClick={(event) => {
          event.stopPropagation();
          onTrack();
        }}
      >
        <GitFork className="h-4 w-4" />
      </WorkCardActionButton>
      <WorkCardActionButton
        title={
          canFetch ? workflowCopy("watchView.fetchCode", { code }) : workflowCopy("watchView.needsFetchPermission")
        }
        disabled={!canFetch || !fetchAllowed || busy}
        showLabel={Boolean(edition)}
        quiet
        label={edition}
        labelClassName="font-mono text-xs"
        onClick={(event) => {
          event.stopPropagation();
          onFetch();
        }}
      >
        <HardDriveDownload className="h-4 w-4" />
      </WorkCardActionButton>
    </>
  );
}

/**
 * Track and Fetch of an available watch target outside the Watch view, such
 * as on a "Now available" card in New releases; nothing once the library has
 * the work.
 */
export function WatchTargetFooterButtons({
  target,
  permissions,
  actions,
}: {
  target: WatchFeedTarget;
  permissions: WatchCardPermissions;
  actions: WatchTargetActions;
}) {
  if (target.inLibrary) return null;
  const actionTarget = {
    id: target.id,
    workCode: target.workCode,
    availableCode: target.availableCode,
    availableSourceId: target.availableSourceId,
  };
  const idle = (status: string) => {
    const state = watchRunState(status);
    return state !== "queued" && state !== "running";
  };
  return (
    <WatchTrackFetchButtons
      target={target}
      canTrack={permissions.track}
      canFetch={permissions.fetch}
      trackAllowed={idle(target.trackRunStatus)}
      fetchAllowed={idle(target.fetchRunStatus)}
      busy={actions.busy !== null}
      onTrack={() => actions.track([actionTarget])}
      onFetch={() => actions.fetch([actionTarget])}
    />
  );
}

/** An available target as another surface knows it. */
export type WatchFeedTarget = {
  id: number;
  workCode: string;
  availableCode: string;
  availableSourceId: number;
  trackRunStatus: string;
  fetchRunStatus: string;
  inLibrary: boolean;
};
