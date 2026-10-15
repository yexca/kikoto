import { describe, expect, it } from "vitest";

import { serviceReceives } from "@/features/work-detail/lyrics/contentRatingModel";

const external = { boundary: "external", allowSensitive: false };
const privateOnly = { boundary: "private", allowSensitive: false };
const privateSensitive = { boundary: "private", allowSensitive: true };

describe("serviceReceives", () => {
  it("sends safe content to every service", () => {
    for (const service of [external, privateOnly, privateSensitive])
      expect(serviceReceives("safe", service)).toBe(true);
  });

  it("sends sensitive content only to a private service allowed to receive it", () => {
    expect(serviceReceives("sensitive", external)).toBe(false);
    expect(serviceReceives("sensitive", privateOnly)).toBe(false);
    expect(serviceReceives("sensitive", { boundary: "external", allowSensitive: true })).toBe(false);
    expect(serviceReceives("sensitive", privateSensitive)).toBe(true);
  });

  it("sends unknown and blocked content nowhere", () => {
    expect(serviceReceives("unknown", privateSensitive)).toBe(false);
    expect(serviceReceives("blocked", privateSensitive)).toBe(false);
  });
});
