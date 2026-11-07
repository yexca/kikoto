/** How long the controls stay after the last interaction while the video plays. */
export const CONTROLS_HIDE_MS = 3000;
/** A second tap within this window on the same third of the video seeks. */
export const DOUBLE_TAP_MS = 300;
/** Further taps within this window of the previous one add to the seek. */
export const TAP_STREAK_MS = 700;

export type TapZone = "back" | "middle" | "forward";

/** The third of the video a tap at `x` falls in, measured from the left edge of a `width` wide surface. */
export function tapZone(x: number, width: number): TapZone {
  if (!(width > 0)) return "middle";
  const ratio = x / width;
  if (ratio < 1 / 3) return "back";
  if (ratio >= 2 / 3) return "forward";
  return "middle";
}

export type TapState = {
  /** The last tap that toggled the controls, while a second tap can still turn it into a double tap. */
  pending: { at: number; zone: TapZone; visibleBefore: boolean } | null;
  /** A run of seeking taps on one side, and the seconds it has moved so far. */
  streak: { at: number; zone: "back" | "forward"; total: number } | null;
};

export const initialTapState: TapState = { pending: null, streak: null };

export type TapAction =
  | { kind: "toggle" }
  /** Seek by `seconds`; `total` is the whole run so far, and the controls return to `visible`. */
  | { kind: "seek"; zone: "back" | "forward"; seconds: number; total: number; visible: boolean | null }
  /** A double tap in the middle third: the controls return to how they were before it. */
  | { kind: "restore"; visible: boolean };

/**
 * The action for a touch or pen tap. A first tap toggles the controls at
 * once. A second tap within {@link DOUBLE_TAP_MS} on the same side third
 * seeks by that side's step and puts the controls back as they were before the
 * first tap; quick further taps on that side add another step each. A double
 * tap in the middle third only undoes the first tap's toggle.
 */
export function nextTap(
  state: TapState,
  tap: { at: number; zone: TapZone; controlsVisible: boolean },
  steps: { backward: number; forward: number },
): { state: TapState; action: TapAction } {
  const { streak, pending } = state;
  if (streak && tap.zone === streak.zone && tap.at - streak.at <= TAP_STREAK_MS) {
    const seconds = streakSeconds(streak.zone, steps);
    const total = streak.total + seconds;
    return {
      state: { pending: null, streak: { at: tap.at, zone: streak.zone, total } },
      action: { kind: "seek", zone: streak.zone, seconds, total, visible: null },
    };
  }
  if (pending && tap.zone === pending.zone && tap.at - pending.at <= DOUBLE_TAP_MS) {
    if (pending.zone === "middle") {
      return { state: initialTapState, action: { kind: "restore", visible: pending.visibleBefore } };
    }
    const seconds = streakSeconds(pending.zone, steps);
    return {
      state: { pending: null, streak: { at: tap.at, zone: pending.zone, total: seconds } },
      action: { kind: "seek", zone: pending.zone, seconds, total: seconds, visible: pending.visibleBefore },
    };
  }
  return {
    state: { pending: { at: tap.at, zone: tap.zone, visibleBefore: tap.controlsVisible }, streak: null },
    action: { kind: "toggle" },
  };
}

function streakSeconds(zone: "back" | "forward", steps: { backward: number; forward: number }) {
  return zone === "back" ? -steps.backward : steps.forward;
}

/**
 * Whether the controls stay on screen regardless of the hide timer: while the
 * video is paused or loading, a menu is open, a control has keyboard focus,
 * or the pointer rests on the controls.
 */
export function controlsStayVisible(state: {
  playing: boolean;
  busy: boolean;
  menuOpen: boolean;
  keyboardFocus: boolean;
  hovering: boolean;
}) {
  return !state.playing || state.busy || state.menuOpen || state.keyboardFocus || state.hovering;
}

type TimeRangesLike = Pick<TimeRanges, "length" | "start" | "end">;

