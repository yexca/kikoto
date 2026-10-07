import { describe, expect, it, vi } from "vitest";

import {
  coalesceRuns,
  combineAbortSignals,
  createInflightRequests,
  ResourceInvalidatedError,
  retryInvalidatedRequest,
} from "@/lib/inflightRequests";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function abortable<T>() {
  const pending = deferred<T>();
  const signals: AbortSignal[] = [];
  const request = vi.fn((signal: AbortSignal) => {
    signals.push(signal);
    signal.addEventListener("abort", () => pending.reject(signal.reason), { once: true });
    return pending.promise;
  });
  return { pending, signals, request };
}

describe("request cancellation lifetimes", () => {
  it.each(["session", "caller"] as const)("preserves the %s cancellation reason", (source) => {
    const session = new AbortController();
    const caller = new AbortController();
    const linked = combineAbortSignals(session.signal, caller.signal);
    const reason = new Error(`${source} cancelled the request`);
    (source === "session" ? session : caller).abort(reason);
    expect(linked.signal.reason).toBe(reason);
    expect((source === "session" ? caller : session).signal.aborted).toBe(false);
    linked.dispose();
  });

  it("releases cancellation listeners when a request finishes", () => {
    const session = new AbortController();
    const caller = new AbortController();
    const linked = combineAbortSignals(session.signal, caller.signal);
    linked.dispose();
    session.abort();
    caller.abort();
    expect(linked.signal.aborted).toBe(false);
  });
});

