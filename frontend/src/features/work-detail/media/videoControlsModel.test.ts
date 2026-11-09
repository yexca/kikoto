import { describe, expect, it, vi } from "vitest";

import {
  bufferedFractions,
  controlsStayVisible,
  cueLineAboveControls,
  DOUBLE_TAP_MS,
  initialTapState,
  nextTap,
  seekVideoBy,
  showVideoSubtitle,
  shownVideoSubtitle,
  TAP_STREAK_MS,
  type TapState,
  tapZone,
  toggleVideoPlayback,
} from "@/features/work-detail/media/videoControlsModel";

const steps = { backward: 10, forward: 30 };

function tapSequence(taps: { at: number; x: number; visible?: boolean }[]) {
  let state: TapState = initialTapState;
  return taps.map(({ at, x, visible = false }) => {
    const result = nextTap(state, { at, zone: tapZone(x, 300), controlsVisible: visible }, steps);
    state = result.state;
    return result.action;
  });
}

describe("tap zones", () => {
  it("splits the video into thirds", () => {
    expect(tapZone(0, 300)).toBe("back");
    expect(tapZone(99, 300)).toBe("back");
    expect(tapZone(150, 300)).toBe("middle");
    expect(tapZone(200, 300)).toBe("forward");
    expect(tapZone(299, 300)).toBe("forward");
    expect(tapZone(10, 0)).toBe("middle");
  });
});

describe("taps on the video", () => {
  it("toggles the controls on a single tap without waiting for a second one", () => {
    expect(tapSequence([{ at: 0, x: 20 }])).toEqual([{ kind: "toggle" }]);
  });

  it("seeks on a side double tap and restores the controls from before the first tap", () => {
    expect(
      tapSequence([
        { at: 0, x: 20, visible: false },
        { at: 200, x: 30, visible: true },
      ]),
    ).toEqual([{ kind: "toggle" }, { kind: "seek", zone: "back", seconds: -10, total: -10, visible: false }]);
  });

  it("adds a step for each further quick tap on the same side", () => {
    const actions = tapSequence([
      { at: 0, x: 280 },
      { at: 150, x: 280 },
      { at: 500, x: 270 },
      { at: 900, x: 260 },
    ]);
    expect(actions.slice(1)).toEqual([
      { kind: "seek", zone: "forward", seconds: 30, total: 30, visible: false },
      { kind: "seek", zone: "forward", seconds: 30, total: 60, visible: null },
      { kind: "seek", zone: "forward", seconds: 30, total: 90, visible: null },
    ]);
  });

  it("starts over after the streak times out or the other side is tapped", () => {
    const timedOut = tapSequence([
      { at: 0, x: 20 },
      { at: 100, x: 20 },
      { at: 100 + TAP_STREAK_MS + 1, x: 20 },
    ]);
    expect(timedOut[2]).toEqual({ kind: "toggle" });

    const otherSide = tapSequence([
      { at: 0, x: 20 },
      { at: 100, x: 20 },
      { at: 200, x: 280 },
    ]);
    expect(otherSide[2]).toEqual({ kind: "toggle" });
  });

  it("treats taps further apart than the double-tap window as single taps", () => {
    expect(
      tapSequence([
        { at: 0, x: 20 },
        { at: DOUBLE_TAP_MS + 1, x: 20 },
      ]),
    ).toEqual([{ kind: "toggle" }, { kind: "toggle" }]);
  });

  it("does nothing on a double tap in the middle third", () => {
    expect(
      tapSequence([
        { at: 0, x: 150, visible: true },
        { at: 120, x: 150, visible: false },
      ]),
    ).toEqual([{ kind: "toggle" }, { kind: "restore", visible: true }]);
  });
});

