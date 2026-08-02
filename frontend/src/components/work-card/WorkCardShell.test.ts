import { describe, expect, it } from "vitest";

import { visibleBadgeCountForRows } from "./tagLayout";

describe("work card tag measurement", () => {
  it("keeps every tag when two rows fit at a common desktop card width", () => {
    expect(visibleBadgeCountForRows([58, 72, 64, 76], 240, 42)).toBe(4);
  });

  it("reserves the overflow badge inside two rows at a common mobile card width", () => {
    expect(visibleBadgeCountForRows([76, 84, 68, 92, 64], 176, 38)).toBe(3);
  });

  it("clamps an oversized tag to one row without hiding tags that fit on the second", () => {
    expect(visibleBadgeCountForRows([320, 68, 68], 176, 38)).toBe(3);
  });
});
