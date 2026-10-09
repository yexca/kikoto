import { describe, expect, it } from "vitest";
import type { DatedListeningReport, PlaybackReport, PlaybackReportResult, ReportStatus } from "@/lib/playbackReportApi";
import {
  emptyOutbox,
  MAX_OUTBOX_HISTORY,
  MAX_OUTBOX_PROGRESS,
  type ReportOutbox,
  type ReportOutboxState,
} from "./playbackReportOutbox";
import { PlaybackReportScheduler, REPORT_RETRY_MAX_MS } from "./playbackReportScheduler";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const date = Date.parse("2026-01-02T00:00:00Z");
const history = (seconds: number, sessionId = "synthetic-session-a", generation = 0): DatedListeningReport => ({
  sessionId,
  workId: 1,
  generation,
  listenedSeconds: seconds,
  startedAt: "2026-01-01T23:59:00Z",
  lastListenedAt: "2026-01-01T23:59:50Z",
  days: [{ day: "2026-01-01", listenedSeconds: seconds }],
});
function memoryOutbox() {
  let state = emptyOutbox();
  const outbox: ReportOutbox = {
    async mutate(change) {
      change(state);
      return structuredClone(state);
    },
  };
  return {
    outbox,
    read: () => structuredClone(state),
    seed: (s: ReportOutboxState) => {
      state = s;
    },
  };
}
const ack = (report: PlaybackReport, generation = 0): PlaybackReportResult => ({
  generation,
  history: report.history.map((r) => ({ sessionId: r.sessionId, status: "recorded" })),
  progress: report.progress.map((r) => ({ reportId: r.reportId, status: "recorded" })),
});

async function harness(store = memoryOutbox()) {
  let now = date,
    id = 0;
  let current = true,
    generation = 0;
  const requests: { report: PlaybackReport; signal: AbortSignal; keepalive: boolean }[] = [];
  const cursors: NonNullable<PlaybackReportResult["progress"][number]["cursor"]>[] = [];
  let transport: (report: PlaybackReport) => Promise<PlaybackReportResult> = (r) => Promise.resolve(ack(r, generation));
  const scheduler = new PlaybackReportScheduler({
    outbox: store.outbox,
    now: () => now,
    createId: () => `synthetic-report-${++id}`,
    isCurrent: () => current,
    fetchGeneration: async () => generation,
    isPermanentFailure: (e) => e === "permanent",
    onCursor: (cursor) => cursors.push(cursor),
    warn: () => {},
    send: (report, signal, keepalive) => {
      requests.push({ report, signal, keepalive });
      return transport(report);
    },
  });
  await scheduler.initialize();
  await settle();
  const progress = (position: number, workId = 1) =>
    scheduler.stageProgress(workId, {
      mediaItemId: workId,
      locationId: workId,
      positionSeconds: position,
      durationSeconds: 600,
      completed: false,
    });
  const tick = async (elapsed: number) => {
    now = date + elapsed;
    scheduler.tick();
    await settle();
  };
  return {
    scheduler,
    requests,
    cursors,
    store,
    progress,
    tick,
    transport: (send: typeof transport) => {
      transport = send;
    },
    generation: (value: number) => {
      generation = value;
    },
    current: (value: boolean) => {
      current = value;
    },
  };
}

