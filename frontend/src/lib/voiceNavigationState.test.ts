import { describe, expect, it, vi } from "vitest";

import {
  isVoiceListLocation,
  readLastVoiceListLocation,
  replaceVoiceRouteKey,
  writeLastVoiceListLocation,
} from "./voiceNavigationState";

describe("voice navigation state", () => {
  it("recognizes list locations without treating voice details as list roots", () => {
    expect(isVoiceListLocation("/voices")).toBe(true);
    expect(isVoiceListLocation("/voices?q=example&page=2")).toBe(true);
    expect(isVoiceListLocation("/voices/00000001")).toBe(false);
    expect(isVoiceListLocation("/favorites")).toBe(false);
  });

  it("scopes stored list locations and ignores non-list values", () => {
    const getItem = vi.fn().mockReturnValue("/voices?q=example&page=2");
    const setItem = vi.fn();
    vi.stubGlobal("window", { sessionStorage: { getItem, setItem } });

    expect(readLastVoiceListLocation("server:user-1")).toBe("/voices?q=example&page=2");
    writeLastVoiceListLocation("server:user-1", "/voices?filter=local");
    writeLastVoiceListLocation("server:user-1", "/voices/00000001");

    expect(getItem).toHaveBeenCalledWith("kikoto:voice-list-location:v1:server:user-1");
    expect(setItem).toHaveBeenCalledOnce();
    expect(setItem).toHaveBeenCalledWith("kikoto:voice-list-location:v1:server:user-1", "/voices?filter=local");
    vi.unstubAllGlobals();
  });

  it("replaces a non-canonical voice URL only while it is still open", () => {
    const replaceState = vi.fn();
    const dispatchEvent = vi.fn();
    const location = { pathname: "/voices/00000002", search: "?view=works", hash: "#top" };
    vi.stubGlobal("window", { location, history: { state: { returnTo: "/voices" }, replaceState }, dispatchEvent });

    replaceVoiceRouteKey("00000002", "00000001");
    expect(replaceState).toHaveBeenCalledWith({ returnTo: "/voices" }, "", "/voices/00000001?view=works#top");
    expect(dispatchEvent).toHaveBeenCalledOnce();

    location.pathname = "/voices/local-8";
    replaceVoiceRouteKey("00000002", "00000001");
    replaceVoiceRouteKey("local-8", "local-8");
    expect(replaceState).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});
