import { describe, expect, it, vi } from "vitest";

import {
  handleVideoStageKeyDown,
  nextVideoPlaybackRate,
  VIDEO_SHORTCUT_GUIDE,
  videoShortcut,
  videoShortcutKeyLabel,
} from "@/player/video/videoShortcuts";

function key(value: string, options: { code?: string; shiftKey?: boolean; ctrlKey?: boolean } = {}) {
  return {
    key: value,
    code: options.code ?? "",
    shiftKey: options.shiftKey ?? false,
    altKey: false,
    ctrlKey: options.ctrlKey ?? false,
    metaKey: false,
  };
}

describe("video stage shortcuts", () => {
  it("maps the playback keys", () => {
    expect(videoShortcut(key(" "))).toEqual({ action: "togglePlay" });
    expect(videoShortcut(key("k"))).toEqual({ action: "togglePlay" });
    expect(videoShortcut(key("j"))).toEqual({ action: "seek", seconds: -10 });
    expect(videoShortcut(key("l"))).toEqual({ action: "seek", seconds: 10 });
    expect(videoShortcut(key("ArrowLeft"))).toEqual({ action: "seek", seconds: -5 });
    expect(videoShortcut(key("ArrowRight"))).toEqual({ action: "seek", seconds: 5 });
    expect(videoShortcut(key("f"))).toEqual({ action: "fullscreen" });
    expect(videoShortcut(key("m"))).toEqual({ action: "mute" });
    expect(videoShortcut(key("<", { code: "Comma", shiftKey: true }))).toEqual({ action: "rate", step: -1 });
    expect(videoShortcut(key(">", { code: "Period", shiftKey: true }))).toEqual({ action: "rate", step: 1 });
  });

  it("leaves other keys and modified keys to the dialog and the browser", () => {
    expect(videoShortcut(key("Escape"))).toBeNull();
    expect(videoShortcut(key("ArrowUp"))).toBeNull();
    expect(videoShortcut(key(",", { code: "Comma" }))).toBeNull();
    expect(videoShortcut(key("F", { shiftKey: true }))).toBeNull();
    expect(videoShortcut(key("f", { ctrlKey: true }))).toBeNull();
  });

  it("steps the speed through the listed rates and stops at either end", () => {
    expect(nextVideoPlaybackRate(1, 1)).toBe(1.25);
    expect(nextVideoPlaybackRate(1, -1)).toBe(0.75);
    expect(nextVideoPlaybackRate(1.1, 1)).toBe(1.25);
    expect(nextVideoPlaybackRate(1.1, -1)).toBe(1);
    expect(nextVideoPlaybackRate(2, 1)).toBe(2);
    expect(nextVideoPlaybackRate(0.5, -1)).toBe(0.5);
  });
});

describe("handleVideoStageKeyDown", () => {
  function setup() {
    const video = {
      paused: true,
      ended: false,
      play: vi.fn(async () => undefined),
      pause: vi.fn(),
      muted: false,
      playbackRate: 1,
    };
    const stage = {};
    const actions = { duration: 60, toggleFullscreen: vi.fn(), changeRate: vi.fn() };
    const press = (key: string, options: { target?: object; repeat?: boolean; shiftKey?: boolean } = {}) => {
      const event = {
        key,
        code: "",
        shiftKey: options.shiftKey ?? false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        repeat: options.repeat ?? false,
        defaultPrevented: false,
        nativeEvent: { isComposing: false },
        target: options.target ?? stage,
        currentTarget: stage,
        preventDefault: vi.fn(),
      };
      handleVideoStageKeyDown(
        event as unknown as Parameters<typeof handleVideoStageKeyDown>[0],
        video as unknown as HTMLVideoElement,
        actions,
      );
      return event;
    };
    return { video, actions, press };
  }

  it("acts on the stage's own keys and leaves buttons beside the video alone", () => {
    const { video, actions, press } = setup();
    expect(press(" ").preventDefault).toHaveBeenCalled();
    expect(video.play).toHaveBeenCalledTimes(1);
    press(" ", { repeat: true });
    expect(video.play).toHaveBeenCalledTimes(1);
    press("f");
    expect(actions.toggleFullscreen).toHaveBeenCalledTimes(1);
    press(">", { shiftKey: true });
    expect(actions.changeRate).toHaveBeenCalledWith(1.25);
    const button = press(" ", { target: {} });
    expect(button.preventDefault).not.toHaveBeenCalled();
    expect(video.play).toHaveBeenCalledTimes(1);
  });
});

describe("VIDEO_SHORTCUT_GUIDE", () => {
  it("lists every key with the shortcut the stage maps it to", () => {
    for (const entry of VIDEO_SHORTCUT_GUIDE) {
      for (const pressed of entry.keys) {
        expect(videoShortcut(key(pressed.key, { shiftKey: pressed.shiftKey }))).toEqual(entry.shortcut);
      }
    }
    expect(VIDEO_SHORTCUT_GUIDE.flatMap((entry) => entry.keys.map(videoShortcutKeyLabel))).toEqual([
      "Space",
      "K",
      "J",
      "L",
      "←",
      "→",
      "F",
      "M",
      "Shift + <",
      "Shift + >",
    ]);
  });
});
