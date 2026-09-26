import { beforeEach, describe, expect, it, vi } from "vitest";

const isNativeApp = vi.hoisted(() => vi.fn(() => false));
vi.mock("@/lib/serverConfig", () => ({ isNativeApp, getStoredServerURL: () => "" }));

import {
  DEFAULT_SLEEP_REWIND_MINUTES,
  getStoredSleepRewindMinutes,
  parseSleepRewindDraft,
  planSleepStop,
  SLEEP_REWIND_CHANGE_EVENT,
  sleepRewindStorageKey,
  storeSleepRewindMinutes,
  type SleepStopInput,
} from "./sleepRewind";

const playing: SleepStopInput = {
  rewindMinutes: 5,
  wasPlaying: true,
  unappliedStartSeconds: null,
  pendingSeekSeconds: null,
  elementPositionSeconds: 900,
  ended: false,
  durationSeconds: 1_800,
};

describe("sleep timer stop position", () => {
  it("keeps the current position when rewind is off or the listener already paused", () => {
    expect(planSleepStop({ ...playing, rewindMinutes: 0 })).toEqual({ kind: "none" });
    expect(planSleepStop({ ...playing, wasPlaying: false })).toEqual({ kind: "none" });
  });

  it("rewinds within the current track and clamps at its start", () => {
    expect(planSleepStop(playing)).toEqual({ kind: "seek", positionSeconds: 600 });
    expect(planSleepStop({ ...playing, elementPositionSeconds: 90 })).toEqual({ kind: "seek", positionSeconds: 0 });
  });

  it("rewinds from the track end when the finish-current-track timer fires", () => {
    expect(planSleepStop({ ...playing, ended: true, elementPositionSeconds: 1_799.9 })).toEqual({
      kind: "seek",
      positionSeconds: 1_500,
    });
    // A stream without a known duration rewinds from the element position.
    expect(planSleepStop({ ...playing, ended: true, durationSeconds: Number.NaN })).toEqual({
      kind: "seek",
      positionSeconds: 600,
    });
  });

  it("rewinds from an unconfirmed seek target instead of the stale element position", () => {
    expect(planSleepStop({ ...playing, pendingSeekSeconds: 1_200 })).toEqual({ kind: "seek", positionSeconds: 900 });
  });

  it("moves a start position still waiting for metadata without seeking the loading element", () => {
    expect(planSleepStop({ ...playing, unappliedStartSeconds: 420, elementPositionSeconds: 0 })).toEqual({
      kind: "start",
      positionSeconds: 120,
    });
    expect(planSleepStop({ ...playing, unappliedStartSeconds: 60, elementPositionSeconds: 0 })).toEqual({
      kind: "start",
      positionSeconds: 0,
    });
  });

  it("treats an out-of-range stored setting as off", () => {
    expect(planSleepStop({ ...playing, rewindMinutes: 121 })).toEqual({ kind: "none" });
    expect(planSleepStop({ ...playing, rewindMinutes: 2.5 })).toEqual({ kind: "none" });
  });
});

describe("sleep rewind setting", () => {
  const dispatchEvent = vi.fn();

  beforeEach(() => {
    const entries = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
      removeItem: (key: string) => entries.delete(key),
    });
    vi.stubGlobal("window", { location: { origin: "https://kikoto.example.invalid" }, dispatchEvent });
    vi.stubGlobal(
      "CustomEvent",
      class extends Event {
        detail: unknown;
        constructor(type: string, init?: { detail?: unknown }) {
          super(type);
          this.detail = init?.detail;
        }
      },
    );
    dispatchEvent.mockReset();
  });

  it("defaults to off and keeps a value per server account", () => {
    expect(getStoredSleepRewindMinutes(7)).toBe(DEFAULT_SLEEP_REWIND_MINUTES);
    expect(storeSleepRewindMinutes(7, 15)).toBe(15);
    expect(getStoredSleepRewindMinutes(7)).toBe(15);
    expect(getStoredSleepRewindMinutes(8)).toBe(0);
    expect(getStoredSleepRewindMinutes(null)).toBe(0);
    expect(sleepRewindStorageKey(7)).not.toBe(sleepRewindStorageKey(8));

    const event = dispatchEvent.mock.calls[0][0] as CustomEvent;
    expect(event.type).toBe(SLEEP_REWIND_CHANGE_EVENT);
    expect(event.detail).toEqual({ storageKey: sleepRewindStorageKey(7), minutes: 15 });
  });

  it("accepts only whole minutes from 0 to 120 in the menu draft", () => {
    expect(parseSleepRewindDraft("0")).toBe(0);
    expect(parseSleepRewindDraft(" 120 ")).toBe(120);
    expect(parseSleepRewindDraft("121")).toBeNull();
    expect(parseSleepRewindDraft("1.5")).toBeNull();
    expect(parseSleepRewindDraft("-1")).toBeNull();
    expect(parseSleepRewindDraft("")).toBeNull();
  });
});
