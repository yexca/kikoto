import { useTranslation } from "react-i18next";

import { SettingsSection } from "@/components/settings/SettingsSection";
import { FloatingSelect } from "@/components/ui/floating-select";
import type { ClientPrincipalID } from "@/lib/clientStorageScope";
import {
  LOUDNESS_NORMALIZATION_MODES,
  normalizeLoudnessMode,
  storeLoudnessMode,
  type LoudnessNormalizationMode,
} from "@/player/loudnessNormalization";
import { useLoudnessNormalizationMode } from "@/player/useLoudnessNormalization";

const modeLabelKeys = {
  off: "settings.loudnessOff",
  attenuate: "settings.loudnessAttenuate",
  full: "settings.loudnessFull",
} as const satisfies Record<LoudnessNormalizationMode, string>;

/** Per-account loudness normalization; off by default and applied to the next measured track at once. */
export function PlaybackLoudnessPreference({ userId }: { userId: ClientPrincipalID }) {
  const { t } = useTranslation();
  const mode = useLoudnessNormalizationMode(userId);
  return (
    <SettingsSection
      title={t("settings.loudness")}
      action={
        <FloatingSelect
          ariaLabel={t("settings.loudnessMode")}
          className="max-w-52 sm:max-w-none"
          value={mode}
          options={LOUDNESS_NORMALIZATION_MODES.map((value) => ({ value, label: t(modeLabelKeys[value]) }))}
          onValueChange={(value) => storeLoudnessMode(userId, normalizeLoudnessMode(value))}
        />
      }
    />
  );
}
