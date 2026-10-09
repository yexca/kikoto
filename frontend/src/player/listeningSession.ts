import type { DatedListeningReport } from "@/lib/playbackReportApi";

export const MAX_LISTENING_SESSION_SECONDS = 86_400;
export const LISTENING_MAX_OBSERVATION_GAP_MS = 60_000;
const MAX_SESSION_DAYS = 32;
export type ListeningTarget = { activationKey: string; workId: number };

/** Measures actual advancing wall time. It owns neither storage nor networking. */
export class ListeningClock {
  private target: ListeningTarget | null = null;
  private generation: number | null = null;
  private report: DatedListeningReport | null = null;
  private days = new Map<string, number>();
  private runningSince: number | null = null;
  private wallSince = 0;
  private publishedSeconds = 0;

  constructor(
    private readonly createId: () => string,
    private readonly checkpoint: (report: DatedListeningReport) => void,
  ) {}

  update(target: ListeningTarget | null, generation: number | null, advancing: boolean, now: number, wall: number) {
    if (generation !== this.generation) {
      this.report = null;
      this.days.clear();
      this.publishedSeconds = 0;
      this.runningSince = null;
      this.generation = generation;
    }
    this.observe(now, wall);
    if (!advancing) this.publish(true);
    if (target?.activationKey !== this.target?.activationKey || target?.workId !== this.target?.workId) {
      this.end();
      this.target = target;
    }
    this.runningSince = advancing && target && generation !== null ? now : null;
    this.wallSince = wall;
  }

  observe(now: number, wall: number) {
    if (this.runningSince === null || !this.target || this.generation === null) return;
    const elapsed = now - this.runningSince;
    const wallElapsed = wall - this.wallSince;
    this.runningSince = now;
    this.wallSince = wall;
    // Frozen pages, device sleep, or a changed wall clock cannot invent time.
    if (Math.abs(elapsed - wallElapsed) > 2000) {
      this.closeReport();
      return;
    }
    if (elapsed <= 0 || elapsed > LISTENING_MAX_OBSERVATION_GAP_MS) return;
    let cursor = wall - elapsed;
    while (cursor < wall) {
      const day = new Date(cursor).toISOString().slice(0, 10);
      if (this.days.size >= MAX_SESSION_DAYS && !this.days.has(day)) this.closeReport();
      if (!this.report)
        this.report = {
          generation: this.generation,
          sessionId: this.createId(),
          workId: this.target.workId,
          listenedSeconds: 0,
          startedAt: new Date(cursor).toISOString(),
          lastListenedAt: new Date(cursor).toISOString(),
          days: [],
        };
      const midnight = Date.parse(`${day}T00:00:00Z`) + 86_400_000;
      const remaining = MAX_LISTENING_SESSION_SECONDS * 1000 - this.report.listenedSeconds * 1000;
      const amount = Math.min(wall - cursor, midnight - cursor, remaining);
      this.days.set(day, (this.days.get(day) ?? 0) + amount);
      cursor += amount;
      this.report.listenedSeconds = [...this.days.values()].reduce((sum, value) => sum + value, 0) / 1000;
      this.report.lastListenedAt = new Date(cursor).toISOString();
      this.report.days = [...this.days]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, ms]) => ({ day, listenedSeconds: ms / 1000 }));
      this.publish();
      if (this.report.listenedSeconds >= MAX_LISTENING_SESSION_SECONDS) this.closeReport();
    }
  }

  end() {
    this.closeReport();
    this.runningSince = null;
  }
  private publish(force = false) {
    if (
      !this.report ||
      this.report.listenedSeconds < 1 ||
      (!force && Math.floor(this.report.listenedSeconds) <= Math.floor(this.publishedSeconds))
    )
      return;
    this.publishedSeconds = this.report.listenedSeconds;
    this.checkpoint(structuredClone(this.report));
  }
  private closeReport() {
    this.publish(true);
    this.report = null;
    this.days.clear();
    this.publishedSeconds = 0;
  }
}

export function isMediaAdvancing(
  element: Pick<HTMLMediaElement, "paused" | "ended" | "seeking" | "readyState"> | null,
) {
  return Boolean(element && !element.paused && !element.ended && !element.seeking && element.readyState >= 3);
}
