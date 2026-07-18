import { useEffect, useRef, useState } from "react";
import { RefreshCw, X } from "lucide-react";

import { Button } from "@/components/ui/button";

export function PWAServiceWorker() {
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);
  const reloadRequestedRef = useRef(false);

  useEffect(() => {
    if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
    let registration: ServiceWorkerRegistration | null = null;

    const showWaitingWorker = (worker: ServiceWorker | null) => {
      if (worker && navigator.serviceWorker.controller) setWaitingWorker(worker);
    };
    const handleControllerChange = () => {
      if (!reloadRequestedRef.current) return;
      reloadRequestedRef.current = false;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", handleControllerChange);
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).then((nextRegistration) => {
      registration = nextRegistration;
      showWaitingWorker(nextRegistration.waiting);
      nextRegistration.addEventListener("updatefound", () => {
        const installing = nextRegistration.installing;
        installing?.addEventListener("statechange", () => {
          if (installing.state === "installed") showWaitingWorker(nextRegistration.waiting ?? installing);
        });
      });
    }).catch(() => {
      // The application remains usable when service workers are unavailable.
    });

    const checkForUpdate = () => {
      if (document.visibilityState === "visible") void registration?.update();
    };
    const interval = window.setInterval(checkForUpdate, 60 * 60 * 1000);
    document.addEventListener("visibilitychange", checkForUpdate);
    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", handleControllerChange);
      document.removeEventListener("visibilitychange", checkForUpdate);
      window.clearInterval(interval);
    };
  }, []);

  if (!waitingWorker) return null;
  return (
    <div className="fixed bottom-[var(--app-update-banner-bottom)] left-[max(0.75rem,var(--safe-area-left))] right-[max(0.75rem,var(--safe-area-right))] z-[90] mx-auto flex max-w-xl items-center gap-3 rounded-xl border bg-card p-3 text-card-foreground shadow-2xl">
      <RefreshCw className="h-5 w-5 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">Kikoto update ready</div>
        <div className="text-xs text-muted-foreground">Reload to use the latest version.</div>
      </div>
      <Button size="sm" onClick={() => {
        reloadRequestedRef.current = true;
        waitingWorker.postMessage({ type: "SKIP_WAITING" });
      }}>
        Reload
      </Button>
      <button className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted" onClick={() => setWaitingWorker(null)} aria-label="Dismiss update">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
