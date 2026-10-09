import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

import { isAndroidApp } from "@/lib/serverConfig";

/** What the lock screen media controls show: everything, everything except the cover, or only the app name. */
export type LockScreenMediaContent = "full" | "hideCover" | "hidden";

export const LOCK_SCREEN_MEDIA_CONTENTS: readonly LockScreenMediaContent[] = ["full", "hideCover", "hidden"];

/** Time outside Kikoto before returning needs an unlock; 0 locks on every return. */
export const APP_LOCK_TIMEOUTS_SECONDS = [0, 60, 300, 900] as const;
export type AppLockTimeoutSeconds = (typeof APP_LOCK_TIMEOUTS_SECONDS)[number];

export type NativePrivacySettings = {
  /** Recent apps show a cover instead of the app's content. */
  recentsShield: boolean;
  lockScreenContent: LockScreenMediaContent;
  /** Playback through the phone speaker waits for confirmation. */
  speakerConfirm: boolean;
  /** Screenshots, screen recording, and casting show nothing of Kikoto or its floating lyrics. */
  screenSecure: boolean;
  /** Returning to Kikoto needs a biometric or the device screen lock. */
  appLock: boolean;
  appLockTimeoutSeconds: AppLockTimeoutSeconds;
};

export const DEFAULT_NATIVE_PRIVACY_SETTINGS: NativePrivacySettings = {
  recentsShield: true,
  lockScreenContent: "hideCover",
  speakerConfirm: true,
  screenSecure: false,
  appLock: false,
  appLockTimeoutSeconds: 0,
};

export const NATIVE_PRIVACY_SETTINGS_CHANGE_EVENT = "kikoto:native-privacy-settings-change";

type KikotoPrivacyPlugin = {
  getSettings(): Promise<NativePrivacySettings>;
  setSettings(change: Partial<NativePrivacySettings>): Promise<NativePrivacySettings>;
  status(): Promise<{ appLockAvailable: boolean }>;
  setUnlockLabels(labels: { title: string; action: string }): Promise<void>;
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
    screenSecure: typeof candidate.screenSecure === "boolean" ? candidate.screenSecure : defaults.screenSecure,
    appLock: typeof candidate.appLock === "boolean" ? candidate.appLock : defaults.appLock,
    appLockTimeoutSeconds: APP_LOCK_TIMEOUTS_SECONDS.includes(candidate.appLockTimeoutSeconds as AppLockTimeoutSeconds)
      ? (candidate.appLockTimeoutSeconds as AppLockTimeoutSeconds)
      : defaults.appLockTimeoutSeconds,
  };
}

/** The app lock needs a device screen lock to authenticate against. */
export async function nativeAppLockAvailable() {
  if (!supportsNativePrivacy()) return false;
  const status = await KikotoPrivacy.status().catch(() => null);
  return status?.appLockAvailable === true;
}

/** Stores the unlock prompt's title and button in the app language for the native lock screen. */
export async function setNativeUnlockLabels(labels: { title: string; action: string }) {
  if (!supportsNativePrivacy()) return;
  await KikotoPrivacy.setUnlockLabels(labels).catch(() => {});
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
