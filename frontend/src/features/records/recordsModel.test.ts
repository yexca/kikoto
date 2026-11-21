import { describe, expect, it } from "vitest";

import { formatPlaybackTime } from "./recordsModel";

describe("formatPlaybackTime", () => {
  it("formats minutes and hours", () => {
    expect(formatPlaybackTime(83)).toBe("1:23");
    expect(formatPlaybackTime(3_725)).toBe("1:02:05");
  });
});
