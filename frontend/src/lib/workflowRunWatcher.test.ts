import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/serverConfig", () => ({
  getStoredServerURL: () => "",
  getStoredSessionToken: () => "",
  isNativeApp: () => false,
}));
vi.mock("@/lib/mobileDiagnostics", () => ({ recordApiError: () => {} }));

import { apiSessionVersion, changeApiSession } from "./apiSession";
import { refreshWorkflowRun, subscribeToRun, workflowRunSettled, type WorkflowRunSnapshot } from "./workflowRunWatcher";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function network() {
  let status = 200;
  const fetch = vi.fn(async (url: string | URL | Request) => {
    if (status !== 200) return response({ error: "Example access failure" }, status);
    const path = String(url);
    if (path.includes("/events")) return response([{ id: 1, message: "Example private event" }]);
    if (path.endsWith("/candidates")) return response([{ id: 1, title: "Example private candidate" }]);
    return response({ id: 71, status: "succeeded", candidateCount: 1, summaryJson: "Example private summary" });
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, deny: (next: number) => (status = next) };
}

async function settle() {
  for (let step = 0; step < 30; step += 1) await Promise.resolve();
}

describe("workflow run session and access boundaries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      location: { origin: "https://app.example.invalid" },
    });
    vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: false }));
    changeApiSession();
  });
  afterEach(() => {
    changeApiSession();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not resolve a new session from the preceding account's cached terminal run", async () => {
    const remote = network();
    await expect(workflowRunSettled(71)).resolves.toMatchObject({ id: 71 });
    await settle();
    changeApiSession();
    remote.deny(403);
    await expect(workflowRunSettled(71)).rejects.toThrow("Example access failure");
  });

  it("clears subscribed private data synchronously on a session change", async () => {
    network();
    let snapshot: WorkflowRunSnapshot | undefined;
    const unsubscribe = subscribeToRun(71, false, (next) => (snapshot = next));
    await refreshWorkflowRun(71);
    expect(snapshot?.events).toHaveLength(1);
    expect(snapshot?.candidates).toHaveLength(1);
    changeApiSession();
    expect(snapshot).toMatchObject({ run: null, events: [], candidates: [] });
    unsubscribe();
  });

  for (const status of [401, 403, 404]) {
    it(`forgets cached protected data after HTTP ${status}`, async () => {
      const remote = network();
      let snapshot: WorkflowRunSnapshot | undefined;
      const unsubscribe = subscribeToRun(71, false, (next) => (snapshot = next));
      await refreshWorkflowRun(71);
      expect(snapshot?.run).not.toBeNull();
      remote.deny(status);
      await refreshWorkflowRun(71);
      expect(snapshot).toMatchObject({ run: null, events: [], candidates: [], error: "Example access failure" });
      unsubscribe();
    });
  }

  it("keeps a same-session snapshot through a retryable server failure", async () => {
    const remote = network();
    let snapshot: WorkflowRunSnapshot | undefined;
    const unsubscribe = subscribeToRun(71, false, (next) => (snapshot = next));
    await refreshWorkflowRun(71);
    remote.deny(503);
    await refreshWorkflowRun(71);
    expect(snapshot).toMatchObject({ run: { id: 71 }, events: [{ message: "Example private event" }] });
    unsubscribe();
  });

  it("rejects a pending settlement when the account changes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const previous = apiSessionVersion();
    const waiting = workflowRunSettled(71);
    const result = expect(waiting).rejects.toThrow("session");
    changeApiSession();
    expect(apiSessionVersion()).toBeGreaterThan(previous);
    await result;
  });

  it("drops a late response without publishing the previous session into a replacement subscription", async () => {
    let release!: (body: Response) => void;
    const held = new Promise<Response>((resolve) => (release = resolve));
    const oldFetch = vi.fn(() => held);
    vi.stubGlobal("fetch", oldFetch);
    const previousSnapshots: WorkflowRunSnapshot[] = [];
    const previous = subscribeToRun(71, false, (snapshot) => previousSnapshots.push(snapshot));
    await settle();
    expect(oldFetch).toHaveBeenCalled();
    changeApiSession();
    network();
    let current: WorkflowRunSnapshot | undefined;
    const unsubscribe = subscribeToRun(71, false, (snapshot) => (current = snapshot));
    await refreshWorkflowRun(71);
    const oldSnapshotCount = previousSnapshots.length;
    release(response({ id: 71, status: "succeeded", candidateCount: 0, summaryJson: "Previous session" }));
    await settle();
    expect(previousSnapshots).toHaveLength(oldSnapshotCount);
    expect(current?.run?.summaryJson).toBe("Example private summary");
    previous();
    unsubscribe();
  });

  it("clears access on a rejected event stream and does not restart polling", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const path = String(url);
        if (path.includes("/events/stream")) return response({ error: "Example stream access failure" }, 403);
        if (path.includes("/events")) return response([{ id: 1, message: "Example private event" }]);
        return response({ id: 71, status: "running", candidateCount: 0, summaryJson: "Example private summary" });
      }),
    );
    let snapshot: WorkflowRunSnapshot | undefined;
    const unsubscribe = subscribeToRun(71, true, (next) => (snapshot = next));
    await refreshWorkflowRun(71);
    await settle();
    expect(snapshot).toMatchObject({ run: null, events: [], candidates: [], error: "Example stream access failure" });
    const calls = vi.mocked(fetch).mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
    unsubscribe();
  });

  it("cancels an open event stream when a refresh denies access", async () => {
    let streamCancelled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const path = String(url);
        if (path.includes("/events/stream")) {
          return new Response(
            new ReadableStream({
              cancel() {
                streamCancelled = true;
              },
            }),
            {
              headers: { "Content-Type": "text/event-stream" },
            },
          );
        }
        if (path.includes("/events")) return response([]);
        return response({ id: 71, status: "running", candidateCount: 0, summaryJson: "Example private summary" });
      }),
    );
    let snapshot: WorkflowRunSnapshot | undefined;
    const unsubscribe = subscribeToRun(71, true, (next) => (snapshot = next));
    await refreshWorkflowRun(71);
    await settle();
    expect(snapshot?.run?.id).toBe(71);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ error: "Example access failure" }, 404)),
    );
    await refreshWorkflowRun(71);
    await settle();
    expect(streamCancelled).toBe(true);
    expect(snapshot).toMatchObject({ run: null, events: [], candidates: [] });
    unsubscribe();
  });
});
