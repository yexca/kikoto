import { describe, expect, it } from "vitest";

import type { ListeningSessionReport } from "@/lib/listeningApi";

import {
  isMediaAdvancing,
  LISTENING_GENERATION_RETRY_MAX_MS,
  LISTENING_HEARTBEAT_MS,
  LISTENING_MAX_OBSERVATION_GAP_MS,
  LISTENING_MAX_PENDING_SESSIONS,
  LISTENING_MAX_SEND_ATTEMPTS,
  ListeningSessionTracker,
  type ListeningSnapshot,
} from "./listeningSession";

const scope = "https%3A%2F%2Fkikoto.example.invalid:user-7";
const trackA = { activationKey: "queue-item-a", workId: 11 };
const trackB = { activationKey: "queue-item-b", workId: 12 };

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

type SentReport = ListeningSessionReport & { keepalive: boolean };

type Deferred = { resolve: (value?: unknown) => void; reject: (error: unknown) => void };

/**
 * A tracker wired to a simulated server whose history generation the test
 * controls. Reports for an older generation are rejected as `cleared`, like
 * the server's HTTP 409. Unless `establish` is false, the scope's generation is
 * looked up before the test starts, so accounting begins immediately.
 */
async function harness(
  options: { fail?: (report: ListeningSessionReport) => unknown; generation?: number; establish?: boolean } = {},
) {
  const sent: SentReport[] = [];
  const sentScopes: string[] = [];
  const pending: Array<Deferred & { report: SentReport }> = [];
  const lookups: string[] = [];
  const pendingLookups: Deferred[] = [];
  const server = { generation: options.generation ?? 0 };
  const clock = { now: 0 };
  let ids = 0;
  let manual = false;
  let manualLookups = false;
  let lookupFailure: unknown;
  const tracker = new ListeningSessionTracker({
    createId: () => `session-${++ids}`,
    now: () => clock.now,
    isPermanentFailure: (error) => error === "permanent" || error === "cleared",
    isHistoryCleared: (error) => error === "cleared",
    fetchGeneration: (requestScope) => {
      lookups.push(requestScope);
      if (manualLookups) return new Promise((resolve, reject) => pendingLookups.push({ resolve, reject }));
      return lookupFailure === undefined ? Promise.resolve(server.generation) : Promise.reject(lookupFailure);
    },
    send: (report, { keepalive, scope: requestScope }) => {
      const entry = { ...report, keepalive };
      sent.push(entry);
      sentScopes.push(requestScope);
      if (manual) {
        return new Promise((resolve, reject) => pending.push({ resolve, reject, report: entry }));
      }
      if (report.generation !== server.generation) return Promise.reject("cleared");
      const failure = options.fail?.(report);
      return failure === undefined ? Promise.resolve() : Promise.reject(failure);
    },
  });
  const update = (snapshot: Partial<ListeningSnapshot>, now: number) =>
    tracker.update({ scope, target: trackA, advancing: false, ...snapshot }, now);
  if (options.establish !== false) {
    tracker.update({ scope, target: null, advancing: false }, 0);
    await settle();
  }
  return {
    tracker,
    sent,
    sentScopes,
    pending,
    lookups,
    pendingLookups,
    server,
    clock,
    update,
    holdResponses: () => {
      manual = true;
    },
    holdLookups: () => {
      manualLookups = true;
    },
    failLookups: (error: unknown) => {
      lookupFailure = error;
    },
  };
}

