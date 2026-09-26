import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { announceListeningHistoryCleared, subscribeListeningHistoryCleared } from "./listeningHistoryEvents";

const scope = "https%3A%2F%2Fkikoto.example.invalid:user-1";
const otherAccount = "https%3A%2F%2Fkikoto.example.invalid:user-2";

const delivery = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("listening history cleared announcements", () => {
  beforeEach(() => {
    vi.stubGlobal("window", new EventTarget());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reaches players of the same server and account exactly once in the announcing tab", async () => {
    const sameAccount = vi.fn();
    const differentAccount = vi.fn();
    const unsubscribeSame = subscribeListeningHistoryCleared(scope, sameAccount);
    const unsubscribeOther = subscribeListeningHistoryCleared(otherAccount, differentAccount);

    announceListeningHistoryCleared(scope);
    await delivery();

    expect(sameAccount).toHaveBeenCalledOnce();
    expect(differentAccount).not.toHaveBeenCalled();
    unsubscribeSame();
    unsubscribeOther();
  });

  it("reaches another tab through the broadcast channel", async () => {
    const otherTab = new BroadcastChannel("kikoto:listening-history");
    const received = new Promise((resolve) => {
      otherTab.onmessage = (event) => resolve(event.data);
    });
    announceListeningHistoryCleared(scope);
    await expect(received).resolves.toMatchObject({ type: "cleared", scope });
    otherTab.close();
  });

  it("stops notifying after unsubscribe", async () => {
    const listener = vi.fn();
    subscribeListeningHistoryCleared(scope, listener)();
    announceListeningHistoryCleared(scope);
    await delivery();
    expect(listener).not.toHaveBeenCalled();
  });
});
