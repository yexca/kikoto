import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mobileDiagnostics", () => ({ recordApiError: vi.fn() }));

import { ApiError } from "@/lib/api";
import { fetchDestinationCode, fetchSubmissionFailure } from "@/lib/fetchDestination";

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

describe("Fetch submission failures", () => {
  it("reports a refusal as a Fetch that did not start", () => {
    expect(fetchSubmissionFailure(new ApiError("too large", 422, "download_limit_exceeded"))).toBe("rejected");
    expect(fetchSubmissionFailure(new ApiError("no space", 422, "insufficient_disk_space"))).toBe("rejected");
    expect(fetchSubmissionFailure(new ApiError("bad folder", 400, "invalid_request"))).toBe("rejected");
    expect(fetchSubmissionFailure(new ApiError("gone", 404, "not_found"))).toBe("rejected");
    expect(fetchSubmissionFailure(new ApiError("disabled", 409, "source_not_usable"))).toBe("rejected");
  });

  it("asks for a new plan only when the reviewed plan conflicts", () => {
    expect(fetchSubmissionFailure(new ApiError("conflict", 409, "conflict"))).toBe("plan_changed");
  });

  it("keeps a missing or failed answer unconfirmed", () => {
    expect(fetchSubmissionFailure(new ApiError("upstream", 502, "upstream_unavailable", true))).toBe("unconfirmed");
    expect(fetchSubmissionFailure(new ApiError("busy", 503, "database_busy", true))).toBe("unconfirmed");
    expect(fetchSubmissionFailure(new TypeError("Failed to fetch"))).toBe("unconfirmed");
    expect(fetchSubmissionFailure(new ApiError("login", 401, "authentication_required"))).toBe("sign_in");
  });
});