describe("listening session accounting", () => {
  it("credits only wall time while media advances, excluding pause and buffering", async () => {
    const { tracker, sent, update } = await harness();
    update({ advancing: true }, 0);
    update({ advancing: false }, 10_000); // buffering for 5 s
    update({ advancing: true }, 15_000);
    update({ advancing: false }, 22_500); // user pause
    await settle();

    expect(tracker.currentListenedSeconds()).toBe(17);
    expect(sent.map((report) => report.listenedSeconds)).toEqual([10, 17]);
    expect(new Set(sent.map((report) => report.sessionId))).toEqual(new Set(["session-1"]));
  });

  it("reports the cumulative total every heartbeat and never writes while idle", async () => {
    const { tracker, sent, update } = await harness();
    update({ advancing: true }, 0);
    tracker.heartbeat(LISTENING_HEARTBEAT_MS - 1);
    expect(sent).toHaveLength(0);
    tracker.heartbeat(LISTENING_HEARTBEAT_MS);
    await settle();
    tracker.heartbeat(LISTENING_HEARTBEAT_MS * 2);
    await settle();
    expect(sent.map((report) => report.listenedSeconds)).toEqual([15, 30]);

    update({ advancing: false }, LISTENING_HEARTBEAT_MS * 2);
    await settle();
    tracker.heartbeat(LISTENING_HEARTBEAT_MS * 3);
    tracker.heartbeat(LISTENING_HEARTBEAT_MS * 4);
    tracker.flush({ keepalive: true });
    await settle();
    expect(sent).toHaveLength(2);
  });

  it("does not credit a suspended device or frozen page beyond the observation gap", async () => {
    const { tracker, update } = await harness();
    update({ advancing: true }, 0);
    tracker.observe(60 * 60_000);
    expect(tracker.currentListenedSeconds()).toBe(LISTENING_MAX_OBSERVATION_GAP_MS / 1000);
  });

  it("starts a new session for each track activation and flushes the previous one", async () => {
    const { tracker, sent, update } = await harness();
    update({ advancing: true }, 0);
    update({ target: trackB, advancing: true }, 8_000);
    update({ target: trackB, advancing: false }, 20_000);
    await settle();

    expect(sent).toEqual([
      { generation: 0, sessionId: "session-1", workId: 11, listenedSeconds: 8, keepalive: false },
      { generation: 0, sessionId: "session-2", workId: 12, listenedSeconds: 12, keepalive: false },
    ]);
    expect(tracker.currentSessionId()).toBe("session-2");
  });

  it("treats a replay after the track ended as a new activation of the same queue item", async () => {
    const { tracker, sent, update } = await harness();
    update({ advancing: true }, 0);
    tracker.endActivation(5_000);
    update({ advancing: true }, 5_000);
    update({ advancing: false }, 7_000);
    await settle();

    expect(sent.map(({ sessionId, listenedSeconds }) => [sessionId, listenedSeconds])).toEqual([
      ["session-1", 5],
      ["session-2", 2],
    ]);
    expect(tracker.currentSessionId()).toBe("session-2");
  });

  it("retries a failed report with the same session id and the latest cumulative total", async () => {
    let failures = 1;
    const { tracker, sent, update } = await harness({
      fail: () => (failures-- > 0 ? new Error("offline") : undefined),
    });
    update({ advancing: true }, 0);
    update({ advancing: false }, 10_000);
    await settle();
    update({ advancing: true }, 20_000);
    update({ advancing: false }, 24_000);
    await settle();
    tracker.heartbeat(40_000);
    await settle();

    expect(sent.map(({ sessionId, listenedSeconds }) => [sessionId, listenedSeconds])).toEqual([
      ["session-1", 10],
      ["session-1", 14],
    ]);
    expect(tracker.pendingSessionCount()).toBe(1);
  });

  it("retries a closed session until it succeeds, then forgets it", async () => {
    let failures = 2;
    const { tracker, sent, update } = await harness({
      fail: () => (failures-- > 0 ? new Error("offline") : undefined),
    });
    update({ advancing: true }, 0);
    update({ target: null, advancing: false }, 6_000);
    await settle();
    tracker.heartbeat(20_000);
    await settle();
    tracker.heartbeat(40_000);
    await settle();
    tracker.heartbeat(60_000);
    await settle();

    expect(sent.map((report) => report.listenedSeconds)).toEqual([6, 6, 6]);
    expect(tracker.pendingSessionCount()).toBe(0);
  });

  it("abandons a session the server rejects permanently or after bounded attempts", async () => {
    const permanent = await harness({ fail: () => "permanent" });
    permanent.update({ advancing: true }, 0);
    permanent.update({ target: null }, 5_000);
    await settle();
    permanent.tracker.heartbeat(30_000);
    await settle();
    expect(permanent.sent).toHaveLength(1);
    expect(permanent.tracker.pendingSessionCount()).toBe(0);

    const transient = await harness({ fail: () => new Error("offline") });
    transient.update({ advancing: true }, 0);
    transient.update({ target: null }, 5_000);
    for (let tick = 1; tick <= LISTENING_MAX_SEND_ATTEMPTS + 2; tick += 1) {
      await settle();
      transient.tracker.heartbeat(tick * 20_000);
    }
    await settle();
    expect(transient.sent).toHaveLength(LISTENING_MAX_SEND_ATTEMPTS);
    expect(transient.tracker.pendingSessionCount()).toBe(0);
  });

  it("never sends an old principal's unsent time after the server or account changes", async () => {
    const { tracker, sent, update } = await harness({ fail: () => new Error("offline") });
    update({ advancing: true }, 0);
    update({ advancing: false }, 9_000);
    await settle();
    update({ scope: "https%3A%2F%2Fkikoto.example.invalid:user-8", target: null }, 10_000);
    tracker.heartbeat(30_000);
    tracker.flush({ keepalive: true });
    await settle();

    expect(sent).toHaveLength(1);
    expect(tracker.pendingSessionCount()).toBe(0);
  });

  it("skips recording without a recordable scope or resolved work", async () => {
    const { tracker, sent, update } = await harness();
    update({ scope: null, advancing: true }, 0);
    update({ scope: null, advancing: false }, 30_000);
    update({ target: null, advancing: true }, 30_000);
    update({ target: null, advancing: false }, 60_000);
    tracker.heartbeat(90_000);
    await settle();
    expect(sent).toHaveLength(0);
  });

  it("keeps one ordinary report in flight per session and follows up with the latest total", async () => {
    const { tracker, sent, pending, update, holdResponses } = await harness();
    holdResponses();
    update({ advancing: true }, 0);
    tracker.heartbeat(LISTENING_HEARTBEAT_MS);
    tracker.heartbeat(LISTENING_HEARTBEAT_MS * 2);
    tracker.heartbeat(LISTENING_HEARTBEAT_MS * 3);
    // A slow server does not accumulate a new request every heartbeat.
    expect(sent.map((report) => report.listenedSeconds)).toEqual([15]);

    update({ advancing: false }, LISTENING_HEARTBEAT_MS * 3 + 2_000);
    expect(sent).toHaveLength(1);
    pending[0].resolve();
    await settle();
    // The paused session sends one follow-up carrying everything credited meanwhile.
    expect(sent.map(({ sessionId, listenedSeconds }) => [sessionId, listenedSeconds])).toEqual([
      ["session-1", 15],
      ["session-1", 47],
    ]);
    pending[1].resolve();
    await settle();
    tracker.heartbeat(LISTENING_HEARTBEAT_MS * 5);
    await settle();
    expect(sent).toHaveLength(2);
  });

  it("lets only one page-hide report overlap a pending report", async () => {
    const { tracker, sent, update, holdResponses } = await harness();
    holdResponses();
    update({ advancing: true }, 0);
    tracker.heartbeat(LISTENING_HEARTBEAT_MS);
    tracker.observe(20_000);
    tracker.flush({ keepalive: true });
    tracker.observe(25_000);
    tracker.flush({ keepalive: true });
    expect(sent.map(({ listenedSeconds, keepalive }) => [listenedSeconds, keepalive])).toEqual([
      [15, false],
      [20, true],
    ]);
  });

  it("keeps the larger acknowledged total when an older response arrives late", async () => {
    const { tracker, sent, pending, update, holdResponses } = await harness();
    holdResponses();
    update({ advancing: true }, 0);
    tracker.heartbeat(LISTENING_HEARTBEAT_MS);
    tracker.observe(30_000);
    tracker.flush({ keepalive: true });
    expect(sent.map((report) => report.listenedSeconds)).toEqual([15, 30]);

    pending[1].resolve();
    await settle();
    pending[0].resolve();
    await settle();
    update({ advancing: false }, 30_000);
    tracker.flush({ keepalive: true });
    await settle();
    // 30 s was acknowledged, so the late 15 s response does not trigger a resend.
    expect(sent).toHaveLength(2);
  });

  it("flushes a keepalive report when the page is hidden mid-play", async () => {
    const { tracker, sent, update } = await harness();
    update({ advancing: true }, 0);
    tracker.observe(4_000);
    tracker.flush({ keepalive: true });
    await settle();
    expect(sent).toEqual([{ generation: 0, sessionId: "session-1", workId: 11, listenedSeconds: 4, keepalive: true }]);
  });

  it("rolls a full day of listening into a new session instead of stopping the count", async () => {
    const { tracker, sent, update } = await harness();
    update({ advancing: true }, 0);
    for (let now = 30_000; now <= 86_400_000 + 90_000; now += 30_000) tracker.observe(now);
    expect(tracker.currentSessionId()).toBe("session-2");
    expect(tracker.currentListenedSeconds()).toBe(90);
    update({ advancing: false }, 86_400_000 + 90_000);
    await settle();
    expect(sent.map(({ sessionId, listenedSeconds }) => [sessionId, listenedSeconds])).toEqual([
      ["session-1", 86_400],
      ["session-2", 90],
    ]);
  });

  it("bounds how many closed sessions wait for a retry", async () => {
    const { tracker, update } = await harness({ fail: () => new Error("offline") });
    for (let index = 0; index < LISTENING_MAX_PENDING_SESSIONS + 5; index += 1) {
      update({ target: { activationKey: `queue-item-${index}`, workId: 11 }, advancing: true }, index * 10_000);
      update(
        { target: { activationKey: `queue-item-${index}`, workId: 11 }, advancing: false },
        index * 10_000 + 5_000,
      );
    }
    await settle();
    expect(tracker.pendingSessionCount()).toBeLessThanOrEqual(LISTENING_MAX_PENDING_SESSIONS + 1);
  });
});

