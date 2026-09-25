import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mobileDiagnostics", () => ({ recordApiError: vi.fn() }));

import { ApiError } from "@/lib/api";
import { fetchDestinationCode } from "@/lib/fetchDestination";

describe("Fetch destination errors", () => {
  it("recognizes the library settings a Fetch is waiting for", () => {
    expect(fetchDestinationCode(new ApiError("pool", 409, "fetch_pool_required"))).toBe("fetch_pool_required");
    expect(fetchDestinationCode(new ApiError("offline", 409, "library_offline"))).toBe("library_offline");
  });

  it("leaves plan conflicts and other failures to the regular Fetch messages", () => {
    expect(fetchDestinationCode(new ApiError("conflict", 409, ""))).toBeNull();
    expect(fetchDestinationCode(new ApiError("pool", 500, "fetch_pool_required"))).toBeNull();
    expect(fetchDestinationCode(new Error("network"))).toBeNull();
  });
});
