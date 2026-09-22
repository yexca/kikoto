import { Pause, Play, SkipBack, SkipForward, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import {
  addNativeLyricsOverlayListener,
  hideNativeLyricsOverlay,
  nativeLyricsOverlayStatus,
  requestNativeLyricsOverlayPermission,
  showNativeLyricsOverlay,
  updateNativeLyricsOverlayPlayback,
} from "@/lib/nativeMedia";
import { isNativeApp } from "@/lib/serverConfig";

export type ScreenLyricLine = { time: number; text: string };

export type ScreenLyricsBackend = "native" | "document-pip" | "video-pip";

export type ScreenLyricsSnapshot = {
  trackKey: string;
  title: string;
  subtitle: string;
  lines: ScreenLyricLine[];
  activeIndex: number;
  currentTime: number;
  playing: boolean;
  playbackRate: number;
};

export type ScreenLyricsStartResult = "opened" | "permission-required" | "unsupported" | "failed";

type DocumentPictureInPictureAPI = {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
  window: Window | null;
};

type VideoPictureInPicture = {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  timer: number;
};

const PIP_WIDTH = 460;
const PIP_HEIGHT = 150;
const CANVAS_WIDTH = 960;
const CANVAS_HEIGHT = 270;

function documentPictureInPicture(): DocumentPictureInPictureAPI | null {
  if (typeof window === "undefined") return null;
  const api = (window as Window & { documentPictureInPicture?: DocumentPictureInPictureAPI }).documentPictureInPicture;
  return api ?? null;
}

export function screenLyricsBackend(): ScreenLyricsBackend | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  if (isNativeApp()) return "native";
  if (documentPictureInPicture()) return "document-pip";
  if (
    document.pictureInPictureEnabled &&
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function"
  ) {
    return "video-pip";
  }
  return null;
}

/**
 * Keeps the current lyric line visible outside the page: a Document
 * Picture-in-Picture window on desktop browsers, a canvas-backed video
 * Picture-in-Picture fallback elsewhere, and a native overlay on Android.
 */
