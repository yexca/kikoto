import type { ListeningSessionReport } from "@/lib/listeningApi";

/** The API accepts at most one day of listening per session. */
export const MAX_LISTENING_SESSION_SECONDS = 86_400;

/** Cumulative listening time is reported at most this often while media plays. */
export const LISTENING_HEARTBEAT_MS = 15_000;

/**
 * The longest wall-clock gap credited between two observations of advancing
 * media. A suspended device or frozen page cannot turn its sleep into listening.
 */
export const LISTENING_MAX_OBSERVATION_GAP_MS = 60_000;

/** A session whose report keeps failing is abandoned after this many attempts. */
export const LISTENING_MAX_SEND_ATTEMPTS = 4;

/** Closed sessions still waiting for acknowledgement; the oldest is dropped beyond this. */
export const LISTENING_MAX_PENDING_SESSIONS = 20;

/** A failed history generation lookup waits this long before the next attempt, doubling per failure. */
export const LISTENING_GENERATION_RETRY_MIN_MS = 5_000;

/** The longest wait between history generation lookups while media advances without one. */
export const LISTENING_GENERATION_RETRY_MAX_MS = 5 * 60_000;

/** One track play activation of a work the current principal may record. */
export type ListeningTarget = {
  /** Changes when a different queue item becomes current. */
  activationKey: string;
  workId: number;
};

export type ListeningSnapshot = {
  /** Server and principal the reports belong to; null when recording is not allowed. */
  scope: string | null;
  target: ListeningTarget | null;
  /** The media element is actually advancing: not paused, buffering, seeking, or ended. */
  advancing: boolean;
};

export type ListeningSender = (
  report: ListeningSessionReport,
  options: { keepalive: boolean; scope: string },
) => Promise<unknown>;

type ListeningSessionState = {
  id: string;
  workId: number;
  /** The history generation this interval was measured under; its reports always carry it. */
  generation: number;
  listenedMs: number;
  acknowledgedSeconds: number;
  /** The total carried by the report in flight, or 0. One ordinary report per session is in flight at a time. */
  inFlightSeconds: number;
  /** A page-hide report may overlap an ordinary one; the server keeps the maximum. */
  keepaliveInFlight: boolean;
  failedAttempts: number;
  /** History was cleared or the scope changed; the session is neither reported nor retried again. */
  discarded: boolean;
};

type TrackerDependencies = {
  send: ListeningSender;
  /** Resolves the scope's current history generation, a nonnegative integer. */
  fetchGeneration: (scope: string) => Promise<unknown>;
  createId: () => string;
  /** The clock `update` and `heartbeat` receive, read when an asynchronous lookup completes. */
  now: () => number;
  /** A rejected request that retrying cannot fix, such as a 4xx response. */
  isPermanentFailure?: (error: unknown) => boolean;
  /** The server rejected a report because its generation is no longer current. */
  isHistoryCleared?: (error: unknown) => boolean;
};

/**
 * Accumulates real listening time per track play activation and reports the
 * cumulative total under a stable session id. Elapsed wall time is credited only
 * while the media element advances, so pause, buffering, and seeking are
 * excluded and the playback rate is never applied a second time.
 *
 * Every session belongs to the server's history generation that was current
 * when it opened. Time is measured only once that generation is known, and a
 * history clear (announced here or reported as a stale generation by the
 * server) drops every unreported interval before measuring resumes under the
 * new generation.
 *
 * Each session has at most one ordinary report in flight; time credited while
 * it is pending is sent as one follow-up with the latest total. A session that
 * reaches the one-day limit closes and listening continues in a new session.
 */
export class ListeningSessionTracker {
  private scope: string | null = null;
  private target: ListeningTarget | null = null;
  private advancing = false;
  private current: ListeningSessionState | null = null;
  private closed: ListeningSessionState[] = [];
  private runningSince: number | null = null;
  private lastReportAt = 0;
  private disposed = false;

