import { useState } from "react";
import { useTranslation } from "react-i18next";

import { toastFromError, useToast } from "@/components/ui/toast";
import { api, type TranslationReviewResult } from "@/lib/api";
import { translationRefusalKey } from "./translationReviewModel";

/**
 * Accept, discard and resend translation items, reporting refusals item by
 * item. `onDone` reloads what the caller shows; `onAccepted` runs when an
 * accepted item changed the work.
 */
export function useTranslationReviewActions({
  onDone,
  onAccepted,
}: {
  onDone: () => Promise<void> | void;
  onAccepted?: () => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [busyIds, setBusyIds] = useState<ReadonlySet<number>>(new Set());

  const run = async (
    ids: number[],
    request: () => Promise<{ results: TranslationReviewResult[] }>,
    success: (count: number) => string,
    failure: string,
  ) => {
    setBusyIds((current) => new Set([...current, ...ids]));
    let accepted = 0;
    try {
      const { results } = await request();
      accepted = results.filter((result) => result.ok).length;
      const refused = results.filter((result) => !result.ok);
      if (accepted > 0) toast.success(success(accepted));
      if (refused.length > 0) {
        toast.notify({
          kind: "error",
          message: t("translationReview.refusedCount", {
            count: refused.length,
            reason: t(translationRefusalKey(refused[0].code)),
          }),
        });
      }
    } catch (error) {
      toast.notify(toastFromError(error, failure));
    } finally {
      setBusyIds((current) => new Set([...current].filter((id) => !ids.includes(id))));
    }
    return accepted;
  };

  return {
    busyIds,
    accept: async (ids: number[]) => {
      const accepted = await run(
        ids,
        () => api.acceptTranslationItems(ids),
        (count) => t("translationReview.acceptedCount", { count }),
        t("translationReview.acceptFailed"),
      );
      if (accepted > 0) await onAccepted?.();
      await onDone();
    },
    reject: async (ids: number[]) => {
      await run(
        ids,
        () => api.rejectTranslationItems(ids),
        (count) => t("translationReview.discardedCount", { count }),
        t("translationReview.discardFailed"),
      );
      await onDone();
    },
    resend: async (ids: number[], acknowledgeUncertain: boolean) => {
      await run(
        ids,
        () => api.resendTranslationItems(ids, acknowledgeUncertain),
        (count) => t("translationReview.resentCount", { count }),
        t("translationReview.resendFailed"),
      );
      await onDone();
    },
  };
}
