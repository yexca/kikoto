import { metadataSyncResultURL } from "@/lib/metadataMaintenance";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";

import { useAuth } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { api, type MetadataOnboarding } from "@/lib/api";
import { currentClientStorageScope } from "@/lib/clientStorageScope";
import { createEffectScope } from "@/lib/effectScope";

export function MetadataOnboardingNotice({ active }: { active: boolean }) {
  const auth = useAuth();
  const scope = currentClientStorageScope(auth.user?.id ?? null);
  const enabled = active && !auth.demoMode && auth.hasPermission("metadata:sync");
  // Remount on account/server changes so no previous instance's prompt leaks.
  return enabled ? <MetadataNotice key={scope} canViewActivity={auth.hasPermission("workflows:run")} /> : null;
}

function MetadataNotice({ canViewActivity }: { canViewActivity: boolean }) {
  const { t } = useTranslation();
  const [view, setView] = useState<MetadataOnboarding | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const mutation = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    const scope = createEffectScope();
    const refresh = (delayMs?: number) =>
      scope.load(
        async (signal) => {
          const version = generation.current;
          const result = document.hidden || mutation.current ? null : await api.getMetadataOnboarding(signal);
          return { version, result };
        },
        {
          onSuccess: ({ version, result }) => {
            if (result && version === generation.current) {
              setView(result);
              if (result.status === "hidden") return;
            }
            refresh(5000);
          },
          // This optional prompt must never replace known Library content.
          onError: () => refresh(5000),
        },
        { delayMs },
      );
    refresh();
    return scope.cancel;
  }, []);

  async function act(action: "start" | "dismiss") {
    if (mutation.current) return;
    mutation.current = true;
    generation.current++;
    setBusy(true);
    setError(false);
    try {
      setView(await (action === "start" ? api.startMetadataOnboarding() : api.dismissMetadataOnboarding()));
    } catch {
      setError(true);
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  }

  if (!view || view.status === "hidden" || view.status === "waiting") return null;
  const ready = view.status === "ready";
  const running = view.status === "queued" || view.status === "running";
  const succeeded = view.status === "succeeded";
  const needsAttention = !ready && !running && !succeeded;
  const title = ready ? "title" : running ? "running" : succeeded ? "succeeded" : "attention";
  return (
    <section aria-label={t("metadataOnboarding.label")} className="rounded-lg border bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1" role="status">
          <p className="flex items-center gap-2 text-sm font-medium">
            {running && <RefreshCw aria-hidden="true" className="h-4 w-4 motion-safe:animate-spin" />}
            {t(`metadataOnboarding.${title}`)}
          </p>
          <p className="text-sm text-muted-foreground">
            {ready
              ? t("metadataOnboarding.description", { count: view.missingWorks })
              : running
                ? t("metadataOnboarding.background")
                : succeeded
                  ? t("metadataOnboarding.complete")
                  : t("metadataOnboarding.partial")}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {ready && (
            <Button className="min-h-11" disabled={busy} onClick={() => void act("start")}>
              {t("metadataOnboarding.start")}
            </Button>
          )}
          {!ready && (needsAttention || (canViewActivity && view.runId > 0)) && (
            <Button
              className="min-h-11"
              variant="outline"
              onClick={() => {
                window.history.pushState({}, "", metadataSyncResultURL(view.runId, needsAttention, canViewActivity));
                window.dispatchEvent(new PopStateEvent("popstate"));
              }}
            >
              {t(needsAttention ? "metadataIssues.openIssues" : "metadataOnboarding.activity")}
            </Button>
          )}
          <Button className="min-h-11" variant="ghost" disabled={busy} onClick={() => void act("dismiss")}>
            {t(ready ? "metadataOnboarding.later" : "metadataOnboarding.dismiss")}
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-error">
          {t("metadataOnboarding.error")}
        </p>
      )}
    </section>
  );
}
