import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

import { isAndroidApp } from "@/lib/serverConfig";

/** What the lock screen media controls show: everything, everything except the cover, or only the app name. */
export type LockScreenMediaContent = "full" | "hideCover" | "hidden";

export const LOCK_SCREEN_MEDIA_CONTENTS: readonly LockScreenMediaContent[] = ["full", "hideCover", "hidden"];

export type NativePrivacySettings = {
  /** Recent apps show a cover instead of the app's content. */
  recentsShield: boolean;
  lockScreenContent: LockScreenMediaContent;
  /** Playback through the phone speaker waits for confirmation. */
  speakerConfirm: boolean;
};

export const DEFAULT_NATIVE_PRIVACY_SETTINGS: NativePrivacySettings = {
  recentsShield: true,
  lockScreenContent: "hideCover",
  speakerConfirm: true,
};

export const NATIVE_PRIVACY_SETTINGS_CHANGE_EVENT = "kikoto:native-privacy-settings-change";

type KikotoPrivacyPlugin = {
  getSettings(): Promise<NativePrivacySettings>;
  setSettings(change: Partial<NativePrivacySettings>): Promise<NativePrivacySettings>;
  outputStatus(): Promise<{ phoneSpeaker: boolean }>;
  addListener(
    eventName: "outputChanged",
    listenerFunc: (event: { phoneSpeaker: boolean }) => void,
  ): Promise<PluginListenerHandle>;
};

const KikotoPrivacy = registerPlugin<KikotoPrivacyPlugin>("KikotoPrivacy");

/** These settings belong to the Android device, so the native shell stores them for every server and account. */
export function supportsNativePrivacy() {
  return isAndroidApp();
}

export function normalizeNativePrivacySettings(value: unknown): NativePrivacySettings {
  const defaults = DEFAULT_NATIVE_PRIVACY_SETTINGS;
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaults;
  const candidate = value as Partial<Record<keyof NativePrivacySettings, unknown>>;
  return {
    recentsShield: typeof candidate.recentsShield === "boolean" ? candidate.recentsShield : defaults.recentsShield,
    lockScreenContent: LOCK_SCREEN_MEDIA_CONTENTS.includes(candidate.lockScreenContent as LockScreenMediaContent)
      ? (candidate.lockScreenContent as LockScreenMediaContent)
      : defaults.lockScreenContent,
    speakerConfirm: typeof candidate.speakerConfirm === "boolean" ? candidate.speakerConfirm : defaults.speakerConfirm,
  };
}

export async function getNativePrivacySettings() {
  if (!supportsNativePrivacy()) return DEFAULT_NATIVE_PRIVACY_SETTINGS;
  return normalizeNativePrivacySettings(await KikotoPrivacy.getSettings().catch(() => null));
}

export async function updateNativePrivacySettings(change: Partial<NativePrivacySettings>) {
  if (!supportsNativePrivacy()) return DEFAULT_NATIVE_PRIVACY_SETTINGS;
  const settings = normalizeNativePrivacySettings(await KikotoPrivacy.setSettings(change));
  window.dispatchEvent(
    new CustomEvent<NativePrivacySettings>(NATIVE_PRIVACY_SETTINGS_CHANGE_EVENT, { detail: settings }),
  );
  return settings;
}

/** Whether media would play from the phone itself; null when the shell cannot tell. */
export async function nativeOutputIsPhoneSpeaker() {
  if (!supportsNativePrivacy()) return false;
  const status = await KikotoPrivacy.outputStatus().catch(() => null);
  return typeof status?.phoneSpeaker === "boolean" ? status.phoneSpeaker : null;
}

export async function addNativeOutputListener(onChange: (phoneSpeaker: boolean) => void) {
  if (!supportsNativePrivacy()) return () => {};
  const handle = await KikotoPrivacy.addListener("outputChanged", (event) => {
    if (typeof event.phoneSpeaker === "boolean") onChange(event.phoneSpeaker);
  });
  return () => {
    void handle.remove();
  };
}
