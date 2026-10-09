import type { DatedListeningReport, PlaybackReport, ProgressReport } from "@/lib/playbackReportApi";

export const MAX_OUTBOX_HISTORY = 64;
export const MAX_OUTBOX_PROGRESS = 32;
export const MAX_OUTBOX_BYTES = 256 * 1024;
const serializedSize = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const validID = (id: string) => /^[A-Za-z0-9_-][A-Za-z0-9._-]{7,79}$/.test(id);
export type OutboxEntry<T> = { report: T; blocked?: boolean };
export type ReportOutboxState = {
  version: 1;
  generation: number | null;
  order: number;
  failures: number;
  retryAt: number;
  history: OutboxEntry<DatedListeningReport>[];
  progress: (OutboxEntry<ProgressReport> & { workId: number })[];
};
export const emptyOutbox = (): ReportOutboxState => ({
  version: 1,
  generation: null,
  order: 0,
  failures: 0,
  retryAt: 0,
  history: [],
  progress: [],
});
export interface ReportOutbox {
  mutate(change: (state: ReportOutboxState) => void): Promise<ReportOutboxState>;
}

function validatedState(value: unknown): ReportOutboxState {
  if (!value || typeof value !== "object") return emptyOutbox();
  const s = value as ReportOutboxState;
  if (
    s.version !== 1 ||
    !Array.isArray(s.history) ||
    !Array.isArray(s.progress) ||
    s.history.length > MAX_OUTBOX_HISTORY ||
    s.progress.length > MAX_OUTBOX_PROGRESS ||
    serializedSize(s) > MAX_OUTBOX_BYTES ||
    !Number.isSafeInteger(s.order) ||
    s.order < 0 ||
    !Number.isFinite(s.retryAt) ||
    !Number.isSafeInteger(s.failures) ||
    s.failures < 0 ||
    (s.generation !== null && (!Number.isSafeInteger(s.generation) || s.generation < 0))
  )
    return emptyOutbox();
  const finite = (n: number) => Number.isFinite(n) && n >= 0;
  if (
    s.history.some(
      ({ report: r }) =>
        !r ||
        typeof r.sessionId !== "string" ||
        !validID(r.sessionId) ||
        !Number.isSafeInteger(r.generation) ||
        r.generation < 0 ||
        !Number.isSafeInteger(r.workId) ||
        r.workId <= 0 ||
        !finite(r.listenedSeconds) ||
        r.listenedSeconds > 86400 ||
        !Array.isArray(r.days) ||
        r.days.length === 0 ||
        r.days.length > 32 ||
        !Number.isFinite(Date.parse(r.startedAt)) ||
        !Number.isFinite(Date.parse(r.lastListenedAt)) ||
        r.days.some((d) => !d || typeof d.day !== "string" || !finite(d.listenedSeconds)),
    ) ||
    s.progress.some(
      ({ report: r, workId }) =>
        !r ||
        !Number.isSafeInteger(workId) ||
        workId <= 0 ||
        typeof r.reportId !== "string" ||
        !validID(r.reportId) ||
        !Number.isSafeInteger(r.order) ||
        r.order <= 0 ||
        !Number.isSafeInteger(r.mediaItemId) ||
        r.mediaItemId <= 0 ||
        !Number.isSafeInteger(r.locationId) ||
        r.locationId <= 0 ||
        !finite(r.positionSeconds) ||
        (r.durationSeconds !== null && !finite(r.durationSeconds)) ||
        typeof r.completed !== "boolean",
    )
  )
    return emptyOutbox();
  return s;
}

/** One atomic account/server record; concurrent tabs merge and acknowledge in IDB transactions. */
export function createReportOutbox(scope: string, unavailable: () => void = () => {}): ReportOutbox {
  const volatile = emptyOutbox();
  let database: Promise<IDBDatabase> | null = null;
  const open = () =>
    (database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open("kikoto-playback-reports", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("outbox");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Playback report storage is blocked."));
    }));
  return {
    async mutate(change) {
      let db: IDBDatabase;
      try {
        db = await open();
      } catch {
        unavailable();
        change(volatile);
        return structuredClone(volatile);
      }
      return new Promise((resolve, reject) => {
        const tx = db.transaction("outbox", "readwrite");
        const store = tx.objectStore("outbox");
        const request = store.get(scope);
        let state: ReportOutboxState;
        request.onsuccess = () => {
          try {
            try {
              state = validatedState(request.result);
            } catch {
              state = emptyOutbox();
              unavailable();
            }
            change(state);
            if (serializedSize(state) > MAX_OUTBOX_BYTES) throw new Error("Playback report capacity exceeded.");
            store.put(state, scope);
          } catch {
            tx.abort();
          }
        };
        tx.oncomplete = () => resolve(state);
        tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("Playback report storage failed."));
      });
    },
  };
}

/** Keepalive's aggregate fetch limit is 64 KiB; ordinary batches use the same bound. */
export function pendingBatch(s: ReportOutboxState): PlaybackReport {
  const batch: PlaybackReport = { history: [], progress: [] };
  for (const entry of s.progress) {
    if (entry.blocked) continue;
    batch.progress.push(entry.report);
    if (serializedSize(batch) > 48 * 1024) {
      batch.progress.pop();
      break;
    }
  }
  for (const entry of s.history) {
    if (entry.blocked) continue;
    batch.history.push(entry.report);
    if (serializedSize(batch) > 48 * 1024) {
      batch.history.pop();
      break;
    }
  }
  return batch;
}
