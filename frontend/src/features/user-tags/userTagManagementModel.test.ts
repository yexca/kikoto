import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mobileDiagnostics", () => ({ recordApiError: vi.fn() }));

import { ApiError } from "@/lib/api";

import {
  isDuplicateTagNameError,
  mergeTargetCandidates,
  pageAfterRemoval,
  validateTagRename,
} from "./userTagManagementModel";

const tag = { id: 1, name: "Example Tag", color: "", usageCount: 3 };

describe("personal tag management", () => {
  it("accepts 1 to 40 Unicode characters after trimming", () => {
    expect(validateTagRename("  Example Tag 2 ", tag)).toEqual({ ok: true, name: "Example Tag 2" });
    expect(validateTagRename("   ", tag)).toEqual({ ok: false, reason: "invalid" });
    // Astral characters count once each, matching the backend's rune limit.
    expect(validateTagRename("\u{1F3A7}".repeat(40), tag)).toEqual({ ok: true, name: "\u{1F3A7}".repeat(40) });
    expect(validateTagRename("x".repeat(41), tag)).toEqual({ ok: false, reason: "invalid" });
    expect(validateTagRename("Example Tag", tag)).toEqual({ ok: false, reason: "unchanged" });
  });

  it("recognizes the duplicate-name conflict separately from other failures", () => {
    expect(isDuplicateTagNameError(new ApiError("exists", 409, "conflict"))).toBe(true);
    expect(isDuplicateTagNameError(new ApiError("bad", 400))).toBe(false);
  });

  it("never offers the source tag as its own merge target", () => {
    const other = { ...tag, id: 2, name: "Example Tag 2" };
    expect(mergeTargetCandidates([tag, other], tag)).toEqual([other]);
  });

  it("moves back a page when the only row of a later page disappears", () => {
    expect(pageAfterRemoval(3, 1)).toBe(2);
    expect(pageAfterRemoval(3, 2)).toBe(3);
    expect(pageAfterRemoval(1, 1)).toBe(1);
  });
});
