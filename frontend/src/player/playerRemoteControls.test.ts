import { describe, expect, it, vi } from "vitest";

import { bindMediaSessionActions, type PlayerRemoteControls } from "./playerRemoteControls";

function fakeMediaSession(unsupported: MediaSessionAction[] = []) {
  const handlers = new Map<MediaSessionAction, MediaSessionActionHandler | null>();
  return {
    handlers,
    setActionHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null) {
      if (unsupported.includes(action)) throw new TypeError(`${action} is not supported`);
      handlers.set(action, handler);
    },
  };
}

function remoteControls(): PlayerRemoteControls {
  return {
    play: vi.fn(),
    pause: vi.fn(),
    previous: vi.fn(),
    next: vi.fn(),
    seekBackward: vi.fn(),
    seekForward: vi.fn(),
    seekTo: vi.fn(),
  };
}

describe("bindMediaSessionActions", () => {
  it("sends an action to the controls that are current when it arrives", () => {
    // A handler bound while the queue was in order mode must still wrap after the listener switches to loop.
    const session = fakeMediaSession();
    let controls = remoteControls();
    bindMediaSessionActions(session, () => controls);
    const boundControls = controls;
    controls = remoteControls();

    session.handlers.get("nexttrack")?.({ action: "nexttrack" });
    session.handlers.get("previoustrack")?.({ action: "previoustrack" });

    expect(controls.next).toHaveBeenCalledTimes(1);
    expect(controls.previous).toHaveBeenCalledTimes(1);
    expect(boundControls.next).not.toHaveBeenCalled();
    expect(boundControls.previous).not.toHaveBeenCalled();
  });

  it("seeks to the requested position and clears every handler on cleanup", () => {
    const session = fakeMediaSession();
    const controls = remoteControls();
    const unbind = bindMediaSessionActions(session, () => controls);

    session.handlers.get("seekto")?.({ action: "seekto", seekTime: 42 });
    expect(controls.seekTo).toHaveBeenCalledWith(42);

    unbind();
    expect([...session.handlers.values()].every((handler) => handler === null)).toBe(true);
  });

  it("registers the supported actions when the browser rejects another one", () => {
    const session = fakeMediaSession(["seekto"]);
    const controls = remoteControls();
    bindMediaSessionActions(session, () => controls);

    session.handlers.get("pause")?.({ action: "pause" });

    expect(session.handlers.has("seekto")).toBe(false);
    expect(controls.pause).toHaveBeenCalledTimes(1);
  });
});
