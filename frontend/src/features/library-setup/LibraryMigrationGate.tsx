import { HardDriveDownload, Loader2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { toastFromError, useToast } from "@/components/ui/toast";
import { api, type LibraryMigrationStatus } from "@/lib/api";
import { SITE_MAINTENANCE_EVENT } from "@/lib/appEvents";

/** The maintenance check stays outside the app shell so failed media requests
 * cannot replace the progress view. The backend remains the access boundary. */
export function LibraryMigrationGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const toast = useToast();
  const auth = useAuth();
  const admin = auth.hasPermission("sources:write") && !auth.demoMode;
  const [maintenance, setMaintenance] = useState<boolean | null>(null);
  const [status, setStatus] = useState<LibraryMigrationStatus | null>(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    // Outside maintenance nothing polls: a request every few seconds would reach
    // every page, and on sign-in password managers read it as a submitted login.
    // A request the server refuses for maintenance switches back to polling.
    if (maintenance === false) {
      const enterMaintenance = () => setMaintenance(true);
      window.addEventListener(SITE_MAINTENANCE_EVENT, enterMaintenance);
      return () => window.removeEventListener(SITE_MAINTENANCE_EVENT, enterMaintenance);
    }
    let alive = true;
    const refresh = async () => {
      try {
        const result = await api.getPublicLibraryMigration();
        if (!alive) return;
        setMaintenance(result.maintenance);
        if (result.maintenance && admin) {
          try {
            const detail = await api.getLibraryMigration();
            if (alive) setStatus(detail);
          } catch {
            // Keep the last known phase while the server is busy.
          }
        }
      } catch {
        if (alive && maintenance === null) setMaintenance(false);
      }
    };
    void refresh();
    const timer = maintenance ? window.setInterval(() => void refresh(), 2000) : undefined;
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [admin, maintenance]);

  if (maintenance === null) {
    return (
      <div className="grid min-h-dvh place-items-center bg-background text-sm text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" aria-label={t("app.loading")} />
      </div>
    );
  }
  if (!maintenance) return <>{children}</>;

  const retry = async () => {
    setRetrying(true);
    try {
      setStatus(await api.retryLibraryMigration());
    } catch (error) {
      toast.notify(toastFromError(error, t("librarySetup.migration.failed")));
    } finally {
      setRetrying(false);
    }
  };

  return (
    <main className="grid min-h-dvh place-items-center bg-background px-6 py-12">
      <div className="w-full max-w-md space-y-5 rounded-xl border bg-card p-7 text-center">
        <HardDriveDownload className="mx-auto h-9 w-9 text-muted-foreground" aria-hidden />
        <h1 className="text-lg font-semibold">{t("librarySetup.migration.maintenance")}</h1>
        {admin && status && (
          <div className="space-y-4" role="status">
            <p className="text-sm text-muted-foreground">
              {t("librarySetup.migration.progress", {
                phase: t(`librarySetup.migration.phases.${status.phase ?? "prepare"}`, {
                  defaultValue: status.phase ?? "prepare",
                }),
                current: status.progressCurrent ?? 0,
                total: status.progressTotal ?? 0,
                size: ((status.progressBytesCurrent ?? 0) / 1024 ** 3).toFixed(2),
                totalSize: ((status.progressBytesTotal ?? 0) / 1024 ** 3).toFixed(2),
              })}
            </p>
            {status.status === "failed" && (
              <>
                <p className="text-sm text-warning-foreground">{t("librarySetup.migration.failed")}</p>
                <Button disabled={retrying} onClick={() => void retry()}>
                  {t("librarySetup.migration.retry")}
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
