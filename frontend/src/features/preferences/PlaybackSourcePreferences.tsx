import { useId } from "react";
import { useTranslation } from "react-i18next";

import { SettingsRow, SettingsSection } from "@/components/settings/SettingsSection";
import { Switch } from "@/components/ui/switch";
import type { ClientPrincipalID } from "@/lib/clientStorageScope";
import { storePlaybackSourcePreferences, type PlaybackSourcePreferences } from "@/player/playbackPreferences";
import { usePlaybackSourcePreferences } from "@/player/usePlaybackSourcePreferences";

/** Per-account opt-ins for manual source switching and automatic source fallback; both apply immediately. */
export function PlaybackSourcePreferences({ userId }: { userId: ClientPrincipalID }) {
  const { t } = useTranslation();
  const preferences = usePlaybackSourcePreferences(userId);
  const switchingId = useId();
  const fallbackId = useId();
  const update = (change: Partial<PlaybackSourcePreferences>) =>
    storePlaybackSourcePreferences(userId, { ...preferences, ...change });

  return (
    <SettingsSection title={t("settings.playbackSources")} description={t("settings.playbackSourcesDescription")}>
      <SettingsRow
        htmlFor={switchingId}
        title={t("settings.sourceSwitching")}
        description={t("settings.sourceSwitchingDescription")}
      >
        <Switch
          id={switchingId}
          aria-label={t("settings.sourceSwitching")}
          checked={preferences.sourceSwitching}
          onCheckedChange={(sourceSwitching) => update({ sourceSwitching })}
        />
      </SettingsRow>
      <SettingsRow
        htmlFor={fallbackId}
        title={t("settings.sourceFallback")}
        description={t("settings.sourceFallbackDescription")}
      >
        <Switch
          id={fallbackId}
          aria-label={t("settings.sourceFallback")}
          checked={preferences.sourceFallback}
          onCheckedChange={(sourceFallback) => update({ sourceFallback })}
        />
      </SettingsRow>
    </SettingsSection>
  );
}
