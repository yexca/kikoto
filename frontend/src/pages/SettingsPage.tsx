import { KeyRound, LoaderCircle, Monitor, Moon, Save, Sun, UserRound } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";

import {
  applyThemeMode,
  applyThemePalette,
  applyThemePreset,
  getStoredThemeMode,
  getStoredThemePalette,
  getStoredThemePreset,
  storeThemeMode,
  storeThemePalette,
  storeThemePreset,
  THEME_CHANGE_EVENT,
  THEME_PALETTE_CHANGE_EVENT,
  THEME_PRESET_CHANGE_EVENT,
  type ThemeMode,
  type ThemePalette,
  type ThemePreset,
} from "@/app/theme";
import { ThemePalettePicker } from "@/app/ThemePalettePicker";
import { ThemePresetPicker } from "@/app/ThemePresetPicker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toastFromError, useToast } from "@/components/ui/toast";
import { api, type CurrentUser } from "@/lib/api";
import { validatePasswordChange, type PasswordChangeDraft } from "@/pages/accountSettings";

const emptyPasswordDraft: PasswordChangeDraft = {
  currentPassword: "",
  newPassword: "",
  confirmPassword: "",
};

export function SettingsPage({
  user,
  readOnly = false,
  onAccountUpdated,
}: {
  user: CurrentUser;
  readOnly?: boolean;
  onAccountUpdated: () => Promise<void>;
}) {
  const toast = useToast();
  const { t } = useTranslation();
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getStoredThemeMode());
  const [themePreset, setThemePreset] = useState<ThemePreset>(() => getStoredThemePreset());
  const [themePalette, setThemePalette] = useState<ThemePalette>(() => getStoredThemePalette());
  const [displayName, setDisplayName] = useState(user.displayName || user.username);
  const [passwordDraft, setPasswordDraft] = useState<PasswordChangeDraft>(emptyPasswordDraft);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [isProfileSaving, setIsProfileSaving] = useState(false);
  const [isPasswordSaving, setIsPasswordSaving] = useState(false);

  useEffect(() => {
    setDisplayName(user.displayName || user.username);
  }, [user.displayName, user.username]);

  useEffect(() => {
    const syncMode = (event: Event) => setThemeMode((event as CustomEvent<ThemeMode>).detail ?? getStoredThemeMode());
    const syncPreset = (event: Event) =>
      setThemePreset((event as CustomEvent<ThemePreset>).detail ?? getStoredThemePreset());
    const syncPalette = (event: Event) =>
      setThemePalette((event as CustomEvent<ThemePalette>).detail ?? getStoredThemePalette());
    window.addEventListener(THEME_CHANGE_EVENT, syncMode);
    window.addEventListener(THEME_PRESET_CHANGE_EVENT, syncPreset);
    window.addEventListener(THEME_PALETTE_CHANGE_EVENT, syncPalette);
    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, syncMode);
      window.removeEventListener(THEME_PRESET_CHANGE_EVENT, syncPreset);
      window.removeEventListener(THEME_PALETTE_CHANGE_EVENT, syncPalette);
    };
  }, []);

  const updateTheme = (mode: ThemeMode) => {
    setThemeMode(mode);
    applyThemeMode(mode);
    storeThemeMode(mode);
  };

  const updatePreset = (preset: ThemePreset) => {
    setThemePreset(preset);
    applyThemePreset(preset);
    storeThemePreset(preset);
  };

  const updatePalette = (palette: ThemePalette) => {
    setThemePalette(palette);
    applyThemePalette(palette);
    storeThemePalette(palette);
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
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)]">
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
                <input
                  id="account-display-name"
                  className="h-[var(--control-height)] w-full rounded-md border bg-background px-3 text-sm disabled:bg-muted"
                  value={displayName}
                  autoComplete="name"
                  disabled={readOnly || isProfileSaving}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </label>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
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
        <Card className="lg:col-span-2 xl:col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Monitor className="h-4 w-4" />
              {t("appearance.title")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t("appearance.displayMode")}</legend>
              <div
                className="inline-flex max-w-full gap-1 overflow-x-auto rounded-md border bg-muted/40 p-1"
                aria-label={t("appearance.themePreference")}
              >
                {(
                  [
                    { value: "light", label: t("appearance.light"), icon: <Sun className="h-4 w-4" /> },
                    { value: "dark", label: t("appearance.dark"), icon: <Moon className="h-4 w-4" /> },
                    { value: "system", label: t("appearance.system"), icon: <Monitor className="h-4 w-4" /> },
                  ] as const
                ).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`flex h-[var(--control-height)] items-center gap-2 rounded px-3 text-sm font-medium transition-[color,background-color,box-shadow,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[var(--press-scale)] motion-reduce:active:scale-100 ${themeMode === option.value ? "bg-background shadow-sm" : "text-muted-foreground hover:bg-background/60 hover:text-foreground"}`}
                    aria-pressed={themeMode === option.value}
                    onClick={() => updateTheme(option.value)}
                  >
                    {option.icon}
                    {option.label}
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t("appearance.themeStyle")}</legend>
              <ThemePresetPicker value={themePreset} onChange={updatePreset} palette={themePalette} />
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t("appearance.color")}</legend>
              <ThemePalettePicker preset={themePreset} value={themePalette} onChange={updatePalette} />
            </fieldset>
          </CardContent>
        </Card>
      </div>
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
      <input
        id={id}
        className="h-[var(--control-height)] w-full rounded-md border bg-background px-3 text-sm disabled:bg-muted"
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
