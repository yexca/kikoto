import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { SettingsRow, SettingsSection } from "@/components/settings/SettingsSection";
import { FloatingSelect } from "@/components/ui/floating-select";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { toastFromError, useToast } from "@/components/ui/toast";
import { useNativePrivacySettings } from "@/hooks/useNativePrivacySettings";
import { createEffectScope } from "@/lib/effectScope";
import {
  APP_LOCK_TIMEOUTS_SECONDS,
  LOCK_SCREEN_MEDIA_CONTENTS,
  nativePrivacyStatus,
  updateNativePrivacySettings,
  type AppLockTimeoutSeconds,
  type NativePrivacySettings,
} from "@/lib/nativePrivacy";
import { isAndroidApp, isIOSApp } from "@/lib/serverConfig";

/**
 * Native privacy capabilities, checked again when the user returns from the
 * system settings.
 */
function useNativePrivacyStatus() {
  const [status, setStatus] = useState<{
    supported: boolean;
    available: boolean;
    recentsShieldBlocksCapture: boolean;
    screenshotsHidden: boolean;
  } | null>(null);
  useEffect(() => {
    const scope = createEffectScope();
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      scope.load(() => nativePrivacyStatus(), { onSuccess: setStatus });
    };
    refresh();
    document.addEventListener("visibilitychange", refresh);
    return () => {
      scope.cancel();
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  return status;
}

/**
 * Device privacy: the recent apps or app switcher cover, the system media
 * controls, speaker confirmation, screen capture protection, and, where the
 * shell offers it, the app lock. Changes apply immediately. iOS names the
 * choices after what it can do: its media controls cannot tell a locked
 * device, and it blanks a screenshot and covers a recording rather than
 * blocking either.
 */
export function DevicePrivacyPreferences() {
  const { t } = useTranslation();
  const toast = useToast();
  const { settings, loaded } = useNativePrivacySettings();
  const privacyStatus = useNativePrivacyStatus();
  const appLockAvailable = privacyStatus?.available ?? null;
  const recentsShieldBlocksCapture = isAndroidApp() && privacyStatus?.recentsShieldBlocksCapture === true;
  // Without a capture canvas, the iOS shell can cover a recording but not blank a screenshot.
  const screenshotsHidden = privacyStatus?.screenshotsHidden !== false;
  const labels = isIOSApp()
    ? ({
        recentsShield: "settings.appSwitcherBlur",
        recentsShieldDescription: "settings.appSwitcherBlurDescription",
        lockScreenContent: "settings.nowPlayingContent",
        lockScreenContentDescription: "settings.nowPlayingContentDescription",
        screenSecure: screenshotsHidden ? "settings.screenCaptureHide" : "settings.screenCaptureCover",
        screenSecureDescription: screenshotsHidden
          ? "settings.screenCaptureHideDescription"
          : "settings.screenCaptureCoverDescription",
      } as const)
    : ({
        recentsShield: "settings.recentsShield",
        recentsShieldDescription: "settings.recentsShieldDescription",
        lockScreenContent: "settings.lockScreenContent",
        lockScreenContentDescription: "settings.lockScreenContentDescription",
        screenSecure: "settings.screenSecure",
        screenSecureDescription: "settings.screenSecureDescription",
      } as const);
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
        title={t(labels.recentsShield)}
        description={t(
          recentsShieldBlocksCapture ? "settings.recentsShieldLegacyDescription" : labels.recentsShieldDescription,
        )}
      >
        <Switch
          id={recentsId}
          aria-label={t(labels.recentsShield)}
          checked={settings.recentsShield}
          disabled={!loaded}
          onCheckedChange={(recentsShield) => update({ recentsShield })}
        />
      </SettingsRow>
      <SettingsRow title={t(labels.lockScreenContent)} description={t(labels.lockScreenContentDescription)}>
        <div
          role="radiogroup"
          aria-label={t(labels.lockScreenContent)}
          className={segmentedListClassName("w-full sm:w-fit")}
        >
          {LOCK_SCREEN_MEDIA_CONTENTS.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={settings.lockScreenContent === value}
              disabled={!loaded}
              className={segmentedItemClassName(
                settings.lockScreenContent === value,
                "min-w-0 flex-auto shrink justify-center px-2",
              )}
              onClick={() => update({ lockScreenContent: value })}
            >
              <span className="truncate">{t(`settings.lockScreenContentOptions.${value}`)}</span>
            </button>
          ))}
        </div>
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
        title={t(labels.screenSecure)}
        description={t(labels.screenSecureDescription)}
      >
        <Switch
          id={screenSecureId}
          aria-label={t(labels.screenSecure)}
          checked={settings.screenSecure}
          disabled={!loaded}
          onCheckedChange={(screenSecure) => update({ screenSecure })}
        />
      </SettingsRow>
      {privacyStatus?.supported && (
        <>
          <SettingsRow
            htmlFor={appLockId}
            title={t("settings.appLock")}
            description={
              appLockAvailable === false ? t("settings.appLockUnavailable") : t("settings.appLockDescription")
            }
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
        </>
      )}
    </SettingsSection>
  );
}
