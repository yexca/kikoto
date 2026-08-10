import { describe, expect, it, vi } from "vitest";

import { isVoiceListLocation, readLastVoiceListLocation, writeLastVoiceListLocation } from "./voiceNavigationState";

describe("voice navigation state", () => {
  it("recognizes list locations without treating voice details as list roots", () => {
    expect(isVoiceListLocation("/voices")).toBe(true);
    expect(isVoiceListLocation("/voices?q=example&page=2")).toBe(true);
    expect(isVoiceListLocation("/voices/7")).toBe(false);
    expect(isVoiceListLocation("/favorites")).toBe(false);
  });

  it("scopes stored list locations and ignores non-list values", () => {
    const getItem = vi.fn().mockReturnValue("/voices?q=example&page=2");
    const setItem = vi.fn();
    vi.stubGlobal("window", { sessionStorage: { getItem, setItem } });

    expect(readLastVoiceListLocation("server:user-1")).toBe("/voices?q=example&page=2");
    writeLastVoiceListLocation("server:user-1", "/voices?filter=local");
    writeLastVoiceListLocation("server:user-1", "/voices/7");

    expect(getItem).toHaveBeenCalledWith("kikoto:voice-list-location:v1:server:user-1");
    expect(setItem).toHaveBeenCalledOnce();
    expect(setItem).toHaveBeenCalledWith("kikoto:voice-list-location:v1:server:user-1", "/voices?filter=local");
    vi.unstubAllGlobals();
  });
});
