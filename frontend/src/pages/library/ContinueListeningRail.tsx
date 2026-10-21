import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { api, assetURL, type Work } from "@/lib/api";

import { progressPercent, recentProgressLabel, recentTrackName } from "./recentPlayback";

const continueListeningLimit = 12;

/**
 * Recently played works as a horizontal rail below the phone Library's sort
 * row, so resuming takes one tap once the rail is open. The toolbar's toggle
 * mounts it. It loads the current history on mount and whenever the retained
 * Library page becomes active again, since playback elsewhere keeps moving the
 * list; the covers it shows stay until the new list arrives.
 */
export function ContinueListeningRail({
  id,
  active,
  onOpen,
}: {
  id: string;
  active: boolean;
  onOpen: (work: Work) => void;
}) {
  const { t } = useTranslation();
  const [works, setWorks] = useState<Work[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    api
      .listRecentlyPlayedWorks(continueListeningLimit, controller.signal)
      .then((result) => {
        setWorks(result.works);
        setFailed(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [active]);

  const message = (text: string) => <p className="py-3 text-sm text-muted-foreground">{text}</p>;
  return (
    <section id={id} aria-label={t("library.continueListening")}>
      {failed && !works ? (
        message(t("library.recentlyPlayedFailed"))
      ) : !works ? (
        <div className="grid h-24 place-items-center text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        </div>
      ) : works.length === 0 ? (
        message(t("library.noPlaybackYet"))
      ) : (
        <div className="-mx-4 snap-x snap-mandatory overflow-x-auto scroll-px-4 px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <ul className="flex w-max gap-3">
            {works.map((work) => (
              <li key={work.id} className="snap-start">
                <ContinueTile work={work} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        </div>
      )}
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
