import { describe, expect, it, vi } from "vitest";

import {
  exitStageFullscreen,
  toggleVideoFullscreen,
  videoFullscreenMode,
} from "@/features/work-detail/media/videoFullscreen";

function fullscreenDocument(element: Element | null = null) {
  return {
    fullscreenElement: element,
    exitFullscreen: vi.fn().mockResolvedValue(undefined),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
}

function stage(requestFullscreen = true) {
  return {
    contains: vi.fn(() => true),
    requestFullscreen: requestFullscreen ? vi.fn().mockResolvedValue(undefined) : undefined,
  };
}

function video(options: { requestFullscreen?: boolean; webkit?: boolean } = {}) {
  return {
    requestFullscreen: options.requestFullscreen ? vi.fn().mockResolvedValue(undefined) : undefined,
    webkitEnterFullscreen: options.webkit ? vi.fn() : undefined,
  };
}

describe("video fullscreen", () => {
  it("opens the system player on iPhone and iPad", () => {
    const target = stage();
    const element = video({ requestFullscreen: true, webkit: true });
    expect(videoFullscreenMode(target, element, true)).toBe("system");
    toggleVideoFullscreen(target, element, fullscreenDocument(), true);
    expect(element.webkitEnterFullscreen).toHaveBeenCalledTimes(1);
    expect(target.requestFullscreen).not.toHaveBeenCalled();
  });

  it("makes the stage fullscreen elsewhere, so the on-screen controls stay", () => {
    const target = stage();
    const element = video({ requestFullscreen: true, webkit: true });
    toggleVideoFullscreen(target, element, fullscreenDocument(), false);
    expect(target.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(element.requestFullscreen).not.toHaveBeenCalled();
    expect(element.webkitEnterFullscreen).not.toHaveBeenCalled();
  });

  it("falls back to the video element where the stage cannot go fullscreen", () => {
    const element = video({ requestFullscreen: true });
    toggleVideoFullscreen(stage(false), element, fullscreenDocument(), false);
    expect(element.requestFullscreen).toHaveBeenCalledTimes(1);

    const webkitOnly = video({ webkit: true });
    toggleVideoFullscreen(stage(false), webkitOnly, fullscreenDocument(), false);
    expect(webkitOnly.webkitEnterFullscreen).toHaveBeenCalledTimes(1);

    expect(videoFullscreenMode(stage(false), video(), false)).toBeNull();
  });

  it("leaves fullscreen when the page is fullscreen", () => {
    const target = stage();
    const doc = fullscreenDocument({} as Element);
    toggleVideoFullscreen(target, video({ requestFullscreen: true }), doc, false);
    expect(doc.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(target.requestFullscreen).not.toHaveBeenCalled();
  });

  it("leaves fullscreen on close only when the stage holds the fullscreen element", () => {
    const inside = fullscreenDocument({} as Element);
    exitStageFullscreen(stage(), inside);
    expect(inside.exitFullscreen).toHaveBeenCalledTimes(1);

    const elsewhere = fullscreenDocument({} as Element);
    exitStageFullscreen({ contains: () => false }, elsewhere);
    expect(elsewhere.exitFullscreen).not.toHaveBeenCalled();
  });
});
