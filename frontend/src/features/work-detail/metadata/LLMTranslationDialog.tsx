import { Loader2, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toastFromError, useToast } from "@/components/ui/toast";
import { api, type LLMTranslation, type WorkDetail } from "@/lib/api";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import { metadataTagNameLanguages } from "@/lib/metadataTagModel";
import { LLMTranslationReviews } from "./LLMTranslationReviews";
import type { LLMTranslationModel, LLMAssessment } from "@/lib/llmApi";

export function LLMTranslationDialog({
  work,
  onClose,
  onApply,
  applying = false,
}: {
  work: WorkDetail;
  onClose: () => void;
  onApply: (translation: LLMTranslation) => void;
  applying?: boolean;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const translationController = useRef<AbortController | null>(null);
  useEffect(() => () => translationController.current?.abort(), []);
  const [providers, setProviders] = useState<LLMTranslationModel[]>([]);
  const [assessment, setAssessment] = useState<LLMAssessment | null>(null);
  const [providerID, setProviderID] = useState("");
  const [targetLanguage, setTargetLanguage] = useState("zh-cn");
  const [fields, setFields] = useState({ title: true, description: true, tags: false });
  const [workCodes, setWorkCodes] = useState(work.primaryCode);
  const [runs, setRuns] = useState<{ runId: number; state: string }[]>([]);
  const [preview, setPreview] = useState<LLMTranslation | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingProviders, setLoadingProviders] = useState(true);

  useEffect(() => {
    void api
      .listTranslationModels()
      .then((result) => {
        const enabled = result;
        setProviders(enabled);
        setProviderID(enabled[0]?.id ?? "");
      })
      .catch((error) => toast.notify(toastFromError(error, t("llmTranslation.providersFailed"))))
      .finally(() => setLoadingProviders(false));
  }, [toast, t]);

  const selectedFields = Object.entries(fields)
    .filter(([, selected]) => selected)
    .map(([field]) => field);
  const request = {
    providerId: providerID,
    targetLanguage: targetLanguage.trim(),
    fields: selectedFields,
  };
  const queue = async () => {
    setLoading(true);
    try {
      const result = await api.queueTranslations(workCodes.split(/[\s,]+/).filter(Boolean), request);
      setRuns(result.runs);
    } catch (error) {
      toast.notify(toastFromError(error, t("llmTranslation.failed")));
    } finally {
      setLoading(false);
    }
  };
  const translate = async () => {
    if (!providerID || !targetLanguage.trim() || selectedFields.length === 0) return;
    setLoading(true);
    try {
      translationController.current = new AbortController();
      const result = await api.translateWork(work.id, request, translationController.current.signal);
      setPreview(result);
    } catch (error) {
      toast.notify(toastFromError(error, t("llmTranslation.failed")));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog onClose={onClose} size="lg" dismissible={!loading && !applying}>
      <DialogHeader title={t("llmTranslation.title")} description={work.title} />
      <DialogBody>
        {preview ? (
          <div className="space-y-4">
            <div className="rounded-lg border bg-muted/25 px-3 py-3 text-sm">
              <div className="font-medium">
                {t("llmTranslation.previewSummary", { provider: preview.providerName, model: preview.model })}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{preview.assessment.reason}</div>
            </div>
            {preview.translation.title && (
              <PreviewField
                label={t("metadataEditor.sections.title")}
                source={preview.source.title}
                result={preview.translation.title}
              />
            )}
            {preview.translation.description && (
              <PreviewField
                label={t("workTitles.description")}
                source={preview.source.description}
                result={preview.translation.description}
                multiline
              />
            )}
            {preview.translation.tags?.map((name, index) => (
              <PreviewField
                key={index}
                label={t("metadataEntries.tags")}
                source={preview.source.tags?.[index]}
                result={name}
              />
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            <label className="block text-sm font-medium">
              {t("llmTranslation.provider")}
              <select
                aria-label={t("llmTranslation.provider")}
                value={providerID}
                disabled={loadingProviders || loading}
                onChange={(event) => setProviderID(event.target.value)}
                className="mt-1 h-[var(--control-height)] w-full rounded-[var(--control-radius)] border border-input bg-background px-3 text-sm"
              >
                <option value="">
                  {loadingProviders ? t("llmTranslation.loading") : t("llmTranslation.noProvider")}
                </option>
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name} · {provider.defaultModel}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm font-medium">
              {t("llmTranslation.targetLanguage")}
              <select
                aria-label={t("llmTranslation.targetLanguage")}
                className="mt-1 w-full rounded border bg-background p-2 text-sm"
                value={targetLanguage}
                disabled={loading}
                onChange={(event) => setTargetLanguage(event.target.value)}
              >
                {metadataTagNameLanguages.map(([language, label]) => (
                  <option key={language} value={language}>
                    {t(label)}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="space-y-2 rounded-lg border px-3 py-3">
              <legend className="px-1 text-sm font-medium">{t("llmTranslation.fields")}</legend>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={fields.title}
                  disabled={loading}
                  onChange={(event) => setFields((current) => ({ ...current, title: event.target.checked }))}
                />
                {t("metadataEditor.sections.title")}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={fields.description}
                  disabled={loading}
                  onChange={(event) => setFields((current) => ({ ...current, description: event.target.checked }))}
                />
                {t("llmTranslation.description")}
              </label>
            </fieldset>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={fields.tags}
                disabled={loading}
                onChange={(event) => setFields((current) => ({ ...current, tags: event.target.checked }))}
              />
              {t("llmTranslation.sharedTags")}
            </label>
            <LLMTranslationReviews
              workId={work.id}
              onSelect={(review) => {
                setPreview(review);
                setTargetLanguage(review.targetLanguage);
              }}
            />
            <label className="block text-sm">
              {t("llmTranslation.batchCodes")}
              <Input
                aria-label={t("llmTranslation.batchCodes")}
                value={workCodes}
                disabled={loading}
                onChange={(event) => setWorkCodes(event.target.value)}
              />
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={loading || !providerID || selectedFields.length === 0}
              onClick={() => void queue()}
            >
              {t("llmTranslation.queue")}
            </Button>
            {runs.map((run) => (
              <div key={run.runId} className="flex items-center justify-between gap-2 text-sm">
                <a
                  href={"/workflows?activity=1&run=" + run.runId}
                  onClick={(event) => {
                    event.preventDefault();
                    window.history.pushState({}, "", "/workflows?activity=1&run=" + run.runId);
                    window.dispatchEvent(new Event(NAVIGATION_EVENT));
                  }}
                >
                  {t("llmTranslation.activity")} #{run.runId}
                </a>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    try {
                      await api.cancelWorkflowRun(run.runId);
                      setRuns((current) => current.filter((item) => item.runId !== run.runId));
                    } catch (error) {
                      toast.notify(toastFromError(error, t("llmTranslation.failed")));
                    }
                  }}
                >
                  {t("common.cancel")}
                </Button>
                {run.state === "uncertain" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      try {
                        await api.resubmitUncertainTranslation(run.runId);
                        setRuns((current) =>
                          current.map((item) => (item.runId === run.runId ? { ...item, state: "pending" } : item)),
                        );
                      } catch (error) {
                        toast.notify(toastFromError(error, t("llmTranslation.failed")));
                      }
                    }}
                  >
                    {t("llmTranslation.resubmit")}
                  </Button>
                )}
              </div>
            ))}
            <p className="text-xs leading-5 text-muted-foreground">{t("llmTranslation.safetyHint")}</p>
            <Button
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={async () => {
                try {
                  const result = await api.precheckWork(work.id, request);
                  setAssessment(result.assessment);
                } catch (error) {
                  toast.notify(toastFromError(error, t("llmTranslation.failed")));
                }
              }}
            >
              {t("llmTranslation.precheck")}
            </Button>
            {assessment && (
              <div role="status" className="space-y-1 text-sm">
                <p>
                  {assessment.class} · {assessment.reason}
                </p>
                {assessment.matches.map((match, index) => (
                  <p key={index}>
                    {match.rule} · {match.field}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        {loading && (
          <Button variant="outline" size="sm" onClick={() => translationController.current?.abort()}>
            {t("common.cancel")}
          </Button>
        )}
        {preview ? (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={applying}
              onClick={async () => {
                try {
                  await api.rejectTranslation(work.id, preview.previewId);
                  setPreview(null);
                } catch (error) {
                  toast.notify(toastFromError(error, t("llmTranslation.failed")));
                }
              }}
            >
              {t("llmTranslation.back")}
            </Button>
            <Button size="sm" disabled={applying} onClick={() => onApply(preview)}>
              <Sparkles className="h-4 w-4" />
              {t("llmTranslation.apply")}
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            disabled={loading || loadingProviders || !providerID || selectedFields.length === 0}
            onClick={() => void translate()}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {t("llmTranslation.translate")}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}

function PreviewField({
  label,
  source,
  result,
  multiline = false,
}: {
  label: string;
  source?: string;
  result?: string;
  multiline?: boolean;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <div>
        <div className="mb-1 text-xs font-medium text-muted-foreground">{label} · original</div>
        <div
          className={
            multiline
              ? "max-h-48 overflow-auto whitespace-pre-wrap rounded border px-3 py-2 text-sm"
              : "rounded border px-3 py-2 text-sm"
          }
        >
          {source || "—"}
        </div>
      </div>
      <div>
        <div className="mb-1 text-xs font-medium text-muted-foreground">{label} · translation</div>
        <div
          className={
            multiline
              ? "max-h-48 overflow-auto whitespace-pre-wrap rounded border px-3 py-2 text-sm"
              : "rounded border px-3 py-2 text-sm"
          }
        >
          {result || "—"}
        </div>
      </div>
    </div>
  );
}
