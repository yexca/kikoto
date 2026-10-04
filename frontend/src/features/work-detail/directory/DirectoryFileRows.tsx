import { type ReactNode, type RefObject, useRef, useState } from "react";
import {
  AudioLines,
  Captions,
  Check,
  CircleCheck,
  ExternalLink,
  FileText,
  Film,
  Folder,
  Headphones,
  ImageIcon,
  MoreHorizontal,
  Play,
} from "lucide-react";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import {
  filePreviewRequest,
  type FilePreviewRequest,
  type FilePreviewState,
} from "@/features/work-detail/dialogs/FilePreviewDialog";
import { fileIcon } from "@/features/work-detail/dialogs/mediaFilePresentation";
import {
  fileDownloadable,
  fileKindLabel,
  imageThumbnailURL,
  previewForFile,
  trackListeningState,
  type TrackListeningState,
  type TreePlaybackCursor,
  treeTrackProgress,
} from "@/features/work-detail/directory/directoryModel";
import {
  formatBytes,
  formatTrackDuration,
  playableFiles,
  type TreeTrack,
} from "@/features/work-detail/media/mediaTreeModel";
import { useDismissiblePopover } from "@/hooks/useDismissiblePopover";
import i18n from "@/i18n";
import { assetURL, mediaDownloadURL } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";
import { type LyricsChoice, lyricsChoiceDisplayLabel } from "@/player/lyricsMatching";
import { preferredLyricsMediaItemID, useLibraryPlayer } from "@/player/PlayerProvider";

export type DirectoryPlayFolder = (tracks: TreeTrack[], locationId: number) => void;

export type DirectoryFileHandlers = {
  onPlayFolder?: DirectoryPlayFolder;
  onPlayNext?: (track: TreeTrack) => void;
  onAppendQueue?: (track: TreeTrack) => void;
  onPreview?: (request: FilePreviewRequest) => void;
  isLyricsAttachmentHidden?: (locationId: number) => boolean;
  onRevealLyricsAttachment?: (locationId: number) => void;
};

type FileActionState = {
  preview: FilePreviewState | null;
  canPlay: boolean;
  canDownload: boolean;
  canOpen: boolean;
  lyricsChoices: LyricsChoice[];
  hasQueueActions: boolean;
  hasMoreActions: boolean;
  preferredLyricsMediaItemId: number | null;
  automaticLyrics: boolean;
  selectedLyricsChoice: LyricsChoice | null;
};

function fileLyricsState(file: TreeTrack, lyricsPreferenceOverrides: Record<string, number | null>) {
  const lyricsChoices = file.kind === "audio" ? (file.lyricsChoices ?? []) : [];
  const preferredLyricsMediaItemId = preferredLyricsMediaItemID(file, lyricsPreferenceOverrides);
  const selectedLyricsChoice =
    lyricsChoices.find((choice) => choice.mediaItemId === preferredLyricsMediaItemId) ??
    lyricsChoices.find((choice) => choice.locationId === file.autoLyricsLocationId) ??
    lyricsChoices[0] ??
    null;
  return {
    lyricsChoices,
    preferredLyricsMediaItemId,
    automaticLyrics: preferredLyricsMediaItemId === null,
    selectedLyricsChoice,
  };
}

function fileActionState(
  file: TreeTrack,
  handlers: DirectoryFileHandlers,
  lyricsPreferenceOverrides: Record<string, number | null>,
): FileActionState {
  const preview = previewForFile(file);
  const canPlay = Boolean(handlers.onPlayFolder && playableFiles([file]).length > 0);
  const canDownload = fileDownloadable(file);
  const lyrics = fileLyricsState(file, lyricsPreferenceOverrides);
  const hasQueueActions =
    canPlay && (file.kind === "video" || Boolean(handlers.onPlayNext) || Boolean(handlers.onAppendQueue));
  return {
    preview,
    canPlay,
    canDownload,
    canOpen: canPlay || Boolean(preview && handlers.onPreview) || canDownload,
    lyricsChoices: lyrics.lyricsChoices,
    hasQueueActions,
    hasMoreActions: lyrics.lyricsChoices.length > 0 || hasQueueActions,
    preferredLyricsMediaItemId: lyrics.preferredLyricsMediaItemId,
    automaticLyrics: lyrics.automaticLyrics,
    selectedLyricsChoice: lyrics.selectedLyricsChoice,
  };
}

