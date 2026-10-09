import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSpeakerGuardEnabled, SpeakerGuardState, storeSpeakerGuardEnabled } from "./speakerGuard";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

describe("speaker guard", () => {
  it("allows starts on headphones and holds a start on the speaker until it is confirmed", () => {
    const guard = new SpeakerGuardState();
    expect(guard.allowsStart(true)).toBe(true);

    guard.setOutput(true);
    expect(guard.allowsStart(true)).toBe(false);
    expect(guard.allowsStart(false)).toBe(true);

    guard.allowSpeaker();
    expect(guard.allowsStart(true)).toBe(true);
  });

  it("asks again after the output leaves the speaker and comes back", () => {
    const guard = new SpeakerGuardState();
    guard.setOutput(true);
    guard.allowSpeaker();

    guard.setOutput(false);
    expect(guard.allowsStart(true)).toBe(true);
    guard.setOutput(true);
    expect(guard.allowsStart(true)).toBe(false);
  });

  describe("preference", () => {
    beforeEach(() => {
      vi.stubGlobal("localStorage", memoryStorage());
      vi.stubGlobal("window", { dispatchEvent: vi.fn() });
    });
    afterEach(() => vi.unstubAllGlobals());

    it("is on by default and remembers being turned off", () => {
      expect(getSpeakerGuardEnabled()).toBe(true);
      storeSpeakerGuardEnabled(false);
      expect(getSpeakerGuardEnabled()).toBe(false);
      storeSpeakerGuardEnabled(true);
      expect(getSpeakerGuardEnabled()).toBe(true);
    });
  });
});
