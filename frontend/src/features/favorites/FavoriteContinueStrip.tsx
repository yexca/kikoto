import { ChevronDown, Headphones } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { api, assetURL, type Work } from "@/lib/api";
import { formatTime } from "@/player/dock/playerFormat";
import { cn } from "@/lib/tailwindClassNames";
import { favoriteResumeFraction, favoriteResumeRemainingSeconds } from "./favoriteShelfModel";

const continueLimit = 12;
const expandedStorageKey = "kikoto:favorites-continue-expanded";

/**
 * Works marked Listening on the current shelf, most recently played first.
 * The previous strip stays while another shelf loads, like the works grid, so
 * switching shelves does not move the results. A failure only hides the
 * strip; the shelf itself reports its own errors.
 */
export function useFavoriteContinueListening({
  enabled,
  listID,
  requestKey,
}: {
  enabled: boolean;
  listID: "all" | number;
  /** Changes whenever the shelf contents may have changed. */
  requestKey: string;
}) {
  const [works, setWorks] = useState<Work[]>([]);
  // Returning to an unchanged shelf, or to the Favorites tab, reuses the last strip.
  const loadedKeyRef = useRef("");
  const key = `${listID}:${requestKey}`;

  useEffect(() => {
    if (!enabled || loadedKeyRef.current === key) return;
    const controller = new AbortController();
    api
      .listFavoriteWorksPage(
        1,
        continueLimit,
        "",
        listID,
        "listening",
        "all",
        [],
        "activity",
        "desc",
        1,
        controller.signal,
      )
      .then((result) => {
        if (controller.signal.aborted) return;
        loadedKeyRef.current = key;
        setWorks(sortByLastPlayed(result.works));
      })
      .catch(() => {
        if (!controller.signal.aborted) setWorks([]);
      });
    return () => controller.abort();
  }, [enabled, key, listID]);

  return enabled ? works : [];
}

function sortByLastPlayed(works: Work[]) {
  return [...works].sort((left, right) => {
    const a = left.progress.lastPlayedAt ?? "";
    const b = right.progress.lastPlayedAt ?? "";
    return a === b ? 0 : a < b ? 1 : -1;
  });
}

function readContinueExpanded() {
  try {
    return window.localStorage.getItem(expandedStorageKey) === "true";
  } catch {
    return false;
  }
}

/** Collapsed by default; opening it is a per-device preference. */
export function FavoriteContinueStrip({ works, onOpen }: { works: Work[]; onOpen: (work: Work) => void }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(readContinueExpanded);
  const regionID = useId();
  if (works.length === 0) return null;
  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    try {
      window.localStorage.setItem(expandedStorageKey, String(next));
    } catch {
      // The strip still toggles for this visit when storage is unavailable.
    }
  };
  return (
    <section aria-labelledby="favorite-continue-heading" className="space-y-2">
      <h3 id="favorite-continue-heading" className="text-sm font-semibold">
        <button
          type="button"
          className="-mx-1.5 inline-flex h-8 items-center gap-2 rounded-md px-1.5 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={expanded}
          aria-controls={regionID}
          onClick={toggle}
        >
          <Headphones className="h-4 w-4 text-primary" />
          {t("favorites.continueListening")}
          <span className="text-xs font-normal tabular-nums text-muted-foreground">{works.length}</span>
          <ChevronDown
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform motion-reduce:transition-none",
              expanded && "rotate-180",
            )}
          />
        </button>
      </h3>
      <div
        id={regionID}
        hidden={!expanded}
        className="app-scrollbar -mx-1 overflow-x-auto overscroll-x-contain px-1 pb-1"
      >
        <ul className="flex w-max gap-3">
          {works.map((work) => (
            <li key={work.id}>
              <ContinueTile work={work} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function ContinueTile({ work, onOpen }: { work: Work; onOpen: (work: Work) => void }) {
  const { t } = useTranslation();
  const played = Boolean(work.progress.lastPlayedAt);
  const remaining = favoriteResumeRemainingSeconds(work.progress);
  const fraction = favoriteResumeFraction(work.progress);
  const trackTitle = work.progress.title.trim();
  const detail = !played
    ? t("favorites.noPlaybackYet")
    : remaining !== null
      ? t("favorites.timeLeft", { time: formatTime(remaining) })
      : formatTime(work.progress.positionSeconds);
  return (
    <button
      type="button"
      className="group flex w-72 items-center gap-3 rounded-[var(--radius)] border bg-card p-2 pr-3 text-left transition-[border-color,background-color,transform] hover:border-primary/40 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[var(--press-scale)] motion-reduce:active:scale-100"
      title={
        played && trackTitle
          ? t("favorites.resumeAt", { title: trackTitle, time: formatTime(work.progress.positionSeconds) })
          : work.title
      }
      onClick={() => onOpen(work)}
    >
      <span className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md bg-muted">
        {work.coverUrl && (
          <img
            src={assetURL(work.coverUrl)}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
            decoding="async"
          />
        )}
      </span>
      <span className="min-w-0 flex-1 space-y-1">
        <span className="line-clamp-2 text-sm font-medium leading-snug group-hover:text-primary">{work.title}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {played && trackTitle ? trackTitle : work.circle}
        </span>
        <span className="flex items-center gap-2">
          <span className="relative h-1 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <span
              className="absolute inset-y-0 left-0 rounded-full bg-primary"
              style={{ width: `${fraction * 100}%` }}
            />
          </span>
          <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">{detail}</span>
        </span>
      </span>
    </button>
  );
}
