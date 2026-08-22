import { Lock, LogIn } from "lucide-react";
import { FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/auth/AuthProvider";
import { ApiError } from "@/lib/api";
import { clearStoredServerURL, getStoredServerURL, isNativeApp } from "@/lib/serverConfig";

export function LoginPage({ embedded = false, onSuccess }: { embedded?: boolean; onSuccess?: () => void }) {
  const auth = useAuth();
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const mobileServerURL = isNativeApp() ? getStoredServerURL() : "";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);
    try {
      await auth.login(username, password);
      onSuccess?.();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? t("login.invalidCredentials")
          : err instanceof TypeError
            ? t("errors.network")
            : err instanceof Error
              ? err.message
              : t("login.failed"),
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const content = (
    <Card className="w-full max-w-sm">
      <CardContent className="space-y-5 p-6">
        <div>
          <div className="mb-3 grid h-10 w-10 place-items-center rounded-lg bg-secondary text-secondary-foreground">
            <Lock className="h-5 w-5" />
          </div>
          <h1 className="text-xl font-semibold">{t("login.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("login.subtitle")}</p>
          {mobileServerURL && <p className="mt-2 truncate text-xs text-muted-foreground">{mobileServerURL}</p>}
        </div>

        <form className="space-y-3" onSubmit={submit}>
          <label className="grid gap-1.5 text-sm font-medium">
            {t("login.username")}
            <input
              className="h-10 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            {t("login.password")}
            <input
              className="h-10 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
            />
          </label>
          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          <Button className="w-full" disabled={isSubmitting}>
            <LogIn className="h-4 w-4" />
            {isSubmitting ? t("login.signingIn") : t("account.signIn")}
          </Button>
          {mobileServerURL && (
            <Button
              type="button"
              className="w-full"
              variant="ghost"
              onClick={() => {
                setError("");
                setIsSubmitting(true);
                void clearStoredServerURL()
                  .then(() => window.location.reload())
                  .catch(() => {
                    setError(t("serverGate.settingsUnavailable"));
                    setIsSubmitting(false);
                  });
              }}
            >
              {t("login.changeServer")}
            </Button>
          )}
        </form>
      </CardContent>
    </Card>
  );

  if (embedded) return content;

  return <main className="grid min-h-screen place-items-center bg-background px-4">{content}</main>;
}
