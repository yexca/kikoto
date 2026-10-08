import type {
  DatedListeningReport,
  PlaybackReport,
  PlaybackReportResult,
  ProgressReport,
  ReportStatus,
} from "@/lib/playbackReportApi";
import {
  emptyOutbox,
  MAX_OUTBOX_HISTORY,
  MAX_OUTBOX_PROGRESS,
  pendingBatch,
  type ReportOutbox,
  type ReportOutboxState,
} from "./playbackReportOutbox";

export const PLAYBACK_REPORT_INTERVAL_MS = 30_000;
export const REPORT_RETRY_MIN_MS = 5_000;
export const REPORT_RETRY_MAX_MS = 300_000;
export type ProgressCheckpoint = Omit<ProgressReport, "order" | "reportId">;
type Dependencies = {
  outbox: ReportOutbox;
  now: () => number;
  createId: () => string;
  isCurrent: () => boolean;
  send: (report: PlaybackReport, signal: AbortSignal, keepalive: boolean) => Promise<PlaybackReportResult>;
  fetchGeneration: (signal: AbortSignal) => Promise<number>;
  isPermanentFailure: (error: unknown) => boolean;
  onCursor: (cursor: NonNullable<PlaybackReportResult["progress"][number]["cursor"]>) => void;
  warn: () => void;
};
const statuses = new Set<ReportStatus>(["recorded", "stale", "history_cleared", "invalid", "not_found", "conflict"]);
const backoff = (failures: number) =>
  Math.min(REPORT_RETRY_MIN_MS * 2 ** Math.min(failures - 1, 10), REPORT_RETRY_MAX_MS);

/** The sole sender: durable staging, serialized batches, 30s cadence and event coalescing. */
export class PlaybackReportScheduler {
  generation: number | null = null;
  private verified = false;
  private epoch = 0;
  private generationPending = false;
  private generationRetryAt = 0;
  private generationFailures = 0;
  private generationBlocked = false;
  private controller = new AbortController();
  private writes = Promise.resolve();
  private state = emptyOutbox();
  private initialized = false;
  private inFlight = false;
  private disposed = false;
  private nextPeriodic: number;
  private eventDue: number | null = null;
  private followup = false;
  private historyTotals = new Map<string, number>();
  private lastProgress: string | null = null;
  private listeners = new Set<() => void>();