describe("controls visibility", () => {
  const playing = { playing: true, busy: false, menuOpen: false, keyboardFocus: false, hovering: false };

  it("lets the controls hide only while the video plays and nothing holds them", () => {
    expect(controlsStayVisible(playing)).toBe(false);
    expect(controlsStayVisible({ ...playing, playing: false })).toBe(true);
    expect(controlsStayVisible({ ...playing, busy: true })).toBe(true);
    expect(controlsStayVisible({ ...playing, menuOpen: true })).toBe(true);
    expect(controlsStayVisible({ ...playing, keyboardFocus: true })).toBe(true);
    expect(controlsStayVisible({ ...playing, hovering: true })).toBe(true);
  });
});

describe("buffered ranges", () => {
  const ranges = (pairs: [number, number][]) => ({
    length: pairs.length,
    start: (index: number) => pairs[index][0],
    end: (index: number) => pairs[index][1],
  });

  it("converts ranges to fractions of the duration, clamped and without empty ranges", () => {
    expect(
      bufferedFractions(
        ranges([
          [0, 30],
          [60, 60],
          [90, 200],
        ]),
        120,
      ),
    ).toEqual([
      { start: 0, end: 0.25 },
      { start: 0.75, end: 1 },
    ]);
  });

  it("shows nothing while the duration is unknown", () => {
    expect(bufferedFractions(ranges([[0, 10]]), Number.NaN)).toEqual([]);
    expect(bufferedFractions(ranges([[0, 10]]), Number.POSITIVE_INFINITY)).toEqual([]);
  });
});

describe("seeking", () => {
  it("clamps between the start and the end and ignores a video without metadata", () => {
    const video = { currentTime: 5, duration: 60, readyState: 1 };
    seekVideoBy(video, -10, 0);
    expect(video.currentTime).toBe(0);
    seekVideoBy(video, 90, 0);
    expect(video.currentTime).toBe(60);

    const live = { currentTime: 5, duration: Number.NaN, readyState: 1 };
    seekVideoBy(live, 100, 30);
    expect(live.currentTime).toBe(30);

    const empty = { currentTime: 0, duration: Number.NaN, readyState: 0 };
    seekVideoBy(empty, 10, 30);
    expect(empty.currentTime).toBe(0);
  });
});

describe("subtitle choice", () => {
  function element(key: string, mode: TextTrackMode) {
    const track = { mode };
    const modes: TextTrackMode[] = [];
    return {
      dataset: { subtitleKey: key },
      modes,
      track: {
        get mode() {
          return track.mode;
        },
        set mode(value: TextTrackMode) {
          modes.push(value);
          track.mode = value;
        },
      },
    };
  }

  it("shows the chosen track and disables the rest", () => {
    const tracks = [element("a", "showing"), element("b", "disabled"), element("c", "hidden")];
    showVideoSubtitle(tracks, "b");
    expect(tracks.map((track) => track.track.mode)).toEqual(["disabled", "showing", "disabled"]);
    expect(shownVideoSubtitle(tracks)).toBe("b");
    showVideoSubtitle(tracks, null);
    expect(shownVideoSubtitle(tracks)).toBeNull();
  });

  it("switches a track that already shows off and on, so a failed load retries", () => {
    const shown = element("a", "showing");
    showVideoSubtitle([shown], "a");
    expect(shown.modes).toEqual(["disabled", "showing"]);
  });
});

describe("subtitle placement", () => {
  it("keeps automatically placed cues above the controls, never above the middle", () => {
    expect(cueLineAboveControls(720, 72)).toBe(-3);
    expect(cueLineAboveControls(160, 72)).toBe(-5);
    expect(cueLineAboveControls(400, 0)).toBeNull();
    expect(cueLineAboveControls(0, 80)).toBeNull();
  });
});

describe("playback toggle", () => {
  it("plays an ended video and pauses a playing one", () => {
    const play = vi.fn().mockResolvedValue(undefined);
    const pause = vi.fn();
    toggleVideoPlayback({ paused: false, ended: true, play, pause });
    toggleVideoPlayback({ paused: false, ended: false, play, pause });
    expect(play).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenCalledTimes(1);
  });
});