export function useScreenLyrics(
  snapshot: ScreenLyricsSnapshot,
  controls: { onTogglePlay: () => void; onPrevious: () => void; onNext: () => void },
) {
  const backend = screenLyricsBackend();
  const [open, setOpen] = useState(false);
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  const videoPipRef = useRef<VideoPictureInPicture | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const nativeSyncRef = useRef<{
    trackKey: string;
    lineCount: number;
    playing: boolean;
    rate: number;
    at: number;
    position: number;
  } | null>(null);

  const closeVideoPip = useCallback(() => {
    const current = videoPipRef.current;
    videoPipRef.current = null;
    if (!current) return;
    window.clearInterval(current.timer);
    if (document.pictureInPictureElement === current.video) void document.exitPictureInPicture().catch(() => {});
    current.video.srcObject = null;
    current.video.remove();
  }, []);

  const stop = useCallback(() => {
    setOpen(false);
    nativeSyncRef.current = null;
    if (backend === "native") void hideNativeLyricsOverlay();
    setPipWindow((current) => {
      current?.close();
      return null;
    });
    closeVideoPip();
  }, [backend, closeVideoPip]);

  const start = useCallback(async (): Promise<ScreenLyricsStartResult> => {
    if (!backend) return "unsupported";
    try {
      if (backend === "native") {
        const status = await nativeLyricsOverlayStatus();
        if (!status.supported) return "unsupported";
        if (!status.permitted) {
          await requestNativeLyricsOverlayPermission();
          return "permission-required";
        }
        nativeSyncRef.current = null;
        setOpen(true);
        return "opened";
      }
      if (backend === "document-pip") {
        const api = documentPictureInPicture();
        if (!api) return "unsupported";
        const target = api.window ?? (await api.requestWindow({ width: PIP_WIDTH, height: PIP_HEIGHT }));
        prepareLyricsDocument(target.document);
        target.addEventListener(
          "pagehide",
          () => {
            setPipWindow(null);
            setOpen(false);
          },
          { once: true },
        );
        setPipWindow(target);
        setOpen(true);
        return "opened";
      }
      closeVideoPip();
      const canvas = document.createElement("canvas");
      canvas.width = CANVAS_WIDTH;
      canvas.height = CANVAS_HEIGHT;
      drawLyricsCanvas(canvas, snapshotRef.current);
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.setAttribute("aria-hidden", "true");
      video.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;top:0";
      video.srcObject = canvas.captureStream(8);
      document.body.appendChild(video);
      await video.play();
      const timer = window.setInterval(() => drawLyricsCanvas(canvas, snapshotRef.current), 250);
      videoPipRef.current = { video, canvas, timer };
      video.addEventListener(
        "leavepictureinpicture",
        () => {
          closeVideoPip();
          setOpen(false);
        },
        { once: true },
      );
      await video.requestPictureInPicture();
      setOpen(true);
      return "opened";
    } catch {
      closeVideoPip();
      setOpen(false);
      return "failed";
    }
  }, [backend, closeVideoPip]);

  // Native overlay: send the whole timed track once, then only playback corrections so the
  // overlay can keep advancing on its own while the WebView is in the background.
  useEffect(() => {
    if (backend !== "native" || !open) return;
    const previous = nativeSyncRef.current;
    const now = performance.now();
    const trackChanged =
      !previous || previous.trackKey !== snapshot.trackKey || previous.lineCount !== snapshot.lines.length;
    const expectedPosition =
      previous && previous.playing
        ? previous.position + ((now - previous.at) / 1000) * previous.rate
        : (previous?.position ?? 0);
    const drifted = Math.abs(expectedPosition - snapshot.currentTime) > 1.2;
    const playbackChanged =
      !previous || previous.playing !== snapshot.playing || previous.rate !== snapshot.playbackRate || drifted;
    if (!trackChanged && !playbackChanged) return;
    nativeSyncRef.current = {
      trackKey: snapshot.trackKey,
      lineCount: snapshot.lines.length,
      playing: snapshot.playing,
      rate: snapshot.playbackRate,
      at: now,
      position: snapshot.currentTime,
    };
    const playback = {
      positionMs: Math.round(snapshot.currentTime * 1000),
      playing: snapshot.playing,
      playbackRate: snapshot.playbackRate,
    };
    if (trackChanged) {
      void showNativeLyricsOverlay({
        title: snapshot.title,
        lines: snapshot.lines.map((line) => ({ timeMs: Math.round(line.time * 1000), text: line.text })),
        ...playback,
      });
    } else {
      void updateNativeLyricsOverlayPlayback(playback);
    }
  }, [
    backend,
    open,
    snapshot.currentTime,
    snapshot.lines,
    snapshot.playbackRate,
    snapshot.playing,
    snapshot.title,
    snapshot.trackKey,
  ]);

  useEffect(() => {
    if (backend !== "native") return;
    let disposed = false;
    let remove: (() => void) | null = null;
    void addNativeLyricsOverlayListener(() => {
      nativeSyncRef.current = null;
      setOpen(false);
    }).then((dispose) => {
      if (disposed) dispose();
      else remove = dispose;
    });
    return () => {
      disposed = true;
      remove?.();
    };
  }, [backend]);

  useEffect(() => {
    if (!open || backend !== "video-pip" || !videoPipRef.current) return;
    drawLyricsCanvas(videoPipRef.current.canvas, snapshot);
  }, [backend, open, snapshot]);

  useEffect(() => () => stop(), [stop]);

  const portal: ReactNode =
    open && pipWindow
      ? createPortal(
          <ScreenLyricsWindow
            snapshot={snapshot}
            onTogglePlay={controls.onTogglePlay}
            onPrevious={controls.onPrevious}
            onNext={controls.onNext}
            onClose={stop}
          />,
          pipWindow.document.body,
        )
      : null;

  return { backend, supported: backend !== null, open, start, stop, portal };
}

