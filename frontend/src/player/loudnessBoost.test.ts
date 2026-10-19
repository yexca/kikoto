import { afterEach, describe, expect, it, vi } from "vitest";

import { routeLoudnessGain } from "./loudnessBoost";

class FakeEvents {
  listeners: Record<string, Array<() => void>> = {};
  addEventListener(type: string, listener: () => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  emit(type: string) {
    for (const listener of this.listeners[type] ?? []) listener();
  }
}

class FakeAudioContext extends FakeEvents {
  static created = 0;
  static last: FakeAudioContext | null = null;
  state = "suspended";
  resumed = 0;
  destination = {};
  gainNode = { gain: { value: 1 }, connect: () => this.destination };
  constructor() {
    super();
    FakeAudioContext.created += 1;
    FakeAudioContext.last = this;
  }
  resume() {
    this.resumed += 1;
    this.state = "running";
    return Promise.resolve();
  }
  createGain() {
    return this.gainNode;
  }
  createMediaElementSource() {
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

function pageAt(origin: string) {
  vi.stubGlobal("window", { location: { href: `${origin}/works/1`, origin }, AudioContext: FakeAudioContext });
}

describe("routeLoudnessGain", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeAudioContext.created = 0;
    FakeAudioContext.last = null;
  });

  it("routes a same-origin element only in full mode and only once a track needs a change", () => {
    pageAt("https://kikoto.example");
    const audio = element("https://kikoto.example/api/media/1/stream");
    expect(routeLoudnessGain(audio, 1, true)).toBe(false);
    expect(routeLoudnessGain(audio, 0.5, false)).toBe(false);
    expect(FakeAudioContext.created).toBe(0);
    expect(routeLoudnessGain(audio, 2, true)).toBe(true);
    // Once routed, the graph applies every later gain, cuts included.
    expect(routeLoudnessGain(audio, 0.5, false)).toBe(true);
    expect(FakeAudioContext.last?.gainNode.gain.value).toBe(0.5);
    expect(FakeAudioContext.created).toBe(1);
  });

  it("resumes a graph built while the track already plays, so it is not silenced", () => {
    pageAt("https://kikoto.example");
    routeLoudnessGain(element("https://kikoto.example/api/media/2/stream", false), 2, true);
    expect(FakeAudioContext.last?.resumed).toBe(1);
  });

  it("resumes a context an audio interruption left interrupted once playback goes on", () => {
    pageAt("https://kikoto.example");
    const audio = element("https://kikoto.example/api/media/3/stream", false);
    routeLoudnessGain(audio, 2, true);
    const context = FakeAudioContext.last as FakeAudioContext;
    // A call interrupts the context while the element keeps playing.
    context.state = "interrupted";
    context.emit("statechange");
    expect(context.resumed).toBe(2);
    // Playback resumed from the lock screen after the element paused.
    context.state = "interrupted";
    audio.emit("playing");
    expect(context.resumed).toBe(3);
  });

  it("never routes a cross-origin source, which Web Audio would silence", () => {
    pageAt("http://localhost");
    expect(routeLoudnessGain(element("https://kikoto.example/api/media/1/stream"), 2, true)).toBe(false);
    expect(FakeAudioContext.created).toBe(0);
  });
});