  /** The scope's history generation; null until a lookup confirms it. Nothing is measured while null. */
  private generation: number | null = null;
  /** Invalidates a lookup response that belongs to an earlier scope, clear, or disposal. */
  private generationEpoch = 0;
  private generationPending = false;
  /** The lowest generation a lookup may return; an older value is a stale read. */
  private generationFloor = 0;
  private generationFailures = 0;
  private generationRetryAt = 0;
  /** A permanent lookup failure stops retries until the scope changes or history is cleared. */
  private generationBlocked = false;

  constructor(private readonly deps: TrackerDependencies) {}

  /** Applies the latest player state. Call it whenever scope, target, or advancing changes. */
  update(snapshot: ListeningSnapshot, now: number) {
    if (this.disposed) return;
    if (snapshot.scope !== this.scope) {
      // Reports belong to the principal that listened. Requests for an old
      // server or account must never be retried with new credentials, and a
      // lookup for the old scope must not establish the new scope's generation.
      this.discardSessions();
      this.scope = snapshot.scope;
      this.runningSince = null;
      this.resetGeneration(0);
      this.requestGeneration(now);
    }
    const target = snapshot.scope ? snapshot.target : null;
    if (!sameTarget(target, this.target)) {
      this.accrue(now);
      this.runningSince = null;
      this.closeCurrent();
      this.target = target;
      this.flush({ keepalive: false });
    }
    this.advancing = snapshot.advancing;
    if (snapshot.advancing && this.target && this.scope) {
      if (this.generation === null) {
        this.requestGeneration(now);
        return;
      }
      if (this.runningSince === null) {
        this.startRunning(now);
      } else {
        this.accrue(now);
      }
      return;
    }
    if (this.runningSince !== null) {
      this.accrue(now);
      this.runningSince = null;
      this.flush({ keepalive: false });
    }
  }

  /** Credits time up to now while media advances; call it from media progress events. */
  observe(now: number) {
    if (this.disposed) return;
    this.accrue(now);
  }

  /** Periodic tick: credits time, reports a running session every heartbeat, and retries failures. */
  heartbeat(now: number) {
    if (this.disposed) return;
    if (this.generation === null && this.advancing && this.target) this.requestGeneration(now);
    this.accrue(now);
    const reportCurrent = this.runningSince === null || now - this.lastReportAt >= LISTENING_HEARTBEAT_MS;
    if (reportCurrent) this.lastReportAt = now;
    this.send({ keepalive: false, includeCurrent: reportCurrent });
  }

  /** The current track reached its end; a replay of the same queue item is a new activation. */
  endActivation(now: number) {
    if (this.disposed) return;
    this.accrue(now);
    this.runningSince = null;
    this.advancing = false;
    this.closeCurrent();
    this.flush({ keepalive: false });
  }

  /** Reports every unacknowledged total now, for pause, track change, or page hide. */
  flush({ keepalive }: { keepalive: boolean }) {
    if (this.disposed) return;
    this.send({ keepalive, includeCurrent: true });
  }

  /**
   * The listener's history was cleared. Every current and pending session is
   * dropped without another report, so no pre-clear time is sent again. The
   * new generation is looked up, and playback that is still advancing then
   * continues in a fresh session from that moment.
   */
  discardHistory(now: number) {
    if (this.disposed || !this.scope) return;
    // The announcement follows a committed clear, so a fresh lookup already
    // reflects it. It may describe a clear this tracker has handled after a
    // rejected report, so it must not demand a generation beyond the known one.
    this.invalidateGeneration(now, Math.max(this.generationFloor, this.generation ?? 0));
  }

  /** Stops all reporting. Unsent time is dropped rather than sent with another principal's credentials. */
  dispose() {
    this.disposed = true;
    this.discardSessions();
    this.runningSince = null;
    this.resetGeneration(0);
  }

  /** Test and diagnostics view of the current session's credited whole seconds. */
  currentListenedSeconds() {
    return this.current ? listenedSeconds(this.current) : 0;
  }

  currentSessionId() {
    return this.current?.id ?? null;
  }

  pendingSessionCount() {
    return this.closed.length + (this.current ? 1 : 0);
  }

  /** The history generation new sessions open under, or null while it is being looked up. */
  currentGeneration() {
    return this.generation;
  }