describe("unified playback reports", () => {
  const cursorAck = (
    report: PlaybackReport,
    workId: number,
    mediaWorkId: number,
    editionWorkIds = [...new Set([workId, mediaWorkId])],
  ): PlaybackReportResult => ({
    ...ack(report),
    progress: report.progress.map((r) => ({
      reportId: r.reportId,
      status: "recorded",
      identity: { workId, editionWorkIds },
      cursor: {
        workId,
        mediaWorkId,
        mediaItemId: r.mediaItemId,
        fileSourceId: 1,
        locationId: r.locationId,
        locationType: "local",
        positionSeconds: r.positionSeconds,
        durationSeconds: r.durationSeconds,
        completed: r.completed,
        lastPlayedAt: "2026-01-02 00:00:00",
      },
    })),
  });

  it.each([
    ["ordinary work", 1, 1],
    ["translation", 2, 2],
    ["translation to original", 2, 1],
    ["original to translation", 1, 2],
    ["translation to another translation", 2, 3],
  ])("never publishes an older cursor over a newer local checkpoint: %s", async (_name, before, after) => {
    const h = await harness();
    let resolve!: (value: PlaybackReportResult) => void;
    h.transport(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    h.progress(120, before);
    await h.tick(30_000);
    h.progress(20, after);
    await settle();
    resolve(cursorAck(h.requests[0].report, 1, before, [1, 2, 3]));
    await settle();
    expect(h.cursors).toEqual([]);
    expect(h.store.read().progress).toHaveLength(1);
    expect(h.store.read().progress[0]).toMatchObject({ workId: after, report: { positionSeconds: 20 } });
    h.transport((r) => Promise.resolve(cursorAck(r, 1, after)));
    await h.tick(60_000);
    expect(h.cursors).toHaveLength(1);
    expect(h.cursors[0]).toMatchObject({ workId: 1, mediaWorkId: after, positionSeconds: 20 });
    expect(h.store.read().progress).toEqual([]);
  });

  it("does not guess that an unresolved edition belongs to another work", async () => {
    const h = await harness();
    let resolve!: (value: PlaybackReportResult) => void;
    h.transport(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    h.progress(120, 1);
    await h.tick(30_000);
    h.progress(20, 2);
    await settle();
    resolve(cursorAck(h.requests[0].report, 1, 1));
    await settle();
    h.transport((r) => Promise.resolve(cursorAck(r, 2, 2)));
    await h.tick(60_000);
    expect(h.cursors.map((c) => [c.workId, c.positionSeconds])).toEqual([
      [1, 120],
      [2, 20],
    ]);
  });

  it.each([2, 3])("does not revive an older cursor if a newer edition %i report is stale", async (edition) => {
    const h = await harness();
    let resolve!: (value: PlaybackReportResult) => void;
    h.transport(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    h.progress(120, 2);
    await h.tick(30_000);
    h.progress(20, edition);
    await settle();
    resolve(cursorAck(h.requests[0].report, 1, 2, [1, 2, 3]));
    await settle();
    h.transport((r) =>
      Promise.resolve({
        ...ack(r),
        progress: r.progress.map((p) => ({
          reportId: p.reportId,
          status: "stale",
          identity: { workId: 1, editionWorkIds: [1, 2, 3] },
        })),
      }),
    );
    await h.tick(60_000);
    expect(h.store.read().progress).toEqual([]);
    expect(h.cursors).toEqual([]);
  });

  const rejectedStatuses: ReportStatus[] = ["stale", "not_found", "invalid", "conflict", "history_cleared"];
  it.each(rejectedStatuses.flatMap((status) => [false, true].map((reversed) => ({ status, reversed }))))(
    "isolates another work's $status acknowledgement (reversed: $reversed)",
    async ({ status, reversed }) => {
      const h = await harness();
      h.progress(120, 1);
      h.progress(20, 2);
      h.transport((report) => {
        const [a, b] = report.progress;
        const result = cursorAck({ history: [], progress: [a] }, 1, 1);
        // B has never established a local identity mapping. Older responses may
        // omit identity entirely, including for a permanently rejected item.
        result.progress.push({ reportId: b.reportId, status });
        if (reversed) result.progress.reverse();
        return Promise.resolve(result);
      });
      await h.tick(30_000);
      expect(h.requests[0].report.progress[1].order).toBeGreaterThan(h.requests[0].report.progress[0].order);
      expect(h.cursors).toHaveLength(1);
      expect(h.cursors[0]).toMatchObject({ workId: 1, mediaWorkId: 1, positionSeconds: 120 });
      const pending = h.store.read().progress;
      if (status === "stale") expect(pending).toEqual([]);
      else {
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({ workId: 2, blocked: true, report: { positionSeconds: 20 } });
      }
      h.scheduler.requestFlush();
      await h.tick(60_000);
      await h.tick(90_000);
      expect(h.requests).toHaveLength(1);
      expect(h.cursors).toHaveLength(1);
      expect(h.store.read().progress).toEqual(pending);
    },
  );

  it.each([false, true])("isolates a stale work with explicit ownership (reversed: %s)", async (reversed) => {
    const h = await harness();
    h.progress(120, 1);
    h.progress(20, 2);
    h.transport((report) => {
      const [a, b] = report.progress;
      const result = cursorAck({ history: [], progress: [a] }, 1, 1);
      result.progress.push({ reportId: b.reportId, status: "stale", identity: { workId: 4, editionWorkIds: [2, 4] } });
      if (reversed) result.progress.reverse();
      return Promise.resolve(result);
    });
    await h.tick(30_000);
    expect(h.store.read().progress).toEqual([]);
    expect(h.cursors).toHaveLength(1);
    expect(h.cursors[0]).toMatchObject({ workId: 1, positionSeconds: 120 });
  });

  it.each(["not_found", "invalid", "conflict", "history_cleared"] as const)(
    "a quarantined %s edition cannot block its own family's valid confirmation",
    async (status) => {
      const h = await harness();
      h.progress(120, 1);
      h.progress(20, 2);
      h.transport((report) => {
        const [a, b] = report.progress;
        const result = cursorAck({ history: [], progress: [a] }, 1, 1, [1, 2]);
        result.progress.push({ reportId: b.reportId, status });
        return Promise.resolve(result);
      });
      await h.tick(30_000);
      expect(h.cursors).toHaveLength(1);
      expect(h.cursors[0]).toMatchObject({ workId: 1, positionSeconds: 120 });
      expect(h.store.read().progress).toHaveLength(1);
      expect(h.store.read().progress[0]).toMatchObject({ workId: 2, blocked: true });
      await h.tick(60_000);
      expect(h.requests).toHaveLength(1);
      expect(h.cursors).toHaveLength(1);
      h.transport((r) => Promise.resolve(cursorAck(r, 1, 2, [1, 2])));
      h.progress(10, 2);
      await h.tick(90_000);
      expect(h.store.read().progress).toEqual([]);
      expect(h.cursors).toHaveLength(2);
      expect(h.cursors[1]).toMatchObject({ workId: 1, mediaWorkId: 2, positionSeconds: 10 });
    },
  );

  it.each([false, true])("reconciles same-batch edition confirmations by reportId (reversed: %s)", async (reversed) => {
    for (const status of ["recorded", "stale"] as const) {
      const h = await harness();
      h.progress(120, 2);
      h.progress(20, 3);
      h.transport((report) => {
        const [a, b] = report.progress;
        const result = cursorAck({ history: [], progress: [a] }, 1, 2, [1, 2, 3]);
        const latest = cursorAck({ history: [], progress: [b] }, 1, 3, [1, 2, 3]).progress[0];
        result.progress.push(status === "recorded" ? latest : { ...latest, status, cursor: undefined });
        if (reversed) result.progress.reverse();
        return Promise.resolve(result);
      });
      await h.tick(30_000);
      expect(h.store.read().progress).toEqual([]);
      if (status === "stale") expect(h.cursors).toEqual([]);
      else {
        expect(h.cursors).toHaveLength(1);
        expect(h.cursors[0]).toMatchObject({ workId: 1, mediaWorkId: 3, positionSeconds: 20 });
      }
      await h.tick(60_000);
      expect(h.requests).toHaveLength(1);
      expect(h.cursors).toHaveLength(status === "stale" ? 0 : 1);
    }
  });

  it("publishes an unrelated work while a newer checkpoint is still in flight locally", async () => {
    const h = await harness();
    let resolve!: (value: PlaybackReportResult) => void;
    h.transport(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    h.progress(120, 1);
    await h.tick(30_000);
    h.progress(20, 2);
    await settle();
    resolve(cursorAck(h.requests[0].report, 1, 1));
    await settle();
    expect(h.cursors).toHaveLength(1);
    expect(h.cursors[0]).toMatchObject({ workId: 1, positionSeconds: 120 });
    expect(h.store.read().progress[0]).toMatchObject({ workId: 2, report: { positionSeconds: 20 } });
    h.transport((r) => Promise.resolve(cursorAck(r, 2, 2)));
    await h.tick(60_000);
    expect(h.cursors.map((c) => [c.workId, c.positionSeconds])).toEqual([
      [1, 120],
      [2, 20],
    ]);
    expect(h.store.read().progress).toEqual([]);
  });

  it("does not delete or quarantine new data when an older report is rejected", async () => {
    const h = await harness();
    let resolve!: (value: PlaybackReportResult) => void;
    h.transport(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    h.progress(120);
    await h.tick(30_000);
    h.progress(20);
    await settle();
    resolve({
      ...ack(h.requests[0].report),
      progress: [{ reportId: h.requests[0].report.progress[0].reportId, status: "not_found" }],
    });
    await settle();
    expect(h.store.read().progress[0]).toMatchObject({ workId: 1, blocked: false, report: { positionSeconds: 20 } });
    h.transport((r) => Promise.resolve(cursorAck(r, 1, 1)));
    await h.tick(60_000);
    await h.tick(90_000);
    expect(h.store.read().progress).toEqual([]);
    expect(h.cursors).toHaveLength(1);
    expect(h.cursors[0].positionSeconds).toBe(20);
  });
  it("sends one merged batch each 30s and coalesces identical event checkpoints", async () => {
    const h = await harness();
    h.progress(30);
    h.scheduler.stageHistory(history(30));
    await h.tick(29_999);
    expect(h.requests).toHaveLength(0);
    await h.tick(30_000);
    expect(h.requests[0].report.history[0].listenedSeconds).toBe(30);
    expect(h.requests[0].report.progress[0].positionSeconds).toBe(30);
    h.progress(60);
    h.scheduler.stageHistory(history(60));
    await h.tick(60_000);
    expect(h.requests).toHaveLength(2);
    h.progress(60);
    h.scheduler.stageHistory(history(60));
    h.scheduler.requestFlush();
    h.scheduler.requestFlush();
    h.scheduler.hide();
    await settle();
    expect(h.requests).toHaveLength(2);
    expect(h.store.read().history).toEqual([]);
  });

  it("retains newer cumulative time and backward positions when an older request is acknowledged", async () => {
    const h = await harness();
    let resolve!: (value: PlaybackReportResult) => void;
    h.transport(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    h.progress(120);
    h.scheduler.stageHistory(history(30));
    await h.tick(30_000);
    h.progress(20);
    h.scheduler.stageHistory(history(45));
    await settle();
    expect(h.store.read().progress[0].report.positionSeconds).toBe(20);
    resolve(ack(h.requests[0].report));
    await settle();
    expect(h.store.read().history[0].report.listenedSeconds).toBe(45);
    expect(h.store.read().progress[0].report.positionSeconds).toBe(20);
    h.transport((r) => Promise.resolve(ack(r)));
    await h.tick(60_000);
    expect(h.requests[1].report.progress[0].order).toBeGreaterThan(h.requests[0].report.progress[0].order);
    expect(h.store.read().progress).toEqual([]);
  });

  it("restores unconfirmed data and retries with capped backoff without abandoning it", async () => {
    const h = await harness();
    h.transport(() => Promise.reject("temporary"));
    h.progress(20);
    h.scheduler.stageHistory(history(30));
    await h.tick(30_000);
    const original = h.store.read().history[0].report;
    await h.tick(34_999);
    expect(h.requests).toHaveLength(1);
    await h.tick(35_000);
    expect(h.requests).toHaveLength(2);
    let elapsed = 35_000;
    for (let n = 0; n < 10; n++) {
      elapsed = h.store.read().retryAt - date;
      await h.tick(elapsed);
    }
    expect(h.store.read().retryAt - (date + elapsed)).toBe(REPORT_RETRY_MAX_MS);
    expect(h.store.read().history[0].report).toEqual(original);
    h.scheduler.dispose();
    const restored = await harness(h.store);
    await restored.tick(elapsed + REPORT_RETRY_MAX_MS);
    expect(restored.requests[0].report.history[0]).toEqual(original);
    expect(restored.store.read().history).toEqual([]);
    restored.scheduler.dispose();
    const confirmed = await harness(h.store);
    await confirmed.tick(elapsed + 600_000);
    expect(confirmed.requests).toEqual([]);
  });

  it("checks generation on recovery and keeps saving progress after history is cleared", async () => {
    const store = memoryOutbox();
    const s = emptyOutbox();
    s.generation = 0;
    s.history.push({ report: history(30, "synthetic-stale", 1) });
    store.seed(s);
    const h = await harness(store);
    expect(h.requests).toHaveLength(0);
    expect(store.read().history).toEqual([]);
    h.progress(20);
    h.scheduler.stageHistory(history(30));
    h.generation(1);
    await h.scheduler.clearHistory();
    await settle();
    expect(store.read().history).toEqual([]);
    await h.tick(30_000);
    expect(h.requests[0].report.progress[0].positionSeconds).toBe(20);
    expect(h.requests[0].report.history).toEqual([]);
    h.scheduler.stageHistory(history(5, "synthetic-after-clear", 1));
    h.progress(25);
    await h.tick(60_000);
    expect(h.requests[1].report.history[0].listenedSeconds).toBe(5);
  });

  it("cancels in-flight reporting and cannot drain an old identity with new credentials", async () => {
    const h = await harness();
    h.transport(() => new Promise(() => {}));
    h.progress(20);
    h.scheduler.stageHistory(history(30));
    await h.tick(30_000);
    h.current(false);
    h.scheduler.dispose();
    expect(h.requests[0].signal.aborted).toBe(true);
    h.progress(40);
    await h.tick(60_000);
    expect(h.requests).toHaveLength(1);
    expect(h.store.read().history[0].report.listenedSeconds).toBe(30);
  });

  it("ignores a pre-clear acknowledgement arriving after a new generation starts", async () => {
    const h = await harness();
    let resolve!: (value: PlaybackReportResult) => void;
    h.transport(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    h.progress(120);
    h.scheduler.stageHistory(history(30));
    await h.tick(30_000);
    h.generation(1);
    await h.scheduler.clearHistory();
    await settle();
    h.progress(20);
    h.scheduler.stageHistory(history(5, "synthetic-new-generation", 1));
    await settle();
    resolve(ack(h.requests[0].report));
    await settle();
    expect(h.scheduler.generation).toBe(1);
    expect(h.store.read().history[0].report).toMatchObject({ generation: 1, listenedSeconds: 5 });
    expect(h.store.read().progress[0].report.positionSeconds).toBe(20);
    h.transport((r) => Promise.resolve(ack(r, 1)));
    await h.tick(60_000);
    expect(h.requests[1].report.history[0].generation).toBe(1);
    expect(h.store.read().history).toEqual([]);
  });

  it("quarantines permanent failures and keeps bounded unconfirmed records instead of evicting them", async () => {
    const h = await harness();
    for (let n = 0; n < MAX_OUTBOX_HISTORY + 2; n++) h.scheduler.stageHistory(history(30, `synthetic-session-${n}`));
    for (let n = 1; n <= MAX_OUTBOX_PROGRESS + 2; n++) h.progress(20, n);
    await settle();
    expect(h.store.read().history).toHaveLength(MAX_OUTBOX_HISTORY);
    expect(h.store.read().progress).toHaveLength(MAX_OUTBOX_PROGRESS);
    h.transport(() => Promise.reject("permanent"));
    await h.tick(30_000);
    expect(h.store.read().history.every((e) => e.blocked)).toBe(true);
    await h.tick(60_000);
    expect(h.requests).toHaveLength(1);
    h.transport((r) => Promise.resolve(ack(r)));
    h.progress(10);
    await h.tick(90_000);
    expect(h.requests[1].report.history).toEqual([]);
    expect(h.requests[1].report.progress).toHaveLength(1);
  });
});
