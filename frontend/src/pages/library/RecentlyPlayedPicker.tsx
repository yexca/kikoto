import { History, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { MobileSheet, MobileSheetBody, MobileSheetHeader } from "@/components/ui/mobile-sheet";
import { api, assetURL, type Work } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import { progressPercent, recentProgressLabel } from "./recentPlayback";

const RECENTLY_PLAYED_LIMIT = 20;

/**
 * The Library toolbar's Recently played button and the list it opens: a
 * popover on wide layouts and a sheet on phones. Choosing a work opens it.
 */
export function RecentlyPlayedPicker({
  phone,
  size = "sm",
  onOpen,
}: {
  phone: boolean;
  /** Matches the button to an 8 or 10 unit toolbar row. */
  size?: "sm" | "md";
  onOpen: (work: Work) => void;
}) {
  const { t } = useTranslation();
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const title = t("library.recentlyPlayed");
  const openWork = (work: Work) => {
    setOpen(false);
    onOpen(work);
  };
  const list = <RecentlyPlayedWorks onOpen={openWork} />;

  return (
    <div className="relative shrink-0" ref={anchorRef}>
      <Button
        type="button"
        variant="toolbar"
        size="icon-sm"
        className={cn(size === "md" && "h-10 w-10")}
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <History className="h-4 w-4" aria-hidden="true" />
      </Button>
      {phone ? (
        <MobileSheet open={open} onOpenChange={setOpen} ariaLabel={title}>
          <MobileSheetHeader>
            <h2 className="text-base font-semibold">{title}</h2>
            <Button variant="ghost" size="icon" aria-label={t("common.close")} onClick={() => setOpen(false)}>
              <X className="h-4 w-4" />
            </Button>
          </MobileSheetHeader>
          <MobileSheetBody>{list}</MobileSheetBody>
        </MobileSheet>
      ) : (
        <AnchoredPopover
          open={open}
          anchorRef={anchorRef}
          ariaLabel={title}
          onOpenChange={setOpen}
          className="w-[min(22rem,calc(100vw-1.5rem))] p-1.5"
        >
          <p className="px-2 pb-1.5 pt-1 text-xs font-medium text-muted-foreground">{title}</p>
          {list}
        </AnchoredPopover>
      )}
    </div>
  );
}

/**
 * The works played most recently, each with its last position. It loads
 * whenever it mounts, which is each time the picker opens: playback keeps
 * changing the list while the Library stays mounted.
 */
function RecentlyPlayedWorks({ onOpen }: { onOpen: (work: Work) => void }) {
  const { t } = useTranslation();
  const [works, setWorks] = useState<Work[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api
      .listRecentlyPlayedWorks(RECENTLY_PLAYED_LIMIT, controller.signal)
      .then((result) => setWorks(result.works))
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, []);

  if (failed && !works) {
    return <p className="px-2 py-6 text-center text-sm text-muted-foreground">{t("library.recentlyPlayedFailed")}</p>;
  }
  if (!works) {
    return (
      <div className="grid place-items-center py-6 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      </div>
    );
  }
  if (works.length === 0) {
    return <p className="px-2 py-6 text-center text-sm text-muted-foreground">{t("library.noPlaybackYet")}</p>;
  }
  return (
    <ul className="space-y-0.5">
      {works.map((work) => (
        <li key={work.id}>
          <button
            type="button"
            className="group flex w-full min-w-0 items-center gap-3 rounded-md p-1.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onOpen(work)}
            aria-label={t("library.openWorkTitle", { title: work.title })}
            title={`${work.primaryCode} · ${work.title}`}
          >
            <span className="relative block aspect-[4/3] h-12 shrink-0 overflow-hidden rounded-[calc(var(--radius)-2px)] bg-muted">
              {work.coverUrl ? (
                <img src={assetURL(work.coverUrl)} alt="" className="h-full w-full object-cover" loading="lazy" />
              ) : (
                <span className="grid h-full place-items-center text-xs font-bold text-muted-foreground">
                  {work.primaryCode.slice(0, 2)}
                </span>
              )}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-sm font-medium leading-snug group-hover:text-primary">{work.title}</span>
              <span className="truncate text-2xs text-muted-foreground" title={recentProgressLabel(work.progress, t)}>
                {recentProgressLabel(work.progress, t)}
              </span>
              <span className="block h-0.5 w-full overflow-hidden rounded-full bg-muted">
                <span
                  className="block h-full rounded-full bg-primary"
                  style={{ width: `${progressPercent(work.progress)}%` }}
                />
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