  private startRunning(now: number) {
    if (!this.target || this.generation === null) return;
    if (!this.current) this.current = this.openSession(this.target, this.generation);
    this.runningSince = now;
    this.lastReportAt = now;
  }

  private openSession(target: ListeningTarget, generation: number): ListeningSessionState {
    return {
      id: this.deps.createId(),
      workId: target.workId,
      generation,
      listenedMs: 0,
      acknowledgedSeconds: 0,
      inFlightSeconds: 0,
      keepaliveInFlight: false,
      failedAttempts: 0,
      discarded: false,
    };
  }

  private discardSessions() {
    for (const session of [...this.closed, ...(this.current ? [this.current] : [])]) session.discarded = true;
    this.current = null;
    this.closed = [];
  }

  private resetGeneration(floor: number) {
    this.generation = null;
    this.generationEpoch += 1;
    this.generationPending = false;
    this.generationFloor = floor;
    this.generationFailures = 0;
    this.generationRetryAt = 0;
    this.generationBlocked = false;
  }

  /**
   * Drops every interval measured so far, including time credited since the
   * last report, and looks up the current generation before anything is
   * measured again. A lookup below `floor` is a stale read and is retried.
   */
  private invalidateGeneration(now: number, floor: number) {
    this.discardSessions();
    this.runningSince = null;
    this.resetGeneration(floor);
    this.requestGeneration(now);
  }

  /** Starts one generation lookup for the current scope unless one is pending or backing off. */
  private requestGeneration(now: number) {
    const scope = this.scope;
    if (this.disposed || !scope || this.generation !== null || this.generationPending) return;
    if (this.generationBlocked || now < this.generationRetryAt) return;
    const epoch = this.generationEpoch;
    this.generationPending = true;
    let request: Promise<unknown>;
    try {
      request = this.deps.fetchGeneration(scope);
    } catch (error) {
      request = Promise.reject(error);
    }
    void request.then(
      (value) => {
        if (epoch !== this.generationEpoch) return;
        this.generationPending = false;
        // A value below the floor was read before the clear that invalidated
        // the previous generation; it would only be rejected again.
        if (!isGeneration(value) || value < this.generationFloor) {
          this.generationFailed(false);
          return;
        }
        this.generation = value;
        this.generationFailures = 0;
        this.generationRetryAt = 0;
        if (this.advancing && this.target && this.runningSince === null) this.startRunning(this.deps.now());
      },
      (error: unknown) => {
        if (epoch !== this.generationEpoch) return;
        this.generationPending = false;
        this.generationFailed(this.deps.isPermanentFailure?.(error) === true);
      },
    );
  }

  private generationFailed(permanent: boolean) {
    this.generationFailures += 1;
    if (permanent) this.generationBlocked = true;
    const delay = Math.min(
      LISTENING_GENERATION_RETRY_MIN_MS * 2 ** (this.generationFailures - 1),
      LISTENING_GENERATION_RETRY_MAX_MS,
    );
    this.generationRetryAt = this.deps.now() + delay;
  }

  private accrue(now: number) {
    // A running clock without a current session follows a one-day rollover.
    if (this.runningSince === null || !this.target || !this.scope || this.generation === null) return;
    let elapsed = Math.min(Math.max(0, now - this.runningSince), LISTENING_MAX_OBSERVATION_GAP_MS);
    this.runningSince = now;
    const limitMs = MAX_LISTENING_SESSION_SECONDS * 1000;
    while (elapsed > 0) {
      const session: ListeningSessionState = this.current ?? this.openSession(this.target, this.generation);
      this.current = session;
      const credited = Math.min(elapsed, limitMs - session.listenedMs);
      session.listenedMs += credited;
      elapsed -= credited;
      // A full day closes the session; continued listening starts the next one.
      if (session.listenedMs >= limitMs) this.closeCurrent();
    }
  }

  private closeCurrent() {
    if (this.current) this.closed.push(this.current);
    this.current = null;
    while (this.closed.length > LISTENING_MAX_PENDING_SESSIONS) {
      const dropped = this.closed.shift();
      if (dropped) dropped.discarded = true;
    }
  }

