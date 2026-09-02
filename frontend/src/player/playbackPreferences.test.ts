import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const isNativeApp = vi.hoisted(() => vi.fn(() => false));
vi.mock("@/lib/serverConfig", () => ({ isNativeApp }));

import {
  DEFAULT_SEEK_BACKWARD_SECONDS,
  DEFAULT_SEEK_FORWARD_SECONDS,
  getStoredPlaybackSeekPreferences,
  normalizePlaybackSeekPreferences,
  PLAYER_SEEK_PREFERENCES_CHANGE_EVENT,
  playbackSeekPreferencesStorageKey,
  storePlaybackSeekPreferences,
} from "./playbackPreferences";

function memoryStorage(values: Record<string, string> = {}): Storage {
  const entries = new Map(Object.entries(values));
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: (key) => entries.delete(key),
    clear: () => entries.clear(),
    key: (index) => [...entries.keys()][index] ?? null,
    get length() {
      return entries.size;
    },
  };
}

describe("playback seek preferences", () => {
  const dispatchEvent = vi.fn();

  beforeEach(() => {
    isNativeApp.mockReturnValue(false);
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("window", {
      location: { origin: "https://player.example.invalid" },
      dispatchEvent,
    });
    dispatchEvent.mockReset();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("uses the requested defaults when no preference is stored", () => {
    expect(getStoredPlaybackSeekPreferences(7)).toEqual({
      seekForwardSeconds: DEFAULT_SEEK_FORWARD_SECONDS,
      seekBackwardSeconds: DEFAULT_SEEK_BACKWARD_SECONDS,
    });
  });

  it("falls back independently for malformed or out-of-range values", () => {
    const key = playbackSeekPreferencesStorageKey(7);
    localStorage.setItem(key, JSON.stringify({ seekForwardSeconds: 301, seekBackwardSeconds: 12.5 }));
    expect(getStoredPlaybackSeekPreferences(7)).toEqual({
      seekForwardSeconds: DEFAULT_SEEK_FORWARD_SECONDS,
      seekBackwardSeconds: DEFAULT_SEEK_BACKWARD_SECONDS,
    });

    localStorage.setItem(key, "not-json");
    expect(getStoredPlaybackSeekPreferences(7)).toEqual(normalizePlaybackSeekPreferences(null));
  });

  it("scopes values by server identity and user", () => {
    expect(playbackSeekPreferencesStorageKey(7)).toBe(
      "kikoto:player-seek-preferences:v1:https%3A%2F%2Fplayer.example.invalid:user-7",
    );
    expect(playbackSeekPreferencesStorageKey(null)).toContain(":anonymous");
  });

  it("stores normalized values and notifies the active player", () => {
    const preferences = storePlaybackSeekPreferences(7, {
      seekForwardSeconds: 45,
      seekBackwardSeconds: 15,
    });

    expect(preferences).toEqual({ seekForwardSeconds: 45, seekBackwardSeconds: 15 });
    expect(JSON.parse(localStorage.getItem(playbackSeekPreferencesStorageKey(7)) ?? "null")).toEqual(preferences);
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: PLAYER_SEEK_PREFERENCES_CHANGE_EVENT,
        detail: { storageKey: playbackSeekPreferencesStorageKey(7), preferences },
      }),
    );
  });
});
