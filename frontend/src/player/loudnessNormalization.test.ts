import { describe, expect, it } from "vitest";

import { LOUDNESS_TARGET_LUFS, loudnessGain, normalizeLoudnessMode } from "./loudnessNormalization";
import { applyElementVolume } from "./usePlaybackEngine";

const decibels = (gain: number) => Math.round(20 * Math.log10(gain) * 10) / 10;

describe("loudnessGain", () => {
  const loud = { integratedLufs: -10, peakDbfs: -0.2, peakKind: "true" as const };
  const quiet = { integratedLufs: -30, peakDbfs: -14, peakKind: "true" as const };

  it("changes nothing while normalization is off or a track is not measured", () => {
    expect(loudnessGain(loud, "off")).toBe(1);
    expect(loudnessGain(undefined, "full")).toBe(1);
  });

  it("turns a loud track down to the target in both modes", () => {
    expect(decibels(loudnessGain(loud, "attenuate"))).toBe(LOUDNESS_TARGET_LUFS - loud.integratedLufs);
    expect(loudnessGain(loud, "full")).toBe(loudnessGain(loud, "attenuate"));
  });

  it("raises a quiet track only in full mode, and never past its measured peak", () => {
    expect(loudnessGain(quiet, "attenuate")).toBe(1);
    // 12 dB would bring it to the target; the -14 dBFS peak allows 13 dB with 1 dB of headroom.
    expect(decibels(loudnessGain(quiet, "full"))).toBe(12);
    expect(decibels(loudnessGain({ ...quiet, peakDbfs: -4 }, "full"))).toBe(3);
    expect(loudnessGain({ ...quiet, peakDbfs: -0.5 }, "full")).toBe(1);
  });

  it("bounds a cut for a measurement of near silence", () => {
    expect(decibels(loudnessGain({ integratedLufs: 20, peakDbfs: 0, peakKind: "sample" }, "attenuate"))).toBe(-24);
  });
});

describe("loudness preference", () => {
  it("falls back to off for an unknown stored value", () => {
    expect(normalizeLoudnessMode("full")).toBe("full");
    expect(normalizeLoudnessMode("louder")).toBe("off");
    expect(normalizeLoudnessMode(null)).toBe("off");
  });
});

describe("applyElementVolume", () => {
  it("combines the sleep fade with the loudness cut", () => {
    const audio = { volume: 1 } as HTMLAudioElement;
    const refs = { audioRef: { current: audio }, sleepFadeRef: { current: 0.5 }, loudnessVolumeRef: { current: 0.4 } };
    applyElementVolume(refs);
    expect(audio.volume).toBeCloseTo(0.2);
    refs.loudnessVolumeRef.current = 2;
    refs.sleepFadeRef.current = 1;
    applyElementVolume(refs);
    expect(audio.volume).toBe(1);
  });
});
