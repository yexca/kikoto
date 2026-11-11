import { AlertTriangle, Clapperboard, FolderOpen, Loader2, RefreshCw, ScanLine } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";

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

export function RecordSetupNotice({
  canInitialize,
  busy,
  failed,
  onInitialize,
}: {
  canInitialize: boolean;
  busy: boolean;
  failed: boolean;
  onInitialize: () => void;
}) {
  const { t } = useTranslation();
  return (
    <RecordNotice
      icon={<Clapperboard className="h-4 w-4" />}
      title={t("records.setupTitle")}
      message={canInitialize ? t("records.setupMessage") : t("records.setupNeedsAdmin")}
    >
      {failed && (
        <p role="alert" className="text-sm text-error-foreground">
          {t("records.initializeFailed")}
        </p>
      )}
      {canInitialize && (
        <Button disabled={busy} onClick={onInitialize}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {busy ? t("records.initializing") : t("records.initialize")}
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
  onScan,
}: {
  neverScanned: boolean;
  canScan: boolean;
  onScan: () => void;
}) {
  const { t } = useTranslation();
  if (neverScanned) {
    return (
      <RecordNotice
        icon={<ScanLine className="h-4 w-4" />}
        title={t("records.notScannedTitle")}
        message={canScan ? t("records.notScannedMessage") : t("records.notScannedNeedsWrite")}
      >
        {canScan && (
          <Button onClick={onScan}>
            <ScanLine className="h-4 w-4" />
            {t("records.scan")}
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
