import { describe, expect, it } from "vitest";

import { nextVideoPlaybackRate, videoShortcut } from "@/features/work-detail/media/videoShortcuts";

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
