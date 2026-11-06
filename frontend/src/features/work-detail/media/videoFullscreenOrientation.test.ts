import { describe, expect, it } from "vitest";

import {
  type LandscapeLock,
  watchVideoFullscreenOrientation,
} from "@/features/work-detail/media/videoFullscreenOrientation";

function fixture(size: { width: number; height: number }, lockResult: "resolve" | "reject" = "resolve") {
  const video = Object.assign(new EventTarget(), { videoWidth: size.width, videoHeight: size.height });
  const container = { contains: (node: unknown) => node === video };
  const doc = Object.assign(new EventTarget(), { fullscreenElement: null as unknown });
  const calls: string[] = [];
  const landscape: LandscapeLock = {
    lock: () => {
      calls.push("lock");
      return lockResult === "resolve" ? Promise.resolve() : Promise.reject(new Error("NotSupportedError"));
    },
    unlock: () => calls.push("unlock"),
  };
  const stop = watchVideoFullscreenOrientation(
    video as unknown as HTMLVideoElement,
    doc as unknown as Parameters<typeof watchVideoFullscreenOrientation>[1],
    landscape,
  );
  const enter = (element: unknown = container) => {
    doc.fullscreenElement = element;
    doc.dispatchEvent(new Event("fullscreenchange"));
  };
  const exit = () => {
    doc.fullscreenElement = null;
    doc.dispatchEvent(new Event("fullscreenchange"));
  };
  return { video, calls, enter, exit, stop };
}

describe("video fullscreen orientation", () => {
  it("turns a landscape video to landscape while it is fullscreen", () => {
    const { calls, enter, exit } = fixture({ width: 1920, height: 1080 });
    enter();
    expect(calls).toEqual(["lock"]);
    exit();
    expect(calls).toEqual(["lock", "unlock"]);
  });

  it("leaves the screen alone for a portrait video or another fullscreen element", () => {
    const portrait = fixture({ width: 1080, height: 1920 });
    portrait.enter();
    portrait.exit();
    expect(portrait.calls).toEqual([]);

    const other = fixture({ width: 1920, height: 1080 });
    other.enter({ contains: () => false });
    expect(other.calls).toEqual([]);
  });

  it("locks once the size of a video that entered fullscreen before its metadata is known", () => {
    const { video, calls, enter } = fixture({ width: 0, height: 0 });
    enter();
    expect(calls).toEqual([]);
    Object.assign(video, { videoWidth: 1280, videoHeight: 720 });
    video.dispatchEvent(new Event("resize"));
    expect(calls).toEqual(["lock"]);
  });

  it("releases a held lock when the viewer closes during fullscreen", () => {
    const { calls, enter, stop } = fixture({ width: 1920, height: 1080 });
    enter();
    stop();
    expect(calls).toEqual(["lock", "unlock"]);
  });

  it("does not release a lock the screen refused", async () => {
    const { calls, enter, exit } = fixture({ width: 1920, height: 1080 }, "reject");
    enter();
    await Promise.resolve();
    exit();
    expect(calls).toEqual(["lock"]);
  });
});
