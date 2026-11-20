import { describe, expect, it } from "vitest";

import { sourceCheckSettings } from "./sourcePresenceCheckModel";

const options = { sourceId: 8, library: "all", filter: "all", limit: 250 } as const;
const check = {
  startup: { enabled: true },
  schedule: { enabled: false, intervalMinutes: 360 },
};

describe("source presence checks in source settings", () => {
  it("saves one change together with the source's other settings", () => {
    expect(sourceCheckSettings(check, options, { schedule: true })).toEqual({
      options,
      startup: { enabled: true },
      schedule: { enabled: true, intervalMinutes: 360 },
    });
    expect(sourceCheckSettings(check, options, { startup: false, intervalMinutes: 1440 })).toEqual({
      options,
      startup: { enabled: false },
      schedule: { enabled: false, intervalMinutes: 1440 },
    });
  });
});
