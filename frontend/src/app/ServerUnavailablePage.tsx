import { CloudOff, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useStableCallback } from "@/hooks/useStableCallback";
import { clearStoredServerURL, getStoredServerURL, isNativeApp } from "@/lib/serverConfig";

/**
 * Shown when startup cannot tell who the viewer is because the server did not
 * answer. It never implies the viewer was signed out, and retries on its own
 * when the device comes back online.
 */
export function ServerUnavailablePage({ onRetry }: { onRetry: () => Promise<void> }) {
  const { t } = useTranslation();
  const [retrying, setRetrying] = useState(false);
  const [settingsError, setSettingsError] = useState(false);
  const mobileServerURL = isNativeApp() ? getStoredServerURL() : "";

  const retry = useStableCallback(() => {
    if (retrying) return;
    setRetrying(true);
    void onRetry().finally(() => setRetrying(false));
  });

  useEffect(() => {
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [retry]);

  return (
    <main className="grid min-h-screen place-items-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardContent className="space-y-5 p-6" role="alert" aria-labelledby="server-unavailable-title">
          <div>
            <div className="mb-3 grid h-10 w-10 place-items-center rounded-lg bg-destructive/10 text-destructive">
              <CloudOff className="h-5 w-5" aria-hidden="true" />
            </div>
            <h1 id="server-unavailable-title" className="text-xl font-semibold">
              {t("app.serverUnavailableTitle")}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">{t("app.serverUnavailableMessage")}</p>
            {mobileServerURL && <p className="mt-2 truncate text-xs text-muted-foreground">{mobileServerURL}</p>}
          </div>
          {settingsError && (
            <div className="rounded-md border border-error-border bg-error-surface px-3 py-2 text-sm text-error-foreground">
              {t("serverGate.settingsUnavailable")}
            </div>
          )}
          <div className="space-y-2">
            <Button className="w-full" disabled={retrying} aria-busy={retrying} onClick={retry}>
              <RefreshCw className={`h-4 w-4 ${retrying ? "animate-spin" : ""}`} aria-hidden="true" />
              {t("common.retry")}
            </Button>
            {mobileServerURL && (
              <Button
                className="w-full"
                variant="ghost"
                disabled={retrying}
                onClick={() => {
                  setSettingsError(false);
                  void clearStoredServerURL()
                    .then(() => window.location.reload())
                    .catch(() => setSettingsError(true));
                }}
              >
                {t("login.changeServer")}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
