import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { LOGIN_REQUEST_EVENT } from "@/lib/appEvents";
import { useAuth } from "@/auth/AuthProvider";
import { useToast } from "@/components/ui/toast";

type PermissionGateOptions = {
  /**
   * Let Demo continue to the action's own Demo handling (a preview, or the
   * server's read-only answer) instead of stopping at the gate.
   */
  deferDemo?: boolean;
};

/**
 * Returns a check to run at the first step of an action. It explains a
 * missing permission before any dialog opens or state changes; the backend
 * still enforces every permission.
 */
export function usePermissionGate(permission: string | readonly string[], options: PermissionGateOptions = {}) {
  const auth = useAuth();
  const toast = useToast();
  const { t } = useTranslation();
  const required = typeof permission === "string" ? permission : permission.join(" ");
  const deferDemo = options.deferDemo ?? false;

  return useCallback(() => {
    if (auth.demoMode) {
      if (deferDemo) return true;
      toast.warning(t("permissions.demoReadOnly"));
      return false;
    }
    if (!auth.user) {
      window.dispatchEvent(new Event(LOGIN_REQUEST_EVENT));
      return false;
    }
    if (!required.split(" ").every((item) => auth.hasPermission(item))) {
      toast.warning(t("permissions.permissionDenied"));
      return false;
    }
    return true;
  }, [auth, deferDemo, required, t, toast]);
}

/** Adding a remote work to the shared Library: Track, Fork, or a mark or list on a work not yet in it. */
export const REMOTE_TRACK_PERMISSIONS = ["remote:track"] as const;
/** Downloading remote files to the server: Fetch and caching. */
export const REMOTE_FETCH_PERMISSIONS = ["remote:fetch"] as const;
/** Bulk actions run as a workflow, on top of the action's own permissions. */
export const REMOTE_BULK_TRACK_PERMISSIONS = ["workflows:run", "remote:track"] as const;
export const REMOTE_BULK_FETCH_PERMISSIONS = ["workflows:run", "remote:fetch"] as const;
