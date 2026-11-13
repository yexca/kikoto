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
import { FastForward, KeyRound, LoaderCircle, Sparkles, UserRound, type LucideIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useState, type ComponentProps, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { toastFromError, useToast } from "@/components/ui/toast";
import { Input } from "@/components/ui/input";
import { supportsNativePrivacy } from "@/lib/nativePrivacy";
import { api, type CurrentUser } from "@/lib/api";
import { validatePasswordChange, type PasswordChangeDraft } from "@/pages/accountSettings";
import { AccountTimeZoneSection } from "@/features/time-zone/AccountTimeZoneSection";
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

const emptyPasswordDraft: PasswordChangeDraft = {
  currentPassword: "",
  newPassword: "",
  confirmPassword: "",
};

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
  const toast = useToast();
  const { t } = useTranslation();
  const [displayName, setDisplayName] = useState(user.displayName || user.username);
  const [passwordDraft, setPasswordDraft] = useState<PasswordChangeDraft>(emptyPasswordDraft);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [isProfileSaving, setIsProfileSaving] = useState(false);
  const [isPasswordSaving, setIsPasswordSaving] = useState(false);
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
  const profileStatus = useAutosaveStatus();
  const seekStatus = useAutosaveStatus();

  useEffect(() => {
    setDisplayName(user.displayName || user.username);
  }, [user.displayName, user.username]);

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

  // Saved when the field's edit is finished; a failure returns the field to the saved name.
  const saveProfile = async (nextDisplayName: string) => {
    setIsProfileSaving(true);
    try {
      await api.updateCurrentAccount({ displayName: nextDisplayName });
      await onAccountUpdated();
      return true;
    } catch (error) {
      setDisplayName(user.displayName || user.username);
      toast.notify(toastFromError(error, t("account.profileUpdateFailed")));
      return false;
    } finally {
      setIsProfileSaving(false);
    }
  };

  const commitDisplayName = () => {
    const nextDisplayName = displayName.trim() || user.username;
    if (readOnly || isProfileSaving || nextDisplayName === (user.displayName || user.username)) return;
    void profileStatus.track(saveProfile(nextDisplayName));
  };

  const changePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validationError = validatePasswordChange(passwordDraft);
    setPasswordError(validationError ? t(passwordErrorKey(validationError), { defaultValue: validationError }) : null);
    if (validationError) return;
    setIsPasswordSaving(true);
    try {
      await api.updateCurrentAccount({
        currentPassword: passwordDraft.currentPassword,
        newPassword: passwordDraft.newPassword,
      });
      await onAccountUpdated();
      setPasswordDraft(emptyPasswordDraft);
      toast.success(t("account.passwordChanged"));
    } catch (error) {
      toast.notify(toastFromError(error, t("account.passwordChangeFailed")));
    } finally {
      setIsPasswordSaving(false);
    }
  };

  const updatePassword = (field: keyof PasswordChangeDraft, value: string) => {
    setPasswordDraft((current) => ({ ...current, [field]: value }));
    setPasswordError(null);
  };

  const navItems: SubNavItem<SettingsTab>[] = settingsTabs.map((tab) => ({
    value: tab.id,
    label: t(tab.labelKey),
    icon: tab.icon,
    id: `settings-tab-${tab.id}`,
    controls: `settings-panel-${tab.id}`,
  }));

  const savedDisplayName = user.displayName || user.username;
  const passwordManagedByEnvironment = user.passwordManagedBy === "environment";

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
          <SettingsSection title={t("settings.account")} action={<AutosaveStatus state={profileStatus.state} />}>
            <div className="flex min-w-0 items-center gap-3 py-4">
              <span
                className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-primary/10 text-base font-semibold text-primary"
                aria-hidden="true"
              >
                {avatarInitial(savedDisplayName)}
              </span>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{savedDisplayName}</div>
                <div className="truncate text-xs text-muted-foreground">
                  @{user.username}
                  <span aria-hidden="true" className="px-1.5">
                    ·
                  </span>
                  {t(`account.roles.${user.role}`, { defaultValue: user.role.replace("_", " ") })}
                </div>
              </div>
            </div>
            <SettingsRow title={t("settings.displayName")} htmlFor="account-display-name">
              <Input
                id="account-display-name"
                className="w-full sm:w-64"
                value={displayName}
                autoComplete="name"
                disabled={readOnly || isProfileSaving}
                onChange={(event) => setDisplayName(event.target.value)}
                onBlur={commitDisplayName}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitDisplayName();
                }}
              />
            </SettingsRow>
          </SettingsSection>
          {passwordManagedByEnvironment ? (
            <SettingsSection title={t("settings.password")}>
              <div className="py-3 text-sm text-muted-foreground" role="status">
                <Trans
                  i18nKey="settings.rootPasswordManaged"
                  components={{
                    env: <code className="font-mono text-foreground" />,
                    file: <code className="font-mono text-foreground" />,
                  }}
                />
              </div>
            </SettingsSection>
          ) : (
            <form onSubmit={changePassword}>
              <SettingsSection
                title={t("settings.password")}
                footer={
                  <>
                    <span
                      className="mr-auto min-h-5 text-sm text-destructive"
                      id="password-error"
                      role={passwordError ? "alert" : undefined}
                    >
                      {passwordError}
                    </span>
                    <Button type="submit" size="sm" disabled={readOnly || isPasswordSaving}>
                      {isPasswordSaving ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : (
                        <KeyRound className="h-4 w-4" />
                      )}
                      {t("settings.changePassword")}
                    </Button>
                  </>
                }
              >
                {/* Names the account so password managers update its saved sign-in. */}
                <input type="text" name="username" autoComplete="username" value={user.username} readOnly hidden />
                <PasswordField
                  id="current-password"
                  label={t("settings.currentPassword")}
                  value={passwordDraft.currentPassword}
                  autoComplete="current-password"
                  disabled={readOnly || isPasswordSaving}
                  onChange={(value) => updatePassword("currentPassword", value)}
                />
                <PasswordField
                  id="new-password"
                  label={t("settings.newPassword")}
                  value={passwordDraft.newPassword}
                  autoComplete="new-password"
                  disabled={readOnly || isPasswordSaving}
                  onChange={(value) => updatePassword("newPassword", value)}
                />
                <PasswordField
                  id="confirm-password"
                  label={t("settings.confirmNewPassword")}
                  value={passwordDraft.confirmPassword}
                  autoComplete="new-password"
                  disabled={readOnly || isPasswordSaving}
                  onChange={(value) => updatePassword("confirmPassword", value)}
                />
              </SettingsSection>
            </form>
          )}
          <AccountTimeZoneSection readOnly={readOnly} />
          {data && (
            <section
              id="settings-section-data"
              className="scroll-mt-[calc(var(--header-height)+var(--safe-area-top)+1rem)]"
              aria-label={t("nav.userData")}
            >
              <Suspense fallback={null}>
                <UserDataPage {...data} />
              </Suspense>
            </section>
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
            description={t("settings.playbackDescription")}
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
              description={t("settings.seekRange", { min: SEEK_SECONDS_MIN, max: SEEK_SECONDS_MAX })}
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
              description={t("settings.seekRange", { min: SEEK_SECONDS_MIN, max: SEEK_SECONDS_MAX })}
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

function passwordErrorKey(message: string) {
  switch (message) {
    case "Current password is required.":
      return "settings.passwordErrors.currentRequired";
    case "New password is required.":
      return "settings.passwordErrors.newRequired";
    case "New password must be at least 8 characters.":
      return "settings.passwordErrors.tooShort";
    case "New password must differ from your current password.":
      return "settings.passwordErrors.unchanged";
    case "Confirm your new password.":
      return "settings.passwordErrors.confirmRequired";
    case "New passwords do not match.":
      return "settings.passwordErrors.mismatch";
    default:
      return message;
  }
}

function avatarInitial(name: string) {
  return Array.from(name.trim())[0]?.toUpperCase() ?? "?";
}

function SeekRow({
  id,
  label,
  description,
  unit,
  value,
  onChange,
  onCommit,
}: {
  id: string;
  label: string;
  description: string;
  unit: string;
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
}) {
  return (
    <SettingsRow htmlFor={id} title={label} description={description}>
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

function PasswordField({
  id,
  label,
  value,
  autoComplete,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  autoComplete: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <SettingsRow title={label} htmlFor={id}>
      <Input
        id={id}
        name={id}
        className="w-full sm:w-64"
        type="password"
        value={value}
        autoComplete={autoComplete}
        disabled={disabled}
        aria-describedby="password-error"
        onChange={(event) => onChange(event.target.value)}
      />
    </SettingsRow>
  );
}
