import { describe, expect, it, vi } from "vitest";

import { createSpeakerPlaybackGuard } from "./speakerPlaybackGuard";

function setup({ enabled = true, queried = null as boolean | null } = {}) {
  const callbacks = {
    queryPhoneSpeaker: vi.fn(async () => queried),
    requestConfirmation: vi.fn(),
    dismissConfirmation: vi.fn(),
    replay: vi.fn(),
  };
  const guard = createSpeakerPlaybackGuard({ isEnabled: () => enabled, ...callbacks });
  return { guard, ...callbacks };
}

describe("speaker playback guard", () => {
  it("allows every start when the setting is off", () => {
    const { guard, requestConfirmation } = setup({ enabled: false });
    guard.initializeOutput(true);

    expect(guard.allowStart()).toBe(true);
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it("allows starts through headphones", () => {
    const { guard } = setup();
    guard.initializeOutput(false);

    expect(guard.allowStart()).toBe(true);
  });

  it("holds a speaker start until confirmed, then keeps the confirmation for the speaker period", () => {
    const { guard, requestConfirmation, replay } = setup();
    guard.initializeOutput(true);

    expect(guard.allowStart()).toBe(false);
    expect(requestConfirmation).toHaveBeenCalledTimes(1);

    guard.confirm();
    expect(replay).toHaveBeenCalledTimes(1);
    expect(guard.allowStart()).toBe(true);
    expect(guard.allowStart()).toBe(true);
  });

  it("asks again after an output connects and disconnects", () => {
    const { guard, dismissConfirmation } = setup();
    guard.initializeOutput(true);
    guard.allowStart();
    guard.confirm();

    guard.outputChanged(false);
    expect(dismissConfirmation).toHaveBeenCalled();
    expect(guard.allowStart()).toBe(true);

    guard.outputChanged(true);
    expect(guard.allowStart()).toBe(false);
  });

  it("checks an unknown output before playing and replays when it is not the speaker", async () => {
    const { guard, queryPhoneSpeaker, requestConfirmation, replay } = setup({ queried: false });

    expect(guard.allowStart()).toBe(false);
    await vi.waitFor(() => expect(replay).toHaveBeenCalledTimes(1));
    expect(queryPhoneSpeaker).toHaveBeenCalledTimes(1);
    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(guard.allowStart()).toBe(true);
  });

  it("asks when the output stays unknown", async () => {
    const { guard, requestConfirmation, replay } = setup({ queried: null });

    expect(guard.allowStart()).toBe(false);
    await vi.waitFor(() => expect(requestConfirmation).toHaveBeenCalledTimes(1));
    expect(replay).not.toHaveBeenCalled();
  });
});
