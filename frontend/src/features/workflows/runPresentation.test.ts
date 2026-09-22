import { describe, expect, it } from "vitest";

import {
  appendTransferSample,
  formatDuration,
  hasTransferProgress,
  parseWorkflowTimestamp,
  runDurationMs,
  transferProgress,
  transferRate,
} from "./runPresentation";

describe("workflow run timestamps", () => {
  it("reads zoneless database timestamps as UTC", () => {
    expect(parseWorkflowTimestamp("2026-09-22 10:44:12")?.toISOString()).toBe("2026-09-22T10:44:12.000Z");
    expect(parseWorkflowTimestamp("2026-09-22T10:44:12+09:00")?.toISOString()).toBe("2026-09-22T01:44:12.000Z");
    expect(parseWorkflowTimestamp("")).toBeNull();
    expect(parseWorkflowTimestamp("not a time")).toBeNull();
  });

  it("measures finished runs between endpoints and active runs against now", () => {
    const now = Date.parse("2026-09-22T10:50:00Z");
    expect(
      runDurationMs({ status: "succeeded", startedAt: "2026-09-22 10:44:12", finishedAt: "2026-09-22 10:46:14" }, now),
    ).toBe(122_000);
    expect(runDurationMs({ status: "running", startedAt: "2026-09-22 10:49:00", finishedAt: "" }, now)).toBe(60_000);
    expect(runDurationMs({ status: "failed", startedAt: "2026-09-22 10:49:00", finishedAt: "" }, now)).toBeNull();
    expect(runDurationMs({ status: "queued", startedAt: "", finishedAt: "" }, now)).toBeNull();
  });

  it("formats durations with at most two units", () => {
    expect(formatDuration(4_400, "en")).toBe("4s");
    expect(formatDuration(95_000, "en")).toBe("1m 35s");
    expect(formatDuration(3_600_000 + 125_000, "en")).toBe("1h 2m");
  });
});

describe("Fetch transfer progress", () => {
  it("keeps unknown-size transfers indeterminate", () => {
    expect(
      transferProgress({ progressBytesCurrent: 50, progressBytesTotal: 100, progressBytesUnknownItems: 1 }),
    ).toMatchObject({ determinate: false, percent: 0 });
    expect(
      transferProgress({ progressBytesCurrent: 50, progressBytesTotal: 100, progressBytesUnknownItems: 0 }),
    ).toMatchObject({ determinate: true, percent: 50 });
  });

  it("applies only to Fetch runs that are active or have transferred bytes", () => {
    const fetch = {
      workflowCode: "remote_work_fetch",
      status: "succeeded",
      progressBytesCurrent: 0,
      progressBytesTotal: 0,
      progressBytesUnknownItems: 0,
    };
    expect(hasTransferProgress(fetch)).toBe(false);
    expect(hasTransferProgress({ ...fetch, status: "running" })).toBe(true);
    expect(hasTransferProgress({ ...fetch, progressBytesCurrent: 1 })).toBe(true);
    expect(hasTransferProgress({ ...fetch, workflowCode: "metadata_sync", status: "running" })).toBe(false);
  });

  it("derives a rate only from observed counter changes", () => {
    let samples = appendTransferSample([], { at: 0, bytes: 0 });
    samples = appendTransferSample(samples, { at: 1_000, bytes: 0 });
    expect(samples).toHaveLength(1);
    expect(transferRate(samples)).toBeNull();
    samples = appendTransferSample(samples, { at: 2_000, bytes: 4_000 });
    expect(transferRate(samples)).toBe(2_000);
  });

  it("restarts sampling when a retried transfer resets the counter", () => {
    let samples = appendTransferSample([], { at: 0, bytes: 0 });
    samples = appendTransferSample(samples, { at: 2_000, bytes: 8_000 });
    samples = appendTransferSample(samples, { at: 3_000, bytes: 1_000 });
    expect(samples).toEqual([{ at: 3_000, bytes: 1_000 }]);
    expect(transferRate(samples)).toBeNull();
  });

  it("forgets samples older than the rate window", () => {
    let samples = appendTransferSample([], { at: 0, bytes: 0 });
    samples = appendTransferSample(samples, { at: 1_000, bytes: 100_000 });
    samples = appendTransferSample(samples, { at: 20_000, bytes: 110_000 });
    samples = appendTransferSample(samples, { at: 22_000, bytes: 130_000 });
    expect(samples[0].at).toBe(20_000);
    expect(transferRate(samples)).toBe(10_000);
  });
});
