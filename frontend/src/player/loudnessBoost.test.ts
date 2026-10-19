import { afterEach, describe, expect, it, vi } from "vitest";

import { routeLoudnessGain, unlockLoudnessGain, type LoudnessGainOptions } from "./loudnessBoost";

class FakeEvents {
  listeners: Record<string, Array<() => void>> = {};
  addEventListener(type: string, listener: () => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  emit(type: string) {
    for (const listener of this.listeners[type] ?? []) listener();
  }
}

class FakeGainParam {
  value = 1;
  ramps: Array<{ target: number; timeConstant: number }> = [];
  cancelScheduledValues() {}
  setValueAtTime(value: number) {
    this.value = value;
  }
  setTargetAtTime(target: number, _start: number, timeConstant: number) {
    this.ramps.push({ target, timeConstant });
    this.value = target;
  }
}

class FakeAudioContext extends FakeEvents {
  static created = 0;
  static last: FakeAudioContext | null = null;
  // Safari outside a user gesture: resume() leaves the context suspended.
  static resumeRuns = true;
  state = "suspended";
  resumed = 0;
  routed = 0;
  currentTime = 0;
  destination = {};
  gainNode = { gain: new FakeGainParam(), connect: () => this.destination };
  constructor() {
    super();
    FakeAudioContext.created += 1;
    FakeAudioContext.last = this;
  }
  resume() {
    this.resumed += 1;
    if (FakeAudioContext.resumeRuns && this.state !== "running") {
      this.state = "running";
      this.emit("statechange");
    }
    return Promise.resolve();
  }
  createGain() {
    return this.gainNode;
  }
  createMediaElementSource() {
    this.routed += 1;
    return { connect: () => this.gainNode };
  }
}

function element(source: string, paused = true) {
  return Object.assign(new FakeEvents(), {
    currentSrc: source,
    paused,
    getAttribute: () => source,
  }) as unknown as HTMLMediaElement & FakeEvents;
}

function pageAt(origin: string, visibilityState = "visible") {
  vi.stubGlobal("window", { location: { href: `${origin}/works/1`, origin }, AudioContext: FakeAudioContext });
  vi.stubGlobal("document", { visibilityState });
}

function options(overrides: Partial<LoudnessGainOptions> = {}): LoudnessGainOptions {
  return { allowRouting: true, currentGain: 1, ramp: false, onRunning: () => {}, ...overrides };
}

describe("routeLoudnessGain", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeAudioContext.created = 0;
    FakeAudioContext.last = null;
    FakeAudioContext.resumeRuns = true;
  });

  it("routes a same-origin element only in full mode and only once a track needs a change", () => {
    pageAt("https://kikoto.example");
    const audio = element("https://kikoto.example/api/media/1/stream");
    expect(routeLoudnessGain(audio, 1, options())).toBe(false);
    expect(routeLoudnessGain(audio, 0.5, options({ allowRouting: false }))).toBe(false);
    expect(FakeAudioContext.created).toBe(0);
    unlockLoudnessGain(audio, true);
    expect(routeLoudnessGain(audio, 2, options())).toBe(true);
    // Once routed, the graph applies every later gain, cuts included.
    expect(routeLoudnessGain(audio, 0.5, options({ allowRouting: false }))).toBe(true);
    expect(FakeAudioContext.last?.gainNode.gain.value).toBe(0.5);
    expect(FakeAudioContext.created).toBe(1);
  });

  it("keeps the element's own output while its context cannot run, and routes once a gesture starts it", () => {
    pageAt("https://kikoto.example");
    FakeAudioContext.resumeRuns = false;
    const audio = element("https://kikoto.example/api/media/2/stream", false);
    const onRunning = vi.fn();
    // The measurement arrives outside a gesture, as in background auto-advance.
    expect(routeLoudnessGain(audio, 2, options({ onRunning }))).toBe(false);
    const context = FakeAudioContext.last as FakeAudioContext;
    expect(context.routed).toBe(0);
    // A tap anywhere starts the context, and the player routes again.
    FakeAudioContext.resumeRuns = true;
    unlockLoudnessGain(audio, true);
    expect(onRunning).toHaveBeenCalledTimes(1);
    expect(routeLoudnessGain(audio, 2, options({ onRunning }))).toBe(true);
    expect(context.routed).toBe(1);
  });

  it("does not route while the page is hidden", () => {
    pageAt("https://kikoto.example", "hidden");
    const audio = element("https://kikoto.example/api/media/3/stream", false);
    unlockLoudnessGain(audio, true);
    expect(routeLoudnessGain(audio, 2, options())).toBe(false);
    expect(FakeAudioContext.last?.routed).toBe(0);
  });

  it("moves to a gain that arrives mid-track smoothly, from the level heard so far", () => {
    pageAt("https://kikoto.example");
    const audio = element("https://kikoto.example/api/media/4/stream", false);
    unlockLoudnessGain(audio, true);
    routeLoudnessGain(audio, 0.25, options({ currentGain: 0.5, ramp: true }));
    const gain = FakeAudioContext.last?.gainNode.gain as FakeGainParam;
    expect(gain.ramps).toEqual([{ target: 0.25, timeConstant: expect.any(Number) }]);
    // A new track starts at its own level at once.
    routeLoudnessGain(audio, 2, options({ ramp: false }));
    expect(gain.ramps).toHaveLength(1);
    expect(gain.value).toBe(2);
  });

  it("resumes a context an audio interruption left interrupted once playback goes on", () => {
    pageAt("https://kikoto.example");
    const audio = element("https://kikoto.example/api/media/5/stream", false);
    unlockLoudnessGain(audio, true);
    routeLoudnessGain(audio, 2, options());
    const context = FakeAudioContext.last as FakeAudioContext;
    const resumed = context.resumed;
    // A call interrupts the context while the element keeps playing.
    context.state = "interrupted";
    context.emit("statechange");
    expect(context.resumed).toBe(resumed + 1);
    // Playback resumed from the lock screen after the element paused.
    context.state = "interrupted";
    audio.emit("playing");
    expect(context.resumed).toBe(resumed + 2);
  });

  it("never routes a cross-origin source, which Web Audio would silence", () => {
    pageAt("http://localhost");
    const audio = element("https://kikoto.example/api/media/1/stream");
    unlockLoudnessGain(audio, true);
    expect(routeLoudnessGain(audio, 2, options())).toBe(false);
    expect(FakeAudioContext.created).toBe(0);
  });
});
