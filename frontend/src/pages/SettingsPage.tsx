import {
  DevicePrivacyPreferences,
  PlaybackLoudnessPreference,
  PlaybackSourcePreferences,
  RecommendationActivity,
  UserPreferencePanels,
} from "@/features/preferences";
import { DemoReadOnlyNotice } from "@/components/DemoReadOnlyNotice";
import { AutosaveStatus, useAutosaveStatus } from "@/components/settings/AutosaveStatus";
import { SettingsNumberInput, SettingsRow, SettingsSection } from "@/components/settings/SettingsSection";
import { SubNavTabs, type SubNavItem } from "@/components/ui/sub-nav";
import { FastForward, Pencil, Sparkles, UserRound, type LucideIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useState, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { type CurrentUser } from "@/lib/api";
import { supportsNativePrivacy } from "@/lib/nativePrivacy";
import { AccountTimeZoneSection } from "@/features/time-zone/AccountTimeZoneSection";
import { AccountEditDialog } from "@/pages/AccountEditDialog";
import {
  settingsPageClassName,
  settingsPanelClassName,
  useSettingsLocation,
  type SettingsLocation,
} from "@/pages/settingsLocation";
import {
  getStoredPlaybackSeekPreferences,
  normalizeSeekSeconds,
  PLAYER_SEEK_PREFERENCES_CHANGE_EVENT,
  playbackSeekPreferencesStorageKey,
  SEEK_SECONDS_MAX,
  SEEK_SECONDS_MIN,
  storePlaybackSeekPreferences,
  type PlaybackSeekPreferences,
} from "@/player/playbackPreferences";

// Your data loads its own chunk so Settings does not download it up front.
const UserDataPage = lazy(() =>
  import("@/features/user-data/UserDataPage").then((module) => ({ default: module.UserDataPage })),
);

const settingsTabs = [
  { id: "account", labelKey: "settings.account", icon: UserRound },
  { id: "playback", labelKey: "settings.playback", icon: FastForward },
  { id: "recommendation", labelKey: "settings.recommendations", icon: Sparkles },
] as const satisfies ReadonlyArray<{ id: string; labelKey: string; icon: LucideIcon }>;

type SettingsTab = (typeof settingsTabs)[number]["id"];

// Alias tab ids keep existing links valid; each opens the Account section that holds its content.
const settingsTabAliases: Record<string, SettingsLocation<SettingsTab>> = {
  data: { tab: "account", section: "data" },
  "time-zone": { tab: "account", section: "time-zone" },
};

function resolveSettingsTab(tab: string): SettingsLocation<SettingsTab> {
  if (settingsTabs.some((candidate) => candidate.id === tab)) return { tab: tab as SettingsTab };
  return settingsTabAliases[tab] ?? { tab: "account" };
}

/** The signed-in account's own settings. Instance settings are the System page. */
export function SettingsPage({
  user,
  readOnly = false,
  data,
  onAccountUpdated,
}: {
  user: CurrentUser;
  readOnly?: boolean;
  /** Omitted when the account cannot read the library, which hides Your data. */
  data?: ComponentProps<typeof UserDataPage>;
  onAccountUpdated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [isAccountDialogOpen, setIsAccountDialogOpen] = useState(false);
  const { tab: activeTab, select: selectTab } = useSettingsLocation<SettingsTab>(
    "/settings",
    "account",
    resolveSettingsTab,
  );
  const [seekPreferences, setSeekPreferences] = useState<PlaybackSeekPreferences>(() =>
    getStoredPlaybackSeekPreferences(user.id),
  );
  const [seekDraft, setSeekDraft] = useState(() => ({
    forward: String(seekPreferences.seekForwardSeconds),
    backward: String(seekPreferences.seekBackwardSeconds),
  }));
  const [seekError, setSeekError] = useState<string | null>(null);
  const seekStatus = useAutosaveStatus();

  useEffect(() => {
    const preferences = getStoredPlaybackSeekPreferences(user.id);
    setSeekPreferences(preferences);
    setSeekDraft({
      forward: String(preferences.seekForwardSeconds),
      backward: String(preferences.seekBackwardSeconds),
    });
    setSeekError(null);
  }, [user.id]);

  useEffect(() => {
    const storageKey = playbackSeekPreferencesStorageKey(user.id);
    const syncPreferences = (event: Event) => {
      const detail = (event as CustomEvent<{ storageKey?: string; preferences?: PlaybackSeekPreferences }>).detail;
      if (detail?.storageKey !== storageKey || !detail.preferences) return;
      setSeekPreferences(detail.preferences);
      setSeekDraft({
        forward: String(detail.preferences.seekForwardSeconds),
        backward: String(detail.preferences.seekBackwardSeconds),
      });
      setSeekError(null);
    };
    const syncStorage = (event: StorageEvent) => {
      if (event.key !== storageKey) return;
      const preferences = getStoredPlaybackSeekPreferences(user.id);
      setSeekPreferences(preferences);
      setSeekDraft({
        forward: String(preferences.seekForwardSeconds),
        backward: String(preferences.seekBackwardSeconds),
      });
      setSeekError(null);
    };
    window.addEventListener(PLAYER_SEEK_PREFERENCES_CHANGE_EVENT, syncPreferences);
    window.addEventListener("storage", syncStorage);
    return () => {
      window.removeEventListener(PLAYER_SEEK_PREFERENCES_CHANGE_EVENT, syncPreferences);
      window.removeEventListener("storage", syncStorage);
    };
  }, [user.id]);

  // Stored when either field's edit is finished; an invalid value stays as typed with its error.
  const commitSeekPreferences = () => {
    const forward = Number(seekDraft.forward);
    const backward = Number(seekDraft.backward);
    const validForward = normalizeSeekSeconds(forward, Number.NaN);
    const validBackward = normalizeSeekSeconds(backward, Number.NaN);
    if (!Number.isFinite(validForward) || !Number.isFinite(validBackward)) {
      setSeekError(
        t("settings.seekInvalid", {
          min: SEEK_SECONDS_MIN,
          max: SEEK_SECONDS_MAX,
        }),
      );
      return;
    }
    if (validForward === seekPreferences.seekForwardSeconds && validBackward === seekPreferences.seekBackwardSeconds) {
      setSeekError(null);
      return;
    }
    const preferences = storePlaybackSeekPreferences(user.id, {
      seekForwardSeconds: validForward,
      seekBackwardSeconds: validBackward,
    });
    setSeekPreferences(preferences);
    setSeekDraft({
      forward: String(preferences.seekForwardSeconds),
      backward: String(preferences.seekBackwardSeconds),
    });
    setSeekError(null);
    void seekStatus.track(Promise.resolve(true));
  };

  const navItems: SubNavItem<SettingsTab>[] = settingsTabs.map((tab) => ({
    value: tab.id,
    label: t(tab.labelKey),
    icon: tab.icon,
    id: `settings-tab-${tab.id}`,
    controls: `settings-panel-${tab.id}`,
  }));

  const savedDisplayName = user.displayName || user.username;

  return (
    <div className={settingsPageClassName}>
      {readOnly && <DemoReadOnlyNotice />}
      <SubNavTabs label={t("nav.settings")} items={navItems} selected={activeTab} onSelect={selectTab} />
      {activeTab === "account" && (
        <div
          id="settings-panel-account"
          className={settingsPanelClassName}
          role="tabpanel"
          aria-labelledby="settings-tab-account"
        >
          <SettingsSection title={t("settings.account")}>
            <div className="flex min-w-0 items-center gap-3 py-4">
              <span
                className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-primary/10 text-base font-semibold text-primary"
                aria-hidden="true"
              >
                {avatarInitial(savedDisplayName)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{savedDisplayName}</div>
                <div className="truncate text-xs text-muted-foreground">
                  @{user.username}
                  <span aria-hidden="true" className="px-1.5">
                    ·
                  </span>
                  {t(`account.roles.${user.role}`, { defaultValue: user.role.replace("_", " ") })}
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-muted-foreground hover:text-foreground"
                aria-label={t("settings.editAccount")}
                title={t("settings.editAccount")}
                onClick={() => setIsAccountDialogOpen(true)}
              >
                <Pencil className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </SettingsSection>
          <AccountTimeZoneSection readOnly={readOnly} />
          {data && (
            <div
              id="settings-section-data"
              className="scroll-mt-[calc(var(--header-height)+var(--safe-area-top)+1rem)]"
            >
              <Suspense fallback={null}>
                <UserDataPage {...data} />
              </Suspense>
            </div>
          )}
          {isAccountDialogOpen && (
            <AccountEditDialog
              user={user}
              readOnly={readOnly}
              onAccountUpdated={onAccountUpdated}
              onClose={() => setIsAccountDialogOpen(false)}
            />
          )}
        </div>
      )}

      {activeTab === "playback" && (
        <div
          className={settingsPanelClassName}
          role="tabpanel"
          id="settings-panel-playback"
          aria-labelledby="settings-tab-playback"
        >
          <SettingsSection
            title={t("settings.playback")}
            action={<AutosaveStatus state={seekStatus.state} />}
            footer={
              seekError ? (
                <span id="seek-preferences-error" className="mr-auto text-sm text-destructive" role="alert">
                  {seekError}
                </span>
              ) : undefined
            }
          >
            <SeekRow
              id="seek-forward-seconds"
              label={t("settings.seekForward")}
              unit={t("settings.seconds")}
              value={seekDraft.forward}
              onChange={(forward) => {
                setSeekDraft((current) => ({ ...current, forward }));
                setSeekError(null);
              }}
              onCommit={commitSeekPreferences}
            />
            <SeekRow
              id="seek-backward-seconds"
              label={t("settings.seekBackward")}
              unit={t("settings.seconds")}
              value={seekDraft.backward}
              onChange={(backward) => {
                setSeekDraft((current) => ({ ...current, backward }));
                setSeekError(null);
              }}
              onCommit={commitSeekPreferences}
            />
          </SettingsSection>
          <PlaybackLoudnessPreference userId={user.id} />
          <PlaybackSourcePreferences userId={user.id} />
          {supportsNativePrivacy() && <DevicePrivacyPreferences />}
          <UserPreferencePanels userId={user.id} section="playback" readOnly={readOnly} />
        </div>
      )}
      {activeTab === "recommendation" && (
        <div
          className={settingsPanelClassName}
          role="tabpanel"
          id="settings-panel-recommendation"
          aria-labelledby="settings-tab-recommendation"
        >
          <RecommendationActivity userId={user.id} />
          <UserPreferencePanels userId={user.id} section="recommendation" readOnly={readOnly} />
        </div>
      )}
    </div>
  );
}

function avatarInitial(name: string) {
  return Array.from(name.trim())[0]?.toUpperCase() ?? "?";
}

function SeekRow({
  id,
  label,
  unit,
  value,
  onChange,
  onCommit,
}: {
  id: string;
  label: string;
  unit: string;
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
}) {
  return (
    <SettingsRow htmlFor={id} title={label}>
      <SettingsNumberInput
        id={id}
        label={label}
        min={SEEK_SECONDS_MIN}
        max={SEEK_SECONDS_MAX}
        unit={unit}
        value={value}
        describedBy="seek-preferences-error"
        onChange={(_, text) => onChange(text)}
        onCommit={onCommit}
      />
    </SettingsRow>
  );
}