function openFile(
  file: TreeTrack,
  tracks: TreeTrack[],
  state: FileActionState,
  handlers: DirectoryFileHandlers,
  previewSiblings: FilePreviewState[],
) {
  if (state.preview && file.kind === "video") {
    handlers.onPreview?.(filePreviewRequest(state.preview, previewSiblings));
    return;
  }
  if (state.canPlay) {
    handlers.onPlayFolder?.(tracks, file.locationId);
    return;
  }
  if (state.preview) {
    handlers.onPreview?.(filePreviewRequest(state.preview, previewSiblings));
    return;
  }
  if (state.canDownload) window.open(mediaDownloadURL(file.locationId), "_blank", "noopener,noreferrer");
}

function fileSizeLabel(file: TreeTrack) {
  return file.sizeBytes === null ? i18n.t("libraryDetail.unknownSize") : formatBytes(file.sizeBytes);
}

function MetaList({ items, lastItemCompactOnly = false }: { items: ReactNode[]; lastItemCompactOnly?: boolean }) {
  const visible = items.filter(Boolean);
  if (visible.length === 0) return null;
  return (
    <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
      {visible.map((item, index) => (
        <span
          key={index}
          className={cn(
            "inline-flex min-w-0 items-center gap-1.5",
            index === visible.length - 1 && lastItemCompactOnly && "lg:hidden",
          )}
        >
          {index > 0 && (
            <span aria-hidden="true" className="text-muted-foreground/50">
              ·
            </span>
          )}
          {item}
        </span>
      ))}
    </span>
  );
}

function ListeningStateLabel({ state }: { state: TrackListeningState }) {
  if (state.kind === "played") {
    return (
      <span className="inline-flex items-center gap-1">
        <CircleCheck className="h-3 w-3" aria-hidden="true" />
        {i18n.t("libraryDetail.played")}
      </span>
    );
  }
  if (state.kind !== "inProgress") return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      {state.fraction !== null && (
        <span aria-hidden="true" className="block h-1 w-10 overflow-hidden rounded-full bg-muted-foreground/20">
          <span
            className="block h-full rounded-full bg-primary"
            style={{ width: `${Math.round(state.fraction * 100)}%` }}
          />
        </span>
      )}
      <span className="tabular-nums">
        {state.remainingSeconds !== null
          ? i18n.t("libraryDetail.timeLeft", { time: formatTrackDuration(Math.max(1, state.remainingSeconds)) })
          : i18n.t("libraryDetail.listenedTo", { time: formatTrackDuration(state.positionSeconds) })}
      </span>
    </span>
  );
}

function TrackLeading({
  file,
  number,
  active,
  canPlay,
}: {
  file: TreeTrack;
  number: number;
  active: boolean;
  canPlay: boolean;
}) {
  if (active) {
    return (
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary/15 text-primary">
        <AudioLines className="h-4 w-4 motion-safe:animate-pulse" />
      </span>
    );
  }
  return (
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground" aria-hidden="true">
      <span className={cn("text-xs tabular-nums", canPlay && "group-hover:hidden")}>
        {number > 0 ? number : fileIcon(file)}
      </span>
      {canPlay && <Play className="hidden h-3.5 w-3.5 fill-current text-foreground group-hover:block" />}
    </span>
  );
}

/**
 * One directory entry. Tracks are numbered in folder playback order with their
 * duration in a trailing column; other files show their type and size.
 */
