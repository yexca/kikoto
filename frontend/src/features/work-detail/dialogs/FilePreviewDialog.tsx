import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileText,
  ImageIcon,
  Loader2,
  Maximize2,
  Minimize2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { type ImageZoom, ZoomableImage } from "@/components/zoomable-image";
import { countTextLines, formatLyricsTime, lyricsView } from "@/features/work-detail/dialogs/textPreviewModel";
import { WorkVideoPlayer } from "@/features/work-detail/media/WorkVideoPlayer";
import type { VideoSubtitle } from "@/player/video/videoSubtitles";
import { formatBytes } from "@/features/work-detail/media/mediaTreeModel";
import i18n from "@/i18n";
import { ApiError, TextTooLargeError, api, assetURL, type TimedLyricsResult } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { startLoad } from "@/lib/effectScope";
import { cn } from "@/lib/tailwindClassNames";

type FilePreviewBase = {
  title: string;
  locationId: number;
  sizeBytes?: number | null;
};

export type FilePreviewState =
  | (FilePreviewBase & {
      kind: "image";
      url: string;
      canSetCover: boolean;
      /** Local and cached images may load as filmstrip thumbnails; remote ones load only when shown. */
      thumbnail?: boolean;
    })
  | (FilePreviewBase & {
      kind: "video";
      url: string;
      durationSeconds: number | null;
      canTranscode: boolean;
      /** Same-name WebVTT and SRT files beside the video. */
      subtitles?: VideoSubtitle[];
    })
  | (FilePreviewBase & { kind: "text"; url?: string });

/** A file to show and the sibling files the viewer can step through. */
export type FilePreviewRequest = { items: FilePreviewState[]; index: number };

function samePreview(left: FilePreviewState, right: FilePreviewState) {
  return left.kind === right.kind && left.locationId === right.locationId && left.title === right.title;
}

/** Opens `preview` among `siblings`, or on its own when it is not one of them. */
export function filePreviewRequest(preview: FilePreviewState, siblings: FilePreviewState[] = []): FilePreviewRequest {
  const index = siblings.findIndex((item) => samePreview(item, preview));
  return index >= 0 ? { items: siblings, index } : { items: [preview], index: 0 };
}

const kindIcons = { image: ImageIcon, text: FileText } as const;
const kindLabelKeys = {
  image: "libraryDetail.image",
  text: "libraryDetail.text",
} as const;

