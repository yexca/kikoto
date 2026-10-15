import { Check, Loader2, ShieldAlert } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  const titleId = useId();
  const [agreed, setAgreed] = useState(false);
  const [accepting, setAccepting] = useState(false);

  const accept = async () => {
    setAccepting(true);
    try {
      await api.acceptServiceNotice();
      onAccepted();
    } catch (error) {
      toast.notify(toastFromError(error, t("maintenance.llm.notice.acceptFailed")));
    } finally {
      setAccepting(false);
    }
  };

  return (
    <section
      aria-labelledby={titleId}
      className="theme-floating-surface sticky top-6 mx-auto w-full max-w-lg rounded-[var(--radius)] border bg-popover p-5 text-popover-foreground shadow-2xl"
    >
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-warning-surface text-warning-foreground">
          <ShieldAlert className="h-5 w-5" />
        </span>
        <div className="min-w-0 space-y-3">
          <h3 id={titleId} className="text-base font-semibold leading-6">
            {t("maintenance.llm.notice.title")}
          </h3>
          <ul className="list-disc space-y-2 pl-4 text-sm leading-6 text-muted-foreground">
            <li>{t("maintenance.llm.notice.terms")}</li>
            <li>{t("maintenance.llm.notice.advisory")}</li>
            <li>{t("maintenance.llm.notice.liability")}</li>
          </ul>
          <p className="text-xs leading-5 text-muted-foreground">{t("maintenance.llm.notice.scope")}</p>
          <label className="flex w-fit items-center gap-2 text-sm font-medium">
            <Checkbox
              checked={agreed}
              disabled={accepting}
              aria-label={t("maintenance.llm.notice.agree")}
              onCheckedChange={setAgreed}
            />
            {t("maintenance.llm.notice.agree")}
          </label>
          <div className="flex justify-end">
            <Button size="sm" disabled={!agreed || accepting} onClick={() => void accept()}>
              {accepting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              {t("maintenance.llm.notice.accept")}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
