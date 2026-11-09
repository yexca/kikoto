import { type RefObject, useEffect, useState } from "react";

import { appleMobileWebKit } from "@/player/mediaPlayback";

type FullscreenDocument = Pick<Document, "addEventListener" | "removeEventListener"> & {
  readonly fullscreenElement: Element | null;
  exitFullscreen?: () => Promise<void>;
};

type FullscreenStage = Pick<HTMLElement, "contains"> & {
  requestFullscreen?: (options?: FullscreenOptions) => Promise<void>;
};

type FullscreenVideo = {
  requestFullscreen?: (options?: FullscreenOptions) => Promise<void>;
  webkitEnterFullscreen?: () => void;
};

/** How the video enters fullscreen here: the system player, the stage with its controls, or the bare element. */
export type VideoFullscreenMode = "system" | "stage" | "element" | null;

export function videoFullscreenMode(
  stage: FullscreenStage,
  video: FullscreenVideo,
  appleMobile = appleMobileWebKit(),
): VideoFullscreenMode {
  // iPhone and iPad play fullscreen video in the system player, with its own controls.
  if (appleMobile && typeof video.webkitEnterFullscreen === "function") return "system";
  if (typeof stage.requestFullscreen === "function") return "stage";
  if (typeof video.requestFullscreen === "function" || typeof video.webkitEnterFullscreen === "function") {
    return "element";
  }
  return null;
}

/**
 * Leaves fullscreen when the page is fullscreen, otherwise enters it as
 * {@link videoFullscreenMode} chooses. Only stage fullscreen keeps the
 * on-screen controls; the bare element falls back to the browser's own.
 */
export function toggleVideoFullscreen(
  stage: FullscreenStage,
  video: FullscreenVideo,
  doc: FullscreenDocument = document,
  appleMobile = appleMobileWebKit(),
) {
  if (doc.fullscreenElement) {
    void doc.exitFullscreen?.().catch(() => undefined);
    return;
  }
  switch (videoFullscreenMode(stage, video, appleMobile)) {
    case "system":
      video.webkitEnterFullscreen?.();
      return;
    case "stage":
      void stage.requestFullscreen?.({ navigationUI: "hide" }).catch(() => undefined);
      return;
    case "element":
      if (typeof video.requestFullscreen === "function") void video.requestFullscreen().catch(() => undefined);
      else video.webkitEnterFullscreen?.();
      return;
    case null:
      return;
  }
}

/** Leaves fullscreen when the stage or something inside it is fullscreen. */
export function exitStageFullscreen(stage: FullscreenStage, doc: FullscreenDocument = document) {
  const element = doc.fullscreenElement;
  if (element && stage.contains(element)) void doc.exitFullscreen?.().catch(() => undefined);
}

/**
 * Whether the stage itself is fullscreen, kept current as fullscreen starts
 * and ends. Unmounting the stage, such as closing the viewer, leaves it.
 */
export function useStageFullscreen(stageRef: RefObject<HTMLElement | null>) {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const update = () => setFullscreen(document.fullscreenElement === stage);
    update();
    document.addEventListener("fullscreenchange", update);
    return () => {
      document.removeEventListener("fullscreenchange", update);
      exitStageFullscreen(stage);
    };
  }, [stageRef]);
  return fullscreen;
}