export function DirectoryFileRow({
  file,
  tracks,
  variant,
  isActive,
  liveCursor = null,
  previewSiblings = [],
  handlers,
}: {
  file: TreeTrack;
  /** The folder's playable files, in playback order. */
  tracks: TreeTrack[];
  variant: "track" | "file";
  isActive: boolean;
  /** A cursor saved since the tree loaded, when it belongs to this tree. */
  liveCursor?: TreePlaybackCursor | null;
  /** Files of the same kind the viewer can step to from this one. */
  previewSiblings?: FilePreviewState[];
  handlers: DirectoryFileHandlers;
}) {
  const player = useLibraryPlayer();
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [lyricsMenuOpen, setLyricsMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const actionAreaRef = useRef<HTMLSpanElement | null>(null);
  useDismissiblePopover(moreMenuOpen, moreMenuRef, () => setMoreMenuOpen(false));
  useDismissiblePopover(lyricsMenuOpen, actionAreaRef, () => setLyricsMenuOpen(false));
  const state = fileActionState(file, handlers, player.lyricsPreferenceOverrides);
  const open = () => openFile(file, tracks, state, handlers, previewSiblings);
  const isTrack = variant === "track";
  const number = isTrack ? trackNumber(file, tracks) : 0;
  const duration = file.kind === "audio" || file.kind === "video" ? formatTrackDuration(file.durationSeconds) : "";
  const listening = isTrack ? trackListeningState(treeTrackProgress(file, liveCursor), file.durationSeconds) : null;
  const meta = isTrack
    ? [
        file.kind === "video" && (
          <span className="inline-flex items-center gap-1">
            <Film className="h-3 w-3" aria-hidden="true" />
            {fileKindLabel(file.kind)}
          </span>
        ),
        listening && listening.kind !== "unplayed" && <ListeningStateLabel state={listening} />,
        fileSizeLabel(file),
        // Wide layouts show a lyrics button instead; last, so hiding it leaves no separator behind.
        state.lyricsChoices.length > 0 && (
          <span className="inline-flex items-center gap-1">
            <Captions className="h-3 w-3" aria-hidden="true" />
            {i18n.t("libraryDetail.lyrics")}
          </span>
        ),
      ]
    : [fileKindLabel(file.kind), duration, fileSizeLabel(file)];

  return (
    <div
      data-testid="directory-file-row"
      data-file-kind={file.kind}
      role={state.canOpen ? "button" : undefined}
      tabIndex={state.canOpen ? 0 : undefined}
      aria-current={isActive ? "true" : undefined}
      className={cn(
        "group flex items-center gap-3 rounded-lg px-2 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isTrack ? "min-h-14" : "min-h-12",
        isActive ? "bg-primary/10" : "hover:bg-muted",
        state.canOpen ? "cursor-pointer" : "cursor-default",
      )}
      onClick={() => {
        if (state.canOpen) open();
      }}
      onKeyDown={(event) => {
        if (!state.canOpen || event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) {
          return;
        }
        event.preventDefault();
        open();
      }}
    >
      {isTrack ? (
        <TrackLeading file={file} number={number} active={isActive} canPlay={state.canPlay} />
      ) : (
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-muted/60">{fileIcon(file)}</span>
      )}
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block whitespace-normal break-words [overflow-wrap:anywhere]",
            isActive && "font-medium text-primary",
          )}
        >
          {file.title}
        </span>
        <MetaList items={meta} lastItemCompactOnly={isTrack && state.lyricsChoices.length > 0} />
      </span>
      {isTrack && (
        <span className="min-w-10 shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground">
          {duration}
        </span>
      )}
      <span ref={actionAreaRef} className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        {file.kind === "file" && state.canDownload && (
          <ExternalLink
            className="mx-1 h-3.5 w-3.5 text-primary"
            aria-label={i18n.t("libraryDetail.downloadsNewTab")}
          />
        )}
        {state.lyricsChoices.length > 0 && (
          <LyricsActions
            file={file}
            choices={state.lyricsChoices}
            preferredLyricsMediaItemId={state.preferredLyricsMediaItemId}
            automaticLyrics={state.automaticLyrics}
            selectedLyricsChoice={state.selectedLyricsChoice}
            open={lyricsMenuOpen}
            anchorRef={actionAreaRef}
            onOpenChange={setLyricsMenuOpen}
            onCloseMore={() => setMoreMenuOpen(false)}
            onPreview={handlers.onPreview}
            isLyricsAttachmentHidden={handlers.isLyricsAttachmentHidden}
            onRevealLyricsAttachment={handlers.onRevealLyricsAttachment}
          />
        )}
        {state.hasMoreActions && (
          <MoreActions
            file={file}
            tracks={tracks}
            choices={state.lyricsChoices}
            canPlay={state.canPlay}
            hasQueueActions={state.hasQueueActions}
            open={moreMenuOpen}
            anchorRef={moreMenuRef}
            onOpenChange={setMoreMenuOpen}
            onOpenLyrics={() => setLyricsMenuOpen(true)}
            onCloseLyrics={() => setLyricsMenuOpen(false)}
            handlers={handlers}
          />
        )}
      </span>
    </div>
  );
}

