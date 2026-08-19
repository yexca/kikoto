import { describe, expect, it } from "vitest";

import { formatCurrency, formatDateTime, formatList, formatNumber } from "./format";

describe("localized formatting helpers", () => {
  it("formats numbers, currency, and conjunction lists for the requested locale", () => {
    expect(formatNumber(1234567, "en")).toBe("1,234,567");
    expect(formatCurrency(1200, "JPY", "ja")).toContain("1,200");
    expect(formatList(["Example A", "Example B"], "en")).toBe("Example A and Example B");
  });

  it("returns an empty string for invalid dates and formats valid date inputs", () => {
    expect(formatDateTime("not-a-date", "en")).toBe("");
    expect(formatDateTime(new Date("2026-01-02T03:04:00Z"), "en")).not.toBe("");
    expect(formatDateTime(0, "en")).not.toBe("");
  });
});
