import { describe, expect, it } from "vitest";

import { voiceDetailPath, voiceRouteKeyFromPath } from "./voiceRoute";

describe("voice route keys", () => {
  it("reads a DLsite id or a local person key from a detail path", () => {
    expect(voiceRouteKeyFromPath("/voices/00000001")).toBe("00000001");
    expect(voiceRouteKeyFromPath("/voices/local-7/")).toBe("local-7");
    for (const path of [
      "/voices",
      "/voices/local-",
      "/voices/local-07",
      "/voices/LOCAL-7",
      "/voices/7/works",
      "/voices/Example",
    ]) {
      expect(voiceRouteKeyFromPath(path)).toBeNull();
    }
  });

  it("links only a route key the server reported", () => {
    expect(voiceDetailPath("00000001")).toBe("/voices/00000001");
    expect(voiceDetailPath("local-7")).toBe("/voices/local-7");
    expect(voiceDetailPath("")).toBeNull();
    expect(voiceDetailPath(undefined)).toBeNull();
    expect(voiceDetailPath("../settings")).toBeNull();
  });
});
