import { beforeEach, expect, it, vi } from "vitest";
import type { WorkDetail } from "@/lib/api";
import { syntheticWorkCode } from "@/test-support/workCode";

const mocks = vi.hoisted(() => ({ summary: vi.fn(), media: vi.fn(), cache: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { getWorkSummary: mocks.summary, getWorkMedia: mocks.media } }));
vi.mock("./media/workMediaCache", () => ({ getCachedWorkMedia: () => null, setCachedWorkMedia: mocks.cache }));
import { loadWorkDetailStages } from "./loadWorkDetailStages";

const summary = {
  id: 1,
  primaryCode: syntheticWorkCode("RJ", 0),
  baseCode: "",
  mediaItems: [],
} as unknown as WorkDetail;
beforeEach(() => vi.resetAllMocks());

it("starts a code directory alongside summary and keeps summary when the directory fails", async () => {
  let finish!: (value: WorkDetail) => void;
  mocks.summary.mockReturnValue(new Promise<WorkDetail>((resolve) => (finish = resolve)));
  const failure = new Error("directory unavailable");
  mocks.media.mockRejectedValue(failure);
  const rendered = vi.fn();
  const directoryError = vi.fn();
  const pending = loadWorkDetailStages(
    summary.primaryCode,
    1,
    new AbortController().signal,
    rendered,
    vi.fn(),
    directoryError,
  );
  expect(mocks.media).toHaveBeenCalledWith(summary.primaryCode, expect.any(AbortSignal));
  finish(summary);
  await pending;
  expect(rendered).toHaveBeenCalledWith(summary);
  expect(directoryError).toHaveBeenCalledWith(failure);
});

it("re-reads the rendered identity once when an alias changes between concurrent reads", async () => {
  mocks.summary.mockResolvedValue(summary);
  const stale = [{}];
  const current: WorkDetail["mediaItems"] = [];
  mocks.media
    .mockResolvedValueOnce({ workId: 2, mediaItems: stale })
    .mockResolvedValueOnce({ workId: 1, mediaItems: current });
  const rendered = vi.fn();
  await loadWorkDetailStages(summary.primaryCode, 1, new AbortController().signal, vi.fn(), rendered, vi.fn());
  expect(mocks.media).toHaveBeenCalledTimes(2);
  expect(mocks.media).toHaveBeenLastCalledWith(1, expect.any(AbortSignal));
  expect(rendered).toHaveBeenCalledWith(current);
  expect(mocks.cache).toHaveBeenCalledWith(1, 1, current);
});

it("cancels the directory and discards late summary after navigating away", async () => {
  let finish!: (value: WorkDetail) => void;
  mocks.summary.mockReturnValue(new Promise<WorkDetail>((resolve) => (finish = resolve)));
  mocks.media.mockResolvedValue({ workId: 1, mediaItems: [] });
  const controller = new AbortController();
  const rendered = vi.fn();
  const pending = loadWorkDetailStages(summary.primaryCode, 1, controller.signal, rendered, rendered, rendered);
  const directorySignal = mocks.media.mock.calls[0][1] as AbortSignal;
  controller.abort();
  finish(summary);
  await pending;
  expect(directorySignal.aborted).toBe(true);
  expect(rendered).not.toHaveBeenCalled();
  expect(mocks.cache).not.toHaveBeenCalled();
});
