import { useCallback } from "react";

import { LOGIN_REQUEST_EVENT } from "@/app/events";
import { useAuth } from "@/auth/AuthProvider";
import { useToast } from "@/components/ui/toast";

export function usePermissionGate(permission: string) {
  const auth = useAuth();
  const toast = useToast();

  return useCallback(() => {
    if (!auth.user) {
      window.dispatchEvent(new Event(LOGIN_REQUEST_EVENT));
      return false;
    }
    if (!auth.hasPermission(permission)) {
      toast.warning("Your account does not have permission to use this feature.");
      return false;
    }
    return true;
  }, [auth, permission, toast]);
}
