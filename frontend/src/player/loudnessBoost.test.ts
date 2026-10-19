import { afterEach, describe, expect, it, vi } from "vitest";

import { routeLoudnessGain } from "./loudnessBoost";

class FakeAudioContext {
  static created = 0;
  static last: FakeAudioContext | null = null;
  state = "suspended";
  resumed = 0;
  destination = {};
  gainNode = { gain: { value: 1 }, connect: () => this.destination };
  constructor() {
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
  return { currentSrc: source, paused, getAttribute: () => source } as unknown as HTMLMediaElement;
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

  it("never routes a cross-origin source, which Web Audio would silence", () => {
    pageAt("http://localhost");
    expect(routeLoudnessGain(element("https://kikoto.example/api/media/1/stream"), 2, true)).toBe(false);
    expect(FakeAudioContext.created).toBe(0);
  });
});
