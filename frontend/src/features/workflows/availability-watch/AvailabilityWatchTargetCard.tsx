import { AudioLines, Languages, Loader2, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Card } from "@/components/ui/card";
import type { CompactWorkCardLayout } from "@/components/work-card/CompactWorkCard";
import { coverChipClassName } from "@/components/work-card/WorkCardShell";
import { formatRelativeTime, parseWorkflowTimestamp } from "@/features/workflows/runPresentation";
import { workflowCopy } from "@/features/workflows/workflowPageModel";
import { assetURL, type AvailabilityWatchTarget } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import { availabilityWatchStateLabel } from "./AvailabilityWatchFamilyDialog";
import { isAvailableTarget } from "./availabilityWatchModel";

/**
 * One watched code in the card mode the page's display options choose: the
 * code, title, and cover Kikoto knows for its family, its state, and the
 * source and edition that made it available. A target need not be a work in
 * the library, so the card leaves out the work card's credits, tags, and
 * metrics. Selecting it opens the family; the × removes it after a second,
 * confirming press.
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
  const state = availabilityWatchStateLabel(target);
  const checkedAt = parseWorkflowTimestamp(target.lastCheckedAt);
  const detail = available ? sourceName : !failed && checkedAt ? formatRelativeTime(checkedAt, locale, now) : "";
  const title = target.title || workflowCopy("editionWithoutMetadata");
  const tooltip = [
    target.workCode,
    target.title,
    [state, detail].filter(Boolean).join(" · "),
    viaEdition ? workflowCopy("availableAsCode", { code: viaEdition }) : "",
    target.lastError,
  ]
    .filter(Boolean)
    .join("\n");
  const extras = [
    viaEdition ? workflowCopy("availableAsCode", { code: viaEdition }) : "",
    otherEditions > 0 ? workflowCopy("otherEditions", { count: otherEditions }) : "",
  ]
    .filter(Boolean)
    .join(", ");

  const status = (
    <span className="flex min-w-0 items-center gap-1.5 text-xs">
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          failed ? "bg-warning" : available ? "bg-success" : "bg-muted-foreground/50",
        )}
        aria-hidden="true"
      />
      <span className={cn("shrink-0 font-medium", failed && "text-warning-foreground")}>{state}</span>
      {detail && <span className="min-w-0 truncate text-muted-foreground">· {detail}</span>}
      {extras && <span className="sr-only">, {extras}</span>}
    </span>
  );
  const code = (
    <span className="block min-w-0 truncate font-mono text-2xs font-medium tracking-wide text-muted-foreground">
      {target.workCode}
    </span>
  );
  const cover = <TargetCover target={target} layout={layout} viaEdition={viaEdition} otherEditions={otherEditions} />;

  let content: ReactNode;
  if (layout === "row") {
    content = (
      <span className="flex gap-3 p-2.5">
        <span className="block w-[7.5rem] shrink-0">{cover}</span>
        <span className="flex min-w-0 flex-1 flex-col gap-1 pr-7">
          {code}
          <TargetTitle title={title} known={Boolean(target.title)} className="text-[0.9375rem] leading-5" />
          <span className="mt-auto block pt-0.5">{status}</span>
        </span>
      </span>
    );
  } else if (layout === "cover") {
    content = (
      <>
        <span className="block p-1.5 pb-0">{cover}</span>
        <span className="block px-2 pb-2 pt-1.5">
          <span className="sr-only">{target.workCode} </span>
          <TargetTitle
            title={title}
            known={Boolean(target.title)}
            className="min-h-9 text-[0.8125rem] leading-[1.125rem]"
          />
          <span className="sr-only">{[state, detail, extras].filter(Boolean).join(", ")}</span>
        </span>
      </>
    );
  } else {
    const tile = layout === "tile";
    content = (
      <>
        <span className="block p-1.5 pb-0">{cover}</span>
        <span className={cn("flex flex-1 flex-col gap-1", tile ? "px-2.5 pb-2.5 pt-2" : "px-3 pb-3 pt-2.5")}>
          {code}
          <TargetTitle
            title={title}
            known={Boolean(target.title)}
            className={cn("min-h-10 leading-5", tile ? "text-sm" : "text-[0.9375rem]")}
          />
          <span className="mt-auto block pt-1">{status}</span>
        </span>
      </>
    );
  }

  return (
    <Card
      className={cn(
        "relative h-full overflow-hidden transition-colors hover:border-primary/40 focus-within:border-primary/40",
        armed && "border-error-border hover:border-error-border",
        failed && !armed && "border-warning-border",
      )}
      data-card-layout={layout ?? "full"}
    >
      <button
        type="button"
        className="flex h-full w-full min-w-0 flex-col rounded-[inherit] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        title={tooltip}
        onClick={onOpen}
      >
        {content}
      </button>
      {!readOnly &&
        (armed || removing ? (
          <button
            type="button"
            className="touch-target absolute right-2 top-2 flex h-6 items-center gap-1 rounded-md bg-destructive px-2 text-xs font-medium text-destructive-foreground shadow-sm transition-colors hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={workflowCopy("confirmRemoveAria", { workCode: target.workCode })}
            onClick={onRemove}
            disabled={removing}
          >
            {removing ? <Loader2 className="h-3 w-3 animate-spin" /> : workflowCopy("confirmRemove")}
          </button>
        ) : (
          <button
            type="button"
            className="touch-target absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-md bg-background/90 text-muted-foreground shadow-sm ring-1 ring-foreground/10 transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={workflowCopy("removeFromWatchAria", { workCode: target.workCode })}
            title={workflowCopy("removeFromWatch")}
            onClick={onRemove}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ))}
    </Card>
  );
}

function TargetTitle({ title, known, className }: { title: string; known: boolean; className?: string }) {
  return (
    <span className={cn("line-clamp-2 font-semibold", !known && "font-normal text-muted-foreground", className)}>
      {title}
    </span>
  );
}

/** The family's cover with the marks a glance needs: a failed check, the edition found, and other editions. */
function TargetCover({
  target,
  layout,
  viaEdition,
  otherEditions,
}: {
  target: AvailabilityWatchTarget;
  layout: CompactWorkCardLayout | null;
  viaEdition: string;
  otherEditions: number;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [target.coverUrl]);
  const chip = cn(coverChipClassName, "h-5 px-1.5 text-2xs font-medium");
  return (
    <span className="relative block aspect-[4/3] overflow-hidden rounded-[calc(var(--radius)-4px)] bg-muted after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:ring-1 after:ring-inset after:ring-foreground/5">
      {target.coverUrl && !imageFailed ? (
        <img
          src={assetURL(target.coverUrl)}
          alt=""
          className={cn("h-full w-full", layout === "row" ? "object-cover" : "object-contain")}
          loading="lazy"
          decoding="async"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <span className="flex h-full flex-col items-center justify-center gap-1 bg-secondary text-secondary-foreground">
          <AudioLines className="h-6 w-6 opacity-50" aria-hidden="true" />
          <span className="max-w-full truncate px-2 font-mono text-2xs opacity-70">{target.workCode}</span>
        </span>
      )}
      {(target.state === "error" || viaEdition || otherEditions > 0) && (
        // The card's text repeats these marks for assistive technology.
        <span className="absolute inset-x-1 bottom-1 flex items-center gap-1" aria-hidden="true">
          {target.state === "error" && (
            <span className={cn(chip, "w-5 justify-center px-0")}>
              <span className="h-1.5 w-1.5 rounded-full bg-warning" />
            </span>
          )}
          {viaEdition && (
            <span className={cn(chip, "min-w-0 text-success-foreground")}>
              <Languages className="h-3 w-3 shrink-0" />
              {layout !== "cover" && <span className="truncate font-mono">{viaEdition}</span>}
            </span>
          )}
          {otherEditions > 0 && <span className={cn(chip, "shrink-0 tabular-nums")}>+{otherEditions}</span>}
        </span>
      )}
    </span>
  );
}