/** The buffered ranges as fractions of `duration`, clamped to the bar and without empty ranges. */
export function bufferedFractions(ranges: TimeRangesLike, duration: number) {
  if (!(Number.isFinite(duration) && duration > 0)) return [];
  const fractions: { start: number; end: number }[] = [];
  for (let index = 0; index < ranges.length; index++) {
    const start = clampFraction(ranges.start(index) / duration);
    const end = clampFraction(ranges.end(index) / duration);
    if (end > start) fractions.push({ start, end });
  }
  return fractions;
}

function clampFraction(value: number) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** The duration to show: the element's own once it knows one, otherwise the playback info's. */
export function videoDuration(elementDuration: number, fallback: number) {
  return Number.isFinite(elementDuration) && elementDuration > 0 ? elementDuration : fallback;
}

type SeekableVideo = Pick<HTMLVideoElement, "currentTime" | "duration" | "readyState">;

/**
 * Moves the video to `seconds`, clamped between the start and the end. A video
 * without metadata ignores the seek. The keyboard, the on-screen buttons, and
 * double taps all seek through this.
 */
export function seekVideoTo(video: SeekableVideo, seconds: number, fallbackDuration: number) {
  if (video.readyState === 0 || !Number.isFinite(seconds)) return;
  const end = Number.isFinite(video.duration) ? video.duration : fallbackDuration || Number.POSITIVE_INFINITY;
  video.currentTime = Math.min(Math.max(0, seconds), end);
}

export function seekVideoBy(video: SeekableVideo, seconds: number, fallbackDuration: number) {
  seekVideoTo(video, video.currentTime + seconds, fallbackDuration);
}

export function toggleVideoPlayback(video: Pick<HTMLVideoElement, "paused" | "ended" | "play" | "pause">) {
  if (video.paused || video.ended) void video.play().catch(() => undefined);
  else video.pause();
}

type SubtitleTrackElement = { dataset: DOMStringMap; track: { mode: TextTrackMode } };

/**
 * Shows the subtitle track rendered with `key` and disables the rest; null
 * turns subtitles off. Choosing the track that already shows switches it off
 * and on again, so a track whose loading failed loads again.
 */
export function showVideoSubtitle(elements: Iterable<SubtitleTrackElement>, key: string | null) {
  for (const element of elements) {
    if (element.dataset.subtitleKey === key) {
      if (element.track.mode === "showing") element.track.mode = "disabled";
      element.track.mode = "showing";
    } else {
      element.track.mode = "disabled";
    }
  }
}

/** The key of the subtitle track that shows, or null when subtitles are off. */
export function shownVideoSubtitle(elements: Iterable<SubtitleTrackElement>) {
  for (const element of elements) {
    if (element.track.mode === "showing") return element.dataset.subtitleKey ?? null;
  }
  return null;
}

// Browsers size caption text at about 5% of the video height, with a minimum, so a caption
// line box is about 6% of the frame and never much under 14px. Overestimating keeps the line
// in the frame; a line past the top makes the browser put the cue back at the bottom.
const cueLineHeightRatio = 0.06;
const cueLineMinHeight = 14;

/**
 * The snap-to-lines line, counted up from the bottom as a negative number, for
 * an automatically placed cue to stay above `reservedHeight` pixels of
 * controls; null leaves cues where the browser puts them. A multi-line cue
 * grows upward from that line, and cues never move above the middle.
 */
export function cueLineAboveControls(frameHeight: number, reservedHeight: number) {
  if (!(frameHeight > 0) || !(reservedHeight > 0)) return null;
  const lineHeight = Math.max(frameHeight * cueLineHeightRatio, cueLineMinHeight);
  // Line -1 is the bottom line itself, so clearing the controls takes one more.
  const lines = Math.ceil(reservedHeight / lineHeight) + 1;
  return -Math.min(lines, Math.floor(frameHeight / 2 / lineHeight));
}

export function formatVideoDuration(seconds: number) {
  const total = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}
