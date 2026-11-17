import { Check, File as FileIcon, FileText, Folder, Music, Play, Subtitles, Trash2, Video } from "lucide-react";
import { memo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ActionMenu } from "@/components/ui/action-menu";
import { Badge } from "@/components/ui/badge";
import { assetURL, type RecordAsset, type RecordFolder, type RecordProgress } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import { watchedFraction } from "./recordProgress";
import { baseName, fileTypeLabel, formatFileSize, formatPlaybackTime } from "./recordsModel";

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
  onDelete,
}: {
  folder: RecordFolder;
  onOpen: (folder: RecordFolder) => void;
  /** Reviews deleting the folder; absent for a viewer who may not delete files. */
  onDelete?: (folder: RecordFolder) => void;
}) {
  const { t } = useTranslation();
  const items = folder.childCount + folder.assetCount;
  // A poster is the folder's cover; a folder with only a backdrop shows that
  // instead. The square crop suits both portrait posters and wide backdrops.
  const cover = folder.artwork.posterUrl ?? folder.artwork.backdropUrl;
  const tile = (
    <button
      type="button"
      className={`group flex w-full min-w-0 flex-col gap-2 ${tileFocus}`}
      onClick={() => onOpen(folder)}
    >
      <span className="relative block aspect-square w-full overflow-hidden rounded-lg border bg-muted">
        {cover ? (
          <img
            src={assetURL(cover)}
            alt=""
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03] motion-reduce:transition-none"
          />
        ) : (
          <span className="grid h-full w-full place-items-center bg-primary/5">
            <Folder className="h-8 w-8 text-primary/70" strokeWidth={1.5} aria-hidden="true" />
          </span>
        )}
      </span>
      <span className={cn("min-w-0 px-0.5", onDelete && "pr-9")}>
        <span className="line-clamp-2 break-words text-sm font-medium group-hover:text-primary">{folder.name}</span>
        <span className="block text-xs text-muted-foreground">{t("records.itemCount", { count: items })}</span>
      </span>
    </button>
  );
  if (!onDelete) return tile;
  // The menu sits beside the name, outside the tile's button.
  return (
    <div className="relative min-w-0">
      {tile}
      <div className="absolute bottom-0 right-0">
        <RecordItemMenu name={folder.name} onDelete={() => onDelete(folder)} />
      </div>
    </div>
  );
});

/** The More menu of a Record file row or folder tile, which holds Delete. */
function RecordItemMenu({ name, onDelete }: { name: string; onDelete: () => void }) {
  const { t } = useTranslation();
  return (
    <ActionMenu
      quiet
      label={t("records.actions.moreFor", { name })}
      buttonLabel={t("records.actions.more")}
      buttonLabelClassName="hidden"
      triggerClassName="h-9 w-9 text-muted-foreground"
      items={[
        {
          key: "delete",
          label: t("records.delete.action"),
          icon: <Trash2 className="h-4 w-4" />,
          onSelect: onDelete,
        },
      ]}
    />
  );
}

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

function fileIcon(kind: RecordAsset["kind"]) {
  switch (kind) {
    case "audio":
      return Music;
    case "subtitle":
      return Subtitles;
    case "metadata":
      return FileText;
    default:
      return FileIcon;
  }
}

/** A file row's picture: an audio file's embedded cover art, or the icon of its kind. */
function FileThumbnail({ file }: { file: RecordAsset }) {
  const [failed, setFailed] = useState(false);
  if (file.thumbnailUrl && !failed) {
    return (
      <img
        src={assetURL(file.thumbnailUrl)}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className="h-full w-full rounded-md object-cover"
      />
    );
  }
  const Icon = fileIcon(file.kind);
  return <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />;
}

/**
 * A folder's files that are not tiles, one row each with its type and size.
 * Audio rows play in the global player and show how much was heard. For a
 * viewer who may delete files, each row ends with a More menu holding Delete.
 */
export const RecordFileList = memo(function RecordFileList({
  files,
  progress,
  onPlay,
  onDelete,
}: {
  files: readonly RecordAsset[];
  progress: ReadonlyMap<number, RecordProgress>;
  onPlay: (id: number) => void;
  /** Reviews deleting a file; absent for a viewer who may not delete files. */
  onDelete?: (file: RecordAsset) => void;
}) {
  const { t } = useTranslation();
  return (
    <ul className="max-w-3xl divide-y overflow-hidden rounded-lg border">
      {files.map((file) => {
        const playable = file.kind === "audio" && Boolean(file.streamUrl);
        const heard = playable ? progress.get(file.id) : undefined;
        const fraction = watchedFraction(heard);
        const details = [
          fileTypeLabel(file.name),
          file.sizeBytes !== undefined ? formatFileSize(file.sizeBytes) : null,
          file.durationSeconds ? formatPlaybackTime(file.durationSeconds) : null,
        ].filter(Boolean);
        const body = (
          <>
            <span className="relative grid h-9 w-9 shrink-0 place-items-center rounded-md bg-muted">
              <FileThumbnail file={file} />
              {playable && (
                <span className="absolute inset-0 grid place-items-center rounded-md bg-primary text-primary-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                  <Play className="h-4 w-4 translate-x-px fill-current" aria-hidden="true" />
                </span>
              )}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-sm font-medium group-hover:text-primary">{file.name}</span>
              <span className="flex items-center gap-2 text-xs tabular-nums text-muted-foreground">
                <span className="truncate">{details.join(" · ")}</span>
                {heard?.completed && (
                  <span className="inline-flex shrink-0 items-center gap-1">
                    <Check className="h-3 w-3" aria-hidden="true" />
                    {t("records.played")}
                  </span>
                )}
              </span>
              {fraction !== null && (
                <span
                  role="progressbar"
                  aria-label={t("records.heardShare", { percent: Math.round(fraction * 100) })}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(fraction * 100)}
                  className="mt-0.5 block h-1 w-full max-w-48 overflow-hidden rounded-full bg-foreground/15"
                >
                  <span className="block h-full bg-primary" style={{ width: `${fraction * 100}%` }} />
                </span>
              )}
            </span>
          </>
        );
        return (
          <li key={file.id} className="flex min-w-0 items-center gap-1 pr-1.5">
            {playable ? (
              <button
                type="button"
                className="group flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                onClick={() => onPlay(file.id)}
              >
                {body}
              </button>
            ) : (
              <div className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2">{body}</div>
            )}
            {onDelete && <RecordItemMenu name={file.name} onDelete={() => onDelete(file)} />}
          </li>
        );
      })}
    </ul>
  );
});
