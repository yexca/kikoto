import { History, Music, Video, X } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { MobileSheet, MobileSheetBody, MobileSheetHeader } from "@/components/ui/mobile-sheet";
import { assetURL, type RecordAsset } from "@/lib/api";

import { watchedFraction } from "./recordProgress";
import { baseName, formatPlaybackTime } from "./recordsModel";

/** The folder path a Continue watching item names under its title. */
function folderCaption(relativePath: string | undefined) {
  const parts = (relativePath ?? "").split("/").filter(Boolean);
  return parts.slice(0, -1).join(" › ");
}

function ContinueThumbnail({ video }: { video: RecordAsset }) {
  const [failed, setFailed] = useState(false);
  const fraction = watchedFraction(video.progress);
  const Placeholder = video.kind === "audio" ? Music : Video;
  return (
    <span className="relative block aspect-video w-20 shrink-0 overflow-hidden rounded-[calc(var(--radius)-2px)] border bg-muted">
      {video.thumbnailUrl && !failed ? (
        <img
          src={assetURL(video.thumbnailUrl)}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <span className="grid h-full w-full place-items-center">
          <Placeholder className="h-4 w-4 text-muted-foreground/70" aria-hidden="true" />
        </span>
      )}
      {fraction !== null && (
        <span className="absolute inset-x-0 bottom-0 h-0.5 bg-foreground/15" aria-hidden="true">
          <span className="block h-full bg-primary" style={{ width: `${fraction * 100}%` }} />
        </span>
      )}
    </span>
  );
}

function ContinueList({
  assets,
  onSelect,
}: {
  assets: readonly RecordAsset[];
  onSelect: (video: RecordAsset) => void;
}) {
  const { t } = useTranslation();
  if (assets.length === 0) {
    return <p className="px-2 py-6 text-center text-sm text-muted-foreground">{t("records.noContinue")}</p>;
  }
  return (
    <ul className="space-y-0.5">
      {assets.map((video) => {
        const title = baseName(video.name);
        const folder = folderCaption(video.relativePath);
        const position = video.progress?.positionSeconds;
        const duration = video.durationSeconds ?? video.progress?.durationSeconds;
        const timeLabel =
          position !== undefined
            ? duration
              ? `${formatPlaybackTime(position)} / ${formatPlaybackTime(duration)}`
              : formatPlaybackTime(position)
            : null;
        return (
          <li key={video.id}>
            <button
              type="button"
              className="group flex w-full min-w-0 items-center gap-3 rounded-md p-1.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onSelect(video)}
            >
              <ContinueThumbnail video={video} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-medium leading-snug group-hover:text-primary">{title}</span>
                {folder && <span className="truncate text-xs text-muted-foreground">{folder}</span>}
                {timeLabel && <span className="text-xs tabular-nums text-muted-foreground">{timeLabel}</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The Continue watching icon button and the list it opens: a popover on wide
 * layouts and a sheet on phones. Available from any folder.
 */
export function RecordContinuePicker({
  assets,
  phone,
  onOpen,
}: {
  assets: readonly RecordAsset[];
  phone: boolean;
  onOpen: (video: RecordAsset) => void;
}) {
  const { t } = useTranslation();
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const title = t("records.sections.continue");
  const select = (video: RecordAsset) => {
    setOpen(false);
    onOpen(video);
  };

  return (
    <div className="relative shrink-0" ref={anchorRef}>
      <Button
        type="button"
        variant="toolbar"
        size="icon"
        aria-label={title}
        title={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <History className="h-4 w-4" aria-hidden="true" />
        {assets.length > 0 && (
          <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
        )}
      </Button>
      {phone ? (
        <MobileSheet open={open} onOpenChange={setOpen} ariaLabel={title}>
          <MobileSheetHeader>
            <h2 className="text-base font-semibold">{title}</h2>
            <Button variant="ghost" size="icon" aria-label={t("common.close")} onClick={() => setOpen(false)}>
              <X className="h-4 w-4" />
            </Button>
          </MobileSheetHeader>
          <MobileSheetBody>
            <ContinueList assets={assets} onSelect={select} />
          </MobileSheetBody>
        </MobileSheet>
      ) : (
        <AnchoredPopover
          open={open}
          anchorRef={anchorRef}
          ariaLabel={title}
          onOpenChange={setOpen}
          className="w-[min(24rem,calc(100vw-1.5rem))] p-1.5"
        >
          <p className="px-2 pb-1.5 pt-1 text-xs font-medium text-muted-foreground">{title}</p>
          <ContinueList assets={assets} onSelect={select} />
        </AnchoredPopover>
      )}
    </div>
  );
}
