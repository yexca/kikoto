import { afterEach, describe, expect, it, vi } from "vitest";

import {
  announceRemoteTrackCreated,
  isMatchingRemoteTrack,
  REMOTE_TRACK_CREATED_EVENT,
  type RemoteTrackTerminalDetail,
} from "./remoteTrackWorkflows";

describe("remote track workflow events", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("normalizes the announced codes and dispatches a stable detail", () => {
    const windowTarget = new EventTarget();
    vi.stubGlobal("window", windowTarget);
    const received: unknown[] = [];
    windowTarget.addEventListener(REMOTE_TRACK_CREATED_EVENT, (event) => {
      received.push((event as CustomEvent).detail);
    });

    const detail = announceRemoteTrackCreated(7, " rj00000000 ", {
      jobId: 4,
      runId: 3,
      workId: null,
      primaryCode: " rj00000000 ",
      status: "queued",
      deduplicated: true,
      triggerReason: "manual",
    });
    expect(detail).toEqual({
      runId: 3,
      sourceId: 7,
      requestedCode: "RJ00000000",
      primaryCode: "RJ00000000",
      status: "queued",
      deduplicated: true,
    });
    expect(received).toEqual([detail]);
  });

  it("matches a terminal event by source and either requested or canonical code", () => {
    const detail: RemoteTrackTerminalDetail = {
      runId: 3,
      sourceId: 7,
      requestedCode: "RJ00000000",
      primaryCode: "RJ00000001",
      status: "succeeded",
      deduplicated: false,
      workId: 11,
      fileSourceId: 7,
    };
    expect(isMatchingRemoteTrack(detail, 7, " rj00000001 ")).toBe(true);
    expect(isMatchingRemoteTrack(detail, 7, "unknown", null)).toBe(false);
    expect(isMatchingRemoteTrack(detail, 8, "RJ00000000")).toBe(false);
    expect(isMatchingRemoteTrack(detail, 7)).toBe(true);
  });
});
