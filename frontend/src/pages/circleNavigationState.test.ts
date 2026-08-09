import { describe, expect, it, vi } from "vitest";

import { isCircleListLocation, readLastCircleListLocation, writeLastCircleListLocation } from "./circleNavigationState";

describe("circle navigation state", () => {
  it("recognizes list locations without treating detail routes as list roots", () => {
    expect(isCircleListLocation("/circles")).toBe(true);
    expect(isCircleListLocation("/circles?q=example&page=2")).toBe(true);
    expect(isCircleListLocation("/circles/RG00000")).toBe(false);
    expect(isCircleListLocation("/library")).toBe(false);
  });

  it("scopes stored list locations and ignores non-list values", () => {
    const getItem = vi.fn().mockReturnValue("/circles?q=example&page=2");
    const setItem = vi.fn();
    vi.stubGlobal("window", { sessionStorage: { getItem, setItem } });

    expect(readLastCircleListLocation("server:user-1")).toBe("/circles?q=example&page=2");
    writeLastCircleListLocation("server:user-1", "/circles?filter=local");
    writeLastCircleListLocation("server:user-1", "/RJ00000000");

    expect(getItem).toHaveBeenCalledWith("kikoto:circle-list-location:v1:server:user-1");
    expect(setItem).toHaveBeenCalledOnce();
    expect(setItem).toHaveBeenCalledWith("kikoto:circle-list-location:v1:server:user-1", "/circles?filter=local");
    vi.unstubAllGlobals();
  });
});
