import { useState } from "react";
import { useTranslation } from "react-i18next";

import { toastFromError, useToast } from "@/components/ui/toast";
import { api, type AppSettings, type ProxySettings } from "@/lib/api";

import { proxyConfigDraft, proxySettingsPayload, type ProxyConfigDraft } from "./proxyModel";

/**
 * Saves a proxy configuration as soon as it changes, like the remote-source
 * list beside it. The draft being saved is shown until the server answers; a
 * failure reverts to the saved configuration and reports the error.
 */
export function useProxySettingsSave(saved: ProxySettings, onSaved: (settings: AppSettings) => void) {
  const { t } = useTranslation();
  const toast = useToast();
  const [pending, setPending] = useState<ProxyConfigDraft | null>(null);

  const save = async (next: ProxyConfigDraft, successMessage = t("maintenance.proxy.saved")) => {
    setPending(next);
    try {
      onSaved(await api.updateSettings({ proxy: proxySettingsPayload(next) }));
      toast.success(successMessage);
      return true;
    } catch (error) {
      toast.notify(toastFromError(error, t("maintenance.proxy.saveFailed")));
      return false;
    } finally {
      setPending(null);
    }
  };

  return { draft: pending ?? proxyConfigDraft(saved), saving: pending !== null, save };
}
