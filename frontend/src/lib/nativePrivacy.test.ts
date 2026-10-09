import { beforeEach, describe, expect, it, vi } from "vitest";

const isAndroidApp = vi.hoisted(() => vi.fn(() => false));
const plugin = vi.hoisted(() => ({
  getSettings: vi.fn(),
  setSettings: vi.fn(),
  outputStatus: vi.fn(),
  addListener: vi.fn(),
}));
const registerPlugin = vi.hoisted(() => vi.fn(() => plugin));

vi.mock("@capacitor/core", () => ({ registerPlugin }));
vi.mock("@/lib/serverConfig", () => ({ isAndroidApp }));

import {
  DEFAULT_NATIVE_PRIVACY_SETTINGS,
  getNativePrivacySettings,
  NATIVE_PRIVACY_SETTINGS_CHANGE_EVENT,
  nativeOutputIsPhoneSpeaker,
  normalizeNativePrivacySettings,
  updateNativePrivacySettings,
} from "./nativePrivacy";

describe("native privacy bridge", () => {
  beforeEach(() => {
    isAndroidApp.mockReset();
    isAndroidApp.mockReturnValue(false);
    for (const method of Object.values(plugin)) method.mockReset();
  });

  it("defaults to the protective settings", () => {
    expect(DEFAULT_NATIVE_PRIVACY_SETTINGS).toEqual({
      recentsShield: true,
      lockScreenContent: "hideCover",
      speakerConfirm: true,
      screenSecure: false,
      appLock: false,
      appLockTimeoutSeconds: 0,
    });
    expect(
      normalizeNativePrivacySettings({
        recentsShield: "no",
        lockScreenContent: "everything",
        appLockTimeoutSeconds: 30,
      }),
    ).toEqual(DEFAULT_NATIVE_PRIVACY_SETTINGS);
    const chosen = {
      recentsShield: false,
      lockScreenContent: "hidden",
      speakerConfirm: false,
      screenSecure: true,
      appLock: true,
      appLockTimeoutSeconds: 300,
    };
    expect(normalizeNativePrivacySettings(chosen)).toEqual(chosen);
  });

  it("does not call a native plugin in the browser", async () => {
    expect(await getNativePrivacySettings()).toEqual(DEFAULT_NATIVE_PRIVACY_SETTINGS);
    expect(await nativeOutputIsPhoneSpeaker()).toBe(false);
    expect(plugin.getSettings).not.toHaveBeenCalled();
    expect(plugin.outputStatus).not.toHaveBeenCalled();
  });

  it("announces saved settings to the page", async () => {
    isAndroidApp.mockReturnValue(true);
    const stored = { ...DEFAULT_NATIVE_PRIVACY_SETTINGS, recentsShield: false, lockScreenContent: "full" };
    plugin.setSettings.mockResolvedValue(stored);
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });

    const saved = await updateNativePrivacySettings({ recentsShield: false });

    vi.unstubAllGlobals();
    expect(plugin.setSettings).toHaveBeenCalledWith({ recentsShield: false });
    expect(saved).toEqual(stored);
    const event = dispatchEvent.mock.calls[0][0] as CustomEvent;
    expect(event.type).toBe(NATIVE_PRIVACY_SETTINGS_CHANGE_EVENT);
    expect(event.detail).toEqual(saved);
  });

  it("reports an unknown output when the shell cannot tell", async () => {
    isAndroidApp.mockReturnValue(true);
    plugin.outputStatus.mockRejectedValue(new Error("unavailable"));

    expect(await nativeOutputIsPhoneSpeaker()).toBeNull();
  });
});
