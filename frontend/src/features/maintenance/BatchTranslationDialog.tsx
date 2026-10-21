import { Languages, Loader2 } from "lucide-react";
import { useEffect, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { toastFromError, useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import type { LLMTranslationModel } from "@/lib/llmApi";
import { serviceModelChoices } from "@/lib/serviceModels";
import { modelTranslationTargets } from "@/lib/translationTargets";
import type { TranslationCoverageWork } from "./translationCoverageApi";

type Field = "title" | "description" | "tags";

/**
 * Queues one background LLM translation per selected work into the view's
 * language. Results wait for review in each work's metadata editor, as a
 * translation queued from the editor does.
 */
export function BatchTranslationDialog({
  works,
  language,
  languageLabel,
  onClose,
  onQueued,
}: {
  works: TranslationCoverageWork[];
  language: string;
  languageLabel: string;
  onClose: () => void;
  onQueued: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [providers, setProviders] = useState<LLMTranslationModel[]>([]);
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [choiceKey, setChoiceKey] = useState("");
  // Fields start on what some selected work still lacks.
  const [fields, setFields] = useState<Record<Field, boolean>>(() => ({
    title: works.some((work) => work.translation.title === "missing"),
    description: works.some((work) => work.translation.description === "missing"),
    tags: works.some((work) => work.translation.tags.done < work.translation.tags.total),
  }));
  const [queueing, setQueueing] = useState(false);
  const [runs, setRuns] = useState<{ workId: number; runId: number; deduplicated: boolean }[] | null>(null);

  useEffect(() => {
    void api
      .listTranslationModels()
      .then((result) => {
        setProviders(result);
        setChoiceKey(serviceModelChoices(result)[0]?.key ?? "");
      })
      .catch((error) => toast.notify(toastFromError(error, t("llmTranslation.providersFailed"))))
      .finally(() => setLoadingProviders(false));
  }, [toast, t]);

  const choices = serviceModelChoices(providers);
  const choice = choices.find((candidate) => candidate.key === choiceKey) ?? null;
  const targets = modelTranslationTargets(choice?.service, choice?.model);
  const languageSupported = targets === null || targets.includes(language);
  const selectedFields = (Object.keys(fields) as Field[]).filter((field) => fields[field]);
  const canQueue = !!choice && languageSupported && selectedFields.length > 0 && !queueing && runs === null;

  const queue = async () => {
    if (!canQueue || !choice) return;
    setQueueing(true);
    try {
      const result = await api.queueTranslations(
        works.map((work) => work.primaryCode),
        { providerId: choice.service.id, model: choice.model, targetLanguage: language, fields: selectedFields },
      );
      setRuns(result.runs);
      onQueued();
    } catch (error) {
      toast.notify(toastFromError(error, t("llmTranslation.failed")));
    } finally {
      setQueueing(false);
    }
  };

  const openActivity = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    window.history.pushState({}, "", event.currentTarget.getAttribute("href"));
    window.dispatchEvent(new Event(NAVIGATION_EVENT));
  };

  const fieldLabels: Record<Field, string> = {
    title: t("translationCoverage.columns.title"),
    description: t("translationCoverage.columns.description"),
    tags: t("translationCoverage.columns.tags"),
  };

  return (
    <Dialog onClose={onClose} size="lg" dismissible={!queueing}>
      <DialogHeader
        title={t("translationCoverage.batch.title", { count: works.length })}
        description={t("translationCoverage.batch.description", { language: languageLabel })}
      />
      <DialogBody>
        {runs ? (
          <div className="space-y-3 text-sm" role="status">
            <p className="font-medium">{t("translationCoverage.batch.queued", { count: runs.length })}</p>
            <p className="text-muted-foreground">{t("translationCoverage.batch.reviewHint")}</p>
            <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border bg-muted/25 px-3 py-2">
              {runs.map((run) => {
                const work = works.find((candidate) => candidate.id === run.workId);
                const href = `/workflows?activity=1&run=${run.runId}`;
                return (
                  <li key={run.runId} className="flex min-w-0 items-center justify-between gap-3">
                    <span className="truncate">
                      <span className="font-mono text-xs text-muted-foreground">{work?.primaryCode}</span> {work?.title}
                    </span>
                    <a href={href} onClick={openActivity} className="shrink-0 text-primary hover:underline">
                      {t("llmTranslation.activity")} #{run.runId}
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : (
          <div className="space-y-4">
            <ul className="max-h-36 space-y-1 overflow-y-auto rounded-md border bg-muted/25 px-3 py-2 text-xs">
              {works.map((work) => (
                <li key={work.id} className="truncate" title={work.title}>
                  <span className="font-mono text-muted-foreground">{work.primaryCode}</span> {work.title}
                </li>
              ))}
            </ul>
            <label className="block text-sm font-medium">
              {t("llmTranslation.provider")}
              <select
                aria-label={t("llmTranslation.provider")}
                value={choiceKey}
                disabled={loadingProviders || queueing}
                onChange={(event) => setChoiceKey(event.target.value)}
                className="mt-1 h-[var(--control-height)] w-full rounded-[var(--control-radius)] border border-input bg-background px-3 text-sm"
              >
                <option value="">
                  {loadingProviders ? t("llmTranslation.loading") : t("llmTranslation.noProvider")}
                </option>
                {choices.map(({ key, service, model }) => (
                  <option key={key} value={key}>
                    {service.name} · {model}
                  </option>
                ))}
              </select>
            </label>
            {!languageSupported && (
              <p className="text-xs text-warning-foreground">
                {t("translationCoverage.batch.unsupported", { language: languageLabel })}
              </p>
            )}
            <fieldset className="space-y-2 rounded-lg border px-3 py-3">
              <legend className="px-1 text-sm font-medium">{t("llmTranslation.fields")}</legend>
              {(Object.keys(fieldLabels) as Field[]).map((field) => (
                <label key={field} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={fields[field]}
                    disabled={queueing}
                    onCheckedChange={(checked) => setFields((current) => ({ ...current, [field]: checked }))}
                  />
                  {fieldLabels[field]}
                </label>
              ))}
            </fieldset>
            <p className="text-xs leading-5 text-muted-foreground">{t("translationCoverage.batch.scopeHint")}</p>
            <p className="text-xs leading-5 text-muted-foreground">{t("llmTranslation.safetyHint")}</p>
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose} disabled={queueing}>
          {runs ? t("common.close") : t("common.cancel")}
        </Button>
        {!runs && (
          <Button size="sm" disabled={!canQueue} onClick={() => void queue()}>
            {queueing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Languages className="h-4 w-4" />}
            {t("translationCoverage.batch.queue", { count: works.length })}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
