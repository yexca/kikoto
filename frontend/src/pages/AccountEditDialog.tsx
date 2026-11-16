import { LoaderCircle, Save } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toastFromError, useToast } from "@/components/ui/toast";
import { api, type CurrentUser } from "@/lib/api";
import { validatePasswordChange, type PasswordChangeDraft } from "@/pages/accountSettings";

const emptyPasswordDraft: PasswordChangeDraft = {
  currentPassword: "",
  newPassword: "",
  confirmPassword: "",
};

/** Edits the signed-in account's display name and password in one dialog. */
export function AccountEditDialog({
  user,
  readOnly,
  onAccountUpdated,
  onClose,
}: {
  user: CurrentUser;
  readOnly: boolean;
  onAccountUpdated: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const savedDisplayName = user.displayName || user.username;
  const passwordManagedByEnvironment = user.passwordManagedBy === "environment";
  const [displayName, setDisplayName] = useState(savedDisplayName);
  const [passwordDraft, setPasswordDraft] = useState<PasswordChangeDraft>(emptyPasswordDraft);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const nextDisplayName = displayName.trim() || user.username;
  const displayNameChanged = nextDisplayName !== savedDisplayName;
  const passwordTouched =
    !passwordManagedByEnvironment &&
    Boolean(passwordDraft.currentPassword || passwordDraft.newPassword || passwordDraft.confirmPassword);
  const hasChanges = displayNameChanged || passwordTouched;

  const updatePassword = (field: keyof PasswordChangeDraft, value: string) => {
    setPasswordDraft((current) => ({ ...current, [field]: value }));
    setPasswordError(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (readOnly || isSaving || !hasChanges) return;
    if (passwordTouched) {
      const validationError = validatePasswordChange(passwordDraft);
      if (validationError) {
        setPasswordError(t(passwordErrorKey(validationError), { defaultValue: validationError }));
        return;
      }
    }
    setIsSaving(true);
    try {
      await api.updateCurrentAccount({
        ...(displayNameChanged ? { displayName: nextDisplayName } : {}),
        ...(passwordTouched
          ? {
              currentPassword: passwordDraft.currentPassword,
              newPassword: passwordDraft.newPassword,
            }
          : {}),
      });
      await onAccountUpdated();
      toast.success(t(passwordTouched ? "account.passwordChanged" : "account.profileUpdated"));
      onClose();
    } catch (error) {
      toast.notify(
        toastFromError(error, t(passwordTouched ? "account.passwordChangeFailed" : "account.profileUpdateFailed")),
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog onClose={onClose} size="md" dismissible={!isSaving}>
      <DialogHeader
        title={t("settings.editAccount")}
        description={`@${user.username}`}
        onClose={isSaving ? undefined : onClose}
        closeLabel={t("common.close")}
      />
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
        <DialogBody className="space-y-4">
          {!passwordManagedByEnvironment && (
            /* Names the account so password managers update its saved sign-in. */
            <input type="text" name="username" autoComplete="username" value={user.username} readOnly hidden />
          )}
          <label htmlFor="account-display-name" className="grid gap-1.5 text-sm font-medium">
            {t("settings.displayName")}
            <Input
              id="account-display-name"
              value={displayName}
              autoComplete="name"
              disabled={readOnly || isSaving}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
          <div className="space-y-3 border-t pt-4">
            <div className="text-sm font-medium">{t("settings.password")}</div>
            {passwordManagedByEnvironment ? (
              <div className="rounded-lg border bg-muted/30 px-3 py-2.5 text-sm text-muted-foreground" role="status">
                <Trans
                  i18nKey="settings.rootPasswordManaged"
                  components={{
                    env: <code className="font-mono text-foreground" />,
                    file: <code className="font-mono text-foreground" />,
                  }}
                />
              </div>
            ) : (
              <>
                <DialogPasswordField
                  id="current-password"
                  label={t("settings.currentPassword")}
                  value={passwordDraft.currentPassword}
                  autoComplete="current-password"
                  disabled={readOnly || isSaving}
                  describedBy={passwordError ? "password-error" : undefined}
                  onChange={(value) => updatePassword("currentPassword", value)}
                />
                <DialogPasswordField
                  id="new-password"
                  label={t("settings.newPassword")}
                  value={passwordDraft.newPassword}
                  autoComplete="new-password"
                  disabled={readOnly || isSaving}
                  describedBy={passwordError ? "password-error" : undefined}
                  onChange={(value) => updatePassword("newPassword", value)}
                />
                <DialogPasswordField
                  id="confirm-password"
                  label={t("settings.confirmNewPassword")}
                  value={passwordDraft.confirmPassword}
                  autoComplete="new-password"
                  disabled={readOnly || isSaving}
                  describedBy={passwordError ? "password-error" : undefined}
                  onChange={(value) => updatePassword("confirmPassword", value)}
                />
                {passwordError && (
                  <p className="text-sm text-destructive" id="password-error" role="alert">
                    {passwordError}
                  </p>
                )}
              </>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={isSaving}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" size="sm" disabled={readOnly || isSaving || !hasChanges}>
            {isSaving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {isSaving ? t("common.saving") : t("common.save")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function DialogPasswordField({
  id,
  label,
  value,
  autoComplete,
  disabled,
  describedBy,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  autoComplete: string;
  disabled: boolean;
  describedBy?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label htmlFor={id} className="grid gap-1.5 text-sm font-medium">
      {label}
      <Input
        id={id}
        name={id}
        type="password"
        value={value}
        autoComplete={autoComplete}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
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
