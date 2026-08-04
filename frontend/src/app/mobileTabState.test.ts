import { describe, expect, it } from "vitest";

import { mobileTabSnapshotFromValue } from "./mobileTabState";

describe("mobile tab state", () => {
  it("keeps an internal detail route with restorable history state", () => {
    expect(
      mobileTabSnapshotFromValue(
        {
          page: "library",
          location: "/RJ00000000?view=tracked",
          state: { returnTo: "/?q=voice", workPreview: { primaryCode: "RJ00000000" } },
          scrollY: 320,
        },
        "library",
      ),
    ).toEqual({
      page: "library",
      location: "/RJ00000000?view=tracked",
      state: { returnTo: "/?q=voice", workPreview: { primaryCode: "RJ00000000" } },
      scrollY: 320,
    });
  });

  it("rejects another page, an external URL, or an invalid scroll position", () => {
    expect(
      mobileTabSnapshotFromValue({ page: "voice-actors", location: "/voices/7", state: {}, scrollY: 0 }, "library"),
    ).toBeNull();
    expect(
      mobileTabSnapshotFromValue(
        { page: "library", location: "https://example.invalid/RJ00000000", state: {}, scrollY: 0 },
        "library",
      ),
    ).toBeNull();
    expect(
      mobileTabSnapshotFromValue({ page: "library", location: "/RJ00000000", state: {}, scrollY: -1 }, "library"),
    ).toBeNull();
  });
});