describe("createInflightRequests", () => {
  it("shares one request between concurrent callers with the same key", async () => {
    const inflight = createInflightRequests();
    const { pending, request } = abortable<string>();

    const first = inflight.run("work:1", request);
    const second = inflight.run("work:1", request);
    pending.resolve("detail");

    await expect(Promise.all([first, second])).resolves.toEqual(["detail", "detail"]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps different keys independent", async () => {
    const inflight = createInflightRequests();
    const request = vi.fn(async (_signal: AbortSignal) => "detail");

    await Promise.all([inflight.run("work:1", request), inflight.run("work:2", request)]);

    expect(request).toHaveBeenCalledTimes(2);
  });

  it("forgets a request once it settles instead of caching it", async () => {
    const inflight = createInflightRequests();
    const request = vi.fn(async (_signal: AbortSignal) => "detail");

    await inflight.run("work:1", request);
    expect(inflight.size()).toBe(0);
    await inflight.run("work:1", request);

    expect(request).toHaveBeenCalledTimes(2);
  });

  it("shares a failure with every caller and then forgets it", async () => {
    const inflight = createInflightRequests();
    const { pending, request } = abortable<string>();

    const first = inflight.run("work:1", request);
    const second = inflight.run("work:1", request);
    pending.reject(new Error("GET failed"));

    await expect(first).rejects.toThrow("GET failed");
    await expect(second).rejects.toThrow("GET failed");
    expect(inflight.size()).toBe(0);
  });

  it("rejects only the aborting caller and keeps the shared request running", async () => {
    const inflight = createInflightRequests();
    const { pending, signals, request } = abortable<string>();
    const aborting = new AbortController();

    const cancelled = inflight.run("work:1", request, aborting.signal);
    const remaining = inflight.run("work:1", request, new AbortController().signal);
    aborting.abort();

    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(signals[0].aborted).toBe(false);
    pending.resolve("detail");
    await expect(remaining).resolves.toBe("detail");
  });

  it("aborts the shared request only after every caller aborts", async () => {
    const inflight = createInflightRequests();
    const { signals, request } = abortable<string>();
    const first = new AbortController();
    const second = new AbortController();

    const firstResult = inflight.run("work:1", request, first.signal);
    const secondResult = inflight.run("work:1", request, second.signal);
    first.abort();
    expect(signals[0].aborted).toBe(false);
    second.abort();

    expect(signals[0].aborted).toBe(true);
    await expect(firstResult).rejects.toMatchObject({ name: "AbortError" });
    await expect(secondResult).rejects.toMatchObject({ name: "AbortError" });
    expect(inflight.size()).toBe(0);
  });

  it("never aborts a request that a caller without a signal still awaits", async () => {
    const inflight = createInflightRequests();
    const { pending, signals, request } = abortable<string>();
    const aborting = new AbortController();

    const unsignalled = inflight.run("work:1", request);
    const cancelled = inflight.run("work:1", request, aborting.signal);
    aborting.abort();

    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(signals[0].aborted).toBe(false);
    pending.resolve("detail");
    await expect(unsignalled).resolves.toBe("detail");
  });

  it("starts a fresh request after every earlier caller aborted", async () => {
    const inflight = createInflightRequests();
    const aborted = abortable<string>();
    const aborting = new AbortController();

    const cancelled = inflight.run("work:1", aborted.request, aborting.signal);
    aborting.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });

    const fresh = vi.fn(async (_signal: AbortSignal) => "fresh");
    await expect(inflight.run("work:1", fresh)).resolves.toBe("fresh");
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh request after forgetAll while earlier callers keep theirs", async () => {
    const inflight = createInflightRequests();
    const first = deferred<string>();
    const second = deferred<string>();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const before = inflight.run("work", request);
    inflight.forgetAll();
    const after = inflight.run("work", request);
    first.resolve("before write");
    second.resolve("after write");

    await expect(before).resolves.toBe("before write");
    await expect(after).resolves.toBe("after write");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects an already aborted caller without starting a request", async () => {
    const inflight = createInflightRequests();
    const request = vi.fn(async (_signal: AbortSignal) => "detail");
    const aborting = new AbortController();
    aborting.abort();

    await expect(inflight.run("work:1", request, aborting.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(request).not.toHaveBeenCalled();
  });

  it("evicts only affected resources without interrupting existing callers", async () => {
    const inflight = createInflightRequests();
    const old = abortable<string>();
    const other = abortable<string>();
    const before = inflight.run("work:1", old.request, undefined, ["work:1"]);
    const unaffected = inflight.run("work:2", other.request, undefined, ["work:2"]);
    inflight.forgetResources(["work:1"]);
    const fresh = inflight.run("work:1", async () => "new detail", undefined, ["work:1"]);
    const joined = inflight.run("work:2", other.request, undefined, ["work:2"]);

    expect(old.signals[0].aborted).toBe(false);
    old.pending.resolve("old detail");
    other.pending.resolve("other detail");
    await expect(Promise.all([before, fresh, unaffected, joined])).resolves.toEqual([
      "old detail",
      "new detail",
      "other detail",
      "other detail",
    ]);
    expect(other.request).toHaveBeenCalledOnce();
  });

  it("rejects forgotten reads on a session change even when the transport ignores abort", async () => {
    const inflight = createInflightRequests();
    const old = deferred<string>();
    const during = deferred<string>();
    const before = inflight.run("work", () => old.promise);
    inflight.forgetAll();
    const detached = inflight.run("work", () => during.promise);
    const reason = new DOMException("The session has changed.", "AbortError");
    inflight.invalidateAll(reason);

    await expect(before).rejects.toBe(reason);
    await expect(detached).rejects.toBe(reason);
    const after = inflight.run("work", async () => "current detail");
    old.resolve("stale detail");
    during.reject(new Error("stale failure"));
    await expect(after).resolves.toBe("current detail");
  });

  it("distinguishes resource invalidation from caller cancellation and preserves other resources", async () => {
    const inflight = createInflightRequests();
    const edited = abortable<string>();
    const other = abortable<string>();
    const settled = deferred<void>();
    const first = inflight.run("work:1", edited.request, undefined, ["work:1"]);
    const unaffected = inflight.run("work:2", other.request, undefined, ["work:2"]);
    inflight.invalidateResources(["work:1"], settled.promise);

    await expect(first).rejects.toMatchObject({ name: "ResourceInvalidatedError", settled: settled.promise });
    expect(edited.signals[0].reason).toBeInstanceOf(ResourceInvalidatedError);
    expect(other.signals[0].aborted).toBe(false);
    settled.resolve();
    other.pending.resolve("other directory");
    await expect(unaffected).resolves.toBe("other directory");
  });
});

describe("resource read recovery", () => {
  it("waits for the update then coalesces surviving callers into one fresh read", async () => {
    const inflight = createInflightRequests();
    const old = deferred<string>();
    const update = deferred<void>();
    const request = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue("fresh directory");
    const read = () => inflight.run("work", request, undefined, ["work"]);
    const first = retryInvalidatedRequest(read);
    const second = retryInvalidatedRequest(read);
    inflight.invalidateResources(["work"], update.promise);
    await Promise.resolve();
    expect(request).toHaveBeenCalledOnce();

    update.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual(["fresh directory", "fresh directory"]);
    expect(request).toHaveBeenCalledTimes(2);
    old.reject(new Error("old network failure"));
  });

  it("stops recovery immediately when the caller cancels while waiting for a write", async () => {
    const update = deferred<void>();
    const read = vi.fn().mockRejectedValue(new ResourceInvalidatedError(update.promise));
    const caller = new AbortController();
    const result = retryInvalidatedRequest(read, caller.signal);
    await Promise.resolve();
    const reason = new Error("Caller left the directory");
    caller.abort(reason);

    await expect(result).rejects.toBe(reason);
    update.resolve();
    expect(read).toHaveBeenCalledOnce();
  });

  it("bounds resource recovery and never retries an ordinary failure", async () => {
    const invalidated = vi.fn().mockRejectedValue(new ResourceInvalidatedError());
    await expect(retryInvalidatedRequest(invalidated)).rejects.toBeInstanceOf(ResourceInvalidatedError);
    expect(invalidated).toHaveBeenCalledTimes(3);

    const failure = new Error("Network request failed");
    const failed = vi.fn().mockRejectedValue(failure);
    await expect(retryInvalidatedRequest(failed)).rejects.toBe(failure);
    expect(failed).toHaveBeenCalledOnce();
  });
});

describe("coalesceRuns", () => {
  it("collapses calls made during a run into one trailing run", async () => {
    const gates = [deferred<void>(), deferred<void>()];
    let calls = 0;
    const task = vi.fn(() => gates[calls++].promise);
    const run = coalesceRuns(task);

    const first = run();
    await Promise.resolve();
    const second = run();
    const third = run();
    expect(second).toBe(third);
    expect(task).toHaveBeenCalledTimes(1);

    gates[0].resolve();
    await first;
    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(2));
    gates[1].resolve();
    await Promise.all([second, third]);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("runs the trailing refresh even when the earlier run failed", async () => {
    const failing = deferred<void>();
    const task = vi.fn().mockReturnValueOnce(failing.promise).mockResolvedValueOnce(undefined);
    const run = coalesceRuns(task);

    const first = run();
    await Promise.resolve();
    const trailing = run();
    failing.reject(new Error("GET failed"));

    await expect(first).rejects.toThrow("GET failed");
    await expect(trailing).resolves.toBeUndefined();
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("starts a fresh run once the previous one settled", async () => {
    const task = vi.fn(async () => undefined);
    const run = coalesceRuns(task);

    await run();
    await run();

    expect(task).toHaveBeenCalledTimes(2);
  });
});
