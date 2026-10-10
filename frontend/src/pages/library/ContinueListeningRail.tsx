import { ChevronDown, Headphones } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { api, assetURL, type Work } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import { progressPercent, recentProgressLabel, recentTrackName } from "./recentPlayback";

const continueListeningLimit = 12;
const expandedStorageKey = "kikoto:library-continue-expanded";

function readContinueExpanded() {
  try {
    return window.localStorage.getItem(expandedStorageKey) === "true";
  } catch {
    return false;
  }
}

/**
 * Recently played works as a horizontal rail at the top of the phone Library,
 * so resuming takes one tap instead of opening the history sheet. A failure or
 * an empty history hides the rail; the library list reports its own errors.
 * Collapsed by default; opening it is a per-device preference.
 */
export function ContinueListeningRail({ active, onOpen }: { active: boolean; onOpen: (work: Work) => void }) {
  const { t } = useTranslation();
  const [works, setWorks] = useState<Work[]>([]);
  const [expanded, setExpanded] = useState(readContinueExpanded);
  const regionID = useId();

  // Reload whenever the page becomes active again: playback elsewhere moves the list.
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    api
      .listRecentlyPlayedWorks(continueListeningLimit, controller.signal)
      .then((result) => setWorks(result.works))
      .catch(() => {
        if (!controller.signal.aborted) setWorks([]);
      });
    return () => controller.abort();
  }, [active]);

  if (works.length === 0) return null;
  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    try {
      window.localStorage.setItem(expandedStorageKey, String(next));
    } catch {
      // The rail still toggles for this visit when storage is unavailable.
    }
  };
  return (
    <section aria-labelledby="library-continue-heading" className="space-y-2">
      <h2 id="library-continue-heading" className="text-sm font-semibold">
        <button
          type="button"
          className="-mx-1.5 inline-flex min-h-9 items-center gap-1.5 rounded-md px-1.5 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={expanded}
          aria-controls={regionID}
          onClick={toggle}
        >
          <Headphones className="h-4 w-4 text-primary" aria-hidden="true" />
          {t("library.continueListening")}
          <span className="text-xs font-normal tabular-nums text-muted-foreground">{works.length}</span>
          <ChevronDown
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform motion-reduce:transition-none",
              expanded && "rotate-180",
            )}
            aria-hidden="true"
          />
        </button>
      </h2>
      <div
        id={regionID}
        hidden={!expanded}
        className="-mx-4 snap-x snap-mandatory overflow-x-auto scroll-px-4 px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <ul className="flex w-max gap-3">
          {works.map((work) => (
            <li key={work.id} className="snap-start">
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
  const percent = progressPercent(work.progress);
  const track = recentTrackName(work.progress);
  return (
    <button
      type="button"
      className="group flex w-36 flex-col gap-1.5 rounded-[var(--radius)] text-left transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[var(--press-scale)] motion-reduce:active:scale-100"
      aria-label={t("library.openWorkTitle", { title: work.title })}
      title={`${work.title} · ${recentProgressLabel(work.progress, t)}`}
      onClick={() => onOpen(work)}
    >
      <span className="relative block aspect-[4/3] w-full overflow-hidden rounded-[calc(var(--radius)-2px)] bg-muted ring-1 ring-inset ring-foreground/5">
        {work.coverUrl ? (
          <img
            src={assetURL(work.coverUrl)}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <span className="grid h-full place-items-center font-mono text-2xs text-muted-foreground">
            {work.primaryCode}
          </span>
        )}
        <span className="absolute inset-x-0 bottom-0 h-1 bg-foreground/20" aria-hidden="true">
          <span className="block h-full bg-primary" style={{ width: `${percent}%` }} />
        </span>
      </span>
      <span className="line-clamp-2 text-xs font-medium leading-4">{work.title}</span>
      <span className="truncate text-2xs text-muted-foreground">
        {work.progress.completed ? t("library.finished") : track || work.circle}
      </span>
    </button>
  );
}