  private send({ keepalive, includeCurrent }: { keepalive: boolean; includeCurrent: boolean }) {
    const sessions = includeCurrent && this.current ? [...this.closed, this.current] : [...this.closed];
    for (const session of sessions) this.report(session, keepalive);
    this.closed = this.closed.filter((session) => !isFinished(session));
  }

  private report(session: ListeningSessionState, keepalive: boolean) {
    const scope = this.scope;
    if (!scope || session.discarded || session.failedAttempts >= LISTENING_MAX_SEND_ATTEMPTS) return;
    const seconds = listenedSeconds(session);
    if (seconds < 1 || seconds <= session.acknowledgedSeconds || seconds <= session.inFlightSeconds) return;
    // An ordinary report waits for the one in flight and then sends the latest
    // total; only a page-hide report, the last chance to send, may overlap it.
    const overlapping = session.inFlightSeconds > 0;
    if (overlapping && (!keepalive || session.keepaliveInFlight)) return;
    if (overlapping) session.keepaliveInFlight = true;
    else session.inFlightSeconds = seconds;

    let request: Promise<unknown>;
    try {
      request = this.deps.send(
        {
          generation: session.generation,
          sessionId: session.id,
          workId: session.workId,
          listenedSeconds: seconds,
        },
        { keepalive, scope },
      );
    } catch (error) {
      request = Promise.reject(error);
    }
    const settle = () => {
      if (overlapping) session.keepaliveInFlight = false;
      else session.inFlightSeconds = 0;
    };
    void request.then(
      () => {
        settle();
        // A late response for a smaller total cannot lower the acknowledged value.
        session.acknowledgedSeconds = Math.max(session.acknowledgedSeconds, seconds);
        session.failedAttempts = 0;
        // Time credited while this report was pending goes out as one follow-up.
        // A running session's follow-up waits for its next heartbeat instead.
        const running = session === this.current && this.runningSince !== null;
        if (!overlapping && !running && session.acknowledgedSeconds < listenedSeconds(session)) {
          this.report(session, false);
        }
        this.forgetIfFinished(session);
      },
      (error: unknown) => {
        settle();
        // A discarded session belongs to an earlier scope or generation; its
        // outcome must not affect the current one.
        if (session.discarded) return;
        if (this.deps.isHistoryCleared?.(error) === true) {
          // History was cleared elsewhere after this generation was read. Every
          // interval measured under it is dropped rather than resent, and only
          // a newer generation is accepted.
          if (session.generation === this.generation && !this.disposed) {
            this.invalidateGeneration(this.deps.now(), session.generation + 1);
          } else session.discarded = true;
          this.forgetIfFinished(session);
          return;
        }
        session.failedAttempts =
          this.deps.isPermanentFailure?.(error) === true ? LISTENING_MAX_SEND_ATTEMPTS : session.failedAttempts + 1;
        this.forgetIfFinished(session);
      },
    );
  }

  private forgetIfFinished(session: ListeningSessionState) {
    if (session !== this.current && isFinished(session)) {
      this.closed = this.closed.filter((candidate) => candidate !== session);
    }
  }
}

function isGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function listenedSeconds(session: ListeningSessionState) {
  return Math.min(Math.floor(session.listenedMs / 1000), MAX_LISTENING_SESSION_SECONDS);
}

function isFinished(session: ListeningSessionState) {
  if (session.discarded) return true;
  if (session.inFlightSeconds > 0 || session.keepaliveInFlight) return false;
  const seconds = listenedSeconds(session);
  return seconds < 1 || session.acknowledgedSeconds >= seconds || session.failedAttempts >= LISTENING_MAX_SEND_ATTEMPTS;
}

function sameTarget(left: ListeningTarget | null, right: ListeningTarget | null) {
  if (!left || !right) return left === right;
  return left.activationKey === right.activationKey && left.workId === right.workId;
}

/** True while an audio or video element is actually producing new media time. */
export function isMediaAdvancing(
  element: Pick<HTMLMediaElement, "paused" | "ended" | "seeking" | "readyState"> | null,
) {
  return Boolean(element && !element.paused && !element.ended && !element.seeking && element.readyState >= 3);
}
