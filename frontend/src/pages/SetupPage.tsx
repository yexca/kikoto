import { KeyRound, UserPlus } from "lucide-react";
import { FormEvent, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/auth/AuthProvider";
import { ApiError } from "@/lib/api";

function setupErrorKey(code: string) {
  switch (code) {
    case "invalid_setup_token":
      return "setup.invalidToken";
    case "setup_complete":
      return "setup.complete";
    case "username_required":
      return "setup.usernameRequired";
    case "username_reserved":
      return "setup.usernameReserved";
    case "username_exists":
      return "setup.usernameExists";
    case "password_required":
      return "setup.passwordRequired";
    case "password_too_short":
      return "setup.passwordTooShort";
    case "password_placeholder":
      return "setup.passwordPlaceholder";
    default:
      return undefined;
  }
}

/** Creates the first administrator of a production instance. */
export function SetupPage() {
  const auth = useAuth();
  const { t } = useTranslation();
  const [setupToken, setSetupToken] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (password !== confirmPassword) {
      setError(t("setup.passwordMismatch"));
      return;
    }
    setIsSubmitting(true);
    try {
      await auth.completeSetup({ setupToken: setupToken.trim(), username: username.trim(), password });
    } catch (err) {
      if (err instanceof ApiError && err.code === "setup_complete") {
        // Another administrator exists now; show the sign-in page.
        await auth.refresh().catch(() => undefined);
      }
      const key = err instanceof ApiError ? setupErrorKey(err.code) : undefined;
      setError(key ? t(key) : err instanceof TypeError ? t("errors.network") : t("setup.failed"));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="grid min-h-screen place-items-center bg-background px-4 py-8">
      <Card className="w-full max-w-sm">
        <CardContent className="space-y-5 p-6">
          <div>
            <div className="mb-3 grid h-10 w-10 place-items-center rounded-lg bg-secondary text-secondary-foreground">
              <KeyRound className="h-5 w-5" />
            </div>
            <h1 className="text-xl font-semibold">{t("setup.title")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t("setup.subtitle")}</p>
          </div>

          <form className="space-y-3" onSubmit={submit}>
            <label className="grid gap-1.5 text-sm font-medium">
              {t("setup.setupToken")}
              <Input
                value={setupToken}
                onChange={(event) => setSetupToken(event.target.value)}
                autoComplete="one-time-code"
                spellCheck={false}
                aria-describedby="setup-token-hint"
                required
              />
            </label>
            <p id="setup-token-hint" className="text-xs text-muted-foreground">
              <Trans
                i18nKey="setup.tokenHint"
                values={{ file: "setup-token", command: "docker compose logs kikoto" }}
                components={{
                  file: <code className="font-mono text-foreground" />,
                  cmd: <code className="break-all font-mono text-foreground" />,
                }}
              />
            </p>
            <label className="grid gap-1.5 text-sm font-medium">
              {t("setup.username")}
              <Input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                required
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              {t("setup.password")}
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                aria-describedby="setup-password-hint"
                minLength={8}
                required
              />
            </label>
            <p id="setup-password-hint" className="text-xs text-muted-foreground">
              {t("setup.passwordHint")}
            </p>
            <label className="grid gap-1.5 text-sm font-medium">
              {t("setup.confirmPassword")}
              <Input
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                autoComplete="new-password"
                required
              />
            </label>
            {error && (
              <div
                className="rounded-md border border-error-border bg-error-surface px-3 py-2 text-sm text-error-foreground"
                role="alert"
              >
                {error}
              </div>
            )}
            <Button className="w-full" disabled={isSubmitting}>
              <UserPlus className="h-4 w-4" />
              {isSubmitting ? t("setup.submitting") : t("setup.submit")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
