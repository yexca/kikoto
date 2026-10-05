import { memo } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { WorkCardListButton, WorkCardQuickMarkButton } from "@/components/work-card/WorkCardShell";
import { sourcePresenceBadges } from "@/components/work-card/sourceBadges";
import { assetURL, type ListeningStatus, type Work } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";
import { formatTime } from "@/player/dock/playerFormat";
import { favoriteResumeFraction, favoriteResumeRemainingSeconds } from "./favoriteShelfModel";

export type FavoriteWorkItemHandlers = {
  onSelectedChange: (workID: number, selected: boolean) => void;
  onListsChanged: (work: Work) => Promise<void>;
  onOpen: (work: Work) => void;
  onStatusChange: (workID: number, status: ListeningStatus) => Promise<void>;
};

/** Dense list view: one row per work with its status, resume point, and file availability. */
export function FavoriteWorkList({
  works,
  selectedWorkIDs,
  selectionActive,
  isListSaving,
  busy,
  handlers,
}: {
  works: Work[];
  selectedWorkIDs: Set<number>;
  selectionActive: boolean;
  isListSaving: boolean;
  busy: boolean;
  handlers: FavoriteWorkItemHandlers;
}) {
  return (
    <div className="@container overflow-hidden rounded-[var(--radius)] border bg-card" aria-busy={busy}>
      <ul className="divide-y">
        {works.map((work) => (
          <FavoriteWorkRow
            key={work.id}
            work={work}
            selected={selectedWorkIDs.has(work.id)}
            selectionActive={selectionActive}
            isListSaving={isListSaving}
            handlers={handlers}
          />
        ))}
      </ul>
    </div>
  );
}

const FavoriteWorkRow = memo(function FavoriteWorkRow({
  work,
  selected,
  selectionActive,
  isListSaving,
  handlers,
}: {
  work: Work;
  selected: boolean;
  selectionActive: boolean;
  isListSaving: boolean;
  handlers: FavoriteWorkItemHandlers;
}) {
  const { t } = useTranslation();
  const badges = sourcePresenceBadges(work.sourcePresence, work.availability);
  const voices =
    work.voiceCredits.length > 0 ? work.voiceCredits.map((credit) => credit.displayName) : work.voiceActors;
  return (
    <li
      data-favorite-work-id={work.id}
      tabIndex={-1}
      className={cn(
        "group flex items-center gap-3 px-3 py-2.5 outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/40",
        selected && "bg-primary/5 hover:bg-primary/10",
      )}
    >
      {selectionActive && (
        <label className="-m-2 grid h-11 w-11 shrink-0 cursor-pointer place-items-center">
          <Checkbox
            checked={selected}
            onCheckedChange={(checked) => handlers.onSelectedChange(work.id, checked)}
            aria-label={`${t("workCard.selectWork")}: ${work.primaryCode}`}
          />
        </label>
      )}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="relative h-14 w-[4.5rem] shrink-0 overflow-hidden rounded-md bg-muted ring-1 ring-foreground/5"
        onClick={() => handlers.onOpen(work)}
      >
        {work.coverUrl ? (
          <img
            src={assetURL(work.coverUrl)}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <span className="grid h-full place-items-center text-xs font-semibold text-muted-foreground">
            {work.primaryCode.slice(0, 2)}
          </span>
        )}
      </button>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          className="block max-w-full truncate text-left text-sm font-medium hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title={work.title}
          onClick={() => handlers.onOpen(work)}
        >
          {work.title}
        </button>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0 tabular-nums">{work.primaryCode}</span>
          <span aria-hidden="true">·</span>
          <span className="truncate">
            {work.circle || t("workCard.unknownCircle")}
            {voices.length > 0 && <span className="hidden @lg:inline"> · {voices.join(", ")}</span>}
          </span>
        </div>
      </div>
      <ResumeCell work={work} />
      <div className="hidden w-32 shrink-0 flex-wrap justify-end gap-1 @2xl:flex">
        {badges.slice(0, 2).map((badge) => (
          <Badge
            key={badge.key ?? badge.label}
            variant={badge.variant ?? "secondary"}
            title={badge.title}
            className="max-w-full truncate px-2 text-2xs"
          >
            {badge.label}
          </Badge>
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <WorkCardQuickMarkButton
          value={work.listeningStatus}
          showLabel
          responsiveLabel
          onChange={(status) => void handlers.onStatusChange(work.id, status)}
        />
        <WorkCardListButton
          workId={work.id}
          active={work.favorite}
          disabled={isListSaving}
          onSaved={() => void handlers.onListsChanged(work)}
        />
      </div>
    </li>
  );
});

function ResumeCell({ work }: { work: Work }) {
  const { t } = useTranslation();
  const played = Boolean(work.progress.lastPlayedAt);
  const remaining = favoriteResumeRemainingSeconds(work.progress);
  const trackTitle = work.progress.title.trim();
  return (
    <div className="hidden w-44 shrink-0 @3xl:block">
      {played ? (
        <div className="space-y-1" title={trackTitle || undefined}>
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="truncate text-muted-foreground">{trackTitle || t("favorites.resume")}</span>
            {remaining !== null && (
              <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
                {t("favorites.timeLeft", { time: formatTime(remaining) })}
              </span>
            )}
          </div>
          <div className="relative h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <span
              className="absolute inset-y-0 left-0 rounded-full bg-primary"
              style={{ width: `${favoriteResumeFraction(work.progress) * 100}%` }}
            />
          </div>
        </div>
      ) : (
        <span className="text-xs text-muted-foreground/70">{t("favorites.noPlaybackYet")}</span>
      )}
    </div>
  );
}

export function FavoriteWorkListSkeleton({ label }: { label: string }) {
  return (
    <div
      className="overflow-hidden rounded-[var(--radius)] border bg-card"
      role="status"
      aria-label={label}
      aria-busy="true"
    >
      <div className="divide-y" aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="flex items-center gap-3 px-3 py-2.5">
            <div className="h-14 w-[4.5rem] shrink-0 animate-pulse rounded-md bg-muted" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-3.5 w-2/3 animate-pulse rounded bg-muted" />
              <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
            </div>
            <div className="h-8 w-20 shrink-0 animate-pulse rounded-md bg-muted" />
          </div>
        ))}
      </div>
    </div>
  );
}
