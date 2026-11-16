import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { seekVideoBy, toggleVideoPlayback } from "@/player/video/videoControlsModel";

export type VideoShortcut =
  | { action: "togglePlay" }
  | { action: "seek"; seconds: number }
  | { action: "fullscreen" }
  | { action: "mute" }
  | { action: "rate"; step: -1 | 1 };

type ShortcutKey = Pick<KeyboardEvent, "key" | "code" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey">;

/** The playback speeds Shift+, and Shift+. step through. */
export const VIDEO_PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

const arrowSeekSeconds = 5;
const letterSeekSeconds = 10;

/**
 * The video stage shortcut for a key press, or null for a key the stage leaves
 * alone: Space or K plays and pauses, J and L seek 10 seconds, the left and
 * right arrows seek 5 seconds, F toggles fullscreen, M toggles mute, and
 * Shift+, and Shift+. lower and raise the speed.
 */
export function videoShortcut(event: ShortcutKey): VideoShortcut | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  if (event.shiftKey) {
    if (event.key === "<" || event.code === "Comma") return { action: "rate", step: -1 };
    if (event.key === ">" || event.code === "Period") return { action: "rate", step: 1 };
    return null;
  }
  switch (event.key.toLowerCase()) {
    case " ":
    case "k":
      return { action: "togglePlay" };
    case "j":
      return { action: "seek", seconds: -letterSeekSeconds };
    case "l":
      return { action: "seek", seconds: letterSeekSeconds };
    case "arrowleft":
      return { action: "seek", seconds: -arrowSeekSeconds };
    case "arrowright":
      return { action: "seek", seconds: arrowSeekSeconds };
    case "f":
      return { action: "fullscreen" };
    case "m":
      return { action: "mute" };
    default:
      return null;
  }
}

/** A key as a keyboard event reports it, for the shortcut guide. */
export type VideoShortcutKey = { key: string; shiftKey?: boolean };

/**
 * The stage shortcuts in the order the guide lists them, each with the keys
 * that {@link videoShortcut} maps to it.
 */
export const VIDEO_SHORTCUT_GUIDE: readonly { shortcut: VideoShortcut; keys: readonly VideoShortcutKey[] }[] = [
  { shortcut: { action: "togglePlay" }, keys: [{ key: " " }, { key: "k" }] },
  { shortcut: { action: "seek", seconds: -letterSeekSeconds }, keys: [{ key: "j" }] },
  { shortcut: { action: "seek", seconds: letterSeekSeconds }, keys: [{ key: "l" }] },
  { shortcut: { action: "seek", seconds: -arrowSeekSeconds }, keys: [{ key: "ArrowLeft" }] },
  { shortcut: { action: "seek", seconds: arrowSeekSeconds }, keys: [{ key: "ArrowRight" }] },
  { shortcut: { action: "fullscreen" }, keys: [{ key: "f" }] },
  { shortcut: { action: "mute" }, keys: [{ key: "m" }] },
  { shortcut: { action: "rate", step: -1 }, keys: [{ key: "<", shiftKey: true }] },
  { shortcut: { action: "rate", step: 1 }, keys: [{ key: ">", shiftKey: true }] },
];

/** How the guide names a key: Space, arrows as glyphs, letters in upper case, and Shift before its key. */
export function videoShortcutKeyLabel({ key, shiftKey }: VideoShortcutKey) {
  const name = key === " " ? "Space" : key === "ArrowLeft" ? "←" : key === "ArrowRight" ? "→" : key.toUpperCase();
  return shiftKey ? `Shift + ${name}` : name;
}

/** The next listed speed below or above `current`; the ends of the list stay where they are. */
export function nextVideoPlaybackRate(current: number, step: -1 | 1) {
  if (step > 0) {
    return (
      VIDEO_PLAYBACK_RATES.find((rate) => rate > current + 0.001) ??
      VIDEO_PLAYBACK_RATES[VIDEO_PLAYBACK_RATES.length - 1]
    );
  }
  return [...VIDEO_PLAYBACK_RATES].reverse().find((rate) => rate < current - 0.001) ?? VIDEO_PLAYBACK_RATES[0];
}

/** What the video stage's shortcuts act on besides the element itself. */
export type VideoStageActions = {
  /** The playback info's duration, used until the element reports its own. */
  duration: number;
  toggleFullscreen: () => void;
  changeRate: (rate: number) => void;
};

/**
 * Handles a key press on a video stage, or on its video element, as
 * {@link videoShortcut} maps it. Buttons beside the video keep Space and
 * Enter, and a held Space or K does not repeat play and pause.
 */
export function handleVideoStageKeyDown(
  event: ReactKeyboardEvent<HTMLElement>,
  video: HTMLVideoElement | null,
  actions: VideoStageActions,
) {
  if (!video || event.defaultPrevented || event.nativeEvent.isComposing) return;
  if (event.target !== event.currentTarget && event.target !== video) return;
  const shortcut = videoShortcut(event);
  if (!shortcut) return;
  event.preventDefault();
  switch (shortcut.action) {
    case "togglePlay":
      if (!event.repeat) toggleVideoPlayback(video);
      return;
    case "seek":
      seekVideoBy(video, shortcut.seconds, actions.duration);
      return;
    case "fullscreen":
      actions.toggleFullscreen();
      return;
    case "mute":
      video.muted = !video.muted;
      return;
    case "rate":
      actions.changeRate(nextVideoPlaybackRate(video.playbackRate, shortcut.step));
      return;
  }
}