/** Image entry in a folder gallery. Only local and cached images load a thumbnail. */
export function DirectoryImageTile({
  file,
  previewSiblings,
  onPreview,
}: {
  file: TreeTrack;
  previewSiblings: FilePreviewState[];
  onPreview?: (request: FilePreviewRequest) => void;
}) {
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const preview = previewForFile(file);
  const thumbnail = thumbnailFailed ? "" : imageThumbnailURL(file);
  const canPreview = Boolean(preview && onPreview);
  return (
    <button
      type="button"
      data-testid="directory-file-row"
      data-file-kind={file.kind}
      className="group flex min-w-0 flex-col gap-1.5 rounded-lg p-1.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent"
      title={file.title}
      disabled={!canPreview}
      onClick={() => {
        if (preview) onPreview?.(filePreviewRequest(preview, previewSiblings));
      }}
    >
      <span className="relative block aspect-square w-full overflow-hidden rounded-md border bg-muted">
        {thumbnail ? (
          <img
            src={assetURL(thumbnail)}
            alt=""
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition-transform duration-300 motion-safe:group-hover:scale-[1.03]"
            onError={() => setThumbnailFailed(true)}
          />
        ) : (
          <span className="grid h-full w-full place-items-center text-muted-foreground">
            <ImageIcon className="h-6 w-6" />
          </span>
        )}
      </span>
      <span className="block min-w-0 px-0.5">
        <span className="line-clamp-2 break-words text-xs font-medium leading-snug [overflow-wrap:anywhere]">
          {file.title}
        </span>
        <span className="mt-0.5 block text-2xs text-muted-foreground">{fileSizeLabel(file)}</span>
      </span>
    </button>
  );
}

/** One-based position of a file among the folder's playable tracks, or 0 when it is not playable. */
function trackNumber(file: TreeTrack, tracks: TreeTrack[]) {
  const index = tracks.findIndex((track) =>
    file.playbackKey ? track.playbackKey === file.playbackKey : track.locationId === file.locationId,
  );
  return index + 1;
}

