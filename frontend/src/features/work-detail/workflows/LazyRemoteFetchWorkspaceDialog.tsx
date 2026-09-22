import { type ComponentType, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { toastFromError, useToast } from "@/components/ui/toast";
import type { RemoteFetchWorkspace } from "@/features/work-detail/workflows/useRemoteFetchWorkspace";
import { useStableCallback } from "@/hooks/useStableCallback";

type RemoteFetchWorkspaceDialogComponent = ComponentType<{ workspace: RemoteFetchWorkspace }>;

let loadedDialog: RemoteFetchWorkspaceDialogComponent | null = null;
let pendingDialog: Promise<RemoteFetchWorkspaceDialogComponent> | null = null;

// The fetch workspace dialog is only needed once a draft opens it, so list
// surfaces load its chunk on demand. A failed load is forgotten so a later open
// retries it.
export function preloadRemoteFetchWorkspaceDialog() {
  if (loadedDialog) return Promise.resolve(loadedDialog);
  pendingDialog ??= import("@/features/work-detail/workflows/RemoteFetchWorkspaceDialog").then(
    (module) => {
      loadedDialog = module.RemoteFetchWorkspaceDialog;
      return loadedDialog;
    },
    (error: unknown) => {
      pendingDialog = null;
      throw error;
    },
  );
  return pendingDialog;
}

/**
 * Renders the fetch workspace dialog while its workspace has a draft. The
 * dialog mounts once its chunk is ready, so its open transition and initial
 * focus behave as for a statically imported dialog. A load failure closes the
 * draft with a toast instead of reaching the page error boundary, keeping the
 * surrounding list state.
 */
export function LazyRemoteFetchWorkspaceDialog({ workspace }: { workspace: RemoteFetchWorkspace }) {
  const { t } = useTranslation();
  const toast = useToast();
  const open = workspace.draft !== null;
  const [Dialog, setDialog] = useState<RemoteFetchWorkspaceDialogComponent | null>(() => loadedDialog);
  const closeAfterLoadFailure = useStableCallback((error: unknown) => {
    toast.notify(toastFromError(error, t("errors.unavailable")));
    workspace.close();
  });

  useEffect(() => {
    if (!open || Dialog) return;
    let cancelled = false;
    preloadRemoteFetchWorkspaceDialog().then(
      (component) => {
        if (!cancelled) setDialog(() => component);
      },
      (error: unknown) => {
        if (!cancelled) closeAfterLoadFailure(error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [Dialog, closeAfterLoadFailure, open]);

  if (!open || !Dialog) return null;
  return <Dialog workspace={workspace} />;
}
