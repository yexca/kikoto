import { Loader2, RefreshCw, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { LayoutWorkCard, type CompactWorkCardLayout } from "@/components/work-card/CompactWorkCard";
import {
  WorkCardContextItem,
  WorkCardContextStrip,
  WorkCardStatusBadge,
  type WorkCardStatusTone,
} from "@/components/work-card/WorkCardContext";
import {
  WorkCardActionButton,
  WorkCardDLsiteAction,
  WorkCardFooter,
  WorkCardSelection,
  type WorkCardViewModel,
} from "@/components/work-card/WorkCardShell";
import { dlsiteWorkURL } from "@/features/work-detail/workDetailShared";
import { formatRelativeTime, parseWorkflowTimestamp } from "@/features/workflows/runPresentation";
import { workflowCopy } from "@/features/workflows/workflowPageModel";
import type { AvailabilityWatchTarget } from "@/lib/api";

import {
  watchTargetAllows,
  watchTargetGroup,
  watchTargetOtherEdition,
  watchTargetRun,
  type WatchTargetGroup,
  type WatchTargetRun,
} from "./availabilityWatchModel";
import { WatchTrackFetchButtons } from "./WatchActionButtons";

/**
 * A watched code as a work card. A target need not be a work in the library,
 * so the card knows only the code, and the title and cover Kikoto keeps for
 * its family: no credits, tags, or metrics. Without a title, the code stands
 * in for it.
 */
export function watchTargetCardView(target: AvailabilityWatchTarget): WorkCardViewModel {
  return {
    code: target.workCode,
    title: target.title || target.workCode,
    circle: "",
    credits: false,
    coverUrl: target.coverUrl || undefined,
    dlsiteTags: [],
    sourceBadges: [],
    sourceUnavailableFallback: false,
  };
}

/** The label of a target's state above its card. */
export function watchTargetStateLabel(target: AvailabilityWatchTarget, group = watchTargetGroup(target)): string {
  const run = watchTargetRun(target);
  switch (group) {
    case "available":
      return workflowCopy("availabilityState.available");
    case "inProgress":
      return run ? workflowCopy(`watchView.run.${run.kind}.${run.state}`) : workflowCopy("watchView.groups.inProgress");
    case "failed":
      return workflowCopy("availabilityState.checkFailed");
    case "inLibrary":
      return workflowCopy("watchView.groups.inLibrary");
    case "waiting":
      return target.lastCheckedAt
        ? workflowCopy("availabilityState.notAvailable")
        : workflowCopy("availabilityState.notChecked");
  }
}

function stateTone(group: WatchTargetGroup, run: WatchTargetRun | null): WorkCardStatusTone {
  if (group === "failed" || (group === "inProgress" && run?.state === "failed")) return "warning";
  if (group === "available" || group === "inLibrary" || run?.state === "done") return "success";
  return "neutral";
}

export type WatchCardPermissions = {
  /** `metadata:sync`: Check now and Remove. */
  manage: boolean;
  track: boolean;
  fetch: boolean;
};

/**
 * One watched code in Discover's card layout. The line above the card holds
 * its state, then the source that made it available or when it was last
 * checked, the edition found, and how many other editions the family has; a
 * failed check states its error, and a started Track or Fetch links to its
 * run. The footer keeps the shared order: DLsite, then Track and Fetch on an
 * available work, Check now on a waiting or failed one, and Remove on every
 * card, which confirms on a second press. Selecting the card opens the family.
 */
export function AvailabilityWatchTargetCard({
  target,
  layout,
  sourceName,
  locale,
  now,
  permissions,
  armed,
  busy,
  selection,
  onOpen,
  onOpenRun,
  onTrack,
  onFetch,
  onCheck,
  onRemove,
}: {
  target: AvailabilityWatchTarget;
  /** The reduced card layout, or null for the regular card. */
  layout: CompactWorkCardLayout | null;
  sourceName: string;
  locale: string;
  now: number;
  /** The account's permissions on the watch, or null where the view is read-only. */
  permissions: WatchCardPermissions | null;
  armed: boolean;
  busy: boolean;
  /** The card's checkbox in selection mode. */
  selection: { checked: boolean; onChange: (checked: boolean) => void } | null;
  onOpen: () => void;
  onOpenRun: (runId: number) => void;
  onTrack: () => void;
  onFetch: () => void;
  onCheck: () => void;
  onRemove: () => void;
}) {
  const group = watchTargetGroup(target);
  const run = watchTargetRun(target);
  const edition = watchTargetOtherEdition(target);
  const otherEditions = Math.max(0, target.family.length - 1);
  const checkedAt = parseWorkflowTimestamp(target.lastCheckedAt);
  const offered = group === "available" || (group === "inProgress" && Boolean(target.availableSourceId));
  const detail = [
    group === "failed" || (group === "inProgress" && target.lastError)
      ? target.lastError
      : offered || group === "inLibrary"
        ? sourceName
        : checkedAt
          ? formatRelativeTime(checkedAt, locale, now)
          : "",
    edition ? workflowCopy("availableAsCode", { code: edition }) : "",
    otherEditions > 0 ? workflowCopy("otherEditions", { count: otherEditions }) : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const viewRun = run && group === "inProgress" && (
    <button
      type="button"
      className="rounded-sm px-1 text-xs font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={(event) => {
        event.stopPropagation();
        onOpenRun(run.runId);
      }}
    >
      {workflowCopy("watchView.viewRun")}
    </button>
  );

  const footer = permissions && (
    <WorkCardFooter
      className={layout === "row" ? "h-10 border-border/40" : undefined}
      left={<WorkCardDLsiteAction href={dlsiteWorkURL(target.workCode)} />}
      right={
        <>
          {offered && !target.inLibrary && (
            <WatchTrackFetchButtons
              target={target}
              canTrack={permissions.track}
              canFetch={permissions.fetch}
              trackAllowed={watchTargetAllows(target, "track")}
              fetchAllowed={watchTargetAllows(target, "fetch")}
              busy={busy}
              onTrack={onTrack}
              onFetch={onFetch}
            />
          )}
          {watchTargetAllows(target, "check") && (
            <WorkCardActionButton
              title={
                permissions.manage
                  ? workflowCopy("watchView.checkNow")
                  : workflowCopy("watchView.needsManagePermission")
              }
              disabled={!permissions.manage || busy}
              onClick={(event) => {
                event.stopPropagation();
                onCheck();
              }}
            >
              <RefreshCw className="h-4 w-4" />
            </WorkCardActionButton>
          )}
          {armed ? (
            <Button
              variant="destructive"
              size="sm"
              className="h-8 px-2.5 text-xs"
              aria-label={workflowCopy("confirmRemoveAria", { workCode: target.workCode })}
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                onRemove();
              }}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : workflowCopy("confirmRemove")}
            </Button>
          ) : (
            <WorkCardActionButton
              title={
                permissions.manage
                  ? workflowCopy("removeFromWatchAria", { workCode: target.workCode })
                  : workflowCopy("watchView.needsManagePermission")
              }
              disabled={!permissions.manage || busy}
              onClick={(event) => {
                event.stopPropagation();
                onRemove();
              }}
            >
              <Trash2 className="h-4 w-4" />
            </WorkCardActionButton>
          )}
        </>
      }
    />
  );

  return (
    <WorkCardContextItem
      label={target.title || target.workCode}
      context={
        <WorkCardContextStrip detail={detail} action={viewRun || undefined}>
          <WorkCardStatusBadge tone={stateTone(group, run)}>{watchTargetStateLabel(target, group)}</WorkCardStatusBadge>
        </WorkCardContextStrip>
      }
    >
      <LayoutWorkCard
        layout={layout}
        work={watchTargetCardView(target)}
        onOpen={onOpen}
        selection={
          selection ? <WorkCardSelection checked={selection.checked} onChange={selection.onChange} /> : undefined
        }
        footer={footer || undefined}
      />
    </WorkCardContextItem>
  );
}
