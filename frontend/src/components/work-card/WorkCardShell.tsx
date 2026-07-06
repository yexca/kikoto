import { ExternalLink, Star } from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { assetURL, type WorkProgressSummary } from "@/lib/api";

export type WorkCardBadge = {
  key?: string;
  label: string;
  variant?: "default" | "secondary" | "outline" | "warning";
  title?: string;
};

export type WorkCardDate = {
  label: "Release" | "Updated";
  value: string;
};

export type WorkCardViewModel = {
  code: string;
  title: string;
  circle: string;
  circleExternalId?: string;
  coverUrl?: string;
  rating?: number | null;
  series?: string | null;
  dlsiteTags: WorkCardBadge[];
  date?: WorkCardDate | null;
  progress?: WorkProgressSummary | null;
  userTags?: WorkCardBadge[];
  sourceBadges: WorkCardBadge[];
};

export function WorkCardShell({
  work,
  selection,
  footer,
  canOpen = true,
  onOpen,
  onCircleOpen,
}: {
  work: WorkCardViewModel;
  selection?: ReactNode;
  footer?: ReactNode;
  canOpen?: boolean;
  onOpen?: () => void;
  onCircleOpen?: (externalId: string) => void;
}) {
  const content = (
    <>
      <WorkCardMedia coverUrl={work.coverUrl} code={work.code} rating={work.rating ?? null} selection={selection} />
      <WorkCardBody work={work} onCircleOpen={onCircleOpen} />
    </>
  );

  return (
    <Card className="group h-full transition-colors hover:border-primary/50">
      <CardContent className="flex h-full flex-col p-0">
        {onOpen ? (
          <button
            className={`flex flex-1 flex-col text-left ${canOpen ? "cursor-pointer" : "cursor-default"}`}
            disabled={!canOpen}
            onClick={onOpen}
          >
            {content}
          </button>
        ) : (
          <div className="flex flex-1 flex-col text-left">{content}</div>
        )}
        {footer}
      </CardContent>
    </Card>
  );
}

export function WorkCardMedia({
  coverUrl,
  code,
  rating,
  selection,
}: {
  coverUrl?: string;
  code: string;
  rating: number | null;
  selection?: ReactNode;
}) {
  const codeText = code || "Source";
  return (
    <div className="relative aspect-[4/3] overflow-hidden bg-muted">
      {selection}
      {coverUrl ? (
        <img src={assetURL(coverUrl)} alt="" className="h-full w-full object-contain transition-transform group-hover:scale-[1.03]" loading="lazy" />
      ) : (
        <div className="grid h-full place-items-center bg-secondary text-2xl font-bold text-secondary-foreground">{codeText.slice(0, 2)}</div>
      )}
      <div className="absolute left-3 top-3 rounded-md bg-background/90 px-2 py-1 text-xs font-semibold">{codeText}</div>
      <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-md bg-background/90 px-2 py-1 text-xs font-semibold">
        <Star className="h-3.5 w-3.5 fill-current" />
        {rating === null ? "No rating" : rating.toFixed(2)}
      </div>
    </div>
  );
}

function WorkCardBody({
  work,
  onCircleOpen,
}: {
  work: WorkCardViewModel;
  onCircleOpen?: (externalId: string) => void;
}) {
  return (
    <div className="flex min-h-52 flex-1 flex-col gap-3 p-4">
      <div className="space-y-1">
        <h3 className="line-clamp-2 min-h-10 text-base font-semibold leading-snug">{work.title}</h3>
        <button
          className="block max-w-full truncate text-left text-sm text-muted-foreground hover:text-primary"
          onClick={(event) => {
            event.stopPropagation();
            if (work.circleExternalId) onCircleOpen?.(work.circleExternalId);
          }}
        >
          {work.circle || "Unknown circle"}
        </button>
      </div>
      {work.series && (
        <div className="truncate text-xs text-muted-foreground">
          Series <span className="font-medium text-foreground">{work.series}</span>
        </div>
      )}
      <BadgeList badges={work.dlsiteTags} emptyLabel="No DLsite tags" />
      {work.date && <div className="truncate text-xs text-muted-foreground">{work.date.label} {work.date.value}</div>}
      {work.progress?.mediaItemId && <WorkProgressLine progress={work.progress} />}
      {work.userTags && work.userTags.length > 0 && (
        <div className="flex min-h-6 flex-wrap gap-1.5">
          {work.userTags.map((tag) => (
            <Badge key={tag.key ?? tag.label} variant={tag.variant ?? "secondary"} title={tag.title} className="border-primary/30 bg-primary/10 text-primary">
              {tag.label}
            </Badge>
          ))}
        </div>
      )}
      <div className="mt-auto">
        <BadgeList badges={work.sourceBadges} emptyLabel="Source unavailable" emptyVariant="warning" />
      </div>
    </div>
  );
}

