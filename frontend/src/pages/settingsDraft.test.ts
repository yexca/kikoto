import { describe, expect, it } from "vitest";

import { draftAfterSectionSave, sectionSettings } from "./settingsDraft";

describe("settings sections", () => {
  const saved = { localScanDepth: 2, cacheLimitGb: 50, transcodeCacheLimitGb: 5, cacheEnabled: true };

  it("sends the saved section's own fields and no other section's", () => {
    const draft = { ...saved, cacheLimitGb: 80, localScanDepth: 4 };

    expect(sectionSettings(draft, ["cacheLimitGb", "transcodeCacheLimitGb", "cacheEnabled"])).toEqual({
      cacheLimitGb: 80,
      transcodeCacheLimitGb: 5,
      cacheEnabled: true,
    });
    expect(sectionSettings(draft, ["localScanDepth"])).toEqual({ localScanDepth: 4 });
  });

  it("keeps edits pending in other sections after a save", () => {
    const draft = { ...saved, cacheLimitGb: 80, localScanDepth: 4 };
    const fromServer = { ...saved, cacheLimitGb: 80 };

    expect(draftAfterSectionSave(fromServer, draft, saved, ["cacheLimitGb", "transcodeCacheLimitGb"])).toEqual({
      ...fromServer,
      localScanDepth: 4,
    });
  });

  it("takes the server's value for the saved section and for untouched fields", () => {
    const draft = { ...saved, cacheLimitGb: 80 };
    const fromServer = { ...saved, cacheLimitGb: 64, transcodeCacheLimitGb: 6 };

    expect(draftAfterSectionSave(fromServer, draft, saved, ["cacheLimitGb"])).toEqual(fromServer);
  });
});
