import { Languages, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { FloatingSelect } from "@/components/ui/floating-select";
import { toastFromError, useToast } from "@/components/ui/toast";
import { ApiError, api, type TranslationCategory } from "@/lib/api";
import type { LLMTranslationModel } from "@/lib/llmApi";
import { serviceModelChoices } from "@/lib/serviceModels";
import { modelTranslationTargets } from "@/lib/translationTargets";
import type { TranslationCoverageWork } from "./translationCoverageApi";

/**
 * Requests Translate with AI for each selected work into the view's language:
 * what each work lacks among its title, description, shared tag names and
 * file and folder display names. Lyrics are chosen track by track in a work's
 * own Translate with AI dialog. Results wait on the Translation page.
 */
export function BatchTranslationDialog({
  works,
  language,
  languageLabel,
  permissions,
  onClose,
  onQueued,
}: {
  works: TranslationCoverageWork[];
  language: string;
  languageLabel: string;
  permissions: { metadata: boolean; files: boolean };
  onClose: () => void;
  onQueued: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [providers, setProviders] = useState<LLMTranslationModel[] | null>(null);
  const [choiceKey, setChoiceKey] = useState("");
  // Categories start on what some selected work still lacks.
  const [categories, setCategories] = useState<Record<TranslationCategory, boolean>>(() => ({
    title: permissions.metadata && works.some((work) => work.translation.title === "missing"),
    description: permissions.metadata && works.some((work) => work.translation.description === "missing"),
    tags: permissions.metadata && works.some((work) => work.translation.tags.done < work.translation.tags.total),
    files: permissions.files && works.some((work) => work.translation.files.done < work.translation.files.total),
  }));
  const [queueing, setQueueing] = useState(false);
  const [result, setResult] = useState<{ queued: number; skipped: number } | null>(null);

  useEffect(() => {
    void api
      .listTranslationModels()
      .then((list) => {
        setProviders(list);
        setChoiceKey(serviceModelChoices(list)[0]?.key ?? "");
      })
      .catch((error) => {
        setProviders([]);
        toast.notify(toastFromError(error, t("aiTranslation.requestFailed")));
      });
  }, [toast, t]);

  const choices = serviceModelChoices(providers ?? []);
  const choice = choices.find((candidate) => candidate.key === choiceKey) ?? null;
  const targets = modelTranslationTargets(choice?.service, choice?.model);
  const languageSupported = targets === null || targets.includes(language);
  const selected = (Object.keys(categories) as TranslationCategory[]).filter((category) => categories[category]);
  const canQueue = !!choice && languageSupported && selected.length > 0 && !queueing && result === null;
  const allowed = (category: TranslationCategory) => (category === "files" ? permissions.files : permissions.metadata);

  const queue = async () => {
    if (!canQueue || !choice) return;
    setQueueing(true);
    let queued = 0;
    let skipped = 0;
    try {
      for (const work of works) {
        try {
          await api.requestTranslation(work.id, {
            languages: [language],
            categories: selected,
            providerId: choice.service.id,
            model: choice.model,
            lyrics: [],
          });
          queued++;
        } catch (error) {
          // A work with nothing missing is skipped; any other refusal stops the batch.
          if (error instanceof ApiError && error.code === "nothing_to_translate") skipped++;
          else throw error;
        }
      }
    } catch (error) {
      toast.notify(toastFromError(error, t("aiTranslation.requestFailed")));
    } finally {
      setQueueing(false);
      setResult({ queued, skipped });
      onQueued();
    }
  };

  return (
    <Dialog onClose={onClose} size="lg" dismissible={!queueing}>
      <DialogHeader
        title={t("translationCoverage.batch.title", { count: works.length })}
        description={t("translationCoverage.batch.description", { language: languageLabel })}
      />
      <DialogBody>
        {result ? (
          <div className="space-y-2 text-sm" role="status">
            <p className="font-medium">{t("translationCoverage.batch.queued", { count: result.queued })}</p>
            {result.skipped > 0 && (
              <p className="text-muted-foreground">
                {t("translationCoverage.batch.skipped", { count: result.skipped })}
              </p>
            )}
            <p className="text-muted-foreground">{t("translationCoverage.batch.reviewHint")}</p>
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
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">{t("aiTranslation.llmModel")}</div>
              <FloatingSelect
                value={choiceKey}
                ariaLabel={t("aiTranslation.llmModel")}
                options={choices.map(({ key, service, model }) => ({
                  value: key,
                  label: `${service.name} · ${model}`,
                }))}
                onValueChange={setChoiceKey}
                triggerLabel={
                  providers === null
                    ? t("aiTranslation.loading")
                    : choices.length === 0
                      ? t("aiTranslation.noLLMService")
                      : undefined
                }
                disabled={queueing || choices.length === 0}
              />
            </div>
            {!languageSupported && (
              <p className="text-xs text-warning-foreground">
                {t("translationCoverage.batch.unsupported", { language: languageLabel })}
              </p>
            )}
            <fieldset className="space-y-2 rounded-lg border px-3 py-3">
              <legend className="px-1 text-sm font-medium">{t("aiTranslation.category")}</legend>
              {(Object.keys(categories) as TranslationCategory[]).map((category) => (
                <label key={category} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={categories[category]}
                    disabled={queueing || !allowed(category)}
                    onCheckedChange={(checked) => setCategories((current) => ({ ...current, [category]: checked }))}
                  />
                  {t(`aiTranslation.categories.${category}`)}
                </label>
              ))}
            </fieldset>
            <p className="text-xs leading-5 text-muted-foreground">{t("translationCoverage.batch.scopeHint")}</p>
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose} disabled={queueing}>
          {result ? t("common.close") : t("common.cancel")}
        </Button>
        {!result && (
          <Button size="sm" disabled={!canQueue} onClick={() => void queue()}>
            {queueing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Languages className="h-4 w-4" />}
            {t("translationCoverage.batch.queue", { count: works.length })}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