function BadgeList({
  badges,
  emptyLabel,
  emptyVariant = "outline",
}: {
  badges: WorkCardBadge[];
  emptyLabel: string;
  emptyVariant?: WorkCardBadge["variant"];
}) {
  return (
    <div className="flex min-h-6 flex-wrap gap-1.5">
      {badges.length > 0 ? badges.map((badge) => (
        <Badge key={badge.key ?? `${badge.label}:${badge.variant ?? "secondary"}`} variant={badge.variant ?? "secondary"} title={badge.title}>
          {badge.label}
        </Badge>
      )) : <Badge variant={emptyVariant}>{emptyLabel}</Badge>}
    </div>
  );
}

export function WorkProgressLine({ progress }: { progress: WorkProgressSummary }) {
  return (
    <div className="space-y-1">
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${workProgressPercent(progress)}%` }} />
      </div>
      <div className="truncate text-xs text-muted-foreground">
        {progress.completed ? `Finished ${progress.title || "track"}` : `Resume ${progress.title || "track"} ${formatTime(progress.positionSeconds)}`}
      </div>
    </div>
  );
}

export function WorkCardFooter({ left, right }: { left?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mt-auto flex h-11 shrink-0 items-center justify-between gap-1 border-t px-3">
      <div className="flex min-w-0 items-center gap-1">{left}</div>
      <div className="flex min-w-0 items-center gap-1">{right}</div>
    </div>
  );
}

export function WorkCardActionButton({
  title,
  disabled,
  children,
  onClick,
}: {
  title: string;
  disabled?: boolean;
  children: ReactNode;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <Button variant="ghost" size="icon" className="h-8 w-8" title={title} aria-label={title} disabled={disabled} onClick={onClick}>
      {children}
    </Button>
  );
}

export function WorkCardDLsiteAction({ href }: { href: string }) {
  return (
    <Button variant="ghost" size="icon" className="h-8 w-8" asChild title="Open DLsite">
      <a href={href} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} aria-label="Open DLsite">
        <ExternalLink className="h-4 w-4" />
      </a>
    </Button>
  );
}

export function WorkCardSelection({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="absolute right-3 top-3 z-10 rounded-md bg-background/90 px-2 py-1 text-xs" onClick={(event) => event.stopPropagation()}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

export function dlsiteTagBadges(tags: string[]): WorkCardBadge[] {
  return tags.map((tag) => ({ key: `dlsite:${tag}`, label: tag, variant: "outline" }));
}

export function cardDate(releaseDate?: string | null, updatedAt?: string | null): WorkCardDate | null {
  const updated = dateOnly(updatedAt);
  if (updated) return { label: "Updated", value: updated };
  const released = dateOnly(releaseDate);
  return released ? { label: "Release", value: released } : null;
}

export function formatTime(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function workProgressPercent(progress: WorkProgressSummary) {
  if (!progress.durationSeconds || progress.durationSeconds <= 0) return 0;
  return Math.min(100, Math.max(0, (progress.positionSeconds / progress.durationSeconds) * 100));
}

function dateOnly(value?: string | null) {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : trimmed;
}
