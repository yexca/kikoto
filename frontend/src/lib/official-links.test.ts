import { describe, expect, it } from "vitest";

import { DLSITE_ENDPOINTS, KIKOTO_GITHUB_ENDPOINTS } from "./official-links";

describe("official links", () => {
  it("keeps DLsite link generation on the built-in public origin", () => {
    const work = new URL(DLSITE_ENDPOINTS.workURL("maniax", "RJ00000000"));
    const maker = new URL(DLSITE_ENDPOINTS.makerURL("pro", "VG00000001"));

    expect(Object.isFrozen(DLSITE_ENDPOINTS)).toBe(true);
    expect(work.hostname).toBe("www.dlsite.com");
    expect(work.pathname).toBe("/maniax/work/=/product_id/RJ00000000.html");
    expect(maker.pathname).toBe("/pro/circle/profile/=/maker_id/VG00000001.html");
  });

  it("keeps project repository links on the built-in public origin", () => {
    const repository = new URL(KIKOTO_GITHUB_ENDPOINTS.repositoryURL);
    const license = new URL(KIKOTO_GITHUB_ENDPOINTS.licenseURL);

    expect(Object.isFrozen(KIKOTO_GITHUB_ENDPOINTS)).toBe(true);
    expect(repository.hostname).toBe("github.com");
    expect(license.pathname).toBe("/yexca/kikoto/blob/main/LICENSE");
  });
});
