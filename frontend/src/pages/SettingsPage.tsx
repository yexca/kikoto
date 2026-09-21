import { UserPreferencePanels } from "@/features/preferences";
import {
  Download,
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toastFromError, useToast } from "@/components/ui/toast";
import { Input } from "@/components/ui/input";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import { api, type CurrentUser } from "@/lib/api";
import { validatePasswordChange, type PasswordChangeDraft } from "@/pages/accountSettings";
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

type SettingsTab = "account" | "playback" | "recommendation" | "library" | "cache" | "users";

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
    if (isAdmin || !["library", "cache", "users"].includes(activeTab)) return;
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
    <div className="space-y-5">
      {readOnly && (
        <div
          className="rounded-lg border border-primary/25 bg-primary/5 px-4 py-3 text-sm text-muted-foreground"
          role="status"
        >
          {t("account.demoReadOnly")}
        </div>
      )}
      <div
        className="app-scrollbar flex gap-2 overflow-x-auto rounded-lg border bg-card p-1"
        role="tablist"
        aria-label={t("nav.settings")}
      >
        <SettingsTabButton
          tab="account"
          active={activeTab === "account"}
          icon={<UserRound className="h-4 w-4" />}
          onClick={() => selectTab("account")}
        >
          {t("settings.account")}
        </SettingsTabButton>
        <SettingsTabButton
          tab="playback"
          active={activeTab === "playback"}
          icon={<FastForward className="h-4 w-4" />}
          onClick={() => selectTab("playback")}
        >
          {t("settings.playback")}
        </SettingsTabButton>
        <SettingsTabButton
          tab="recommendation"
          active={activeTab === "recommendation"}
          icon={<Sparkles className="h-4 w-4" />}
          onClick={() => selectTab("recommendation")}
        >
          {t("maintenance.tabs.recommendation")}
        </SettingsTabButton>
        {isAdmin && (
          <>
            <SettingsTabButton
              tab="library"
              active={activeTab === "library"}
              icon={<Folder className="h-4 w-4" />}
              onClick={() => selectTab("library")}
            >
              {t("maintenance.tabs.library")}
            </SettingsTabButton>
            <SettingsTabButton
              tab="cache"
              active={activeTab === "cache"}
              icon={<Download className="h-4 w-4" />}
              onClick={() => selectTab("cache")}
            >
              {t("maintenance.tabs.cache")}
            </SettingsTabButton>
            <SettingsTabButton
              tab="users"
              active={activeTab === "users"}
              icon={<Shield className="h-4 w-4" />}
              onClick={() => selectTab("users")}
            >
              {t("maintenance.tabs.users")}
            </SettingsTabButton>
          </>
        )}
      </div>

      {activeTab === "account" && (
        <div
          id="settings-panel-account"
          className="grid w-full max-w-4xl gap-4 lg:grid-cols-2"
          role="tabpanel"
          aria-labelledby="settings-tab-account"
        >
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <UserRound className="h-4 w-4" />
                {t("settings.account")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form className="space-y-4" onSubmit={saveProfile}>
                <label className="block space-y-1 text-sm" htmlFor="account-display-name">
                  <span className="font-medium">{t("settings.displayName")}</span>
                  <Input
                    id="account-display-name"
                    className="w-full"
                    value={displayName}
                    autoComplete="name"
                    disabled={readOnly || isProfileSaving}
                    onChange={(event) => setDisplayName(event.target.value)}
                  />
                </label>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
                  <ReadonlyField label={t("settings.username")} value={user.username} />
                  <ReadonlyField
                    label={t("settings.role")}
                    value={t(`account.roles.${user.role}`, { defaultValue: user.role.replace("_", " ") })}
                  />
                </div>
                <div className="flex justify-end">
                  <Button
                    type="submit"
                    disabled={readOnly || isProfileSaving || normalizedDisplayName === savedDisplayName}
                  >
                    {isProfileSaving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    {t("settings.saveProfile")}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <KeyRound className="h-4 w-4" />
                {t("settings.password")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {passwordManagedByEnvironment ? (
                <div className="rounded-md border bg-muted/35 px-3 py-3 text-sm text-muted-foreground" role="status">
                  <Trans
                    i18nKey="settings.rootPasswordManaged"
                    components={{
                      env: <code className="font-mono text-foreground" />,
                      file: <code className="font-mono text-foreground" />,
                    }}
                  />
                </div>
              ) : (
                <form className="space-y-3" onSubmit={changePassword}>
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
                  <div
                    className="min-h-5 text-sm text-destructive"
                    id="password-error"
                    role={passwordError ? "alert" : undefined}
                  >
                    {passwordError}
                  </div>
                  <div className="flex justify-end">
                    <Button type="submit" disabled={readOnly || isPasswordSaving}>
                      {isPasswordSaving ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : (
                        <KeyRound className="h-4 w-4" />
                      )}
                      {t("settings.changePassword")}
                    </Button>
                  </div>
                </form>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {activeTab === "playback" && (
        <div
          className="w-full max-w-4xl space-y-4"
          role="tabpanel"
          id="settings-panel-playback"
          aria-labelledby="settings-tab-playback"
        >
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <FastForward className="h-4 w-4" />
                {t("settings.playback")}
              </CardTitle>
              <p className="text-sm text-muted-foreground">{t("settings.playbackDescription")}</p>
            </CardHeader>
            <CardContent>
              <form className="space-y-4" onSubmit={saveSeekPreferences}>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block space-y-1 text-sm" htmlFor="seek-forward-seconds">
                    <span className="flex items-center gap-2 font-medium">
                      <FastForward className="h-4 w-4 text-muted-foreground" />
                      {t("settings.seekForward")}
                    </span>
                    <div className="flex items-center gap-2">
                      <Input
                        id="seek-forward-seconds"
                        className="w-full"
                        type="number"
                        min={SEEK_SECONDS_MIN}
                        max={SEEK_SECONDS_MAX}
                        step={1}
                        inputMode="numeric"
                        value={seekDraft.forward}
                        onChange={(event) => {
                          setSeekDraft((current) => ({ ...current, forward: event.target.value }));
                          setSeekError(null);
                        }}
                        aria-describedby="seek-preferences-error seek-preferences-range"
                      />
                      <span className="shrink-0 text-sm text-muted-foreground">{t("settings.seconds")}</span>
                    </div>
                  </label>
                  <label className="block space-y-1 text-sm" htmlFor="seek-backward-seconds">
                    <span className="flex items-center gap-2 font-medium">
                      <Rewind className="h-4 w-4 text-muted-foreground" />
                      {t("settings.seekBackward")}
                    </span>
                    <div className="flex items-center gap-2">
                      <Input
                        id="seek-backward-seconds"
                        className="w-full"
                        type="number"
                        min={SEEK_SECONDS_MIN}
                        max={SEEK_SECONDS_MAX}
                        step={1}
                        inputMode="numeric"
                        value={seekDraft.backward}
                        onChange={(event) => {
                          setSeekDraft((current) => ({ ...current, backward: event.target.value }));
                          setSeekError(null);
                        }}
                        aria-describedby="seek-preferences-error seek-preferences-range"
                      />
                      <span className="shrink-0 text-sm text-muted-foreground">{t("settings.seconds")}</span>
                    </div>
                  </label>
                </div>
                <p id="seek-preferences-range" className="text-xs text-muted-foreground">
                  {t("settings.seekRange", { min: SEEK_SECONDS_MIN, max: SEEK_SECONDS_MAX })}
                </p>
                <p
                  id="seek-preferences-error"
                  className="min-h-5 text-sm text-destructive"
                  role={seekError ? "alert" : undefined}
                >
                  {seekError}
                </p>
                <div className="flex justify-end">
                  <Button
                    type="submit"
                    disabled={
                      Number(seekDraft.forward) === seekPreferences.seekForwardSeconds &&
                      Number(seekDraft.backward) === seekPreferences.seekBackwardSeconds
                    }
                  >
                    <Save className="h-4 w-4" />
                    {t("settings.savePlayback")}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
          <UserPreferencePanels userId={user.id} section="playback" readOnly={readOnly} />
        </div>
      )}
      {activeTab === "recommendation" && (
        <div
          className="w-full max-w-4xl"
          role="tabpanel"
          id="settings-panel-recommendation"
          aria-labelledby="settings-tab-recommendation"
        >
          <UserPreferencePanels userId={user.id} section="recommendation" readOnly={readOnly} />
        </div>
      )}
      {isAdmin && ["library", "cache", "users"].includes(activeTab) && (
        <MaintenancePage
          canManageSources={canManageSources}
          canManageUsers={canManageUsers}
          currentUserId={user.id}
          isSuperAdmin={user.role === "super_admin"}
          canManageAccessPolicy={canManageAccessPolicy}
          readOnly={readOnly}
          embedded
          activeTab={activeTab as "library" | "cache" | "users"}
          onAccessPolicyUpdated={onAccessPolicyUpdated}
        />
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
      className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
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
  return ["playback", "recommendation", "library", "cache", "users"].includes(tab ?? "")
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

function ReadonlyField({ label, value }: { label: string; value: string }) {
  return (
    <label className="space-y-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <input
        className="h-[var(--control-height)] w-full rounded-md border bg-muted px-3 text-sm"
        value={value}
        readOnly
      />
    </label>
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
    <label className="block space-y-1 text-sm" htmlFor={id}>
      <span className="font-medium">{label}</span>
      <Input
        id={id}
        className="w-full"
        type="password"
        value={value}
        autoComplete={autoComplete}
        disabled={disabled}
        aria-describedby="password-error"
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