function prepareLyricsDocument(target: Document) {
  target.head.replaceChildren();
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const style = target.createElement("style");
      style.textContent = Array.from(sheet.cssRules)
        .map((rule) => rule.cssText)
        .join("\n");
      target.head.appendChild(style);
    } catch {
      if (!sheet.href) continue;
      const link = target.createElement("link");
      link.rel = "stylesheet";
      link.href = sheet.href;
      target.head.appendChild(link);
    }
  }
  const source = document.documentElement;
  target.documentElement.className = source.className;
  target.documentElement.lang = source.lang;
  for (const [key, value] of Object.entries(source.dataset)) {
    if (value !== undefined && key.startsWith("theme")) target.documentElement.dataset[key] = value;
  }
  const inlineStyle = source.getAttribute("style");
  if (inlineStyle) target.documentElement.setAttribute("style", inlineStyle);
  target.title = document.title;
  target.body.className = "screen-lyrics-body";
}

function ScreenLyricsWindow({
  snapshot,
  onTogglePlay,
  onPrevious,
  onNext,
  onClose,
}: {
  snapshot: ScreenLyricsSnapshot;
  onTogglePlay: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { current, next } = screenLyricText(snapshot);
  return (
    <div className="screen-lyrics group">
      <div className="screen-lyrics-lines" aria-live="polite">
        <p key={`${snapshot.trackKey}:${snapshot.activeIndex}`} className="screen-lyrics-current">
          {current || snapshot.title}
        </p>
        <p className="screen-lyrics-next">{next || (current ? "" : snapshot.subtitle)}</p>
      </div>
      <div className="screen-lyrics-controls">
        <span className="min-w-0 flex-1 truncate">{snapshot.title}</span>
        <button type="button" onClick={onPrevious} aria-label={t("player.previous")} title={t("player.previous")}>
          <SkipBack className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onTogglePlay}
          aria-label={snapshot.playing ? t("player.pause") : t("player.play")}
          title={snapshot.playing ? t("player.pause") : t("player.play")}
        >
          {snapshot.playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </button>
        <button type="button" onClick={onNext} aria-label={t("player.next")} title={t("player.next")}>
          <SkipForward className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("player.closeScreenLyrics")}
          title={t("player.closeScreenLyrics")}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

export function screenLyricText(snapshot: Pick<ScreenLyricsSnapshot, "lines" | "activeIndex">) {
  if (snapshot.lines.length === 0 || snapshot.activeIndex < 0) return { current: "", next: "" };
  const current = snapshot.lines[snapshot.activeIndex]?.text ?? "";
  const next = snapshot.lines.slice(snapshot.activeIndex + 1).find((line) => line.text.trim() !== "")?.text ?? "";
  return { current, next };
}

function drawLyricsCanvas(canvas: HTMLCanvasElement, snapshot: ScreenLyricsSnapshot) {
  const context = canvas.getContext("2d");
  if (!context) return;
  const { current, next } = screenLyricText(snapshot);
  const styles = getComputedStyle(document.documentElement);
  const font = styles.getPropertyValue("--font-sans").trim() || "system-ui, sans-serif";
  const primary = styles.getPropertyValue("--primary").trim();
  context.fillStyle = "#111111";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = primary ? `hsl(${primary})` : "#ffffff";
  context.font = `600 52px ${font}`;
  fillFittedText(
    context,
    current || snapshot.title,
    canvas.width / 2,
    canvas.height * 0.42,
    canvas.width - 64,
    52,
    font,
  );
  context.fillStyle = "rgba(255,255,255,0.62)";
  context.font = `400 32px ${font}`;
  fillFittedText(
    context,
    next || (current ? "" : snapshot.subtitle),
    canvas.width / 2,
    canvas.height * 0.76,
    canvas.width - 96,
    32,
    font,
    400,
  );
}

function fillFittedText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  size: number,
  font: string,
  weight = 600,
) {
  if (!text) return;
  let fontSize = size;
  context.font = `${weight} ${fontSize}px ${font}`;
  while (fontSize > 18 && context.measureText(text).width > maxWidth) {
    fontSize -= 2;
    context.font = `${weight} ${fontSize}px ${font}`;
  }
  context.fillText(text, x, y, maxWidth);
}
