import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toastFromError, useToast } from "@/components/ui/toast";
import { api, type LLMTranslationHistory } from "@/lib/api";
import { metadataTagNameLanguages } from "@/lib/metadataTagModel";

/**
 * The accepted LLM translations of one field of a work, per language, with
 * Revoke, and earlier values that can be restored while the source they were
 * translated from is unchanged. New translations come from Translate with AI.
 */
export function LLMTranslationHistoryPanel({
  workId,
  field,
  readOnly,
  onChanged,
}: {
  workId: number;
  field: "title" | "description";
  readOnly: boolean;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [history, setHistory] = useState<LLMTranslationHistory>({ current: [], history: [] });
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setHistory(await api.listTranslations(workId));
    } catch {
      // Without the list, the editor's own fields still work.
    }
  }, [workId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const current = history.current.filter((row) => row.field === field && row.status === "accepted");
  const earlier = history.history.filter((row) => row.field === field);
  if (current.length === 0 && earlier.length === 0) return null;
  const languageName = (language: string) =>
    t(metadataTagNameLanguages.find(([value]) => value === language)?.[1] ?? language);
  const mutate = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await refresh();
      onChanged();
    } catch (error) {
      toast.notify(toastFromError(error, t("llmTranslation.saveFailed")));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-2 rounded-lg border px-3 py-2" aria-label={t("llmTranslation.history")}>
      {current.map((row) => (
        <div key={row.language} className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="flex min-w-0 items-center gap-2">
            <Badge variant="info" className="px-1.5 py-0 text-2xs">
              {t("workTitles.llmBadge")}
            </Badge>
            <span className="truncate">{languageName(row.language)}</span>
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={readOnly || busy}
            onClick={() => void mutate(() => api.revokeTranslation(workId, row.language, row.field))}
          >
            {t("llmTranslation.revoke")}
          </Button>
        </div>
      ))}
      {earlier.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">{t("llmTranslation.history")}</summary>
          <ul className="mt-2 space-y-1 text-sm">
            {earlier.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-muted-foreground">
                  {languageName(row.language)} · {t(`llmTranslation.states.${row.action}`)}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={readOnly || busy}
                  onClick={() => void mutate(() => api.restoreTranslation(workId, row.id))}
                >
                  {t("llmTranslation.restore")}
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
