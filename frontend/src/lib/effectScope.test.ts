import { afterEach, describe, expect, it, vi } from "vitest";

import { createEffectScope, startLoad } from "@/lib/effectScope";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function handlers() {
  return { onSuccess: vi.fn(), onError: vi.fn(), onSettled: vi.fn() };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("effect loads", () => {
  it("reports a current load's result, then settles", async () => {
    const reported = handlers();
    startLoad(() => Promise.resolve("loaded"), reported);
    await vi.waitFor(() => expect(reported.onSettled).toHaveBeenCalledOnce());
    expect(reported.onSuccess).toHaveBeenCalledWith("loaded");
    expect(reported.onError).not.toHaveBeenCalled();
  });

  it("reports a current load's failure", async () => {
    const reported = handlers();
    const failure = new Error("unavailable");
    startLoad(() => Promise.reject(failure), reported);
    await vi.waitFor(() => expect(reported.onError).toHaveBeenCalledWith(failure));
    expect(reported.onSettled).toHaveBeenCalledOnce();
  });

  it.each(["result", "failure"] as const)("drops the %s of a cancelled load and aborts its signal", async (outcome) => {
    const pending = deferred<string>();
    const signals: AbortSignal[] = [];
    const reported = handlers();
    const cancel = startLoad((signal) => {
      signals.push(signal);
      return pending.promise;
    }, reported);
    cancel();
    expect(signals[0].aborted).toBe(true);
    if (outcome === "result") pending.resolve("stale");
    else pending.reject(new Error("stale"));
    await pending.promise.catch(() => undefined);
    await Promise.resolve();
    expect(reported.onSuccess).not.toHaveBeenCalled();
    expect(reported.onError).not.toHaveBeenCalled();
    expect(reported.onSettled).not.toHaveBeenCalled();
  });

  it("sends a delayed load only after its wait, and nothing once cancelled during it", () => {
    vi.useFakeTimers();
    const load = vi.fn(() => new Promise<never>(() => undefined));
    startLoad(load, {}, { delayMs: 500 });
    vi.advanceTimersByTime(499);
    expect(load).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(load).toHaveBeenCalledOnce();

    const cancelledLoad = vi.fn(() => new Promise<never>(() => undefined));
    const cancel = startLoad(cancelledLoad, {}, { delayMs: 500 });
    vi.advanceTimersByTime(250);
    cancel();
    vi.advanceTimersByTime(500);
    expect(cancelledLoad).not.toHaveBeenCalled();
  });
});

describe("effect listeners", () => {
  it("removes a listener on cancel, including one that registers afterwards", async () => {
    const scope = createEffectScope();
    const remove = vi.fn();
    scope.listen(() => Promise.resolve("registered"), remove);
    const late = deferred<string>();
    scope.listen(() => late.promise, remove);
    await Promise.resolve();
    await Promise.resolve();
    expect(remove).not.toHaveBeenCalled();

    scope.cancel();
    expect(remove).toHaveBeenCalledWith("registered");
    late.resolve("late");
    await late.promise;
    await Promise.resolve();
    expect(remove).toHaveBeenCalledWith("late");
    expect(remove).toHaveBeenCalledTimes(2);
  });
});