  constructor(private readonly deps: Dependencies) {
    this.nextPeriodic = deps.now() + PLAYBACK_REPORT_INTERVAL_MS;
  }
  subscribeGeneration(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private current() {
    return !this.disposed && !this.controller.signal.aborted && this.deps.isCurrent();
  }

  async initialize() {
    await this.write(() => {});
    if (!this.current()) return;
    this.initialized = true;
    this.setGeneration(this.state.generation, false);
    const pending = pendingBatch(this.state);
    if (pending.progress.length || pending.history.length) this.eventDue = this.deps.now();
    void this.verifyGeneration();
  }

  stageHistory(report: DatedListeningReport) {
    if (
      !this.current() ||
      report.generation !== this.generation ||
      report.listenedSeconds <= (this.historyTotals.get(report.sessionId) ?? 0)
    )
      return;
    this.historyTotals.set(report.sessionId, report.listenedSeconds);
    if (this.historyTotals.size > 128) this.historyTotals.delete(this.historyTotals.keys().next().value!);
    void this.write((s) => {
      if (s.generation !== report.generation) return;
      const existing = s.history.find((entry) => entry.report.sessionId === report.sessionId);
      if (existing) {
        if (report.listenedSeconds > existing.report.listenedSeconds) existing.report = report;
      } else if (s.history.length < MAX_OUTBOX_HISTORY) s.history.push({ report });
      else this.deps.warn();
    });
  }

  stageProgress(workId: number, checkpoint: ProgressCheckpoint) {
    if (!this.current()) return;
    const fingerprint = JSON.stringify({ workId, ...checkpoint });
    if (fingerprint === this.lastProgress) return;
    this.lastProgress = fingerprint;
    const at = this.deps.now();
    const reportId = this.deps.createId();
    void this.write((s) => {
      const existing = s.progress.find((entry) => entry.workId === workId);
      if (!existing && s.progress.length >= MAX_OUTBOX_PROGRESS) {
        this.deps.warn();
        return;
      }
      s.order = Math.max(s.order + 1, at);
      const entry = { workId, report: { ...checkpoint, reportId, order: s.order } };
      if (existing) Object.assign(existing, entry, { blocked: false });
      else s.progress.push(entry);
    });
  }

  /** A brief deadline combines pause/ended/track-switch checkpoints in one batch. */
  requestFlush() {
    if (this.current()) {
      this.eventDue ??= this.deps.now() + 100;
      if (this.inFlight) this.followup = true;
    }
  }
  hide() {
    this.requestFlush();
    void this.flush(true);
  }

  tick() {
    if (!this.current() || !this.initialized) return;
    if (!this.verified) void this.verifyGeneration();
    const now = this.deps.now();
    if (
      (this.eventDue !== null && now >= this.eventDue) ||
      now >= this.nextPeriodic ||
      (this.state.failures > 0 && now >= this.state.retryAt)
    )
      void this.flush(false);
  }

  async clearHistory() {
    this.epoch += 1;
    this.generationPending = false;
    this.generationBlocked = false;
    this.generationRetryAt = 0;
    this.setGeneration(null, false);
    this.historyTotals.clear();
    await this.write((s) => {
      s.history = [];
      s.generation = null;
    });
    if (this.current()) void this.verifyGeneration();
  }

  dispose() {
    this.disposed = true;
    this.controller.abort();
  }

  private setGeneration(generation: number | null, verified: boolean) {
    this.verified = verified;
    if (this.generation === generation) return;
    this.generation = generation;
    for (const listener of this.listeners) listener();
  }

  private async verifyGeneration() {
    if (
      !this.current() ||
      !this.initialized ||
      this.generationPending ||
      this.generationBlocked ||
      this.deps.now() < this.generationRetryAt
    )
      return;
    this.generationPending = true;
    const epoch = this.epoch;
    try {
      const generation = await this.deps.fetchGeneration(this.controller.signal);
      if (!this.current() || epoch !== this.epoch) return;
      if (
        !Number.isSafeInteger(generation) ||
        generation < 0 ||
        (this.generation !== null && generation < this.generation)
      )
        throw new Error("Invalid history generation.");
      await this.write((s) => {
        if (s.generation !== null && s.generation > generation) return;
        s.generation = generation;
        s.history = s.history.filter((entry) => entry.report.generation === generation);
      });
      if (!this.current() || epoch !== this.epoch) return;
      if (this.state.generation !== generation) throw new Error("Stale history generation.");
      this.generationFailures = 0;
      this.setGeneration(generation, true);
      if (this.eventDue !== null) void this.flush(false);
    } catch (error) {
      if (!this.current() || epoch !== this.epoch) return;
      this.generationBlocked = this.deps.isPermanentFailure(error);
      this.generationFailures += 1;
      this.generationRetryAt = this.deps.now() + backoff(this.generationFailures);
    } finally {
      if (epoch === this.epoch) this.generationPending = false;
    }
  }

  private async flush(keepalive: boolean) {
    if (!this.current() || !this.initialized || this.inFlight) return;
    this.inFlight = true;
    const epoch = this.epoch;
    let batch: PlaybackReport | null = null;
    try {
      await this.write(() => {});
      if (!this.current() || this.deps.now() < this.state.retryAt) return;
      batch = pendingBatch(this.state);
      if (!this.verified) batch.history = [];
      this.eventDue = null;
      this.nextPeriodic = this.deps.now() + PLAYBACK_REPORT_INTERVAL_MS;
      if (!batch.progress.length && !batch.history.length) return;
      const sent = batch;
      const result = await this.deps.send(sent, this.controller.signal, keepalive);
      if (!this.current()) return;
      if (
        !Number.isSafeInteger(result.generation) ||
        result.generation < 0 ||
        result.history?.length !== sent.history.length ||
        result.progress?.length !== sent.progress.length ||
        sent.history.some((r) => !result.history.some((a) => a.sessionId === r.sessionId && statuses.has(a.status))) ||
        sent.progress.some((r) => !result.progress.some((a) => a.reportId === r.reportId && statuses.has(a.status)))
      )
        throw new Error("Invalid playback acknowledgement.");
      await this.write((s) => {
        for (const ack of result.history) {
          const report = sent.history.find((r) => r.sessionId === ack.sessionId)!;
          const entry = s.history.find((e) => e.report.sessionId === ack.sessionId);
          if (!entry) continue;
          if (ack.status === "recorded" || ack.status === "stale") {
            if (entry.report.listenedSeconds <= report.listenedSeconds)
              s.history = s.history.filter((e) => e !== entry);
          } else if (ack.status === "history_cleared")
            s.history = s.history.filter((e) => e.report.generation !== report.generation);
          else entry.blocked = true;
        }
        for (const ack of result.progress) {
          const entry = s.progress.find((e) => e.report.reportId === ack.reportId);
          if (!entry) continue;
          if (ack.status === "recorded" || ack.status === "stale") s.progress = s.progress.filter((e) => e !== entry);
          else entry.blocked = true;
        }
        s.failures = 0;
        s.retryAt = 0;
        if (epoch === this.epoch && (s.generation === null || result.generation >= s.generation)) {
          s.generation = result.generation;
          s.history = s.history.filter((e) => e.report.generation === result.generation);
        }
      });
      if (!this.current()) return;
      if (epoch === this.epoch && (this.generation === null || result.generation >= this.generation))
        this.setGeneration(result.generation, true);
      // An older response cannot make the Library show a cursor already superseded locally.
      for (const ack of result.progress)
        if (
          ack.cursor &&
          ack.status === "recorded" &&
          !this.state.progress.some(
            (e) =>
              e.report.order > sent.progress.find((r) => r.reportId === ack.reportId)!.order &&
              e.workId === ack.cursor!.workId,
          )
        )
          this.deps.onCursor(ack.cursor);
      if (
        result.history.some((a) => a.status !== "recorded") ||
        result.progress.some((a) => a.status !== "recorded" && a.status !== "stale")
      )
        this.deps.warn();
    } catch (error) {
      if (!this.current() || !batch) return;
      const sent = batch;
      await this.write((s) => {
        if (this.deps.isPermanentFailure(error)) {
          for (const entry of s.history)
            if (sent.history.some((r) => r.sessionId === entry.report.sessionId)) entry.blocked = true;
          for (const entry of s.progress)
            if (sent.progress.some((r) => r.reportId === entry.report.reportId)) entry.blocked = true;
          this.deps.warn();
        } else {
          s.failures = Math.min(s.failures + 1, 20);
          s.retryAt = this.deps.now() + backoff(s.failures);
        }
      });
    } finally {
      this.inFlight = false;
      if (this.followup && this.current()) {
        this.followup = false;
        this.eventDue = this.deps.now() + 100;
      }
    }
  }

  private write(change: (state: ReportOutboxState) => void) {
    this.writes = this.writes.then(async () => {
      if (!this.current()) return;
      try {
        this.state = await this.deps.outbox.mutate(change);
      } catch {
        this.deps.warn();
      }
    });
    return this.writes;
  }
}
