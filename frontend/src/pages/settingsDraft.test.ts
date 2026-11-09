import { describe, expect, it } from "vitest";

import { draftAfterSave, sectionSettings } from "./settingsDraft";

describe("settings saves", () => {
  const saved = { localScanDepth: 2, cacheLimitGb: 50, transcodeCacheLimitGb: 5, cacheEnabled: true };

  it("sends the changed fields and no others", () => {
    const draft = { ...saved, cacheLimitGb: 80, localScanDepth: 4 };

    expect(sectionSettings(draft, ["cacheLimitGb", "transcodeCacheLimitGb", "cacheEnabled"])).toEqual({
      cacheLimitGb: 80,
      transcodeCacheLimitGb: 5,
      cacheEnabled: true,
    });
    expect(sectionSettings(draft, ["localScanDepth"])).toEqual({ localScanDepth: 4 });
  });

  it("takes the server's value for the saved field and keeps a field still being typed", () => {
    const draft = { ...saved, cacheLimitGb: 80, localScanDepth: 4 };
    const fromServer = { ...saved, cacheLimitGb: 64 };

    expect(draftAfterSave(draft, fromServer, ["cacheLimitGb"])).toEqual({
      ...saved,
      cacheLimitGb: 64,
      localScanDepth: 4,
    });
  });

  it("returns a failed field to its saved value", () => {
    const draft = { ...saved, cacheEnabled: false };

    expect(draftAfterSave(draft, saved, ["cacheEnabled"])).toEqual(saved);
  });
});
