import { Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { LayoutWorkCard, type CompactWorkCardLayout } from "@/components/work-card/CompactWorkCard";
import {
  WorkCardContextItem,
  WorkCardContextStrip,
  WorkCardStatusBadge,
  type WorkCardStatusTone,
} from "@/components/work-card/WorkCardContext";
import type { WorkCardViewModel } from "@/components/work-card/WorkCardShell";
import { formatRelativeTime, parseWorkflowTimestamp } from "@/features/workflows/runPresentation";
import { workflowCopy } from "@/features/workflows/workflowPageModel";
import type { AvailabilityWatchTarget } from "@/lib/api";

import { availabilityWatchStateLabel } from "./AvailabilityWatchFamilyDialog";
import { isAvailableTarget } from "./availabilityWatchModel";

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

/**
 * One watched code in Discover's card layout. The line above the card holds
 * its state, and then the source that made it available or when it was last
 * checked, the edition found, and how many other editions the family has; a
 * failed check states its error instead. The × at the end of that line
 * removes the target after a second, confirming press. Selecting the card
 * opens the family.
 */
export function AvailabilityWatchTargetCard({
  target,
  layout,
  sourceName,
  locale,
  now,
  readOnly,
  armed,
  removing,
  onOpen,
  onRemove,
}: {
  target: AvailabilityWatchTarget;
  /** The reduced card layout, or null for the regular card. */
  layout: CompactWorkCardLayout | null;
  sourceName: string;
  locale: string;
  now: number;
  readOnly: boolean;
  armed: boolean;
  removing: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const available = isAvailableTarget(target);
  const failed = target.state === "error";
  const viaEdition =
    available && target.availableCode && target.availableCode !== target.workCode ? target.availableCode : "";
  const otherEditions = Math.max(0, target.family.length - 1);
  const checkedAt = parseWorkflowTimestamp(target.lastCheckedAt);
  const tone: WorkCardStatusTone = failed ? "warning" : available ? "success" : "neutral";
  const detail = [
    failed ? target.lastError : available ? sourceName : checkedAt ? formatRelativeTime(checkedAt, locale, now) : "",
    viaEdition ? workflowCopy("availableAsCode", { code: viaEdition }) : "",
    otherEditions > 0 ? workflowCopy("otherEditions", { count: otherEditions }) : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const remove = readOnly ? null : armed || removing ? (
    <Button
      variant="destructive"
      size="sm"
      className="h-6 px-2 text-xs"
      aria-label={workflowCopy("confirmRemoveAria", { workCode: target.workCode })}
      disabled={removing}
      onClick={onRemove}
    >
      {removing ? <Loader2 className="h-3 w-3 animate-spin" /> : workflowCopy("confirmRemove")}
    </Button>
  ) : (
    <Button
      variant="ghost"
      size="icon-sm"
      className="h-6 w-6 text-muted-foreground hover:text-foreground"
      aria-label={workflowCopy("removeFromWatchAria", { workCode: target.workCode })}
      title={workflowCopy("removeFromWatch")}
      onClick={onRemove}
    >
      <X className="h-3.5 w-3.5" />
    </Button>
  );

  return (
    <WorkCardContextItem
      label={target.title || target.workCode}
      context={
        <WorkCardContextStrip detail={detail} action={remove}>
          <WorkCardStatusBadge tone={tone}>{availabilityWatchStateLabel(target)}</WorkCardStatusBadge>
        </WorkCardContextStrip>
      }
    >
      <LayoutWorkCard layout={layout} work={watchTargetCardView(target)} onOpen={onOpen} />
    </WorkCardContextItem>
  );
}
