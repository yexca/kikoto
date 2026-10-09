import {
  DevicePrivacyPreferences,
  PlaybackSourcePreferences,
  RecommendationActivity,
  UserPreferencePanels,
} from "@/features/preferences";
import { DemoReadOnlyNotice } from "@/components/DemoReadOnlyNotice";
import { SettingsNumberInput, SettingsRow, SettingsSection } from "@/components/settings/SettingsSection";
import { IconRail, type IconRailItem } from "@/components/ui/icon-rail";
import { useRailOrientation } from "@/components/ui/rail-labels";
import {
  Download,
  Eraser,
  FastForward,
  Folder,
  History,
  KeyRound,
  LoaderCircle,
  Network,
  Save,
  Shield,
  Sparkles,
  Tags,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { toastFromError, useToast } from "@/components/ui/toast";
import { Input } from "@/components/ui/input";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import { cx } from "@/lib/classNames";
import { supportsNativePrivacy } from "@/lib/nativePrivacy";
import { api, type CurrentUser } from "@/lib/api";
import { validatePasswordChange, type PasswordChangeDraft } from "@/pages/accountSettings";
import { CleanupPage } from "@/pages/CleanupPage";
import { MaintenancePage } from "@/pages/MaintenancePage";
import { PersonalTabPanel, type PersonalTabProps } from "@/pages/PersonalTabPanel";
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

type SettingsTab =
  "account" | "playback" | "history" | "recommendation" | "tags" | "library" | "cache" | "proxy" | "cleanup" | "users";
type SettingsSectionTarget = "data";
type SettingsLocation = { tab: SettingsTab; section?: SettingsSectionTarget };

const adminSettingsTabs: SettingsTab[] = ["library", "cache", "proxy", "cleanup", "users"];
// Listening history and personal tags need library access; the other personal tabs do not.
const libraryReaderTabs: SettingsTab[] = ["history", "tags"];
const allSettingsTabs: SettingsTab[] = [
  "account",
  "playback",
  "history",
  "recommendation",
  "tags",
  ...adminSettingsTabs,
];
// Alias tab ids keep existing links valid; each opens the tab that holds its content.
const settingsTabAliases: Record<string, SettingsLocation> = {
  data: { tab: "account", section: "data" },
  // The metadata tab id opens Library, which holds catalog freshness.
  metadata: { tab: "library" },
};

// Every tab shares one content width so switching tabs never shifts the layout.
const settingsPanelClassName = "w-full max-w-4xl space-y-8";

const settingsTabs: Array<{ id: SettingsTab; labelKey: string; icon: LucideIcon }> = [
  { id: "account", labelKey: "settings.account", icon: UserRound },
  { id: "playback", labelKey: "settings.playback", icon: FastForward },
  { id: "history", labelKey: "nav.history", icon: History },
  { id: "recommendation", labelKey: "settings.recommendations", icon: Sparkles },
  { id: "tags", labelKey: "nav.tags", icon: Tags },
  { id: "library", labelKey: "maintenance.tabs.library", icon: Folder },
  { id: "cache", labelKey: "maintenance.tabs.cache", icon: Download },
  { id: "proxy", labelKey: "maintenance.tabs.proxy", icon: Network },
  { id: "cleanup", labelKey: "cleanup.tab", icon: Eraser },
  { id: "users", labelKey: "maintenance.tabs.users", icon: Shield },
];

export function SettingsPage({
  user,
  readOnly = false,
  personal,
  onAccountUpdated,
  onAccessPolicyUpdated,
}: {
  user: CurrentUser;
  readOnly?: boolean;
  /** Omitted when the account cannot read the library, which hides the personal tabs. */
  personal?: PersonalTabProps;
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
  const [initialLocation] = useState(settingsLocationFromUrl);
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialLocation.tab);
  // Each navigation stores a fresh object, so opening the same section again scrolls again.
  const [sectionTarget, setSectionTarget] = useState<SettingsLocation>(initialLocation);
  const [seekPreferences, setSeekPreferences] = useState<PlaybackSeekPreferences>(() =>
    getStoredPlaybackSeekPreferences(user.id),
  );
  const [seekDraft, setSeekDraft] = useState(() => ({
    forward: String(seekPreferences.seekForwardSeconds),
    backward: String(seekPreferences.seekBackwardSeconds),
  }));
  const [seekError, setSeekError] = useState<string | null>(null);
  const [railOrientation, toggleRailOrientation] = useRailOrientation("kikoto:settings-rail-orientation");
  // Demo shows every administration surface read-only even though its identity
  // is not an administrator; the server rejects every write.
  const canViewAdministration = readOnly || user.role === "admin" || user.role === "super_admin";
  const isSystemAdmin = user.permissions.includes("system:admin");
  const hasAdminPermission = (permission: string) =>
    canViewAdministration && (readOnly || isSystemAdmin || user.permissions.includes(permission));
  const canManageSources = hasAdminPermission("sources:write");
  const canManageUsers = hasAdminPermission("users:manage");
  const canManageCache = hasAdminPermission("downloads:manage");
  const canManageAccessPolicy = user.role === "super_admin" && !readOnly;
  const canManageCleanup = canManageCache || canManageSources;

  useEffect(() => {
    const syncTabFromLocation = () => {
      if (window.location.pathname !== "/settings") return;
      const location = settingsLocationFromUrl();
      setActiveTab(location.tab);
      setSectionTarget(location);
    };
    window.addEventListener(NAVIGATION_EVENT, syncTabFromLocation);
    window.addEventListener("popstate", syncTabFromLocation);
    return () => {
      window.removeEventListener(NAVIGATION_EVENT, syncTabFromLocation);
      window.removeEventListener("popstate", syncTabFromLocation);
    };
  }, []);

  useEffect(() => {
    const section = sectionTarget.section;
    if (!section) return;
    // Navigation scroll restoration places a new entry at the top two frames later, and the
    // section content loads lazily; land on the section after both.
    let observer: ResizeObserver | undefined;
    const scrollWhenRendered = () => {
      const element = document.getElementById(`settings-section-${section}`);
      if (!element) return;
      observer = new ResizeObserver(() => {
        if (element.offsetHeight === 0) return;
        observer?.disconnect();
        element.scrollIntoView();
      });
      observer.observe(element);
    };
    let frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(scrollWhenRendered);
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [sectionTarget]);

  useEffect(() => {
    const unavailable =
      (!canViewAdministration && adminSettingsTabs.includes(activeTab)) ||
      (!personal && libraryReaderTabs.includes(activeTab));
    if (!unavailable) return;
    setActiveTab("account");
    const url = new URL(window.location.href);
    url.searchParams.delete("tab");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [activeTab, canViewAdministration, personal]);

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

  const railItems: IconRailItem<SettingsTab>[] = settingsTabs
    .filter((tab) =>
      adminSettingsTabs.includes(tab.id) ? canViewAdministration : personal || !libraryReaderTabs.includes(tab.id),
    )
    .map((tab) => {
      const administration = adminSettingsTabs.includes(tab.id);
      return {
        value: tab.id,
        label: t(tab.labelKey),
        icon: tab.icon,
        id: `settings-tab-${tab.id}`,
        controls: `settings-panel-${tab.id}`,
        // A divider and a shared description set the administration tabs apart from the personal ones.
        separated: administration && tab.id === adminSettingsTabs[0],
        description: administration ? t("settings.administration") : undefined,
      };
    });

  const savedDisplayName = user.displayName || user.username;
  const normalizedDisplayName = displayName.trim() || user.username;
  const passwordManagedByEnvironment = user.passwordManagedBy === "environment";

  return (
    <div className="space-y-6">
      {readOnly && <DemoReadOnlyNotice />}
      <div className={cx("flex min-w-0 flex-col gap-6", railOrientation === "vertical" && "lg:flex-row lg:gap-8")}>
        <IconRail
          label={t("nav.settings")}
          labelsStorageKey="kikoto:settings-rail-labels-shown"
          items={railItems}
          selected={activeTab}
          onSelect={selectTab}
          orientation={railOrientation}
          onToggleOrientation={toggleRailOrientation}
        />
        <div className="min-w-0 flex-1">
          {activeTab === "account" && (
            <div
              id="settings-panel-account"
              className={settingsPanelClassName}
              role="tabpanel"
              aria-labelledby="settings-tab-account"
            >
              <form onSubmit={saveProfile}>
                <SettingsSection
                  title={t("settings.account")}
                  footer={
                    <Button
                      type="submit"
                      size="sm"
                      disabled={readOnly || isProfileSaving || normalizedDisplayName === savedDisplayName}
                    >
                      {isProfileSaving ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : (
                        <Save className="h-4 w-4" />
                      )}
                      {t("settings.saveProfile")}
                    </Button>
                  }
                >
                  <div className="flex min-w-0 items-center gap-3 px-4 py-4">
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
                    />
                  </SettingsRow>
                </SettingsSection>
              </form>
              {passwordManagedByEnvironment ? (
                <SettingsSection title={t("settings.password")}>
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
              {personal && (
                <section
                  id="settings-section-data"
                  className="scroll-mt-[calc(var(--header-height)+var(--safe-area-top)+1rem)]"
                  aria-label={t("nav.userData")}
                >
                  <PersonalTabPanel tab="data" {...personal} />
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
              <form onSubmit={saveSeekPreferences}>
                <SettingsSection
                  title={t("settings.playback")}
                  description={t("settings.playbackDescription")}
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
              <PlaybackSourcePreferences userId={user.id} />
              {supportsNativePrivacy() && <DevicePrivacyPreferences />}
              <UserPreferencePanels userId={user.id} section="playback" readOnly={readOnly} />
            </div>
          )}
          {personal && activeTab === "history" && (
            <div
              className={settingsPanelClassName}
              role="tabpanel"
              id="settings-panel-history"
              aria-labelledby="settings-tab-history"
            >
              <PersonalTabPanel tab="history" {...personal} />
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
          {personal && activeTab === "tags" && (
            <div
              className={settingsPanelClassName}
              role="tabpanel"
              id="settings-panel-tags"
              aria-labelledby="settings-tab-tags"
            >
              <PersonalTabPanel tab="tags" {...personal} />
            </div>
          )}
          {canViewAdministration && activeTab === "cleanup" && (
            <div
              className={settingsPanelClassName}
              role="tabpanel"
              id="settings-panel-cleanup"
              aria-labelledby="settings-tab-cleanup"
            >
              <CleanupPage canManageCache={canManageCache} canManageDatabase={canManageSources} readOnly={readOnly} />
            </div>
          )}
          {canViewAdministration && adminSettingsTabs.includes(activeTab) && activeTab !== "cleanup" && (
            <div
              className={settingsPanelClassName}
              role="tabpanel"
              id={`settings-panel-${activeTab}`}
              aria-labelledby={`settings-tab-${activeTab}`}
            >
              <MaintenancePage
                canManageSources={canManageSources}
                canManageUsers={canManageUsers}
                canManageCleanup={canManageCleanup}
                currentUserId={user.id}
                isSuperAdmin={user.role === "super_admin"}
                canManageAccessPolicy={canManageAccessPolicy}
                readOnly={readOnly}
                activeTab={activeTab as "library" | "cache" | "proxy" | "users"}
                onAccessPolicyUpdated={onAccessPolicyUpdated}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function settingsLocationFromUrl(): SettingsLocation {
  const tab = new URLSearchParams(window.location.search).get("tab") ?? "";
  if (allSettingsTabs.includes(tab as SettingsTab)) return { tab: tab as SettingsTab };
  return settingsTabAliases[tab] ?? { tab: "account" };
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
}: {
  id: string;
  label: string;
  description: string;
  unit: string;
  value: string;
  onChange: (value: string) => void;
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