describe("clearing listening history", () => {
  it("drops the playing session unreported and continues counting under the new generation", async () => {
    const { tracker, sent, server, clock, update } = await harness();
    update({ advancing: true }, 0);
    tracker.observe(9_000);
    server.generation = 1;
    tracker.discardHistory(9_000);

    // Nothing is measured until the new generation is known.
    expect(tracker.currentSessionId()).toBeNull();
    expect(tracker.pendingSessionCount()).toBe(0);
    clock.now = 10_000;
    await settle();
    expect(tracker.currentSessionId()).toBe("session-2");
    expect(tracker.currentListenedSeconds()).toBe(0);
    tracker.heartbeat(10_000 + LISTENING_HEARTBEAT_MS);
    await settle();
    expect(sent).toEqual([
      { generation: 1, sessionId: "session-2", workId: 11, listenedSeconds: 15, keepalive: false },
    ]);
  });

  it("does not open a session when playback was paused at the clear", async () => {
    const { tracker, sent, server, update } = await harness({ fail: () => new Error("offline") });
    update({ advancing: true }, 0);
    update({ advancing: false }, 6_000);
    await settle();
    server.generation = 1;
    tracker.discardHistory(7_000);
    await settle();
    expect(tracker.pendingSessionCount()).toBe(0);
    tracker.heartbeat(30_000);
    tracker.flush({ keepalive: true });
    await settle();
    // The failed pre-clear report is never retried.
    expect(sent.map((report) => report.sessionId)).toEqual(["session-1"]);
    expect(tracker.currentGeneration()).toBe(1);
  });

  it("ignores a pre-clear report that completes after the clear", async () => {
    const { tracker, sent, pending, server, clock, update, holdResponses } = await harness();
    holdResponses();
    update({ advancing: true }, 0);
    tracker.heartbeat(LISTENING_HEARTBEAT_MS);
    update({ target: trackB, advancing: true }, 20_000);
    server.generation = 1;
    clock.now = 21_000;
    tracker.discardHistory(21_000);
    pending[0].resolve();
    await settle();
    tracker.heartbeat(21_000 + LISTENING_HEARTBEAT_MS);
    expect(sent.map(({ generation, sessionId, listenedSeconds }) => [generation, sessionId, listenedSeconds])).toEqual([
      [0, "session-1", 15],
      [1, "session-3", 15],
    ]);
  });

  it("never replays a pre-clear interval on page hide, even after the new generation arrives", async () => {
    const { tracker, sent, server, clock, lookups, pendingLookups, update, holdLookups } = await harness();
    update({ advancing: true }, 0);
    tracker.observe(9_000);
    holdLookups();
    server.generation = 1;
    tracker.discardHistory(9_000);
    tracker.observe(12_000);
    tracker.flush({ keepalive: true });
    expect(sent).toEqual([]);

    clock.now = 12_000;
    pendingLookups[0].resolve(1);
    await settle();
    tracker.observe(16_000);
    tracker.flush({ keepalive: true });
    await settle();
    // Only time measured after the new generation arrived is reported under it.
    expect(sent).toEqual([{ generation: 1, sessionId: "session-2", workId: 11, listenedSeconds: 4, keepalive: true }]);
    expect(lookups).toEqual([scope, scope]);
  });

  it("keeps counting when the announcement of a clear arrives after a rejected report already handled it", async () => {
    const { tracker, sent, server, clock, lookups, update } = await harness();
    update({ advancing: true }, 0);
    tracker.heartbeat(LISTENING_HEARTBEAT_MS);
    await settle();

    // Another tab clears history; this tracker's next report is rejected and it refreshes to 1.
    server.generation = 1;
    clock.now = 30_000;
    tracker.heartbeat(30_000);
    await settle();
    expect(tracker.currentGeneration()).toBe(1);

    // The same clear's announcement arrives late. The server is still at 1.
    clock.now = 35_000;
    tracker.discardHistory(35_000);
    await settle();
    expect(tracker.currentGeneration()).toBe(1);
    tracker.heartbeat(35_000 + LISTENING_HEARTBEAT_MS);
    await settle();
    expect(sent.map(({ generation, sessionId, listenedSeconds }) => [generation, sessionId, listenedSeconds])).toEqual([
      [0, "session-1", 15],
      [0, "session-1", 30],
      [1, "session-3", 15],
    ]);
    expect(lookups).toEqual([scope, scope, scope]);
  });

  it("refreshes to the server's current generation after each of two clears and ignores the older lookup", async () => {
    const { tracker, sent, server, clock, pendingLookups, update, holdLookups } = await harness();
    update({ advancing: true }, 0);
    holdLookups();
    server.generation = 1;
    tracker.discardHistory(1_000);
    server.generation = 2;
    tracker.discardHistory(2_000);

    // The first clear's lookup completes last and must not establish generation 1.
    clock.now = 3_000;
    pendingLookups[1].resolve(2);
    await settle();
    pendingLookups[0].resolve(1);
    await settle();
    expect(tracker.currentGeneration()).toBe(2);
    tracker.heartbeat(3_000 + LISTENING_HEARTBEAT_MS);
    await settle();
    expect(sent.map(({ generation, listenedSeconds }) => [generation, listenedSeconds])).toEqual([[2, 15]]);
  });

  it("does not accept a lookup below the generation already known when a clear is announced", async () => {
    const { tracker, clock, pendingLookups, update, holdLookups } = await harness({ generation: 4 });
    holdLookups();
    update({ advancing: true }, 0);
    tracker.discardHistory(1_000);
    pendingLookups[0].resolve(3);
    await settle();
    expect(tracker.currentGeneration()).toBeNull();

    clock.now = 20_000;
    tracker.heartbeat(20_000);
    pendingLookups[1].resolve(5);
    await settle();
    expect(tracker.currentGeneration()).toBe(5);
  });
});

