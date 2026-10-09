import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { SettingsRow, SettingsSection } from "@/components/settings/SettingsSection";
import { FloatingSelect } from "@/components/ui/floating-select";
import { Switch } from "@/components/ui/switch";
import { toastFromError, useToast } from "@/components/ui/toast";
import { useNativePrivacySettings } from "@/hooks/useNativePrivacySettings";
import {
  APP_LOCK_TIMEOUTS_SECONDS,
  LOCK_SCREEN_MEDIA_CONTENTS,
  nativeAppLockAvailable,
  updateNativePrivacySettings,
  type AppLockTimeoutSeconds,
  type LockScreenMediaContent,
  type NativePrivacySettings,
} from "@/lib/nativePrivacy";

/** Whether the device has a screen lock, checked again when the user returns from Android settings. */
function useAppLockAvailable() {
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      void nativeAppLockAvailable().then((value) => {
        if (!disposed) setAvailable(value);
      });
    };
    refresh();
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  return available;
}

/**
 * Android device privacy: recent apps cover, locked media controls, speaker
 * confirmation, screen capture protection, and the app lock. Changes apply
 * immediately.
 */
export function DevicePrivacyPreferences() {
  const { t } = useTranslation();
  const toast = useToast();
  const { settings, loaded } = useNativePrivacySettings();
  const appLockAvailable = useAppLockAvailable();
  const recentsId = useId();
  const speakerId = useId();
  const screenSecureId = useId();
  const appLockId = useId();
  const update = (change: Partial<NativePrivacySettings>) => {
    updateNativePrivacySettings(change).catch((error: unknown) => {
      toast.notify(toastFromError(error, t("settings.devicePrivacySaveFailed")));
    });
  };
  // A lock that is already on stays switchable off when the screen lock is removed.
  const appLockSwitchable = loaded && (appLockAvailable === true || settings.appLock);

  return (
    <SettingsSection title={t("settings.devicePrivacy")} description={t("settings.devicePrivacyDescription")}>
      <SettingsRow
        htmlFor={recentsId}
        title={t("settings.recentsShield")}
        description={t("settings.recentsShieldDescription")}
      >
        <Switch
          id={recentsId}
          aria-label={t("settings.recentsShield")}
          checked={settings.recentsShield}
          disabled={!loaded}
          onCheckedChange={(recentsShield) => update({ recentsShield })}
        />
      </SettingsRow>
      <SettingsRow title={t("settings.lockScreenContent")} description={t("settings.lockScreenContentDescription")}>
        <FloatingSelect
          ariaLabel={t("settings.lockScreenContent")}
          value={settings.lockScreenContent}
          disabled={!loaded}
          options={LOCK_SCREEN_MEDIA_CONTENTS.map((value) => ({
            value,
            label: t(`settings.lockScreenContentOptions.${value}`),
          }))}
          onValueChange={(value) => update({ lockScreenContent: value as LockScreenMediaContent })}
        />
      </SettingsRow>
      <SettingsRow
        htmlFor={speakerId}
        title={t("settings.speakerConfirm")}
        description={t("settings.speakerConfirmDescription")}
      >
        <Switch
          id={speakerId}
          aria-label={t("settings.speakerConfirm")}
          checked={settings.speakerConfirm}
          disabled={!loaded}
          onCheckedChange={(speakerConfirm) => update({ speakerConfirm })}
        />
      </SettingsRow>
      <SettingsRow
        htmlFor={screenSecureId}
        title={t("settings.screenSecure")}
        description={t("settings.screenSecureDescription")}
      >
        <Switch
          id={screenSecureId}
          aria-label={t("settings.screenSecure")}
          checked={settings.screenSecure}
          disabled={!loaded}
          onCheckedChange={(screenSecure) => update({ screenSecure })}
        />
      </SettingsRow>
      <SettingsRow
        htmlFor={appLockId}
        title={t("settings.appLock")}
        description={appLockAvailable === false ? t("settings.appLockUnavailable") : t("settings.appLockDescription")}
      >
        <Switch
          id={appLockId}
          aria-label={t("settings.appLock")}
          checked={settings.appLock}
          disabled={!appLockSwitchable}
          onCheckedChange={(appLock) => update({ appLock })}
        />
      </SettingsRow>
      {settings.appLock && (
        <SettingsRow title={t("settings.appLockTimeout")} description={t("settings.appLockTimeoutDescription")}>
          <FloatingSelect
            ariaLabel={t("settings.appLockTimeout")}
            value={String(settings.appLockTimeoutSeconds)}
            disabled={!loaded}
            options={APP_LOCK_TIMEOUTS_SECONDS.map((seconds) => ({
              value: String(seconds),
              label:
                seconds === 0
                  ? t("settings.appLockTimeoutImmediately")
                  : t("settings.appLockTimeoutMinutes", { count: seconds / 60 }),
            }))}
            onValueChange={(value) => update({ appLockTimeoutSeconds: Number(value) as AppLockTimeoutSeconds })}
          />
        </SettingsRow>
      )}
    </SettingsSection>
  );
}
