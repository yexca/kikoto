import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { SettingsRow, SettingsSection } from "@/components/settings/SettingsSection";
import { Switch } from "@/components/ui/switch";
import {
  nativeAppSwitcherShield,
  nativeScreenCaptureShield,
  setNativeAppSwitcherShield,
  setNativeScreenCaptureShield,
  supportsNativePrivacy,
} from "@/lib/nativePrivacy";
import { storeSpeakerGuardEnabled, useSpeakerGuardEnabled } from "@/player/speakerGuard";
import { storeSystemMediaDetailsHidden, useSystemMediaDetailsHidden } from "@/player/systemMediaPrivacy";

/** Device-wide privacy choices; they apply immediately to every account on this device. */
export function DevicePrivacyPreferences() {
  const { t } = useTranslation();
  const detailsHidden = useSystemMediaDetailsHidden();
  const native = supportsNativePrivacy();

  return (
    <SettingsSection title={t("settings.devicePrivacy")} description={t("settings.devicePrivacyDescription")}>
      <ToggleRow
        title={t("settings.hideMediaDetails")}
        description={t("settings.hideMediaDetailsDescription")}
        checked={detailsHidden}
        onCheckedChange={storeSystemMediaDetailsHidden}
      />
      {native && <SpeakerGuardRow />}
      {native && (
        <NativeToggleRow
          title={t("settings.appSwitcherBlur")}
          description={t("settings.appSwitcherBlurDescription")}
          read={nativeAppSwitcherShield}
          write={setNativeAppSwitcherShield}
        />
      )}
      {native && (
        <NativeToggleRow
          title={t("settings.screenCaptureCover")}
          description={t("settings.screenCaptureCoverDescription")}
          read={nativeScreenCaptureShield}
          write={setNativeScreenCaptureShield}
        />
      )}
    </SettingsSection>
  );
}

function SpeakerGuardRow() {
  const { t } = useTranslation();
  const enabled = useSpeakerGuardEnabled();
  return (
    <ToggleRow
      title={t("settings.speakerGuard")}
      description={t("settings.speakerGuardDescription")}
      checked={enabled}
      onCheckedChange={storeSpeakerGuardEnabled}
    />
  );
}

/** A choice stored by the native shell, which applies it without asking the web view; the default is on. */
function NativeToggleRow({
  title,
  description,
  read,
  write,
}: {
  title: string;
  description: string;
  read: () => Promise<boolean>;
  write: (enabled: boolean) => Promise<void>;
}) {
  // Null until the native choice is read.
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    read()
      .then((value) => {
        if (active) setEnabled(value);
      })
      .catch(() => {
        if (active) setEnabled(true);
      });
    return () => {
      active = false;
    };
  }, [read]);

  const update = (next: boolean) => {
    const previous = enabled;
    setEnabled(next);
    write(next).catch(() => setEnabled(previous));
  };

  return (
    <ToggleRow
      title={title}
      description={description}
      checked={enabled ?? true}
      disabled={enabled === null}
      onCheckedChange={update}
    />
  );
}

function ToggleRow({
  title,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <SettingsRow htmlFor={id} title={title} description={description}>
      <Switch id={id} aria-label={title} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </SettingsRow>
  );
}
