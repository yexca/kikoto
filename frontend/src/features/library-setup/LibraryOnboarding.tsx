import { CheckCircle2, FolderSearch, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { toastFromError, useToast } from "@/components/ui/toast";
import { isActiveWorkflowStatus, useWorkflowRunWatcher } from "@/hooks/useWorkflowRunWatcher";
import { api, type LibraryLayout } from "@/lib/api";
import { currentClientStorageScope } from "@/lib/clientStorageScope";

import { LibraryLayoutEditor } from "./LibraryLayoutEditor";

type Step = "layout" | "scan" | "metadata" | "finish";

const steps: Step[] = ["layout", "scan", "metadata", "finish"];

/**
 * First-run library setup for administrators: choose the library mode, scan,
 * synchronize metadata, and decide whether scans run automatically. It stays
 * available until finished; closing it only postpones it for this visit.
 */
export function LibraryOnboarding() {
  const auth = useAuth();
  const enabled = Boolean(auth.user) && !auth.demoMode && auth.hasPermission("sources:write");
  const scope = currentClientStorageScope(auth.user?.id ?? null);
  return enabled ? <LibraryOnboardingGate key={scope} /> : null;
}

function LibraryOnboardingGate() {
  const [layout, setLayout] = useState<LibraryLayout | null>(null);
  const [postponed, setPostponed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api
      .getLibraryLayout(controller.signal)
      .then(setLayout)
      .catch(() => {
        // Setup is optional for the current page; never block the app on it.
      });
    return () => controller.abort();
  }, []);

  if (!layout || layout.onboardingCompleted || postponed) return null;
  return <LibraryOnboardingDialog initial={layout} onClose={() => setPostponed(true)} />;
}