function HeaderButton({
  label,
  disabled,
  className,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  className?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className={cn("shrink-0 text-muted-foreground", className)}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

/**
 * File viewer for directory previews: a media stage for images, a reading view
 * for text and timed lyrics, and stepping through sibling files with the header
 * controls, arrow keys, swipes, or the image filmstrip. A video opens the
 * full-screen work video player, which steps through the sibling videos.
 */
export function FilePreviewDialog({
  request,
  onClose,
  onSetCover,
}: {
  request: FilePreviewRequest;
  onClose: () => void;
  onSetCover?: (locationId: number) => void | Promise<void>;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [index, setIndex] = useState(request.index);
  const [zoom, setZoom] = useState<ImageZoom>("fit");
  const [details, setDetails] = useState("");
  const [textContent, setTextContent] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const items = request.items;
  const current = Math.min(Math.max(index, 0), items.length - 1);
  const preview = items[current];
  const canPrevious = current > 0;
  const canNext = current < items.length - 1;

  useEffect(() => setIndex(request.index), [request]);
  useEffect(() => {
    setZoom("fit");
    setDetails("");
    setTextContent(null);
    setCopied(false);
    // A control that only some files offer may have held focus; keep it in the viewer so keys keep stepping.
    const dialog = rootRef.current?.closest<HTMLElement>("[role='dialog']");
    if (dialog && !dialog.contains(document.activeElement)) dialog.focus({ preventScroll: true });
  }, [preview]);

  const step = useCallback(
    (delta: number) => setIndex((value) => Math.min(Math.max(value + delta, 0), items.length - 1)),
    [items.length],
  );

  const videoOpen = preview?.kind === "video";
  useEffect(() => {
    // The video player's arrow keys seek instead.
    if (videoOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const dialog = rootRef.current?.closest("[role='dialog']");
      const active = document.activeElement;
      if (!dialog || !(active instanceof HTMLElement) || !dialog.contains(active)) return;
      // Media controls and text selection keep their own arrow-key behavior.
      if (active.closest("video, input, textarea, [contenteditable='true']")) return;
      event.preventDefault();
      step(event.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [step, videoOpen]);

  // Neighboring local images load ahead so stepping through a gallery feels immediate.
  useEffect(() => {
    for (const neighbor of [items[current - 1], items[current + 1]]) {
      if (neighbor?.kind === "image" && neighbor.thumbnail) new Image().src = assetURL(neighbor.url);
    }
  }, [current, items]);

  if (!preview) return null;
  if (preview.kind === "video") {
    const videos = items.filter((item) => item.kind === "video");
    const position = Math.max(
      videos.findIndex((item) => samePreview(item, preview)),
      0,
    );
    const stepTo = (target: FilePreviewState | undefined) =>
      target ? () => setIndex(items.findIndex((item) => samePreview(item, target))) : null;
    return (
      <WorkVideoPlayer
        key={`${preview.locationId}:${preview.url}`}
        video={preview}
        index={position}
        total={Math.max(videos.length, 1)}
        onPrevious={stepTo(videos[position - 1])}
        onNext={stepTo(videos[position + 1])}
        onClose={onClose}
      />
    );
  }
  const KindIcon = kindIcons[preview.kind];
  const meta = [
    i18n.t(kindLabelKeys[preview.kind]),
    details,
    typeof preview.sizeBytes === "number" ? formatBytes(preview.sizeBytes) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const images = items.filter((item) => item.kind === "image");
  const stepsByGesture = preview.kind === "image" && images.length > 1;

  const copyPreviewText = async () => {
    if (textContent === null) return;
    try {
      await copyText(textContent);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Dialog
      onClose={onClose}
      size="full"
      ariaLabel={preview.title}
      overlayClassName="p-0 sm:p-[var(--dialog-inset)]"
      className="h-[100dvh] max-h-[100dvh] rounded-none border-0 sm:h-[min(56rem,var(--dialog-max-height))] sm:max-h-[var(--dialog-max-height)] sm:rounded-[var(--radius)] sm:border"
    >
      <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-1.5 border-b px-2 pb-2 pt-[max(0.5rem,var(--safe-area-top))] sm:gap-3 sm:px-4 sm:py-2.5">
          <span className="hidden h-9 w-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground sm:grid">
            <KindIcon className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1 pl-2 sm:pl-0">
            <h3 className="truncate text-sm font-semibold" title={preview.title}>
              {preview.title}
            </h3>
            <p className="truncate text-xs text-muted-foreground">{meta}</p>
          </div>
          {items.length > 1 && (
            <div className="flex shrink-0 items-center rounded-md bg-muted/60">
              {/* Phones step through images by swiping or with the filmstrip, which frees the header. */}
              <HeaderButton
                label={i18n.t("libraryDetail.previousFile")}
                disabled={!canPrevious}
                className={stepsByGesture ? "max-sm:hidden" : undefined}
                onClick={() => step(-1)}
              >
                <ChevronLeft className="h-4 w-4" />
              </HeaderButton>
              <span className="min-w-10 px-1 text-center text-xs tabular-nums text-muted-foreground">
                {i18n.t("libraryDetail.fileCounter", { current: current + 1, total: items.length })}
              </span>
              <HeaderButton
                label={i18n.t("libraryDetail.nextFile")}
                disabled={!canNext}
                className={stepsByGesture ? "max-sm:hidden" : undefined}
                onClick={() => step(1)}
              >
                <ChevronRight className="h-4 w-4" />
              </HeaderButton>
            </div>
          )}
          {preview.kind === "image" && (
            <HeaderButton
              label={zoom === "fit" ? i18n.t("libraryDetail.actualSize") : i18n.t("libraryDetail.fitToWindow")}
              onClick={() => setZoom((value) => (value === "fit" ? 1 : "fit"))}
            >
              {zoom === "fit" ? <Maximize2 className="h-4 w-4" /> : <Minimize2 className="h-4 w-4" />}
            </HeaderButton>
          )}
          {preview.kind === "text" && (
            <HeaderButton
              label={copied ? i18n.t("libraryDetail.textCopied") : i18n.t("libraryDetail.copyText")}
              disabled={textContent === null}
              onClick={() => void copyPreviewText()}
            >
              {copied ? <Check className="h-4 w-4 text-primary" /> : <Copy className="h-4 w-4" />}
            </HeaderButton>
          )}
          {preview.kind === "image" && onSetCover && preview.canSetCover && (
            <SetCoverButton key={preview.locationId} locationId={preview.locationId} onSetCover={onSetCover} />
          )}
          <HeaderButton label={i18n.t("content.close")} onClick={onClose}>
            <X className="h-4 w-4" />
          </HeaderButton>
        </div>

        {preview.kind === "image" ? (
          <ImageStage
            key={`${preview.locationId}:${preview.url}`}
            preview={preview}
            zoom={zoom}
            canPrevious={canPrevious}
            canNext={canNext}
            onZoomChange={setZoom}
            onStep={step}
            onDetails={setDetails}
          />
        ) : (
          <TextReader
            key={`${preview.locationId}:${preview.title}`}
            preview={preview}
            onDetails={setDetails}
            onContent={setTextContent}
          />
        )}

        {preview.kind === "image" && images.length > 1 && (
          <Filmstrip
            images={images}
            current={preview}
            onSelect={(image) => setIndex(items.findIndex((item) => samePreview(item, image)))}
          />
        )}
      </div>
    </Dialog>
  );
}

// Long enough to find the button again, short enough that a stray tap later does nothing.
const coverConfirmWindowMs = 4000;

/** Replacing the work's cover takes a second click; the request expires or resets on another image. */
function SetCoverButton({
  locationId,
  onSetCover,
}: {
  locationId: number;
  onSetCover: (locationId: number) => void | Promise<void>;
}) {
  const [armed, setArmed] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), coverConfirmWindowMs);
    return () => window.clearTimeout(timer);
  }, [armed]);

  const label = armed ? i18n.t("libraryDetail.confirmSetCover") : i18n.t("libraryDetail.setCover");
  return (
    <Button
      variant={armed ? "default" : "outline"}
      size="sm"
      className="shrink-0"
      disabled={saving}
      aria-label={label}
      title={armed ? i18n.t("detailActions.clickAgainToConfirm") : label}
      onBlur={() => setArmed(false)}
      onClick={async () => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        setSaving(true);
        try {
          await onSetCover(locationId);
        } finally {
          setSaving(false);
        }
      }}
    >
      {saving ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : armed ? (
        <Check className="h-4 w-4" />
      ) : (
        <ImageIcon className="h-4 w-4" />
      )}
      <span className={armed ? undefined : "hidden sm:inline"}>{label}</span>
    </Button>
  );
}

/** The image stage: a zoomable image with a loading state and previous and next arrows on wide screens. */
function ImageStage({
  preview,
  zoom,
  canPrevious,
  canNext,
  onZoomChange,
  onStep,
  onDetails,
}: {
  preview: Extract<FilePreviewState, { kind: "image" }>;
  zoom: ImageZoom;
  canPrevious: boolean;
  canNext: boolean;
  onZoomChange: (zoom: ImageZoom) => void;
  onStep: (delta: number) => void;
  onDetails: (details: string) => void;
}) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const arrowClassName =
    "absolute top-1/2 hidden h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-background/60 text-foreground backdrop-blur transition-colors hover:bg-background/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:grid";
  return (
    <div className="dark relative flex min-h-0 flex-1 bg-black text-foreground">
      {status === "error" ? (
        <div className="grid flex-1 place-items-center px-6 text-center text-sm text-muted-foreground" role="alert">
          {i18n.t("libraryDetail.imageLoadFailed")}
        </div>
      ) : (
        <ZoomableImage
          src={assetURL(preview.url)}
          alt={preview.title}
          zoom={zoom}
          onZoomChange={onZoomChange}
          onSwipe={onStep}
          className="flex-1"
          fitClassName="p-2 sm:p-6"
          imageClassName={cn("transition-opacity duration-200", status === "ready" ? "opacity-100" : "opacity-0")}
          onLoad={(image) => {
            setStatus("ready");
            onDetails(
              i18n.t("libraryDetail.imageDimensions", { width: image.naturalWidth, height: image.naturalHeight }),
            );
          }}
          onError={() => setStatus("error")}
        />
      )}
      {status === "loading" && (
        <div
          className="pointer-events-none absolute inset-0 grid place-items-center text-muted-foreground"
          role="status"
        >
          <Loader2 className="h-6 w-6 animate-spin" aria-label={i18n.t("libraryDetail.loadingImage")} />
        </div>
      )}
      {canPrevious && (
        <button
          type="button"
          className={cn(arrowClassName, "left-3")}
          aria-label={i18n.t("libraryDetail.previousFile")}
          onClick={() => onStep(-1)}
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
      )}
      {canNext && (
        <button
          type="button"
          className={cn(arrowClassName, "right-3")}
          aria-label={i18n.t("libraryDetail.nextFile")}
          onClick={() => onStep(1)}
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      )}
    </div>
  );
}

function Filmstrip({
  images,
  current,
  onSelect,
}: {
  images: FilePreviewState[];
  current: FilePreviewState;
  onSelect: (image: FilePreviewState) => void;
}) {
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView?.({ block: "nearest", inline: "center" });
  }, [current]);
  return (
    <div className="app-scrollbar flex shrink-0 gap-1.5 overflow-x-auto overflow-y-hidden border-t bg-card px-3 pb-[max(0.5rem,var(--safe-area-bottom))] pt-2">
      {images.map((image) => {
        const selected = samePreview(image, current);
        const thumbnail = image.kind === "image" && image.thumbnail ? image.url : "";
        return (
          <button
            key={`${image.locationId}:${image.title}`}
            ref={selected ? selectedRef : undefined}
            type="button"
            className={cn(
              "relative h-14 w-14 shrink-0 overflow-hidden rounded-md border bg-muted transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected ? "ring-2 ring-primary" : "opacity-60 hover:opacity-100",
            )}
            aria-label={image.title}
            aria-current={selected ? "true" : undefined}
            title={image.title}
            onClick={() => onSelect(image)}
          >
            {thumbnail ? (
              <img
                src={assetURL(thumbnail)}
                alt=""
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover"
              />
            ) : (
              <span className="grid h-full w-full place-items-center text-muted-foreground">
                <ImageIcon className="h-4 w-4" />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** A text URL's failure as the viewer names it: the HTTP status or the size bound. */
function textPreviewURLError(error: unknown) {
  if (error instanceof ApiError) {
    return new Error(i18n.t("libraryDetail.textPreviewHttpError", { status: error.status }));
  }
  if (error instanceof TextTooLargeError) return new Error(i18n.t("libraryDetail.textFileTooLarge"));
  return error;
}

function TextReader({
  preview,
  onDetails,
  onContent,
}: {
  preview: Extract<FilePreviewState, { kind: "text" }>;
  onDetails: (details: string) => void;
  onContent: (content: string | null) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<"lyrics" | "raw">("lyrics");
  const [timedLyrics, setTimedLyrics] = useState<TimedLyricsResult | null>(null);
  const lyrics = useMemo(() => lyricsView(timedLyrics), [timedLyrics]);

  useEffect(
    () =>
      startLoad(
        async (signal) => {
          const content = preview.url
            ? await api.getTextPreview(preview.url, signal).catch((error: unknown) => {
                throw textPreviewURLError(error);
              })
            : (await api.getMediaText(preview.locationId, signal)).content;
          // The server reads the text as timed lyrics; a failed read leaves it plain text.
          const timed = await api.parseLyrics(content, signal).catch(() => null);
          return { content, timed };
        },
        {
          onSuccess: (result) => {
            setTimedLyrics(result.timed);
            setText(result.content);
            onContent(result.content);
            onDetails(i18n.t("libraryDetail.lineCount", { count: countTextLines(result.content) }));
          },
          onError: (err) => setError(err instanceof Error ? err.message : i18n.t("libraryDetail.textPreviewFailed")),
        },
      ),
    [onContent, onDetails, preview],
  );

  const showLyrics = lyrics !== null && view === "lyrics";
  return (
    <div className="app-scroll min-h-0 flex-1 overflow-auto bg-background">
      {lyrics && (
        <div className="sticky top-0 z-10 flex justify-center border-b bg-background/95 px-4 py-2 backdrop-blur">
          <div className={segmentedListClassName()} role="group" aria-label={i18n.t("libraryDetail.textView")}>
            <button
              type="button"
              className={segmentedItemClassName(view === "lyrics", "h-7 px-3 text-xs")}
              aria-pressed={view === "lyrics"}
              onClick={() => setView("lyrics")}
            >
              {i18n.t("libraryDetail.lyrics")}
            </button>
            <button
              type="button"
              className={segmentedItemClassName(view === "raw", "h-7 px-3 text-xs")}
              aria-pressed={view === "raw"}
              onClick={() => setView("raw")}
            >
              {i18n.t("libraryDetail.rawText")}
            </button>
          </div>
        </div>
      )}
      <div className="mx-auto w-full max-w-3xl px-5 py-6 sm:px-8">
        {error ? (
          <div className="text-sm text-muted-foreground" role="alert">
            {error}
          </div>
        ) : text === null ? (
          <TextPreviewSkeleton />
        ) : showLyrics ? (
          <>
            {lyrics.tags.length > 0 && (
              <div className="mb-5 flex flex-wrap gap-1.5">
                {lyrics.tags.map((tag) => (
                  <span
                    key={`${tag.key}:${tag.value}`}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground"
                  >
                    <span className="font-medium uppercase">{tag.key}</span>
                    <span className="truncate text-foreground">{tag.value}</span>
                  </span>
                ))}
              </div>
            )}
            <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2">
              {lyrics.lines.map((line, lineIndex) => (
                <div key={lineIndex} className="contents">
                  <span className="pt-0.5 text-right text-xs tabular-nums text-muted-foreground">
                    {formatLyricsTime(line.timeSeconds)}
                  </span>
                  <span className="min-h-[1.5em] break-words text-[15px] leading-relaxed [overflow-wrap:anywhere]">
                    {line.text}
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <pre className="whitespace-pre-wrap break-words font-sans text-[15px] leading-7 [overflow-wrap:anywhere]">
            {text}
          </pre>
        )}
      </div>
    </div>
  );
}

function TextPreviewSkeleton() {
  return (
    <div className="skeleton-reveal space-y-3" aria-label={i18n.t("libraryDetail.loadingTextPreview")}>
      <Skeleton className="h-4 w-40" />
      <div className="space-y-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-10/12" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </div>
  );
}
