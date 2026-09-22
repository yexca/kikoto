import { RecommendationActivity, UserPreferencePanels } from "@/features/preferences";
import { SettingsRow, SettingsSection } from "@/components/settings/SettingsSection";
import { Badge } from "@/components/ui/badge";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import {
  Download,
  Eraser,
  FastForward,
  Folder,
  KeyRound,
  LoaderCircle,
  Rewind,
  Save,
  Shield,
  Sparkles,
  UserRound,
} from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { toastFromError, useToast } from "@/components/ui/toast";
import { Input } from "@/components/ui/input";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import { api, type CurrentUser } from "@/lib/api";
import { validatePasswordChange, type PasswordChangeDraft } from "@/pages/accountSettings";
import { CleanupPage } from "@/pages/CleanupPage";
import { MaintenancePage } from "@/pages/MaintenancePage";
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

type SettingsTab = "account" | "playback" | "recommendation" | "library" | "cache" | "cleanup" | "users";

const adminSettingsTabs: SettingsTab[] = ["library", "cache", "cleanup", "users"];

const settingsTabs: Array<{ id: SettingsTab; labelKey: string; icon: ReactNode }> = [
  { id: "account", labelKey: "settings.account", icon: <UserRound className="h-4 w-4" /> },
  { id: "playback", labelKey: "settings.playback", icon: <FastForward className="h-4 w-4" /> },
  { id: "recommendation", labelKey: "maintenance.tabs.recommendation", icon: <Sparkles className="h-4 w-4" /> },
  { id: "library", labelKey: "maintenance.tabs.library", icon: <Folder className="h-4 w-4" /> },
  { id: "cache", labelKey: "maintenance.tabs.cache", icon: <Download className="h-4 w-4" /> },
  { id: "cleanup", labelKey: "cleanup.tab", icon: <Eraser className="h-4 w-4" /> },
  { id: "users", labelKey: "maintenance.tabs.users", icon: <Shield className="h-4 w-4" /> },
];

