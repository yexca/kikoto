import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useMobileRuntime } from "@/app/MobileRuntime";
import { toastFromError, useToast } from "@/components/ui/toast";
import type { CurrentUser } from "@/lib/api";
import { buildMobileDiagnosticsText } from "@/lib/mobileDiagnostics";
import { clearStoredServerURL } from "@/lib/serverConfig";

/** Native-shell server actions shared by the tablet connection popover and the phone account panel. */
export function useServerConnection(user: CurrentUser | null) {
  const { t } = useTranslation();
  const toast = useToast();
  const mobileRuntime = useMobileRuntime();
  const [status, setStatus] = useState("");
  const [diagnosticsText, setDiagnosticsText] = useState("");

  const reset = () => {
    setStatus("");
    setDiagnosticsText("");
  };

  const check = async () => {
    setStatus(t("common.checking"));
    const health = await mobileRuntime.reconnect();
    setStatus(
      health
        ? t("account.connectedVersion", { version: health.version })
        : mobileRuntime.connection.message || t("common.connectionCheckFailed"),
    );
  };

  const copyDiagnostics = async () => {
    const text = buildMobileDiagnosticsText({
      serverVersion: mobileRuntime.connection.serverVersion,
      connection: mobileRuntime.connection.message || mobileRuntime.connection.kind,
      user: user ? user.username : undefined,
    });
    setDiagnosticsText(text);
    await navigator.clipboard?.writeText(text).catch(() => {});
  };

  const clearServer = async () => {
    try {
      await clearStoredServerURL();
      window.location.reload();
    } catch (error) {
      toast.notify(toastFromError(error, t("serverGate.settingsUnavailable")));
    }
  };

  return {
    connection: mobileRuntime.connection,
    status,
    diagnosticsText,
    reset,
    check,
    copyDiagnostics,
    clearServer,
  };
}

export type ServerConnection = ReturnType<typeof useServerConnection>;
