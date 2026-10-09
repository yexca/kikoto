import { useId } from "react";
import { useTranslation } from "react-i18next";

import { SettingsRow, SettingsSection } from "@/components/settings/SettingsSection";
import { FloatingSelect } from "@/components/ui/floating-select";
import { Switch } from "@/components/ui/switch";
import { toastFromError, useToast } from "@/components/ui/toast";
import { useNativePrivacySettings } from "@/hooks/useNativePrivacySettings";
import {
  LOCK_SCREEN_MEDIA_CONTENTS,
  updateNativePrivacySettings,
  type LockScreenMediaContent,
  type NativePrivacySettings,
} from "@/lib/nativePrivacy";

/** Android device privacy: recent apps cover, locked media controls, and speaker confirmation. Changes apply immediately. */
export function DevicePrivacyPreferences() {
  const { t } = useTranslation();
  const toast = useToast();
  const { settings, loaded } = useNativePrivacySettings();
  const recentsId = useId();
  const speakerId = useId();
  const update = (change: Partial<NativePrivacySettings>) => {
    updateNativePrivacySettings(change).catch((error: unknown) => {
      toast.notify(toastFromError(error, t("settings.devicePrivacySaveFailed")));
    });
  };

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
    </SettingsSection>
  );
}
