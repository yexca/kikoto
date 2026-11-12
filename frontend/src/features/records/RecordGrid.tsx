import { Check, Folder, Play, Video } from "lucide-react";
import { memo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { assetURL, type RecordAsset, type RecordFolder, type RecordProgress } from "@/lib/api";

import { watchedFraction } from "./recordProgress";
import { baseName, formatPlaybackTime } from "./recordsModel";

const tileFocus =
  "rounded-lg text-left outline-none transition-transform focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[var(--press-scale)] motion-reduce:active:scale-100";

export function RecordSection({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-3">
      <div className="flex items-center gap-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        <Badge variant="secondary" className="tabular-nums">
          {count}
        </Badge>
        <span className="h-px flex-1 bg-border" aria-hidden="true" />
      </div>
      {children}
    </section>
  );
}

export const RecordFolderTile = memo(function RecordFolderTile({
  folder,
  onOpen,
}: {
  folder: RecordFolder;
  onOpen: (folder: RecordFolder) => void;
}) {
  const { t } = useTranslation();
  const items = folder.childCount + folder.assetCount;
  return (
    <button type="button" className={`group flex min-w-0 flex-col gap-2 ${tileFocus}`} onClick={() => onOpen(folder)}>
      <span className="relative block aspect-[2/3] w-full overflow-hidden rounded-lg border bg-muted">
        {folder.artwork.posterUrl ? (
          <img
            src={assetURL(folder.artwork.posterUrl)}
            alt=""
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03] motion-reduce:transition-none"
          />
        ) : (
          <span className="grid h-full w-full place-items-center bg-primary/5">
            <Folder className="h-12 w-12 text-primary/70" strokeWidth={1.5} aria-hidden="true" />
          </span>
        )}
      </span>
      <span className="min-w-0 px-0.5">
        <span className="line-clamp-2 text-sm font-medium group-hover:text-primary">{folder.name}</span>
        <span className="block text-xs text-muted-foreground">{t("records.itemCount", { count: items })}</span>
      </span>
    </button>
  );
});

export const RecordVideoTile = memo(function RecordVideoTile({
  video,
  progress,
  caption,
  onOpen,
}: {
  video: RecordAsset;
  progress?: RecordProgress;
  /** A muted line under the name, such as the folder a Continue watching tile comes from. */
  caption?: string;
  onOpen: (id: number) => void;
}) {
  const { t } = useTranslation();
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const id = video.id;
  const fraction = watchedFraction(progress);
  const title = baseName(video.name);
  const duration = video.durationSeconds ?? progress?.durationSeconds;
  return (
    <button type="button" className={`group flex min-w-0 flex-col gap-2 ${tileFocus}`} onClick={() => onOpen(id)}>
      <span className="relative block aspect-video w-full overflow-hidden rounded-lg border bg-muted">
        {video.thumbnailUrl && !thumbnailFailed ? (
          <img
            src={assetURL(video.thumbnailUrl)}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setThumbnailFailed(true)}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03] motion-reduce:transition-none"
          />
        ) : (
          <span className="grid h-full w-full place-items-center">
            <Video className="h-9 w-9 text-muted-foreground/70" strokeWidth={1.5} aria-hidden="true" />
          </span>
        )}
        <span
          className="absolute inset-0 grid place-items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          aria-hidden="true"
        >
          <span className="grid h-11 w-11 place-items-center rounded-full bg-background/85 text-foreground shadow-md">
            <Play className="h-5 w-5 translate-x-px fill-current" />
          </span>
        </span>
        {duration ? (
          <span className="absolute bottom-2 right-2 rounded-md bg-background/85 px-1.5 py-0.5 text-xs font-medium tabular-nums text-foreground">
            {formatPlaybackTime(duration)}
          </span>
        ) : null}
        {progress?.completed ? (
          <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-md bg-background/85 px-1.5 py-0.5 text-xs font-medium text-foreground">
            <Check className="h-3 w-3" aria-hidden="true" />
            {t("records.watched")}
          </span>
        ) : null}
        {fraction !== null && (
          <span
            role="progressbar"
            aria-label={t("records.watchedShare", { percent: Math.round(fraction * 100) })}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(fraction * 100)}
            className="absolute inset-x-0 bottom-0 h-1 bg-foreground/15"
          >
            <span className="block h-full bg-primary" style={{ width: `${fraction * 100}%` }} />
          </span>
        )}
      </span>
      <span className="min-w-0 px-0.5">
        <span className="line-clamp-2 text-sm font-medium group-hover:text-primary">{title}</span>
        {caption && <span className="block truncate text-xs text-muted-foreground">{caption}</span>}
      </span>
    </button>
  );
});

export const RecordPhotoTile = memo(function RecordPhotoTile({
  photo,
  onOpen,
}: {
  photo: RecordAsset;
  onOpen: (id: number) => void;
}) {
  const title = baseName(photo.name);
  // The grid shows the small thumbnail; the full image stays for the viewer
  // and for a photo whose thumbnail cannot be made.
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const source = photo.thumbnailUrl && !thumbnailFailed ? photo.thumbnailUrl : photo.streamUrl;
  return (
    <button
      type="button"
      className={`group block aspect-square w-full overflow-hidden border bg-muted ${tileFocus}`}
      title={title}
      onClick={() => onOpen(photo.id)}
    >
      <img
        onError={() => setThumbnailFailed(true)}
        src={source ? assetURL(source) : undefined}
        alt={title}
        loading="lazy"
        decoding="async"
        className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03] motion-reduce:transition-none"
      />
    </button>
  );
});
