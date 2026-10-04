import { describe, expect, it } from "vitest";

import { formatDateTime } from "@/i18n/format";

import { parseServerTimestamp } from "./serverTimestamp";

describe("server timestamps", () => {
  it("reads zone-less SQLite timestamps as UTC", () => {
    expect(parseServerTimestamp("2026-01-02 19:04:05")?.toISOString()).toBe("2026-01-02T19:04:05.000Z");
    expect(parseServerTimestamp("2026-01-02T19:04")?.toISOString()).toBe("2026-01-02T19:04:00.000Z");
  });

  it("respects an explicit zone and rejects empty or invalid values", () => {
    expect(parseServerTimestamp("2026-01-02T19:04:05+09:00")?.toISOString()).toBe("2026-01-02T10:04:05.000Z");
    expect(parseServerTimestamp("")).toBeNull();
    expect(parseServerTimestamp("not a date")).toBeNull();
  });

  it("formats zone-less server values in the viewer's zone, not as local wall time", () => {
    expect(formatDateTime("2026-01-02 19:04:05", "en")).toBe(formatDateTime(new Date("2026-01-02T19:04:05Z"), "en"));
  });
});
