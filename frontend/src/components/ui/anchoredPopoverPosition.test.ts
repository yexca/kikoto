import { describe, expect, it } from "vitest";

import { popoverLeft } from "./anchoredPopoverPosition";

// A 1000px viewport with 12px padding; the popover is 200px wide.
const viewport = { viewportLeft: 0, viewportWidth: 1000, collisionPadding: 12, contentWidth: 200 };

describe("popover horizontal placement", () => {
  it("lines up with the anchor's left edge when it fits", () => {
    expect(popoverLeft({ ...viewport, align: "start", anchorLeft: 300, anchorRight: 340 })).toBe(300);
  });

  it("switches to the anchor's right edge instead of running off the right side", () => {
    expect(popoverLeft({ ...viewport, align: "start", anchorLeft: 900, anchorRight: 940 })).toBe(740);
  });

  it("switches to the anchor's left edge instead of running off the left side", () => {
    expect(popoverLeft({ ...viewport, align: "end", anchorLeft: 20, anchorRight: 60 })).toBe(20);
  });

  it("stays inside the viewport when neither edge fits", () => {
    const narrow = { ...viewport, viewportWidth: 240 };
    expect(popoverLeft({ ...narrow, align: "start", anchorLeft: 100, anchorRight: 140 })).toBe(28);
  });
});
