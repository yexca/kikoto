import { useTranslation } from "react-i18next";

import { AcceptanceNotice } from "@/components/AcceptanceNotice";
import { toastFromError, useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";

/**
 * The external service notice an administrator accepts before LLM and ASR
 * services can be configured. It sits over the settings it unlocks; the server
 * keeps refusing configuration until it is accepted.
 */
export function ServiceNotice({ onAccepted }: { onAccepted: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();

  return (
    <AcceptanceNotice
      title={t("maintenance.llm.notice.title")}
      items={[
        t("maintenance.llm.notice.terms"),
        t("maintenance.llm.notice.advisory"),
        t("maintenance.llm.notice.liability"),
      ]}
      scope={t("maintenance.llm.notice.scope")}
      agreeLabel={t("maintenance.llm.notice.agree")}
      acceptLabel={t("maintenance.llm.notice.accept")}
      onAccept={async () => {
        try {
          await api.acceptServiceNotice();
          onAccepted();
        } catch (error) {
          toast.notify(toastFromError(error, t("maintenance.llm.notice.acceptFailed")));
        }
      }}
    />
  );
}