function LyricsActions({
  file,
  choices,
  preferredLyricsMediaItemId,
  automaticLyrics,
  selectedLyricsChoice,
  open,
  anchorRef,
  onOpenChange,
  onCloseMore,
  onPreview,
  isLyricsAttachmentHidden,
  onRevealLyricsAttachment,
}: {
  file: TreeTrack;
  choices: LyricsChoice[];
  preferredLyricsMediaItemId: number | null;
  automaticLyrics: boolean;
  selectedLyricsChoice: LyricsChoice | null;
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onOpenChange: (open: boolean) => void;
  onCloseMore: () => void;
  onPreview?: (request: FilePreviewRequest) => void;
  isLyricsAttachmentHidden?: (locationId: number) => boolean;
  onRevealLyricsAttachment?: (locationId: number) => void;
}) {
  const player = useLibraryPlayer();
  return (
    <div className="hidden lg:block" onClick={(event) => event.stopPropagation()}>
      <button
        className={cn(
          "grid h-9 w-9 place-items-center rounded-md hover:bg-secondary hover:text-foreground",
          automaticLyrics ? "text-muted-foreground" : "text-primary",
        )}
        onClick={() => {
          onCloseMore();
          onOpenChange(!open);
        }}
        aria-label={i18n.t("libraryDetail.lyricsFor", { title: file.title })}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={i18n.t("libraryDetail.lyrics")}
      >
        <Captions className="h-4 w-4" />
      </button>
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        onOpenChange={onOpenChange}
        className="w-[min(22rem,calc(100vw-1.5rem))] rounded-lg border bg-card p-2 text-card-foreground shadow-xl"
        bottomCollisionPadding={96}
      >
        <div role="dialog" aria-label={i18n.t("libraryDetail.lyricsFor", { title: file.title })} className="space-y-2">
          <div className="px-1 py-0.5">
            <div className="text-sm font-semibold">{i18n.t("libraryDetail.lyrics")}</div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground" title={file.title}>
              {file.title}
            </div>
          </div>
          <div role="radiogroup" aria-label={i18n.t("libraryDetail.lyricsSource")} className="space-y-1">
            <button
              role="radio"
              aria-checked={automaticLyrics}
              className={`flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm ${automaticLyrics ? "bg-secondary text-secondary-foreground" : "hover:bg-muted"}`}
              onClick={() => void player.changeLyricsChoice(file, null)}
            >
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{i18n.t("libraryDetail.auto")}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {selectedLyricsChoice
                    ? i18n.t("libraryDetail.matchesLyrics", {
                        label: lyricsChoiceDisplayLabel(selectedLyricsChoice, choices),
                      })
                    : i18n.t("libraryDetail.noAvailableMatch")}
                </span>
              </span>
              {automaticLyrics && <Check className="h-4 w-4 shrink-0 text-primary" />}
            </button>
            {choices.map((choice) => {
              const selected = !automaticLyrics && choice.mediaItemId === preferredLyricsMediaItemId;
              return (
                <button
                  key={choice.locationId}
                  role="radio"
                  aria-checked={selected}
                  className={`flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm ${selected ? "bg-secondary text-secondary-foreground" : "hover:bg-muted"}`}
                  onClick={() => void player.changeLyricsChoice(file, choice)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium" title={choice.displayPath || choice.title}>
                      {lyricsChoiceDisplayLabel(choice, choices)}
                    </span>
                    <span className="block text-xs text-muted-foreground">{lyricsMatchReasonLabel(choice.reason)}</span>
                  </span>
                  {selected && <Check className="h-4 w-4 shrink-0 text-primary" />}
                </button>
              );
            })}
          </div>
          <div className="grid grid-cols-2 gap-1 border-t pt-2">
            <button
              className="flex min-h-11 items-center justify-center gap-2 rounded-md px-2 text-sm hover:bg-muted sm:min-h-9"
              disabled={!selectedLyricsChoice || !onPreview}
              onClick={() => {
                if (!selectedLyricsChoice) return;
                onPreview?.(filePreviewRequest(lyricsChoicePreview(selectedLyricsChoice)));
                onOpenChange(false);
              }}
            >
              <FileText className="h-4 w-4" />
              {i18n.t("remoteFetch.actionPreview")}
            </button>
            {selectedLyricsChoice && isLyricsAttachmentHidden?.(selectedLyricsChoice.locationId) && (
              <button
                className="flex min-h-11 items-center justify-center gap-2 rounded-md px-2 text-sm hover:bg-muted sm:min-h-9"
                onClick={() => {
                  onRevealLyricsAttachment?.(selectedLyricsChoice.locationId);
                  onOpenChange(false);
                }}
              >
                <Folder className="h-4 w-4" />
                {i18n.t("libraryDetail.showInDirectory")}
              </button>
            )}
          </div>
          {file.lyricsPreferencePersistable === false && (
            <div className="rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground">
              {i18n.t("libraryDetail.temporaryPreview")}
            </div>
          )}
        </div>
      </AnchoredPopover>
    </div>
  );
}

function MoreActions({
  file,
  tracks,
  choices,
  canPlay,
  hasQueueActions,
  open,
  anchorRef,
  onOpenChange,
  onOpenLyrics,
  onCloseLyrics,
  handlers,
}: {
  file: TreeTrack;
  tracks: TreeTrack[];
  choices: LyricsChoice[];
  canPlay: boolean;
  hasQueueActions: boolean;
  open: boolean;
  anchorRef: RefObject<HTMLDivElement | null>;
  onOpenChange: (open: boolean) => void;
  onOpenLyrics: () => void;
  onCloseLyrics: () => void;
  handlers: DirectoryFileHandlers;
}) {
  const { onPlayFolder, onPlayNext, onAppendQueue } = handlers;
  return (
    <div ref={anchorRef} className={hasQueueActions ? "" : "lg:hidden"} onClick={(event) => event.stopPropagation()}>
      <button
        className={`grid h-11 w-11 place-items-center rounded-md hover:bg-secondary hover:text-foreground sm:h-9 sm:w-9 ${hasQueueActions ? "" : "lg:hidden"}`}
        onClick={() => {
          onCloseLyrics();
          onOpenChange(!open);
        }}
        aria-label={i18n.t("libraryDetail.moreActionsFor", { title: file.title })}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        className={`w-52 rounded-lg border bg-card p-1 text-sm text-card-foreground shadow-xl ${hasQueueActions ? "" : "lg:hidden"}`}
      >
        <div role="menu" aria-label={i18n.t("libraryDetail.moreActionsFor", { title: file.title })}>
          {choices.length > 0 && (
            <button
              role="menuitem"
              className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-muted lg:hidden"
              onClick={() => {
                onOpenChange(false);
                onOpenLyrics();
              }}
              aria-haspopup="dialog"
            >
              <Captions className="h-4 w-4" />
              {i18n.t("libraryDetail.lyrics")}
            </button>
          )}
          {canPlay && file.kind === "video" && (
            <button
              role="menuitem"
              className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-muted sm:h-9 sm:min-h-0"
              onClick={() => {
                onPlayFolder?.(tracks, file.locationId);
                onOpenChange(false);
              }}
            >
              <Headphones className="h-4 w-4" />
              {i18n.t("libraryDetail.playAsAudio")}
            </button>
          )}
          {canPlay && onPlayNext && (
            <button
              role="menuitem"
              className="flex min-h-11 w-full items-center rounded-md px-2 text-left hover:bg-muted sm:h-9 sm:min-h-0"
              onClick={() => {
                onPlayNext(file);
                onOpenChange(false);
              }}
            >
              {i18n.t("libraryDetail.playNext")}
            </button>
          )}
          {canPlay && onAppendQueue && (
            <button
              role="menuitem"
              className="flex min-h-11 w-full items-center rounded-md px-2 text-left hover:bg-muted sm:h-9 sm:min-h-0"
              onClick={() => {
                onAppendQueue(file);
                onOpenChange(false);
              }}
            >
              {i18n.t("libraryDetail.addToQueue")}
            </button>
          )}
        </div>
      </AnchoredPopover>
    </div>
  );
}

function lyricsMatchReasonLabel(reason: LyricsChoice["reason"]) {
  if (reason === "exact_sidecar") return i18n.t("libraryDetail.exactSidecar");
  if (reason === "same_stem") return i18n.t("libraryDetail.matchingFileName");
  if (reason === "normalized_name") return i18n.t("libraryDetail.normalizedFileName");
  return i18n.t("libraryDetail.sharedInFolder");
}

function lyricsChoicePreview(choice: LyricsChoice): FilePreviewState {
  return {
    kind: "text",
    title: choice.title,
    locationId: choice.locationId,
    url: choice.url,
  };
}
