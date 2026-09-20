import { describe, expect, it } from "vitest";
import { metadataIssuesURL, metadataSyncResultURL } from "./metadataMaintenance";

describe("metadata recovery destinations", () => {
  it("opens pending issues at the canonical route with a valid run filter", () => {
    expect(metadataIssuesURL(42)).toBe("/metadata?reason=metadata&metadataRun=42");
    for (const invalid of [0, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(metadataIssuesURL(invalid)).toBe("/metadata?reason=metadata");
    }
  });
  it("omits protected run filters for operators without workflow access", () => {
    expect(metadataSyncResultURL(42, true, false)).toBe("/metadata?reason=metadata");
    expect(metadataSyncResultURL(42, true, true)).toBe("/metadata?reason=metadata&metadataRun=42");
  });
  it("keeps successful and running results in their workflow when accessible", () => {
    expect(metadataSyncResultURL(42, false, true)).toBe("/workflows?workflow=metadata_sync&activity=1&run=42");
    expect(metadataSyncResultURL(42, false, false)).toBe("/metadata");
    expect(metadataSyncResultURL(0, false, true)).toBe("/metadata");
  });
});
