import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { SettingsRow, SettingsSection } from "@/components/settings/SettingsSection";
import { Switch } from "@/components/ui/switch";
import { nativeAppSwitcherShield, setNativeAppSwitcherShield, supportsNativePrivacy } from "@/lib/nativePrivacy";
import { storeSystemMediaDetailsHidden, useSystemMediaDetailsHidden } from "@/player/systemMediaPrivacy";

/** Device-wide privacy choices; they apply immediately to every account on this device. */
export function DevicePrivacyPreferences() {
  const { t } = useTranslation();
  const detailsHidden = useSystemMediaDetailsHidden();
  const detailsId = useId();

  return (
    <SettingsSection title={t("settings.devicePrivacy")} description={t("settings.devicePrivacyDescription")}>
      <SettingsRow
        htmlFor={detailsId}
        title={t("settings.hideMediaDetails")}
        description={t("settings.hideMediaDetailsDescription")}
      >
        <Switch
          id={detailsId}
          aria-label={t("settings.hideMediaDetails")}
          checked={detailsHidden}
          onCheckedChange={storeSystemMediaDetailsHidden}
        />
      </SettingsRow>
      {supportsNativePrivacy() && <AppSwitcherShieldRow />}
    </SettingsSection>
  );
}

function AppSwitcherShieldRow() {
  const { t } = useTranslation();
  const id = useId();
  // Null until the native choice is read.
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    nativeAppSwitcherShield()
      .then((value) => {
        if (active) setEnabled(value);
      })
      .catch(() => {
        if (active) setEnabled(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const update = (next: boolean) => {
    const previous = enabled;
    setEnabled(next);
    setNativeAppSwitcherShield(next).catch(() => setEnabled(previous));
  };

  return (
    <SettingsRow
      htmlFor={id}
      title={t("settings.appSwitcherBlur")}
      description={t("settings.appSwitcherBlurDescription")}
    >
      <Switch
        id={id}
        aria-label={t("settings.appSwitcherBlur")}
        checked={enabled ?? true}
        disabled={enabled === null}
        onCheckedChange={update}
      />
    </SettingsRow>
  );
}
