import { KeyRound, LoaderCircle, Monitor, Moon, Save, Sun, UserRound } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import {
  applyThemeAccent,
  applyThemeMode,
  getStoredThemeAccent,
  getStoredThemeMode,
  storeThemeAccent,
  storeThemeMode,
  THEME_ACCENT_CHANGE_EVENT,
  THEME_CHANGE_EVENT,
  type ThemeAccent,
  type ThemeMode,
} from "@/app/theme";
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
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getStoredThemeMode());
  const [themeAccent, setThemeAccent] = useState<ThemeAccent>(() => getStoredThemeAccent());
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
    const syncAccent = (event: Event) =>
      setThemeAccent((event as CustomEvent<ThemeAccent>).detail ?? getStoredThemeAccent());
    window.addEventListener(THEME_CHANGE_EVENT, syncMode);
    window.addEventListener(THEME_ACCENT_CHANGE_EVENT, syncAccent);
    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, syncMode);
      window.removeEventListener(THEME_ACCENT_CHANGE_EVENT, syncAccent);
    };
  }, []);

  const updateTheme = (mode: ThemeMode) => {
    setThemeMode(mode);
    applyThemeMode(mode);
    storeThemeMode(mode);
  };

  const updateAccent = (accent: ThemeAccent) => {
    setThemeAccent(accent);
    applyThemeAccent(accent);
    storeThemeAccent(accent);
  };

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextDisplayName = displayName.trim() || user.username;
    if (nextDisplayName === user.displayName) return;
    setIsProfileSaving(true);
    try {
      await api.updateCurrentAccount({ displayName: nextDisplayName });
      await onAccountUpdated();
      toast.success("Account profile updated.");
    } catch (error) {
      toast.notify(toastFromError(error, "Profile update failed."));
    } finally {
      setIsProfileSaving(false);
    }
  };

  const changePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validationError = validatePasswordChange(passwordDraft);
    setPasswordError(validationError);
    if (validationError) return;
    setIsPasswordSaving(true);
    try {
      await api.updateCurrentAccount({
        currentPassword: passwordDraft.currentPassword,
        newPassword: passwordDraft.newPassword,
      });
      await onAccountUpdated();
      setPasswordDraft(emptyPasswordDraft);
      toast.success("Password changed. Other sessions were signed out.");
    } catch (error) {
      toast.notify(toastFromError(error, "Password change failed."));
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
          Demo mode is read-only.
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <UserRound className="h-4 w-4" />
              Account
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={saveProfile}>
              <label className="block space-y-1 text-sm" htmlFor="account-display-name">
                <span className="font-medium">Display name</span>
                <input
                  id="account-display-name"
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm disabled:bg-muted"
                  value={displayName}
                  autoComplete="name"
                  disabled={readOnly || isProfileSaving}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </label>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                <ReadonlyField label="Username" value={user.username} />
                <ReadonlyField label="Role" value={user.role.replace("_", " ")} />
              </div>
              <div className="flex justify-end">
                <Button
                  type="submit"
                  disabled={readOnly || isProfileSaving || normalizedDisplayName === savedDisplayName}
                >
                  {isProfileSaving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Save profile
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="h-4 w-4" />
              Password
            </CardTitle>
          </CardHeader>
          <CardContent>
            {passwordManagedByEnvironment ? (
              <div className="rounded-md border bg-muted/35 px-3 py-3 text-sm text-muted-foreground" role="status">
                The root password is managed by <code className="font-mono text-foreground">KIKOTO_ROOT_PASSWORD</code>.
                Update it in <code className="font-mono text-foreground">.env</code> and restart Kikoto.
              </div>
            ) : (
              <form className="space-y-3" onSubmit={changePassword}>
                <PasswordField
                  id="current-password"
                  label="Current password"
                  value={passwordDraft.currentPassword}
                  autoComplete="current-password"
                  disabled={readOnly || isPasswordSaving}
                  onChange={(value) => updatePassword("currentPassword", value)}
                />
                <PasswordField
                  id="new-password"
                  label="New password"
                  value={passwordDraft.newPassword}
                  autoComplete="new-password"
                  disabled={readOnly || isPasswordSaving}
                  onChange={(value) => updatePassword("newPassword", value)}
                />
                <PasswordField
                  id="confirm-password"
                  label="Confirm new password"
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
                    Change password
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
              Appearance
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <fieldset className="space-y-2" disabled={readOnly}>
              <legend className="text-sm font-medium">Display mode</legend>
              <div
                className="inline-flex max-w-full gap-1 overflow-x-auto rounded-md border bg-muted/40 p-1"
                aria-label="Theme preference"
              >
                {(
                  [
                    { value: "light", label: "Light", icon: <Sun className="h-4 w-4" /> },
                    { value: "dark", label: "Dark", icon: <Moon className="h-4 w-4" /> },
                    { value: "system", label: "System", icon: <Monitor className="h-4 w-4" /> },
                  ] as const
                ).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`flex h-9 items-center gap-2 rounded px-3 text-sm font-medium transition-[color,background-color,box-shadow,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97] motion-reduce:active:scale-100 ${themeMode === option.value ? "bg-background shadow-sm" : "text-muted-foreground hover:bg-background/60 hover:text-foreground"}`}
                    aria-pressed={themeMode === option.value}
                    onClick={() => updateTheme(option.value)}
                  >
                    {option.icon}
                    {option.label}
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset className="space-y-2" disabled={readOnly}>
              <legend className="text-sm font-medium">Accent color</legend>
              <AccentColorPicker value={themeAccent} onChange={updateAccent} />
            </fieldset>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

const accentOptions: Array<{ value: ThemeAccent; label: string; swatch: string }> = [
  { value: "pink", label: "Pink", swatch: "bg-[#d94f7b]" },
  { value: "blue", label: "Blue", swatch: "bg-[#347fd8]" },
  { value: "green", label: "Green", swatch: "bg-[#349866]" },
];

function AccentColorPicker({ value, onChange }: { value: ThemeAccent; onChange: (accent: ThemeAccent) => void }) {
  return (
    <div className="flex flex-wrap gap-2" aria-label="Accent color">
      {accentOptions.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`flex h-10 items-center gap-2 rounded-md border px-3 text-sm font-medium transition-[color,background-color,border-color,box-shadow,transform] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97] motion-reduce:active:scale-100 ${value === option.value ? "border-primary bg-primary/10 text-primary ring-1 ring-primary/20" : "bg-background text-muted-foreground"}`}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          <span
            className={`h-4 w-4 rounded-full border border-black/10 shadow-sm ${option.swatch}`}
            aria-hidden="true"
          />
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ReadonlyField({ label, value }: { label: string; value: string }) {
  return (
    <label className="space-y-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <input className="h-10 w-full rounded-md border bg-muted px-3 text-sm" value={value} readOnly />
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
        className="h-10 w-full rounded-md border bg-background px-3 text-sm disabled:bg-muted"
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
