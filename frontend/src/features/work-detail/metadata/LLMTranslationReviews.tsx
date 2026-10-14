import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { toastFromError, useToast } from "@/components/ui/toast";
import { api, type LLMReview, type LLMTranslationHistory } from "@/lib/api";

/** Metadata translation reviews; lyrics translations are reviewed in Manage lyrics. */
export function LLMTranslationReviews({ workId, onSelect }: { workId: number; onSelect: (review: LLMReview) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [reviews, setReviews] = useState<LLMReview[]>([]);
  const [history, setHistory] = useState<LLMTranslationHistory>({ current: [], history: [] });
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([api.listTranslationReviews(workId), api.listTranslations(workId)]);
    if (results[0].status === "fulfilled")
      setReviews(results[0].value.filter((review) => !review.fields.includes("lyrics")));
    if (results[1].status === "fulfilled") setHistory(results[1].value);
    if (results.some((result) => result.status === "rejected"))
      toast.notify(toastFromError(new Error(t("llmTranslation.reviewsFailed")), t("llmTranslation.reviewsFailed")));
  }, [workId, t, toast]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const mutate = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await refresh();
    } catch (error) {
      toast.notify(toastFromError(error, t("llmTranslation.saveFailed")));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-2 rounded border p-3" aria-label={t("llmTranslation.reviews")}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{t("llmTranslation.reviews")}</h3>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>
          {t("maintenance.llm.refresh")}
        </Button>
      </div>
      <ul className="space-y-2 text-sm">
        {reviews.map((review) => (
          <li key={review.previewId} className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {review.targetLanguage} · {review.fields.join(", ")} · {t(`llmTranslation.states.${review.status}`)}
            </span>
            {review.status === "proposed" && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => onSelect(review)}>
                {t("llmTranslation.review")}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {history.current.map((row) => (
        <div key={row.language + row.field} className="flex items-center justify-between gap-2 text-sm">
          <span>
            {row.language} · {row.field} · {t(`llmTranslation.states.${row.status}`)}
          </span>
          {row.status === "accepted" && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void mutate(() => api.revokeTranslation(workId, row.language, row.field))}
            >
              {t("llmTranslation.revoke")}
            </Button>
          )}
        </div>
      ))}
      <details>
        <summary className="cursor-pointer text-sm">{t("llmTranslation.history")}</summary>
        <ul className="mt-2 space-y-2 text-sm">
          {history.history.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-2">
              <span>
                {row.language} · {row.field} · {t(`llmTranslation.states.${row.action}`)}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void mutate(() => api.restoreTranslation(workId, row.id))}
              >
                {t("llmTranslation.restore")}
              </Button>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
