import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FileText,
  FileVideo,
  ImageIcon,
  Loader2,
  Maximize2,
  Minimize2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { countTextLines, formatLyricsTime, parseLyrics } from "@/features/work-detail/dialogs/textPreviewModel";
import { VideoPreview } from "@/features/work-detail/media/VideoPreview";
import { formatBytes, formatTrackDuration } from "@/features/work-detail/media/mediaTreeModel";
import i18n from "@/i18n";
import { api, assetURL, mediaDownloadURL } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";
import { usePlayer } from "@/player/PlayerProvider";

type FilePreviewBase = {
  title: string;
  locationId: number;
  sizeBytes?: number | null;
  /** A local or cached copy that the download endpoint can serve. */
  downloadable?: boolean;
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

const kindIcons = { image: ImageIcon, video: FileVideo, text: FileText } as const;
const kindLabelKeys = {
  image: "libraryDetail.image",
  video: "libraryDetail.video",
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
 * File viewer for directory previews: a media stage for images and video, a
 * reading view for text and timed lyrics, and stepping through sibling files
 * with the header controls, arrow keys, swipes, or the image filmstrip.
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
  const player = usePlayer();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [index, setIndex] = useState(request.index);
  const [zoomed, setZoomed] = useState(false);
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
    setZoomed(false);
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

  useEffect(() => {
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
  }, [step]);

  // Neighboring local images load ahead so stepping through a gallery feels immediate.
  useEffect(() => {
    for (const neighbor of [items[current - 1], items[current + 1]]) {
      if (neighbor?.kind === "image" && neighbor.thumbnail) new Image().src = assetURL(neighbor.url);
    }
  }, [current, items]);

  if (!preview) return null;
  const KindIcon = kindIcons[preview.kind];
  const meta = [
    i18n.t(kindLabelKeys[preview.kind]),
    preview.kind === "video" ? formatTrackDuration(preview.durationSeconds) : "",
    details,
    typeof preview.sizeBytes === "number" ? formatBytes(preview.sizeBytes) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const images = items.filter((item) => item.kind === "image");
  const stepsByGesture = preview.kind === "image" && images.length > 1;

  const copyText = async () => {
    if (textContent === null) return;
    try {
      await navigator.clipboard.writeText(textContent);
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
      overlayClassName="p-0 sm:p-4"
      className="h-[100dvh] max-h-[100dvh] rounded-none border-0 sm:h-[min(56rem,calc(100dvh-2rem))] sm:max-h-[calc(100dvh-2rem)] sm:rounded-[var(--radius)] sm:border"
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
              label={zoomed ? i18n.t("libraryDetail.fitToWindow") : i18n.t("libraryDetail.actualSize")}
              onClick={() => setZoomed((value) => !value)}
            >
              {zoomed ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </HeaderButton>
          )}
          {preview.kind === "text" && (
            <HeaderButton
              label={copied ? i18n.t("libraryDetail.textCopied") : i18n.t("libraryDetail.copyText")}
              disabled={textContent === null}
              onClick={() => void copyText()}
            >
              {copied ? <Check className="h-4 w-4 text-primary" /> : <Copy className="h-4 w-4" />}
            </HeaderButton>
          )}
          {preview.downloadable && preview.locationId > 0 && (
            <a
              href={mediaDownloadURL(preview.locationId)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={i18n.t("libraryDetail.downloadFile")}
              title={i18n.t("libraryDetail.downloadFile")}
            >
              <Download className="h-4 w-4" />
            </a>
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
            zoomed={zoomed}
            canPrevious={canPrevious}
            canNext={canNext}
            onZoomChange={setZoomed}
            onStep={step}
            onDetails={setDetails}
          />
        ) : preview.kind === "video" ? (
          <div className="dark app-scroll flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black p-0 text-foreground sm:p-4">
            <VideoPreview
              locationId={preview.locationId}
              fallbackUrl={preview.url}
              durationSeconds={preview.durationSeconds}
              canTranscode={preview.canTranscode}
              pauseRequested={player.isPlaying}
              onPlay={player.pause}
            />
          </div>
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

type ZoomFocus = { x: number; y: number };
type PanGesture = { pointerId: number; x: number; y: number; left: number; top: number; moved: boolean };

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

function ImageStage({
  preview,
  zoomed,
  canPrevious,
  canNext,
  onZoomChange,
  onStep,
  onDetails,
}: {
  preview: Extract<FilePreviewState, { kind: "image" }>;
  zoomed: boolean;
  canPrevious: boolean;
  canNext: boolean;
  onZoomChange: (zoomed: boolean) => void;
  onStep: (delta: number) => void;
  onDetails: (details: string) => void;
}) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const focusRef = useRef<ZoomFocus | null>(null);
  const swipeRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const panRef = useRef<PanGesture | null>(null);
  const suppressClickRef = useRef(false);

  // Zooming in keeps the point that was clicked, or the center, in the middle of the stage.
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!zoomed || !container) return;
    const focus = focusRef.current ?? { x: 0.5, y: 0.5 };
    focusRef.current = null;
    container.scrollLeft = focus.x * container.scrollWidth - container.clientWidth / 2;
    container.scrollTop = focus.y * container.scrollHeight - container.clientHeight / 2;
  }, [zoomed]);

  const arrowClassName =
    "absolute top-1/2 hidden h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-background/60 text-foreground backdrop-blur transition-colors hover:bg-background/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:grid";
  return (
    <div className="dark relative flex min-h-0 flex-1 bg-black text-foreground">
      <div
        ref={scrollRef}
        className={cn("app-scroll min-h-0 flex-1", zoomed ? "overflow-auto" : "overflow-hidden p-2 sm:p-6")}
        style={{ touchAction: zoomed ? "auto" : "pan-y" }}
        onPointerDown={(event) => {
          suppressClickRef.current = false;
          if (zoomed && event.pointerType === "mouse" && event.button === 0) {
            const container = event.currentTarget;
            panRef.current = {
              pointerId: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              left: container.scrollLeft,
              top: container.scrollTop,
              moved: false,
            };
            return;
          }
          if (!zoomed && event.pointerType !== "mouse") {
            swipeRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
          }
        }}
        onPointerMove={(event) => {
          const pan = panRef.current;
          if (!pan || pan.pointerId !== event.pointerId) return;
          const dx = event.clientX - pan.x;
          const dy = event.clientY - pan.y;
          if (!pan.moved && Math.hypot(dx, dy) < 4) return;
          pan.moved = true;
          event.currentTarget.scrollLeft = pan.left - dx;
          event.currentTarget.scrollTop = pan.top - dy;
        }}
        onPointerUp={(event) => {
          const pan = panRef.current;
          panRef.current = null;
          // A drag that panned the image must not also zoom it out.
          if (pan?.moved) suppressClickRef.current = true;
          const swipe = swipeRef.current;
          swipeRef.current = null;
          if (!swipe || swipe.pointerId !== event.pointerId) return;
          const dx = event.clientX - swipe.x;
          const dy = event.clientY - swipe.y;
          if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            suppressClickRef.current = true;
            onStep(dx < 0 ? 1 : -1);
          }
        }}
        onPointerCancel={() => {
          panRef.current = null;
          swipeRef.current = null;
        }}
      >
        {status === "error" ? (
          <div className="grid h-full place-items-center px-6 text-center text-sm text-muted-foreground" role="alert">
            {i18n.t("libraryDetail.imageLoadFailed")}
          </div>
        ) : (
          <div
            className={cn("flex items-center justify-center", zoomed ? "min-h-full min-w-full w-max" : "h-full w-full")}
          >
            <img
              src={assetURL(preview.url)}
              alt={preview.title}
              draggable={false}
              className={cn(
                "select-none transition-opacity duration-200",
                zoomed
                  ? "max-w-none cursor-grab active:cursor-grabbing"
                  : "max-h-full max-w-full cursor-zoom-in object-contain",
                status === "ready" ? "opacity-100" : "opacity-0",
              )}
              onLoad={(event) => {
                setStatus("ready");
                const image = event.currentTarget;
                onDetails(
                  i18n.t("libraryDetail.imageDimensions", { width: image.naturalWidth, height: image.naturalHeight }),
                );
              }}
              onError={() => setStatus("error")}
              onClick={(event) => {
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return;
                }
                if (!zoomed) {
                  const bounds = event.currentTarget.getBoundingClientRect();
                  focusRef.current = {
                    x: (event.clientX - bounds.left) / Math.max(1, bounds.width),
                    y: (event.clientY - bounds.top) / Math.max(1, bounds.height),
                  };
                }
                onZoomChange(!zoomed);
              }}
            />
          </div>
        )}
      </div>
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
    <div className="app-scrollbar flex shrink-0 gap-1.5 overflow-x-auto border-t bg-card px-3 pb-[max(0.5rem,var(--safe-area-bottom))] pt-2">
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
  const lyrics = useMemo(() => (text === null ? null : parseLyrics(text)), [text]);

  useEffect(() => {
    let active = true;
    const request = preview.url
      ? fetch(assetURL(preview.url), { headers: { Accept: "text/plain,text/*" } }).then(async (response) => {
          if (!response.ok) throw new Error(i18n.t("libraryDetail.textPreviewHttpError", { status: response.status }));
          const length = Number(response.headers.get("content-length") ?? 0);
          if (length > 512 * 1024) throw new Error(i18n.t("libraryDetail.textFileTooLarge"));
          const content = await response.text();
          if (content.length > 512 * 1024) throw new Error(i18n.t("libraryDetail.textFileTooLarge"));
          return { content };
        })
      : api.getMediaText(preview.locationId);
    request
      .then((result) => {
        if (!active) return;
        setText(result.content);
        onContent(result.content);
        onDetails(i18n.t("libraryDetail.lineCount", { count: countTextLines(result.content) }));
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : i18n.t("libraryDetail.textPreviewFailed"));
      });
    return () => {
      active = false;
    };
  }, [onContent, onDetails, preview]);

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
    <div className="space-y-3" aria-label={i18n.t("libraryDetail.loadingTextPreview")}>
      <div className="h-4 w-40 animate-pulse rounded bg-muted" />
      <div className="space-y-2">
        <div className="h-4 w-full animate-pulse rounded bg-muted" />
        <div className="h-4 w-11/12 animate-pulse rounded bg-muted" />
        <div className="h-4 w-4/5 animate-pulse rounded bg-muted" />
        <div className="h-4 w-10/12 animate-pulse rounded bg-muted" />
        <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
      </div>
    </div>
  );
}
