import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  DEFAULT_NATIVE_PRIVACY_SETTINGS,
  getNativePrivacySettings,
  NATIVE_PRIVACY_SETTINGS_CHANGE_EVENT,
  setNativeUnlockLabels,
  supportsNativePrivacy,
  type NativePrivacySettings,
} from "@/lib/nativePrivacy";

/** Keeps the Android app lock prompt in the app language, including for the next cold start. */
export function useNativeUnlockLabels() {
  const { t } = useTranslation();
  const title = t("settings.unlockTitle");
  const action = t("settings.unlockAction");
  useEffect(() => {
    void setNativeUnlockLabels({ title, action });
  }, [action, title]);
}

/**
 * The Android device privacy settings, kept in sync with Settings. `loaded`
 * stays false until the native shell answers, and outside Android.
 */
export function useNativePrivacySettings() {
  const [state, setState] = useState<{ settings: NativePrivacySettings; loaded: boolean }>({
    settings: DEFAULT_NATIVE_PRIVACY_SETTINGS,
    loaded: false,
  });

  useEffect(() => {
    if (!supportsNativePrivacy()) return;
    let disposed = false;
    void getNativePrivacySettings().then((settings) => {
      // A change saved while this read was pending is newer.
      if (!disposed) setState((current) => (current.loaded ? current : { settings, loaded: true }));
    });
    const sync = (event: Event) => {
      const settings = (event as CustomEvent<NativePrivacySettings>).detail;
      if (settings) setState({ settings, loaded: true });
    };
    window.addEventListener(NATIVE_PRIVACY_SETTINGS_CHANGE_EVENT, sync);
    return () => {
      disposed = true;
      window.removeEventListener(NATIVE_PRIVACY_SETTINGS_CHANGE_EVENT, sync);
    };
  }, []);

  return state;
}
