import { describe, expect, it } from "vitest";

import { clampImageZoom, imageClickZoom, maxImageZoom, wheelZoomFactor } from "./imageZoomModel";

describe("image zoom model", () => {
  it("returns to fit at or below the fitted scale and stops at the largest scale", () => {
    expect(clampImageZoom(0.4, 0.5)).toBe("fit");
    expect(clampImageZoom(0.5, 0.5)).toBe("fit");
    expect(clampImageZoom(Number.NaN, 0.5)).toBe("fit");
    expect(clampImageZoom(1.5, 0.5)).toBe(1.5);
    expect(clampImageZoom(40, 0.5)).toBe(maxImageZoom);
  });

  it("zooms a click to actual size, or past it for an image that already fits", () => {
    expect(imageClickZoom(0.25)).toBe(1);
    expect(imageClickZoom(1)).toBe(2);
  });

  it("zooms in for wheel up and out for wheel down by the same amount", () => {
    const zoomIn = wheelZoomFactor(-100, 0, false);
    const zoomOut = wheelZoomFactor(100, 0, false);
    expect(zoomIn).toBeGreaterThan(1);
    expect(zoomIn * zoomOut).toBeCloseTo(1);
    // Line-based wheels and oversized deltas zoom no faster than one pixel-based notch.
    expect(wheelZoomFactor(-10, 1, false)).toBeCloseTo(zoomIn);
    expect(wheelZoomFactor(-1000, 0, false)).toBeCloseTo(zoomIn);
    // A small trackpad pinch still zooms noticeably.
    expect(wheelZoomFactor(-10, 0, true)).toBeGreaterThan(wheelZoomFactor(-10, 0, false));
  });
});