function LibraryOnboardingDialog({ initial, onClose }: { initial: LibraryLayout; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const auth = useAuth();
  const [layout, setLayout] = useState(initial);
  const [step, setStep] = useState<Step>(initial.configured ? "scan" : "layout");
  const [scanRunId, setScanRunId] = useState<number | null>(null);
  const [startingScan, setStartingScan] = useState(false);
  const [metadataQueued, setMetadataQueued] = useState(false);
  const [startingMetadata, setStartingMetadata] = useState(false);
  const [triggers, setTriggers] = useState(initial.localScanTriggers);
  const [finishing, setFinishing] = useState(false);
  const scanRun = useWorkflowRunWatcher(scanRunId).run;
  const scanActive = scanRunId !== null && (!scanRun || isActiveWorkflowStatus(scanRun.status));
  const canSyncMetadata = auth.hasPermission("metadata:sync");

  const startScan = async () => {
    setStartingScan(true);
    try {
      const result = await api.runLocalScan();
      setScanRunId(result.runId);
    } catch (error) {
      toast.notify(toastFromError(error, t("librarySetup.onboarding.scanFailed")));
    } finally {
      setStartingScan(false);
    }
  };

  const startMetadata = async () => {
    setStartingMetadata(true);
    try {
      await api.startMetadataOnboarding();
      setMetadataQueued(true);
    } catch (error) {
      toast.notify(toastFromError(error, t("librarySetup.onboarding.metadataFailed")));
    } finally {
      setStartingMetadata(false);
    }
  };

  const finish = async () => {
    setFinishing(true);
    try {
      await api.completeLibraryOnboarding(triggers);
      toast.success(t("librarySetup.onboarding.done"));
      onClose();
    } catch (error) {
      toast.notify(toastFromError(error, t("librarySetup.onboarding.finishFailed")));
    } finally {
      setFinishing(false);
    }
  };

  const scanSummary = () => {
    if (!scanRunId) return t("librarySetup.onboarding.scanIdle");
    if (!scanRun || isActiveWorkflowStatus(scanRun.status)) return t("librarySetup.onboarding.scanRunning");
    if (scanRun.status === "succeeded" || scanRun.status === "partial") {
      const summary = parseSummary(scanRun.summaryJson);
      return t("librarySetup.onboarding.scanDone", { count: summary.detected_works ?? 0 });
    }
    return t("librarySetup.onboarding.scanAttention");
  };

  const stepIndex = steps.indexOf(step);
  return (
    <Dialog onClose={onClose} size="lg" ariaLabel={t("librarySetup.onboarding.title")}>
      <DialogHeader
        title={t("librarySetup.onboarding.title")}
        description={t("librarySetup.onboarding.step", { current: stepIndex + 1, total: steps.length })}
        icon={<Sparkles />}
        onClose={onClose}
        closeLabel={t("librarySetup.onboarding.later")}
      />
      <DialogBody className="space-y-4">
        <h3 className="text-base font-semibold">{t(`librarySetup.onboarding.steps.${step}.title`)}</h3>
        <p className="text-sm text-muted-foreground">{t(`librarySetup.onboarding.steps.${step}.description`)}</p>

        {step === "layout" && (
          <LibraryLayoutEditor
            layout={layout}
            readOnly={false}
            saveLabel={t("librarySetup.onboarding.saveAndContinue")}
            onSaved={(next) => {
              setLayout(next);
              setStep("scan");
            }}
          />
        )}

        {step === "scan" && (
          <div className="flex flex-wrap items-center gap-3 rounded-md border px-3 py-3">
            <Button size="sm" disabled={startingScan || scanActive} onClick={() => void startScan()}>
              {startingScan || scanActive ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FolderSearch className="h-4 w-4" />
              )}
              {scanRunId ? t("librarySetup.onboarding.scanAgain") : t("librarySetup.onboarding.scan")}
            </Button>
            <span role="status" className="text-sm text-muted-foreground">
              {scanSummary()}
            </span>
          </div>
        )}

        {step === "metadata" && (
          <div className="flex flex-wrap items-center gap-3 rounded-md border px-3 py-3">
            {canSyncMetadata ? (
              <>
                <Button size="sm" disabled={startingMetadata || metadataQueued} onClick={() => void startMetadata()}>
                  {startingMetadata ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : metadataQueued ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  {t("librarySetup.onboarding.syncMetadata")}
                </Button>
                <span role="status" className="text-sm text-muted-foreground">
                  {metadataQueued
                    ? t("librarySetup.onboarding.metadataQueued")
                    : t("librarySetup.onboarding.metadataIdle")}
                </span>
              </>
            ) : (
              <span className="text-sm text-muted-foreground">{t("librarySetup.onboarding.metadataUnavailable")}</span>
            )}
          </div>
        )}

        {step === "finish" && (
          <div className="divide-y rounded-md border">
            {(["startupScan", "watchFolders"] as const).map((key) => (
              <div key={key} className="flex items-start justify-between gap-3 px-3 py-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{t(`librarySetup.onboarding.triggers.${key}.title`)}</div>
                  <p className="text-xs text-muted-foreground">
                    {t(`librarySetup.onboarding.triggers.${key}.description`)}
                  </p>
                </div>
                <Switch
                  aria-label={t(`librarySetup.onboarding.triggers.${key}.title`)}
                  checked={triggers[key]}
                  onCheckedChange={(checked) => setTriggers((current) => ({ ...current, [key]: checked }))}
                />
              </div>
            ))}
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>
          {t("librarySetup.onboarding.later")}
        </Button>
        {step === "scan" && (
          <Button size="sm" disabled={scanActive} onClick={() => setStep("metadata")}>
            {scanRunId ? t("librarySetup.onboarding.next") : t("librarySetup.onboarding.skip")}
          </Button>
        )}
        {step === "metadata" && (
          <Button size="sm" onClick={() => setStep("finish")}>
            {metadataQueued ? t("librarySetup.onboarding.next") : t("librarySetup.onboarding.skip")}
          </Button>
        )}
        {step === "finish" && (
          <Button size="sm" disabled={finishing} onClick={() => void finish()}>
            {finishing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            {t("librarySetup.onboarding.finish")}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}

function parseSummary(raw: string): { detected_works?: number } {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? (parsed as { detected_works?: number }) : {};
  } catch {
    return {};
  }
}