describe("history generation", () => {
  it("looks up the generation before measuring and reports every interval under it", async () => {
    const { tracker, sent, clock, lookups, pendingLookups, update, holdLookups } = await harness({
      establish: false,
      generation: 3,
    });
    holdLookups();
    update({ advancing: true }, 0);
    update({ advancing: true }, 5_000);
    tracker.heartbeat(LISTENING_HEARTBEAT_MS);
    tracker.flush({ keepalive: true });
    // Concurrent needs share one lookup, and nothing is measured or sent meanwhile.
    expect(lookups).toEqual([scope]);
    expect(tracker.currentListenedSeconds()).toBe(0);
    expect(sent).toEqual([]);

    clock.now = 20_000;
    pendingLookups[0].resolve(3);
    await settle();
    tracker.heartbeat(20_000 + LISTENING_HEARTBEAT_MS);
    await settle();
    expect(sent).toEqual([
      { generation: 3, sessionId: "session-1", workId: 11, listenedSeconds: 15, keepalive: false },
    ]);
  });

  it("measures nothing from an invalid generation response", async () => {
    const { tracker, sent, pendingLookups, update, holdLookups } = await harness({ establish: false });
    holdLookups();
    update({ advancing: true }, 0);
    pendingLookups[0].resolve({ ok: true });
    await settle();
    tracker.heartbeat(LISTENING_HEARTBEAT_MS);
    expect(tracker.currentGeneration()).toBeNull();
    expect(sent).toEqual([]);
  });

  it("retries a failed lookup with bounded backoff while media advances", async () => {
    const { tracker, sent, clock, lookups, update, failLookups } = await harness({ establish: false });
    failLookups(new Error("offline"));
    update({ advancing: true }, 0);
    await settle();
    for (let now = LISTENING_HEARTBEAT_MS; now <= 10 * 60_000; now += LISTENING_HEARTBEAT_MS) {
      clock.now = now;
      tracker.heartbeat(now);
      await settle();
    }
    // 40 heartbeats produce only a handful of lookups, spaced further apart each time.
    expect(lookups.length).toBeGreaterThanOrEqual(3);
    expect(lookups.length).toBeLessThanOrEqual(8);
    expect(sent).toEqual([]);

    failLookups(undefined);
    const next = 10 * 60_000 + LISTENING_GENERATION_RETRY_MAX_MS;
    clock.now = next;
    tracker.heartbeat(next);
    await settle();
    tracker.heartbeat(next + LISTENING_HEARTBEAT_MS);
    await settle();
    expect(sent.map(({ generation, listenedSeconds }) => [generation, listenedSeconds])).toEqual([[0, 15]]);
  });

  it("stops looking up after a permanent failure until the scope changes", async () => {
    const { tracker, clock, lookups, update, failLookups } = await harness({ establish: false });
    failLookups("permanent");
    update({ advancing: true }, 0);
    await settle();
    clock.now = 60 * 60_000;
    tracker.heartbeat(60 * 60_000);
    expect(lookups).toHaveLength(1);

    const nextScope = "https%3A%2F%2Fkikoto.example.invalid:user-8";
    update({ scope: nextScope, advancing: true }, 60 * 60_000);
    expect(lookups).toEqual([scope, nextScope]);
  });

  it("drops every interval after another device clears history and continues under the new generation", async () => {
    const { tracker, sent, server, clock, lookups, update } = await harness();
    update({ advancing: true }, 0);
    tracker.heartbeat(LISTENING_HEARTBEAT_MS);
    await settle();
    update({ target: trackB, advancing: true }, 20_000);

    // Another device clears history; this client learns of it only from the rejected report.
    server.generation = 1;
    clock.now = 35_000;
    tracker.heartbeat(35_000);
    await settle();
    expect(tracker.pendingSessionCount()).toBe(1);
    expect(tracker.currentGeneration()).toBe(1);

    tracker.heartbeat(35_000 + LISTENING_HEARTBEAT_MS);
    await settle();
    tracker.heartbeat(35_000 + LISTENING_HEARTBEAT_MS * 3);
    await settle();
    expect(sent.map(({ generation, sessionId, listenedSeconds }) => [generation, sessionId, listenedSeconds])).toEqual([
      [0, "session-1", 15],
      [0, "session-1", 20],
      [0, "session-2", 15],
      [1, "session-3", 15],
      [1, "session-3", 45],
    ]);
    // One rejected report refreshes the generation once; the stale session is never resent.
    expect(lookups).toEqual([scope, scope]);
  });

  it("accepts only a newer generation after a report is rejected as stale", async () => {
    const { tracker, sent, server, clock, lookups, pendingLookups, update, holdLookups } = await harness({
      generation: 4,
    });
    update({ advancing: true }, 0);
    holdLookups();
    server.generation = 5;
    clock.now = LISTENING_HEARTBEAT_MS;
    tracker.heartbeat(LISTENING_HEARTBEAT_MS);
    await settle();
    // A read that still shows the rejected generation backs off like a failed lookup.
    pendingLookups[0].resolve(4);
    await settle();
    expect(tracker.currentGeneration()).toBeNull();
    tracker.heartbeat(16_000);
    expect(lookups).toHaveLength(2);

    clock.now = 25_000;
    tracker.heartbeat(25_000);
    expect(lookups).toHaveLength(3);
    pendingLookups[1].resolve(5);
    await settle();
    tracker.heartbeat(25_000 + LISTENING_HEARTBEAT_MS);
    expect(sent.map(({ generation, listenedSeconds }) => [generation, listenedSeconds])).toEqual([
      [4, 15],
      [5, 15],
    ]);
  });

  it("refreshes once when several stale reports are rejected together", async () => {
    const { tracker, sent, server, clock, lookups, update } = await harness();
    server.generation = 2;
    for (let index = 0; index < 3; index += 1) {
      update({ target: { activationKey: `queue-item-${index}`, workId: 11 }, advancing: true }, index * 10_000);
    }
    clock.now = 30_000;
    update({ target: null, advancing: false }, 30_000);
    await settle();
    expect(sent.filter((report) => report.generation === 0)).toHaveLength(3);
    expect(lookups).toEqual([scope, scope]);
    expect(tracker.pendingSessionCount()).toBe(0);
    expect(tracker.currentGeneration()).toBe(2);
  });

  it("ignores lookups and rejected reports that belong to an earlier scope", async () => {
    const nextScope = "https%3A%2F%2Fkikoto.example.invalid:user-8";
    const { tracker, sent, sentScopes, pending, lookups, pendingLookups, clock, update, holdResponses, holdLookups } =
      await harness();
    holdResponses();
    update({ advancing: true }, 0);
    tracker.heartbeat(LISTENING_HEARTBEAT_MS);
    holdLookups();
    update({ scope: nextScope, advancing: true }, 16_000);
    expect(lookups).toEqual([scope, nextScope]);

    // The old principal's report is rejected as stale after the switch: no new lookup, no resend.
    pending[0].reject("cleared");
    await settle();
    expect(lookups).toEqual([scope, nextScope]);

    clock.now = 17_000;
    pendingLookups[0].resolve(6);
    await settle();
    tracker.heartbeat(17_000 + LISTENING_HEARTBEAT_MS);
    expect(sent.map(({ generation, sessionId, listenedSeconds }) => [generation, sessionId, listenedSeconds])).toEqual([
      [0, "session-1", 15],
      [6, "session-2", 15],
    ]);
    expect(sentScopes).toEqual([scope, nextScope]);
  });

  it("ignores a generation lookup that completes after the scope changed", async () => {
    const nextScope = "https%3A%2F%2Fkikoto.example.invalid:user-8";
    const { tracker, sent, pendingLookups, clock, update, holdLookups } = await harness({
      establish: false,
      generation: 1,
    });
    holdLookups();
    update({ advancing: true }, 0);
    update({ scope: nextScope, advancing: true }, 1_000);
    pendingLookups[0].resolve(9);
    await settle();
    expect(tracker.currentGeneration()).toBeNull();
    clock.now = 2_000;
    pendingLookups[1].resolve(1);
    await settle();
    tracker.heartbeat(2_000 + LISTENING_HEARTBEAT_MS);
    expect(sent.map(({ generation }) => generation)).toEqual([1]);
  });

  it("ignores every response after disposal", async () => {
    const { tracker, sent, lookups, pendingLookups, update, holdLookups } = await harness({ establish: false });
    holdLookups();
    update({ advancing: true }, 0);
    tracker.dispose();
    pendingLookups[0].resolve(0);
    await settle();
    tracker.heartbeat(60_000);
    expect(lookups).toHaveLength(1);
    expect(sent).toEqual([]);
  });
});

describe("media advancing state", () => {
  it("counts only playing media with enough data and no seek in progress", () => {
    const playing = { paused: false, ended: false, seeking: false, readyState: 4 };
    expect(isMediaAdvancing(playing)).toBe(true);
    expect(isMediaAdvancing({ ...playing, paused: true })).toBe(false);
    expect(isMediaAdvancing({ ...playing, seeking: true })).toBe(false);
    expect(isMediaAdvancing({ ...playing, readyState: 2 })).toBe(false);
    expect(isMediaAdvancing({ ...playing, ended: true })).toBe(false);
    expect(isMediaAdvancing(null)).toBe(false);
  });
});
