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
