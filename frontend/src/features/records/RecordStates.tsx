import { AlertTriangle, Clapperboard, FolderOpen, Loader2, RefreshCw, ScanLine, Settings } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";

/** One persistent state panel: loading, setup, unavailable, empty, or failed. */
export function RecordNotice({
  icon,
  title,
  message,
  tone = "neutral",
  children,
}: {
  icon: ReactNode;
  title: string;
  message?: string;
  tone?: "neutral" | "warning";
  children?: ReactNode;
}) {
  return (
    <section
      className={`mx-auto flex max-w-2xl flex-col items-start gap-4 rounded-lg border p-6 ${
        tone === "warning" ? "border-warning-border bg-warning-surface" : "bg-card"
      }`}
    >
      <div className="flex items-start gap-3">
        <span
          className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full ${
            tone === "warning" ? "bg-card text-warning-foreground" : "bg-muted text-muted-foreground"
          }`}
          aria-hidden="true"
        >
          {icon}
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{title}</h2>
          {message && <p className="mt-1 text-sm text-muted-foreground">{message}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

export function RecordLoading({ label }: { label: string }) {
  return (
    <div role="status" className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      {label}
    </div>
  );
}

export function RecordDemoNotice() {
  const { t } = useTranslation();
  return (
    <RecordNotice
      icon={<Clapperboard className="h-4 w-4" />}
      title={t("records.demoTitle")}
      message={t("records.demoMessage")}
    />
  );
}

/**
 * An uninitialized record root. The root is initialized in System -> Library,
 * which `settingsPath` opens for a viewer who may change instance settings.
 */
export function RecordSetupNotice({ settingsPath }: { settingsPath: string | null }) {
  const { t } = useTranslation();
  const openSettings = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!settingsPath || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    window.history.pushState({}, "", settingsPath);
    window.dispatchEvent(new Event(NAVIGATION_EVENT));
  };
  return (
    <RecordNotice
      icon={<Clapperboard className="h-4 w-4" />}
      title={t("records.setupTitle")}
      message={settingsPath ? t("records.setupMessage") : t("records.setupNeedsAdmin")}
    >
      {settingsPath && (
        <Button asChild>
          <a href={settingsPath} onClick={openSettings}>
            <Settings className="h-4 w-4" />
            {t("records.openLibrarySettings")}
          </a>
        </Button>
      )}
    </RecordNotice>
  );
}

export function RecordRetryNotice({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <RecordNotice icon={<AlertTriangle className="h-4 w-4" />} title={title} message={message} tone="warning">
      <Button variant="outline" onClick={onRetry}>
        <RefreshCw className="h-4 w-4" />
        {t("records.retry")}
      </Button>
    </RecordNotice>
  );
}

export function RecordEmptyNotice({
  neverScanned,
  canScan,
  scanning = false,
  onScan,
}: {
  neverScanned: boolean;
  canScan: boolean;
  scanning?: boolean;
  onScan: () => void;
}) {
  const { t } = useTranslation();
  if (neverScanned) {
    return (
      <RecordNotice
        icon={scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanLine className="h-4 w-4" />}
        title={t("records.notScannedTitle")}
        message={canScan ? t("records.notScannedMessage") : t("records.notScannedNeedsWrite")}
      >
        {canScan && (
          <Button disabled={scanning} onClick={onScan}>
            {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanLine className="h-4 w-4" />}
            {scanning ? t("records.scanStatus.running") : t("records.scan")}
          </Button>
        )}
      </RecordNotice>
    );
  }
  return (
    <RecordNotice
      icon={<FolderOpen className="h-4 w-4" />}
      title={t("records.emptyFolder")}
      message={t("records.emptyFolderHint")}
    />
  );
}
