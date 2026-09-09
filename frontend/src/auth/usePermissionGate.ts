import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { LOGIN_REQUEST_EVENT } from "@/app/events";
import { useAuth } from "@/auth/AuthProvider";
import { useToast } from "@/components/ui/toast";

export function usePermissionGate(permission: string) {
  const auth = useAuth();
  const toast = useToast();
  const { t } = useTranslation();

  return useCallback(() => {
    if (auth.demoMode) {
      toast.warning(t("permissions.demoReadOnly"));
      return false;
    }
    if (!auth.user) {
      window.dispatchEvent(new Event(LOGIN_REQUEST_EVENT));
      return false;
    }
    if (!auth.hasPermission(permission)) {
      toast.warning(t("permissions.permissionDenied"));
      return false;
    }
    return true;
  }, [auth, permission, t, toast]);
}