export function SettingsPage({
  user,
  readOnly = false,
  onAccountUpdated,
  onAccessPolicyUpdated,
}: {
  user: CurrentUser;
  readOnly?: boolean;
  onAccountUpdated: () => Promise<void>;
  onAccessPolicyUpdated: () => Promise<void>;
}) {
  const toast = useToast();
  const { t } = useTranslation();
  const [displayName, setDisplayName] = useState(user.displayName || user.username);
  const [passwordDraft, setPasswordDraft] = useState<PasswordChangeDraft>(emptyPasswordDraft);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [isProfileSaving, setIsProfileSaving] = useState(false);
  const [isPasswordSaving, setIsPasswordSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTab>(settingsTabFromLocation);
  const [seekPreferences, setSeekPreferences] = useState<PlaybackSeekPreferences>(() =>
    getStoredPlaybackSeekPreferences(user.id),
  );
  const [seekDraft, setSeekDraft] = useState(() => ({
    forward: String(seekPreferences.seekForwardSeconds),
    backward: String(seekPreferences.seekBackwardSeconds),
  }));
  const [seekError, setSeekError] = useState<string | null>(null);
  const isAdmin = user.role === "admin" || user.role === "super_admin";
  const isSystemAdmin = user.permissions.includes("system:admin");
  const canManageSources = isAdmin && (readOnly || isSystemAdmin || user.permissions.includes("sources:write"));
  const canManageUsers = isAdmin && (readOnly || isSystemAdmin || user.permissions.includes("users:manage"));
  const canManageAccessPolicy = user.role === "super_admin" && !readOnly;
  const canManageCleanup =
    isAdmin && (readOnly || isSystemAdmin || user.permissions.includes("downloads:manage") || canManageSources);

  useEffect(() => {
    const syncTabFromLocation = () => {
      if (window.location.pathname === "/settings") setActiveTab(settingsTabFromLocation());
    };
    window.addEventListener(NAVIGATION_EVENT, syncTabFromLocation);
    window.addEventListener("popstate", syncTabFromLocation);
    return () => {
      window.removeEventListener(NAVIGATION_EVENT, syncTabFromLocation);
      window.removeEventListener("popstate", syncTabFromLocation);
    };
  }, []);

  useEffect(() => {
    if (isAdmin || !adminSettingsTabs.includes(activeTab)) return;
    setActiveTab("account");
    const url = new URL(window.location.href);
    url.searchParams.delete("tab");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [activeTab, isAdmin]);

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

  const saveSeekPreferences = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
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
    toast.success(t("settings.seekUpdated"));
  };

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextDisplayName = displayName.trim() || user.username;
    if (nextDisplayName === user.displayName) return;
    setIsProfileSaving(true);
    try {
      await api.updateCurrentAccount({ displayName: nextDisplayName });
      await onAccountUpdated();
      toast.success(t("account.profileUpdated"));
    } catch (error) {
      toast.notify(toastFromError(error, t("account.profileUpdateFailed")));
    } finally {
      setIsProfileSaving(false);
    }
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

  const selectTab = (tab: SettingsTab) => {
    setActiveTab(tab);
    const url = new URL(window.location.href);
    if (tab === "account") url.searchParams.delete("tab");
    else url.searchParams.set("tab", tab);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  };

  const savedDisplayName = user.displayName || user.username;
  const normalizedDisplayName = displayName.trim() || user.username;
  const passwordManagedByEnvironment = user.passwordManagedBy === "environment";

  return (
    <div className="space-y-6">
      {readOnly && (
        <div
          className="rounded-lg border border-primary/25 bg-primary/5 px-4 py-3 text-sm text-muted-foreground"
          role="status"
        >
          {t("account.demoReadOnly")}
        </div>
      )}
      <div className={segmentedListClassName()} role="tablist" aria-label={t("nav.settings")}>
        {settingsTabs
          .filter((tab) => isAdmin || !adminSettingsTabs.includes(tab.id))
          .map((tab) => (
            <SettingsTabButton
              key={tab.id}
              tab={tab.id}
              active={activeTab === tab.id}
              icon={tab.icon}
              onClick={() => selectTab(tab.id)}
            >
              {t(tab.labelKey)}
            </SettingsTabButton>
          ))}
      </div>

      {activeTab === "account" && (
        <div
          id="settings-panel-account"
          className="w-full max-w-3xl space-y-6"
          role="tabpanel"
          aria-labelledby="settings-tab-account"
        >
          <div className="flex items-center gap-4 px-1">
            <span
              className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-primary/15 text-xl font-semibold text-primary"
              aria-hidden="true"
            >
              {avatarInitial(savedDisplayName)}
            </span>
            <div className="min-w-0">
              <div className="truncate text-lg font-semibold">{savedDisplayName}</div>
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span className="truncate">@{user.username}</span>
                <Badge variant="outline">
                  {t(`account.roles.${user.role}`, { defaultValue: user.role.replace("_", " ") })}
                </Badge>
              </div>
            </div>
          </div>
          <form onSubmit={saveProfile}>
            <SettingsSection
              title={t("settings.account")}
              icon={<UserRound />}
              footer={
                <Button
                  type="submit"
                  size="sm"
                  disabled={readOnly || isProfileSaving || normalizedDisplayName === savedDisplayName}
                >
                  {isProfileSaving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  {t("settings.saveProfile")}
                </Button>
              }
            >
              <SettingsRow title={t("settings.displayName")} htmlFor="account-display-name">
                <Input
                  id="account-display-name"
                  className="w-full sm:w-64"
                  value={displayName}
                  autoComplete="name"
                  disabled={readOnly || isProfileSaving}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </SettingsRow>
            </SettingsSection>
          </form>
          {passwordManagedByEnvironment ? (
            <SettingsSection title={t("settings.password")} icon={<KeyRound />}>
              <div className="px-4 py-3 text-sm text-muted-foreground" role="status">
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
                icon={<KeyRound />}
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
        </div>
      )}

      {activeTab === "playback" && (
        <div
          className="w-full max-w-3xl space-y-6"
          role="tabpanel"
          id="settings-panel-playback"
          aria-labelledby="settings-tab-playback"
        >
          <form onSubmit={saveSeekPreferences}>
            <SettingsSection
              title={t("settings.playback")}
              description={t("settings.playbackDescription")}
              icon={<FastForward />}
              footer={
                <>
                  <span
                    id="seek-preferences-error"
                    className="mr-auto min-h-5 text-sm text-destructive"
                    role={seekError ? "alert" : undefined}
                  >
                    {seekError}
                  </span>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={
                      Number(seekDraft.forward) === seekPreferences.seekForwardSeconds &&
                      Number(seekDraft.backward) === seekPreferences.seekBackwardSeconds
                    }
                  >
                    <Save className="h-4 w-4" />
                    {t("settings.savePlayback")}
                  </Button>
                </>
              }
            >
              <SeekRow
                id="seek-forward-seconds"
                icon={<FastForward className="h-4 w-4 text-muted-foreground" />}
                label={t("settings.seekForward")}
                description={t("settings.seekRange", { min: SEEK_SECONDS_MIN, max: SEEK_SECONDS_MAX })}
                unit={t("settings.seconds")}
                value={seekDraft.forward}
                onChange={(forward) => {
                  setSeekDraft((current) => ({ ...current, forward }));
                  setSeekError(null);
                }}
              />
              <SeekRow
                id="seek-backward-seconds"
                icon={<Rewind className="h-4 w-4 text-muted-foreground" />}
                label={t("settings.seekBackward")}
                description={t("settings.seekRange", { min: SEEK_SECONDS_MIN, max: SEEK_SECONDS_MAX })}
                unit={t("settings.seconds")}
                value={seekDraft.backward}
                onChange={(backward) => {
                  setSeekDraft((current) => ({ ...current, backward }));
                  setSeekError(null);
                }}
              />
            </SettingsSection>
          </form>
          <UserPreferencePanels userId={user.id} section="playback" readOnly={readOnly} />
        </div>
      )}
      {activeTab === "recommendation" && (
        <div
          className="w-full max-w-4xl space-y-6"
          role="tabpanel"
          id="settings-panel-recommendation"
          aria-labelledby="settings-tab-recommendation"
        >
          <UserPreferencePanels userId={user.id} section="recommendation" readOnly={readOnly} />
          <RecommendationActivity userId={user.id} />
        </div>
      )}
      {isAdmin && activeTab === "cleanup" && (
        <div role="tabpanel" id="settings-panel-cleanup" aria-labelledby="settings-tab-cleanup">
          <CleanupPage
            canManageCache={isAdmin && (readOnly || isSystemAdmin || user.permissions.includes("downloads:manage"))}
            canManageDatabase={canManageSources}
            readOnly={readOnly}
          />
        </div>
      )}
      {isAdmin && adminSettingsTabs.includes(activeTab) && activeTab !== "cleanup" && (
        <div role="tabpanel" id={`settings-panel-${activeTab}`} aria-labelledby={`settings-tab-${activeTab}`}>
          <MaintenancePage
            canManageSources={canManageSources}
            canManageUsers={canManageUsers}
            canManageCleanup={canManageCleanup}
            currentUserId={user.id}
            isSuperAdmin={user.role === "super_admin"}
            canManageAccessPolicy={canManageAccessPolicy}
            readOnly={readOnly}
            activeTab={activeTab as "library" | "cache" | "users"}
            onAccessPolicyUpdated={onAccessPolicyUpdated}
          />
        </div>
      )}
    </div>
  );
}

function SettingsTabButton({
  tab,
  active,
  icon,
  children,
  onClick,
}: {
  tab: SettingsTab;
  active: boolean;
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      id={`settings-tab-${tab}`}
      className={segmentedItemClassName(active)}
      type="button"
      role="tab"
      aria-selected={active}
      aria-controls={`settings-panel-${tab}`}
      onClick={onClick}
    >
      {icon}
      {children}
    </button>
  );
}

function settingsTabFromLocation(): SettingsTab {
  const tab = new URLSearchParams(window.location.search).get("tab");
  return ["playback", "recommendation", "library", "cache", "cleanup", "users"].includes(tab ?? "")
    ? (tab as SettingsTab)
    : "account";
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
  icon,
  label,
  description,
  unit,
  value,
  onChange,
}: {
  id: string;
  icon: ReactNode;
  label: string;
  description: string;
  unit: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <SettingsRow
      htmlFor={id}
      title={
        <span className="flex items-center gap-2">
          {icon}
          {label}
        </span>
      }
      description={description}
    >
      <div className="flex w-full items-center gap-2 sm:w-40">
        <Input
          id={id}
          className="w-full text-right tabular-nums"
          type="number"
          min={SEEK_SECONDS_MIN}
          max={SEEK_SECONDS_MAX}
          step={1}
          inputMode="numeric"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-describedby="seek-preferences-error"
        />
        <span className="shrink-0 text-sm text-muted-foreground">{unit}</span>
      </div>
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
