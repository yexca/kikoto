import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as typeof globalThis & { __APP_VERSION__: string }).__APP_VERSION__ = "test";
});

import { ApiError } from "@/lib/api";

import { workLoadFailure } from "./workLoadFailure";

describe("workLoadFailure", () => {
  it("treats an unknown work and a rejected address as a definite miss", () => {
    expect(workLoadFailure(new ApiError("work not found", 404))).toBe("not_found");
    expect(workLoadFailure(new ApiError("invalid work id", 400))).toBe("not_found");
  });

  it("keeps server and network failures retryable instead of reporting a miss", () => {
    expect(workLoadFailure(new ApiError("database is busy", 503, "database_busy", true))).toBe("failed");
    expect(workLoadFailure(new ApiError("internal server error", 500))).toBe("failed");
    expect(workLoadFailure(new TypeError("Failed to fetch"))).toBe("failed");
  });
});
